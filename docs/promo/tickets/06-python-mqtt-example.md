## Problem

The `examples/` directory has TypeScript, Docker, Nginx, and custom-IdP
examples — but nothing for developers who want to consume the
coordinator's MQTT event stream from Python. That excludes a large
chunk of the ML / data-engineering community.

## What to do

Create `examples/python-mqtt/` containing:

- **`subscribe.py`** — connects to the local broker on `tcp://localhost:1883`,
  subscribes to `coordinator/#`, prints each event as
  `topic | json.dumps(payload)` to stdout. Single file, ~50-80 lines,
  well-commented (so a Python dev reading it can understand what each
  step does).
- **`requirements.txt`** — pins `paho-mqtt` to a recent release.
- **`README.md`** — install (`pip install -r requirements.txt`), run
  (`python subscribe.py`), and a "what to expect" section showing
  sample output for an `announce_work` event.

## Acceptance criteria

- [ ] `pip install -r requirements.txt && python subscribe.py` works
      against a running coordinator
- [ ] README shows expected output for at least one event type
- [ ] No coordinator code changes — purely a new example folder
- [ ] Clean shutdown on Ctrl-C (no Python traceback on the terminal)

## Files

- New directory: `examples/python-mqtt/`

## Hints

The list of topics is documented in the main README under "Topic map".
Use `coordinator/#` (with the wildcard) so the script catches every
event. Don't reinvent ACL — the broker accepts anonymous local
connections by default.
