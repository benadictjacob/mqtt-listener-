"""Simulate one battery reporting over MQTT until stopped.

Publishes the synthetic `test_only` JSON envelope (the format the capture worker
stores in Postgres) every few seconds, with readings that drift slightly each
time. It stands in for an LTE module until the real packet decoder exists.

Inside the capture container the broker and login come from the environment:
    python simulate_device.py <imei> [interval_seconds]

From any other machine, point it at a broker with an env file holding
MQTT_BROKER_HOST, MQTT_BROKER_PORT, MQTT_USERNAME and MQTT_PASSWORD:
    python simulate_device.py <imei> [interval_seconds] --env-file .env.live
"""

from __future__ import annotations

import argparse
import json
import os
import random
import signal
import time
from pathlib import Path

import paho.mqtt.client as mqtt


def load_env_file(path: Path) -> None:
    """Fill os.environ from KEY=VALUE lines; real environment variables win."""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulate one battery reporting over MQTT.")
    parser.add_argument("imei", help="15-digit IMEI of a device registered in the app")
    parser.add_argument("interval", nargs="?", type=float, default=3.0, help="seconds between messages")
    parser.add_argument("--env-file", type=Path, help="file with broker host, port and login")
    args = parser.parse_args()
    if not (args.imei.isdigit() and len(args.imei) == 15):
        parser.error("imei must be exactly 15 digits")
    if args.env_file:
        load_env_file(args.env_file)
    imei, interval = args.imei, args.interval
    host = os.environ.get("MQTT_BROKER_HOST", "broker")
    port = int(os.environ.get("MQTT_BROKER_PORT", "1883"))

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"simulator-{imei}",
        protocol=mqtt.MQTTv311,
    )

    def on_connect(_client: mqtt.Client, _userdata: object, _flags: object, reason_code: object, _props: object) -> None:
        if reason_code.is_failure:
            print(f"broker {host}:{port} refused the connection: {reason_code}", flush=True)
        else:
            print(f"connected to {host}:{port}", flush=True)

    client.on_connect = on_connect
    client.username_pw_set(os.environ["MQTT_USERNAME"], os.environ["MQTT_PASSWORD"])
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect(host, port, keepalive=60)
    client.loop_start()

    running = True

    def stop(_signum: int, _frame: object) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    soc, soh, temperature, current = 72.0, 98.0, 27.0, 18.0
    frame = 0
    print(f"simulating IMEI {imei} every {interval}s on devices/{imei}/telemetry", flush=True)
    while running:
        # Discharging slowly: current wanders, SoC falls with it. Temperature is pulled
        # back toward a load-dependent level (~27 °C at 18 A) so it jitters instead of drifting.
        current = clamp(current + random.uniform(-1.5, 1.5), 5.0, 40.0)
        soc = clamp(soc - current * interval / 3600 * 2, 5.0, 100.0)
        settle = 25.0 + current * 0.12
        temperature = clamp(temperature + (settle - temperature) * 0.1 + random.uniform(-0.2, 0.2), 20.0, 44.0)
        voltage = 48.0 + soc * 0.06 - current * 0.02 + random.uniform(-0.05, 0.05)
        frame += 1
        envelope = {
            "test_only": True,
            "imei": imei,
            "frame": frame,
            "telemetry": {
                "voltage": round(voltage, 2),
                "current": round(-current, 2),  # negative = discharge
                "power": round(-voltage * current, 1),
                "soc": round(soc, 2),
                "soh": soh,
                "temperature": round(temperature, 2),
            },
        }
        client.publish(f"devices/{imei}/telemetry", json.dumps(envelope), qos=1)
        print(json.dumps(envelope["telemetry"]), flush=True)
        time.sleep(interval)

    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
