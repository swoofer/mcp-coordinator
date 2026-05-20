# Python MQTT subscriber

This example listens to the coordinator's embedded MQTT broker from Python.
It is useful for data, ML, and automation scripts that want to react to
coordination events without implementing an MCP client.

## Prerequisites

Start a local coordinator:

```bash
mcp-coordinator server start --daemon
```

The default embedded MQTT broker listens on `localhost:1883`.

## Install

```bash
cd examples/python-mqtt
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On Windows PowerShell, activate the virtual environment with:

```powershell
.\.venv\Scripts\Activate.ps1
```

## Run

```bash
python subscribe.py
```

The subscriber connects to `mqtt://localhost:1883`, subscribes to
`coordinator/#`, and prints one line per event:

```text
<topic> | <json payload>
```

Stop it with `Ctrl-C`.

## What to expect

When an agent calls `announce_work`, the coordinator publishes a consultation
event. Depending on the configured organization, the topic includes an org
segment such as `default`:

```text
coordinator/default/consultations/new | {"agent_id": "agent-alpha", "subject": "Update auth docs", "target_modules": ["docs"], "thread_id": "thread-123"}
```

Other common topics include:

```text
coordinator/default/consultations/thread-123/messages | {"agent_id": "agent-beta", "content": "I am touching the same docs.", "type": "context"}
coordinator/default/agents/agent-alpha/status | {"name": "Agent Alpha", "status": "online"}
coordinator/default/quota/update | {"limit": 1000000, "usage": 250000}
```

Use a narrower topic if your script only needs one event class:

```bash
python subscribe.py --topic "coordinator/+/consultations/#"
```
