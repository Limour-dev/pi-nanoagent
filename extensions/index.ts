/**
 * pi-nanoagent — a single `nano_agent` tool for Pi.
 *
 * One call = one fresh `pi` process in `-p` (print) mode, isolated from the
 * current conversation:
 *
 *   pi -p --no-session --no-extensions --no-skills \
 *     -e <pi-trace-id> --tools bash -- <prompt>
 *
 * That is: no skills, no discovered extensions (this plugin included), the
 * pi-trace-id tracing extension loaded explicitly, and exactly one
 * tool — `bash`. The child inherits the dispatching session's cwd, model and
 * thinking level, and is killed when the parent turn is aborted. The CLI is
 * found via `PI_CLI` or as `pi` on PATH — never via `process.argv[1]`, which is
 * the host's script when pi runs in-process (pi-web).
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

const DESCRIPTION = `Run one self-contained task in a fresh, isolated pi subagent ("nano agent"): empty context, no skills, no other extensions, and only the bash tool. Give it the full task in prompt — it cannot read files except through the shell. Independent tasks may be dispatched in parallel. Returns the subagent's stdout.`;

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
	extensions: string[];
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

const PI_CLI_MARKER = "pi-coding-agent";
const PI_BIN_NAMES = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];

function realpathOf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

function isExecutable(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/*
 * Deliberately dumb: PI_CLI, else `pi` on PATH. Nothing is ever executed to
 * find out whether a candidate is really pi, because the parent process is not
 * necessarily the CLI at all — hosts like pi-web run pi in-process, where
 * process.argv[1] is Next.js' own bin (which also takes `-p, --port`).
 */
let piCli: string | undefined;

function resolvePiCli(): string {
	if (piCli) return piCli;

	const override = process.env.PI_CLI?.trim();
	if (override) return (piCli = override);

	const found: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of PI_BIN_NAMES) {
			const full = path.join(dir, name);
			if (isExecutable(full)) found.push(full);
		}
	}

	// A PATH may hold an unrelated `pi`, so prefer a real pi package layout.
	const best = found.find((p) => realpathOf(p).includes(PI_CLI_MARKER)) ?? found[0];
	if (best) return (piCli = best);

	throw new Error("could not find the pi CLI on PATH. Set PI_CLI to the pi executable.");
}

// ---------------------------------------------------------------------------
// Explicitly permitted extensions
// ---------------------------------------------------------------------------

/*
 * `--no-extensions` kills discovery, but explicit `-e` paths still load. That
 * escape hatch is used for exactly one package: pi-trace-id, which stamps
 * AH-Thread-Id / AH-Trace-Id on the child's provider requests. It registers no
 * tools, so `--tools bash` stays a complete description of what the child can
 * do. The child keeps its own ephemeral session id, so its AH-Trace-Id is a
 * fresh trace (the AH-Thread-Id still matches the parent: same cwd).
 *
 * PI_NANO_EXTENSIONS overrides the search with a path list, for installs that
 * do not live under a standard pi package root.
 */
const PERMITTED_EXTENSIONS = ["pi-trace-id"];
const EXTRA_EXTENSIONS_ENV = "PI_NANO_EXTENSIONS";
const PACKAGE_SEARCH_DEPTH = 3;

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** A path pi can load with `-e`: a package directory, or a single extension file. */
function asLoadablePath(dir: string): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
			pi?: { extensions?: unknown };
		};
		if (Array.isArray(pkg.pi?.extensions)) return dir; // pi resolves the manifest itself
	} catch {
		// no package.json (or unreadable): fall through to conventional layouts
	}
	if (isDir(path.join(dir, "extensions"))) return dir;
	for (const name of ["index.ts", `${path.basename(dir)}.ts`]) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return undefined;
}

/** Breadth-first search for a directory named `name` under `root`. */
function findDir(root: string, name: string): string | undefined {
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name !== name) continue;
			const loadable = asLoadablePath(path.join(dir, entry.name));
			if (loadable) return loadable;
		}
		if (depth >= PACKAGE_SEARCH_DEPTH) continue;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
		}
	}
	return undefined;
}

/** Package roots, project scope first — pi gives project settings precedence too. */
function packageRoots(cwd: string): string[] {
	const config = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir =
		config || path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
	return [
		path.join(cwd, ".pi", "git"),
		path.join(cwd, ".pi", "npm", "node_modules"),
		path.join(agentDir, "git"),
		path.join(agentDir, "npm", "node_modules"),
	];
}

function findExtension(cwd: string, name: string): string | undefined {
	for (const root of packageRoots(cwd)) {
		if (path.basename(root) === "node_modules") {
			const full = path.join(root, name); // npm packages sit directly in node_modules
			if (isDir(full)) return asLoadablePath(full);
			continue;
		}
		const loadable = findDir(root, name);
		if (loadable) return loadable;
	}
	return undefined;
}

let permittedExtensionArgs: string[] | undefined;

/** `-e` arguments for the child, resolved once per pi process. */
function resolveExtensions(cwd: string): string[] {
	if (permittedExtensionArgs) return permittedExtensionArgs;

	const override = process.env[EXTRA_EXTENSIONS_ENV]?.trim();
	if (override) {
		return (permittedExtensionArgs = override
			.split(/[;,\n]/) // not path.delimiter: it splits `npm:foo` on posix
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "")
			.map((entry) => {
				const full = path.resolve(cwd, entry);
				if (!fs.existsSync(full)) return entry; // let pi interpret sources like npm:foo
				return isDir(full) ? (asLoadablePath(full) ?? full) : full;
			}));
	}

	const found: string[] = [];
	for (const name of PERMITTED_EXTENSIONS) {
		const loadable = findExtension(cwd, name);
		if (loadable) found.push(loadable);
	}
	return (permittedExtensionArgs = found);
}

function buildArgs(ctx: ExtensionContext, prompt: string): string[] {
	const args = [
		"-p", // print mode: run once, print, exit
		"--no-session", // ephemeral: never touches session storage
		"--no-extensions", // no extension discovery (this plugin is left out too)
		"--no-skills", // no skills discovery/loading
	];

	// Discovery is off, but explicit `-e` paths still load: tracing survives.
	for (const ext of resolveExtensions(ctx.cwd)) args.push("-e", ext);

	// Allowlist: bash is the only tool the child gets — extension tools are
	// filtered by it too, and the permitted extensions register none.
	args.push("--tools", "bash");

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
	const command = resolvePiCli();
	const args = buildArgs(ctx, prompt);
	const cwd = ctx.cwd;
	const startedAt = Date.now();

	let stdout = "";
	let stderr = "";
	let aborted = false;
	let spawnFailed = false;
	let killTimer: NodeJS.Timeout | undefined;

	const result = await new Promise<{ code: number | null; sig: NodeJS.Signals | null; aborted: boolean }>(
		(resolve) => {
			const proc = spawn(command, args, {
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
				spawnFailed = true;
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
		command: `${[command, ...args.slice(0, -2)].join(" ")} -- <prompt>`,
		cwd,
		extensions: resolveExtensions(cwd),
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
	if (spawnFailed) {
		return { text: `${TOOL_NAME}: could not start ${command}.${details.stderr ? `\n\n${details.stderr}` : ""}`, details };
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
