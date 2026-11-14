# my-pi-agent

This is my personal pi configuration: extensions and skills for a new machine.

## Install

```bash
git clone <this-repo> ~/workspace/my-pi-agent
cd ~/workspace/my-pi-agent
./init.sh          # symlink into ~/.pi/agent (recommended)
./init.sh --copy   # copy instead
```

`init.sh` backs up replaced entries as `<name>.bak-<timestamp>`. Override the target directory with `PI_AGENT_DIR`:

```bash
PI_AGENT_DIR=/path/to/agent ./init.sh
```

Then start pi and run `/reload` (or restart pi).

## Requirements

- `pi`
- `node`
- `python3`, `curl`, `openssl` (Agent Hive skill)
