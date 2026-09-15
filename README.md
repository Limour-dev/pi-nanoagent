# pi-nanoagent

A `nano_agent` tool for [Pi](https://github.com/badlogic/pi-mono): every call
spawns a **fresh, isolated `pi` process** with no skills, no discovered
extensions and exactly one tool — `bash`. One extension is deliberately let
back in: the [`pi-trace-id` tracer](#tracing-extension). At most **4 run in
parallel**.

Designed to be minimal — one ~450-line TypeScript file, no dependencies to
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
  -e <pi-trace-id> \
  --tools bash \
  --model <parent provider/id> \
  --thinking <parent level> \
  -- "<prompt>"
```

| Flag | Effect |
|------|--------|
| `-p` | Print mode: run once, print stdout, exit. No state kept. |
| `--no-session` | Ephemeral — the child never writes a session file. |
| `--no-extensions` | Extension/plugin discovery is off, so this tool is not available to the child either (no recursion) and no other plugin can sneak in. |
| `-e <pi-trace-id>` | Explicit path to the tracing extension. Discovery stays off — `-e` bypasses it — so this is the only extension the child loads. |
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

## Tracing extension

`--no-extensions` disables *discovery*, but explicit `-e` paths still load. That
escape hatch is used for exactly one package: `pi-trace-id`, which stamps
`AH-Thread-Id` / `AH-Trace-Id` on every provider request the child makes. It
registers no tools, so `--tools bash` stays a complete description of what the
subagent can do.

- **Resolution** is static and memoized once per pi process — nothing is ever
  executed to find it. The package is looked up by directory name, project
  scope first: `<cwd>/.pi/git/**`, `<cwd>/.pi/npm/node_modules`,
  `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) `git/**`, then
  `npm/node_modules`. What is found is passed as `-e <path>`; a package
  directory is fine, pi reads its manifest.
- **Not installed?** The child simply runs without tracing; nothing else
  changes. `details.extensions` lists what was actually loaded.
- **`AH-Thread-Id`** hashes the cwd, so it equals the parent's thread id — the
  child runs in the parent's cwd.
- **`AH-Trace-Id`** is the child's *own* ephemeral session id (rewritten to a
  v4 UUID) because the child runs with `--no-session`: every `nano_agent` call
  is its own trace within the parent's thread.
- **Override** the search with `PI_NANO_EXTENSIONS` — a path list separated by
  `;`, `,` or newlines, for installs outside the standard package roots:

  ```bash
  PI_NANO_EXTENSIONS=/home/me/pi-trace-id pi
  ```

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
code, signal, wall-clock duration, whether stdout was truncated, the extension
paths actually loaded, and stderr.

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
- Nested delegation is impossible by construction (`--no-extensions`, and `pi-nanoagent` is not on the permit list).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
