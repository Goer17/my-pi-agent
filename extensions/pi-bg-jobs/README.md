# pi-bg-jobs

One-shot background jobs for the [pi coding agent](https://github.com/earendil-works/pi). Run a process in the background, and when it exits — **with any exit code** — its captured stdout/stderr is delivered to the agent as a **user message**, so the agent continues working instead of waiting in the foreground.

`bg_start` runs the command **exactly once**. For recurring listeners use the separate [`pi-listen`](../pi-listen) plugin (`listen_start`), which is the looping version of `bg_start`.

Typical use: the agent starts a long build, download, or one-off server check, then finishes its turn. When the process exits, its output is automatically injected as a user message and the agent wakes up to process it.

## Install

Global (all projects):

```bash
ln -s /path/to/pi-bg-jobs ~/.pi/agent/extensions/pi-bg-jobs
```

Project-local:

```bash
ln -s /path/to/pi-bg-jobs /path/to/project/.pi/extensions/pi-bg-jobs
```

Or load it explicitly for a single run:

```bash
pi -e ./pi-bg-jobs/index.ts
```

Extensions in `~/.pi/agent/extensions/` and `.pi/extensions/` are auto-discovered and can be hot-reloaded with `/reload`.

## Usage

The agent gets five tools:

| Tool | Purpose |
|------|---------|
| `bg_start` | Start `command` via `bash -lc` in the background **once**. Params: `label`, `cwd`, `timeout` (seconds). Returns immediately with a job id such as `bg-1`. |
| `bg_status` | List all jobs, or show details for one (`id`). |
| `bg_output` | Read the last N lines of a job's output (`id`, `lines`). |
| `bg_kill` | Send a signal to a running job (`id`, optional `signal`, default `SIGTERM`). |
| `bg_wait` | Block (bounded, default 60s / max 600s) until the job exits. Usually unnecessary — notifications are automatic. |

And three commands:

| Command | Purpose |
|---------|---------|
| `/jobs` | List background jobs |
| `/jobs-kill <id> [signal]` | Stop a job |
| `/jobs-clear` | Forget finished jobs (running jobs are kept) |

Example prompt to the agent:

> Start `npm run build` in the background with `bg_start`, label it "build", then summarize the README. When the build exits, inspect the output and fix any errors.

While a job runs, a line like `● bg-1 "build" · 2m · npm run build` shows above the editor.

## What the agent receives

When the process exits, pi sends a user message:

```text
[pi background job notification] Background job bg-1 "build" finished with exit code 0.
command: npm run build
cwd: /Users/me/project
duration: 4m 12s
log file: /var/folders/.../pi-bg-jobs/bg-1-1712345678901.log

output:
----- output -----
...
----- end output -----

This is an automatic notification, not a user reply. Continue the task using the output above.
```

Details:

- **Any exit code** triggers the notification (success and failure alike).
- **Run once** — `bg_start` does not repeat. If you need to run again, call `bg_start` again (or use `pi-listen` for a continuous loop).
- If the agent is **idle**, the message is delivered immediately and starts a new turn.
- If the agent is **busy**, notifications are held inside the extension and delivered when the agent settles as a normal user message. This also covers pressing **Esc**: the accumulated output is sent immediately instead of being restored into the editor as text.
- Notifications that land within ~250ms of each other are batched into one message.
- Output is kept in memory (last 200k chars) and the full raw output is written to a log file in the OS temp dir (`pi-bg-jobs/`).
- The notification message includes at most the last 150 lines / 15k chars; the log path is included for the rest.
- `PI_BG_JOB_ID` and `PI_BG_JOB_LABEL` are exported to the command.

## Behavior and limitations

- `timeout` (optional) kills the process (`SIGTERM`, then `SIGKILL` after 5s) if it runs too long.
- `bg_kill` sends a signal; the exit notification is still delivered.
- Processes are plain children of the pi process, with stdin closed. They are killed (`SIGTERM`, then `SIGKILL`) on `session_shutdown` and on process exit, because a job cannot report back once the session is gone.
- Jobs are session-scoped. They do not survive `/new`, `/resume`, `/fork`, `/reload`, or quitting pi.
- Commands run through `bash -lc` (falls back to `sh` if bash is missing), so login-shell PATH applies.

## Development

```bash
# one-time: make "typebox" resolvable for the standalone harness
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/typebox" node_modules/typebox

node test/harness.mjs     # mocked ExtensionAPI: one-shot delivery, busy/settle, kill/timeout, widget, shutdown
node test/e2e-rpc.mjs     # real pi via RPC: one-shot output wakes the agent after the turn ends
```

The unit harness requires Node >= 23.6 (native TypeScript type stripping). The E2E test uses the configured default pi model and takes ~15–30s.
