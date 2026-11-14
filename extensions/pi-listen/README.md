# pi-listen

Continuous background listeners for the [pi coding agent](https://github.com/earendil-works/pi).

`listen_start` is the **looping version of `bg_start`**: it runs a command, delivers the run's captured stdout/stderr to the agent as a **user message** when the command exits, and starts the command again immediately. The loop runs until the agent calls `listen_stop` (or the session shuts down).

```text
listen_start:
  while not stopped:
    status, stdout, stderr = exec(command)
    send_message(status, stdout, stderr)   # full output also goes to the log file
    # restart immediately
```

Typical use: a mail/IM waiter, a queue consumer, a watcher, or a polling command that exits whenever there is something to process.

This plugin is independent of [`pi-bg-jobs`](../pi-bg-jobs), but they can be installed and run together. Use `bg_start` for a process that should run **once** and `listen_start` for a process that should keep running.

## Install

Global (all projects):

```bash
ln -s /path/to/pi-listen ~/.pi/agent/extensions/pi-listen
```

Project-local:

```bash
ln -s /path/to/pi-listen /path/to/project/.pi/extensions/pi-listen
```

Or load it explicitly:

```bash
pi -e ./pi-listen/index.ts
```

## Tools

| Tool | Purpose |
|------|---------|
| `listen_start` | Start `command` via `bash -lc` and restart it after every exit. Params: `label`, `cwd`, `timeout` (per-run seconds; 0/empty = no timeout). Returns immediately with an id such as `listen-1`. |
| `listen_status` | List listeners, or show details for one (`id`): current run, runs completed, elapsed/result, log path. |
| `listen_output` | Read the last N lines of the **current or last run** (`id`, `lines`). The full log has every run. |
| `listen_stop` | Send a signal to the current run (`id`, optional `signal`, default `SIGTERM`) and **prevent the loop from restarting**. The final notification is still delivered. |

Commands:

| Command | Purpose |
|---------|---------|
| `/listen` | List listeners |
| `/listen-stop <id> [signal]` | Stop a listener |
| `/listen-clear` | Forget stopped/failed listeners (running listeners are kept) |

Example prompt:

> Use `listen_start` to run `node wait-mail.js` with label "mail". When it exits, process the mail it printed; keep listening. Stop it with `listen_stop` when I say we are done.

While a listener runs, a line like `● listen-1 "mail" · run 12 · 1h 4m · node wait-mail.js` shows above the editor.

## What the agent receives

Each run ends with a user message. For a single run:

```text
[pi listen notification] Listener listen-1 "mail" run 12 finished with exit code 0 and restarted.
command: node wait-mail.js
cwd: /Users/me/project
run: 12 (12 completed since the listener started)
duration: 18s
log file: /var/folders/.../pi-listen/listen-1-1712345678901.log

output:
----- output -----
From: someone@example.com
Subject: Hello
...
----- end output -----

The listener restarted automatically and is now on run 13. Stop it with listen_stop listen-1.

This is an automatic notification, not a user reply. Continue the task using the output above.
```

If **many runs finish while the agent is busy**, pi-listen coalesces them into one message:

```text
[pi listen notification] Listener listen-1 "mail" completed 17 runs since the last notification; latest run 29 finished with exit code 0 and restarted.
...
Only the latest run's output is shown; all 17 runs are in the log file.
...
```

Details:

- **Any exit code** restarts the loop (success, non-zero exit, timeout, or signal not caused by `listen_stop`).
- If the agent is idle, each run's notification is delivered normally (runs within ~250ms are batched).
- If the agent is busy, notifications are held inside the extension until `agent_settled`; repeated runs of one listener collapse into one notification with a **run count + latest output**. This is Escape-safe: queued output is not restored into the editor.
- The full raw output of **every run** is written to one log file in the OS temp dir (`pi-listen/`), with run separators. The notification shows at most the last 120 lines / 12k chars of the latest run; the log path is included for the rest.
- `timeout` applies **per run**: when it fires, the current run is killed (`SIGTERM`, then `SIGKILL` after 5s) and the listener restarts.
- `listen_stop` sets a stop flag before signalling, so a run that exits during the signal cannot restart the loop.
- `PI_LISTEN_JOB_ID`, `PI_LISTEN_JOB_LABEL` and `PI_LISTEN_JOB_RUN` are exported to the command.
- Processes are plain children of the pi process, with stdin closed. They are killed on `session_shutdown` and on process exit.
- Listeners are session-scoped. They do not survive `/new`, `/resume`, `/fork`, `/reload`, or quitting pi.
- Commands run through `bash -lc` (falls back to `sh` if bash is missing).
- A listener whose command exits immediately will restart immediately in a tight loop. Add `sleep` to the command if it is a polling check; use `listen_stop` to cancel it.

## System prompt

The extension appends a short section to the system prompt that explains the semantics:

- `listen_start` is the looping version of `bg_start`.
- Each exit delivers output, then the command restarts.
- Repeat until `listen_stop`.
- Use `bg_start` for one-shot commands.
- Busy runs are coalesced; the full log has every run.

## Development

```bash
# one-time: make "typebox" resolvable for the standalone harness
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/typebox" node_modules/typebox

node test/harness.mjs     # mocked ExtensionAPI: loop, busy coalescing, stop, timeout, logs, shutdown
node test/e2e-rpc.mjs     # real pi via RPC: one listener run wakes the agent and restarts
```

The unit harness requires Node >= 23.6 (native TypeScript type stripping). The E2E test uses the configured default pi model and takes ~15–30s.
