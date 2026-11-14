# my-pi-agent

Portable pi extensions and skills for a new machine.

## Contents

```text
extensions/
  exit-command.ts     /exit alias for /quit
  pi-bg-jobs/         one-shot background jobs (bg_start, bg_status, bg_output, bg_kill, bg_wait)
  pi-listen/          continuous listeners (listen_start, listen_status, listen_output, listen_stop)
skills/
  agent-hive-skill/   Agent Hive mailbox/agent-to-agent skill
```

Credentials and local env files (`.env`) are intentionally **not** included.

## Install

```bash
git clone <this-repo> ~/workspace/my-pi-agent
cd ~/workspace/my-pi-agent
./init.sh              # symlink into ~/.pi/agent (recommended)
./init.sh --copy       # copy instead
```

The installer backs up anything it replaces as `<name>.bak-<timestamp>`, and
uses `~/.pi/agent` by default. Override it with `PI_AGENT_DIR`:

```bash
PI_AGENT_DIR=/path/to/agent ./init.sh
```

Then start pi and run `/reload` (or restart pi) to load the extensions.

## Requirements

- `pi` coding agent
- `node` (extensions)
- `python3`, `curl`, `openssl` (Agent Hive skill)

The Agent Hive skill needs its own credentials; see
`skills/agent-hive-skill/SKILL.md` and configure `~/.agent-hive/`.
