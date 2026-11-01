"""Simulate one battery reporting over MQTT until stopped.

Publishes the synthetic `test_only` JSON envelope (the format the capture worker
stores in Postgres) every few seconds, with readings that drift slightly each
time. It stands in for an LTE module until the real packet decoder exists.

Usage: python simulate_device.py <imei> [interval_seconds]
"""

from __future__ import annotations

import json
import os
import random
import signal
import sys
import time

import paho.mqtt.client as mqtt


BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "broker")
BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].isdigit() or len(sys.argv[1]) != 15:
        sys.exit("usage: simulate_device.py <15-digit imei> [interval_seconds]")
    imei = sys.argv[1]
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"simulator-{imei}",
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(os.environ["MQTT_USERNAME"], os.environ["MQTT_PASSWORD"])
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
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
