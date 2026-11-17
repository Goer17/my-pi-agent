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

## Models

`models.json` contains only the Bailian provider. If present, `init.sh` copies
it to `$PI_AGENT_DIR/models.json`, replacing the target; an existing file is
backed up as `models.json.bak-<timestamp>` first.

The API key is read from `$BAILIAN_API_KEY` (environment interpolation), so
export it or use `pi`'s `/login` before selecting a Bailian model.

## Requirements

- `pi`
- `node`
- `python3`, `curl`, `openssl` (Agent Hive skill)
