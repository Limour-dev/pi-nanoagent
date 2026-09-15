/**
 * pi-nanoagent — a single `nano_agent` tool for Pi.
 *
 * One call = one fresh `pi` process in `-p` (print) mode, isolated from the
 * current conversation:
 *
 *   pi -p --no-session --no-extensions --no-skills --tools bash -- <prompt>
 *
 * That is: no skills, no extensions (this plugin included), and exactly one
 * tool — `bash`. The child inherits the dispatching session's cwd, model and
 * thinking level, and is killed when the parent turn is aborted.
 *
 * At most 4 children run at the same time; extra calls queue until a slot is
 * free. No dependencies beyond what Pi already provides.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TOOL_NAME = "nano_agent";
const MAX_PARALLEL = 4;
const OUTPUT_LIMIT = 50 * 1024; // stdout kept for the model, tail-biased
const STDERR_LIMIT = 8 * 1024;
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// System-prompt surface (kept deliberately small)
// ---------------------------------------------------------------------------

const DESCRIPTION = `Run one self-contained task in a fresh, isolated pi subagent ("nano agent"): empty context, no skills, no extensions, and only the bash tool. Give it the full task in prompt — it cannot read files except through the shell. Independent tasks may be dispatched in parallel. Returns the subagent's stdout.`;

const PROMPT_SNIPPET = "Delegate a self-contained task to a fresh bash-only subagent";

const PROMPT_GUIDELINES = [`Use ${TOOL_NAME} when a task is self-contained and solvable in the shell.`];

// ---------------------------------------------------------------------------
// Parameter schema & types
// ---------------------------------------------------------------------------

const ParamsSchema = Type.Object({
	prompt: Type.String({
		description:
			"The complete, self-contained task for the subagent. It has no conversation history and only the bash tool, so include all needed context, expected output format, and the working directory assumptions.",
	}),
});
type Params = Static<typeof ParamsSchema>;

interface NanoDetails {
	command: string;
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	durationMs: number;
	stdoutTruncated: boolean;
	stdoutBytes: number;
	stderr: string;
}

// ---------------------------------------------------------------------------
// Concurrency gate: MAX_PARALLEL children, the rest queue up
// ---------------------------------------------------------------------------

let running = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(signal: AbortSignal | undefined): Promise<void> {
	if (running < MAX_PARALLEL) {
		running += 1;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			const i = waiters.indexOf(waiter);
			if (i >= 0) waiters.splice(i, 1);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(`aborted while waiting for a free ${TOOL_NAME} slot`));
		};
		const waiter = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Hand the slot directly to the next waiter, or free it. */
function releaseSlot(): void {
	const next = waiters.shift();
	if (next) next();
	else running = Math.max(0, running - 1);
}

// ---------------------------------------------------------------------------
// Child process invocation
// ---------------------------------------------------------------------------

function getPiInvocation(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}

	return { command: "pi", args: [] };
}

function buildArgs(ctx: ExtensionContext, prompt: string): string[] {
	const args = [
		"-p", // print mode: run once, print, exit
		"--no-session", // ephemeral: never touches session storage
		"--no-extensions", // no plugin discovery (this plugin is left out too)
		"--no-skills", // no skills discovery/loading
		"--tools",
		"bash", // allowlist: bash is the only tool the child gets
	];

	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (model) args.push("--model", model);
	if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);

	// `--` ends option parsing, so a prompt starting with `-` is not read as a flag.
	// A leading `@` would still be an attached-file reference, so pad it away.
	const payload = prompt.startsWith("@") ? ` ${prompt}` : prompt;
	args.push("--", payload);
	return args;
}

function tail(text: string, limit: number): { text: string; truncated: boolean; bytes: number } {
	if (text.length <= limit) return { text, truncated: false, bytes: text.length };
	const dropped = text.length - limit;
	return {
		text: `…[${dropped} chars truncated]…\n${text.slice(text.length - limit)}`,
		truncated: true,
		bytes: text.length,
	};
}

async function runNanoAgent(
	ctx: ExtensionContext,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<{ text: string; details: NanoDetails }> {
	const invocation = getPiInvocation();
	const args = buildArgs(ctx, prompt);
	const cwd = ctx.cwd;
	const startedAt = Date.now();

	let stdout = "";
	let stderr = "";
	let aborted = false;
	let killTimer: NodeJS.Timeout | undefined;

	const result = await new Promise<{ code: number | null; sig: NodeJS.Signals | null; aborted: boolean }>(
		(resolve) => {
			const proc = spawn(invocation.command, [...invocation.args, ...args], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"], // stdin ignored: never merge piped stdin
			});

			const onAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
				killTimer.unref?.();
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			proc.stdout?.setEncoding("utf-8");
			proc.stderr?.setEncoding("utf-8");
			proc.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			proc.stderr?.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-STDERR_LIMIT);
			});

			let settled = false;
			const settle = (code: number | null, sig: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", onAbort);
				resolve({ code, sig, aborted });
			};

			proc.on("error", (err) => {
				stderr = `${stderr}\nspawn failed: ${err.message}`;
				// ENOENT never reaches `close` on some platforms: settle on the next tick.
				if (proc.pid === undefined) setImmediate(() => settle(null, null));
			});
			proc.on("close", (code, sig) => settle(code, sig));
		},
	);

	const out = tail(stdout.trim(), OUTPUT_LIMIT);
	const details: NanoDetails = {
		// Drop `--` and the (possibly huge) prompt: show it as `<prompt>` instead.
		command: `${[invocation.command, ...invocation.args, ...args.slice(0, -2)].join(" ")} -- <prompt>`,
		cwd,
		exitCode: result.code,
		signal: result.sig,
		aborted: result.aborted,
		durationMs: Date.now() - startedAt,
		stdoutTruncated: out.truncated,
		stdoutBytes: out.bytes,
		stderr: stderr.trim(),
	};

	if (result.aborted) {
		return { text: `${TOOL_NAME}: aborted by the user.`, details };
	}
	if (result.code !== 0) {
		const parts = [`${TOOL_NAME}: subagent exited with code ${result.code ?? "null"}.`];
		if (out.text) parts.push("", "stdout:", out.text);
		if (details.stderr) parts.push("", "stderr:", details.stderr);
		return { text: parts.join("\n"), details };
	}
	if (!out.text) {
		const parts = [`${TOOL_NAME}: subagent produced no output.`];
		if (details.stderr) parts.push("", "stderr:", details.stderr);
		return { text: parts.join("\n"), details };
	}
	return { text: out.text, details };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Nano Agent",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as unknown as Params;
			const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
			if (!prompt) {
				return {
					content: [{ type: "text" as const, text: `Error: ${TOOL_NAME} requires a non-empty prompt.` }],
					details: { error: "empty prompt" },
				};
			}

			await acquireSlot(signal);
			try {
				const { text, details } = await runNanoAgent(ctx, prompt, signal);
				return { content: [{ type: "text" as const, text }], details };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `${TOOL_NAME}: ${message}` }],
					details: { error: message },
				};
			} finally {
				releaseSlot();
			}
		},
	});
}
