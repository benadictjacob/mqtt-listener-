"""Publish explicitly synthetic examples to exercise raw MQTT capture."""

from __future__ import annotations

import json
import os
import time

import paho.mqtt.client as mqtt


BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "broker")
BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
USERNAME = os.environ["MQTT_USERNAME"]
PASSWORD = os.environ["MQTT_PASSWORD"]

# Example Rack Status 1 extended CAN ID derived from the workbook's fields:
# priority 2, group 9, rack 0, module 0, message index 0, source node 3.
CAN_ID = 0x09200003

# Synthetic test frame only. It exercises the ingestion path, not vendor decoding.
CAN_DATA = bytes.fromhex("00 14 00 80 57 62 00 14")


def main() -> None:
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"synthetic-can-probe-{int(time.time())}",
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(USERNAME, PASSWORD)
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
    client.loop_start()

    base_topic = f"devices/359881234567890/telemetry"
    samples = [
        (
            f"{base_topic}/json",
            json.dumps(
                {
                    "test_only": True,
                    "imei": "359881234567890",
                    "can_id": f"0x{CAN_ID:08X}",
                    "dlc": len(CAN_DATA),
                    "data_hex": CAN_DATA.hex(),
                    "note": "Synthetic probe envelope; not the vendor's packet wrapper.",
                    "telemetry": {"voltage": 512.0, "current": 0.0, "power": 0.0, "soc": 87.0, "soh": 98.0, "temperature": 25.0},
                },
                separators=(",", ":"),
            ).encode("utf-8"),
        ),
        (f"{base_topic}/binary", CAN_DATA),
        (f"{base_topic}/hex", CAN_DATA.hex().encode("ascii")),
    ]

    try:
        for topic, payload in samples:
            info = client.publish(topic, payload, qos=0, retain=False)
            info.wait_for_publish(timeout=10)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                raise RuntimeError(f"Publish failed for {topic}: rc={info.rc}")
            print(f"published {topic}: {len(payload)} bytes")
    finally:
        client.disconnect()
        client.loop_stop()


if __name__ == "__main__":
    main()
