#!/usr/bin/env python3
"""Subscribe to mcp-coordinator MQTT events and print them as JSON lines."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import paho.mqtt.client as mqtt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Listen to the mcp-coordinator embedded MQTT broker.",
    )
    parser.add_argument("--host", default="localhost", help="MQTT broker host.")
    parser.add_argument("--port", default=1883, type=int, help="MQTT broker TCP port.")
    parser.add_argument(
        "--topic",
        default="coordinator/#",
        help="MQTT topic filter to subscribe to.",
    )
    parser.add_argument(
        "--client-id",
        default="python-mqtt-subscriber",
        help="Client ID shown to the broker.",
    )
    return parser.parse_args()


def decode_payload(payload: bytes) -> Any:
    text = payload.decode("utf-8", errors="replace")
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def on_connect(
    client: mqtt.Client,
    userdata: dict[str, str],
    _flags: mqtt.ConnectFlags,
    reason_code: mqtt.ReasonCode,
    _properties: mqtt.Properties | None,
) -> None:
    if reason_code.is_failure:
        print(f"MQTT connect failed: {reason_code}", file=sys.stderr)
        return

    topic = userdata["topic"]
    client.subscribe(topic)
    print(f"Subscribed to {topic}", file=sys.stderr)


def on_message(
    _client: mqtt.Client,
    _userdata: dict[str, str],
    message: mqtt.MQTTMessage,
) -> None:
    payload = decode_payload(message.payload)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    print(f"{message.topic} | {encoded}", flush=True)


def main() -> int:
    args = parse_args()
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=args.client_id,
        protocol=mqtt.MQTTv311,
    )
    client.user_data_set({"topic": args.topic})
    client.on_connect = on_connect
    client.on_message = on_message

    try:
        client.connect(args.host, args.port, keepalive=30)
        print(f"Connecting to mqtt://{args.host}:{args.port}", file=sys.stderr)
        client.loop_forever()
    except KeyboardInterrupt:
        print("\nStopping subscriber.", file=sys.stderr)
    except OSError as exc:
        print(
            f"Could not connect to mqtt://{args.host}:{args.port}: {exc}",
            file=sys.stderr,
        )
        return 1
    finally:
        client.disconnect()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
