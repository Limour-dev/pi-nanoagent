# pi-nanoagent

A `nano_agent` tool for [Pi](https://github.com/badlogic/pi-mono): every call
spawns a **fresh, isolated `pi` process** with no skills, no extensions and
exactly one tool — `bash`. At most **4 run in parallel**.

Designed to be minimal — one ~250-line TypeScript file, no dependencies to
install (uses only what Pi already provides), and a deliberately small
system-prompt footprint.

## Install

```bash
pi install git:github.com/Limour-dev/pi-nanoagent
```

Or for a quick test:

```bash
pi -e ./extensions/index.ts
```

## What the subagent gets

```bash
pi -p \
  --no-session \
  --no-extensions \
  --no-skills \
  --tools bash \
  --model <parent provider/id> \
  --thinking <parent level> \
  -- "<prompt>"
```

| Flag | Effect |
|------|--------|
| `-p` | Print mode: run once, print stdout, exit. No state kept. |
| `--no-session` | Ephemeral — the child never writes a session file. |
| `--no-extensions` | Extension/plugin discovery is off, so this tool is not available to the child either (no recursion). |
| `--no-skills` | Skill discovery and loading is off. |
| `--tools bash` | Allowlist — `bash` is the **only** tool. `read`, `write`, `edit`, `grep`, `ls`, … are all gone. |
| `--model` / `--thinking` | Inherited from the dispatching session (`ctx.model`, `ctx.thinkingLevel`). |
| `--` | Ends option parsing, so a prompt starting with `-` is not read as a flag. |

The child runs in the parent's `cwd`, inherits the environment (including
`PI_*`), and is killed (`SIGTERM`, then `SIGKILL` after 5s) when the parent turn
is aborted.

### Finding the pi executable

The parent process is **not** always the pi CLI: hosts like [pi-web](https://github.com/Limour-dev/pi-web)
run pi in-process, so `process.argv[1]` there is Next.js' own bin — which also
takes `-p, --port`, so relaunching it as if it were pi fails. The CLI is
therefore found from exactly two sources, both statically (nothing is ever
executed just to test a candidate):

1. `PI_CLI` env var — explicit override.
2. `pi` on `PATH`, preferring a candidate whose real path contains
   `pi-coding-agent` if your `PATH` holds an unrelated `pi`.

Resolution is memoized once per pi process. If nothing is found the tool says
so and tells you to set `PI_CLI`; if the chosen executable cannot be started,
the error names it.

Because only `bash` survives, the subagent must do everything through the shell
— which is the point: a cheap, disposable, single-tool worker.

## Tool contract

```jsonc
{
  "prompt": "Count the lines of TypeScript under src/ and print a per-directory table."
}
```

`prompt` is the only parameter and is required. The subagent has **no
conversation history**, so the prompt must be self-contained: include the
context, the expected output format, and any working-directory assumptions.

Result: the subagent's trimmed stdout as text. Tool `details` carry the exit
code, signal, wall-clock duration, whether stdout was truncated, and stderr.

On failure the tool returns diagnostics instead of stdout:

- exit code != 0 → `stdout:` + `stderr:` blocks
- empty output → a note plus stderr
- aborted → `nano_agent: aborted by the user.`

## Parallelism

Independent tasks should be dispatched in a single message — Pi runs the tool
calls concurrently and this extension caps real concurrency at 4 child
processes. Extra calls wait in a FIFO queue for a free slot; aborting the turn
also removes the call from the queue.

## System-prompt footprint

The whole injected surface is one short description, one `Available tools`
snippet and one guideline bullet — parallelism is mentioned once, as a hint,
not a hard limit. Output is capped at
50 KB (tail-biased) so a chatty subagent cannot flood the parent context.

## Limitations

- One-shot: no back-and-forth with the subagent, no session to resume.
- `bash` only: the child cannot use structured `read`/`edit`/`write` tools.
- No hard timeout; only the parent abort signal stops a runaway child.
- Nested delegation is impossible by construction (`--no-extensions`).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
