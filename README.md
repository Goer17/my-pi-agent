# my-pi-agent

This is my personal pi configuration: extensions and skills for a new machine.

## Install

```bash
git clone <this-repo> ~/workspace/my-pi-agent
cd ~/workspace/my-pi-agent
./init.sh          # copy into ~/.pi/agent (default)
./init.sh --link   # symlink instead
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
