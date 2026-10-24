"""Capture unknown MQTT topics and payloads without assuming a packet format."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import signal
import sys
import threading
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

import paho.mqtt.client as mqtt


BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "broker")
BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
USERNAME = os.environ["MQTT_CAPTURE_USERNAME"]
PASSWORD = os.environ["MQTT_CAPTURE_PASSWORD"]
CAPTURE_FILE = Path(os.environ.get("CAPTURE_FILE", "/app/captures/messages.jsonl"))
MAX_PREVIEW_BYTES = 512

CAPTURE_FILE.parent.mkdir(parents=True, exist_ok=True)
handler = RotatingFileHandler(
    CAPTURE_FILE,
    maxBytes=10 * 1024 * 1024,
    backupCount=5,
    encoding="utf-8",
)
handler.setFormatter(logging.Formatter("%(message)s"))
logger = logging.getLogger("mqtt_capture")
logger.setLevel(logging.INFO)
logger.addHandler(handler)
logger.addHandler(logging.StreamHandler(sys.stdout))


def identify_payload(payload: bytes) -> tuple[str, str | None]:
    """Label the transport representation; do not decode the vendor packet."""
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return "binary", None

    compact = "".join(text.split())
    if compact and len(compact) % 2 == 0:
        try:
            binascii.unhexlify(compact)
        except (binascii.Error, ValueError):
            pass
        else:
            return "hex_text", text[:MAX_PREVIEW_BYTES]

    return "utf8_text", text[:MAX_PREVIEW_BYTES]


def on_connect(client: mqtt.Client, userdata: object, flags: object, reason_code: object, properties: object) -> None:
    if reason_code.is_failure:
        logger.error(json.dumps({"event": "capture_connect_failed", "reason": str(reason_code)}))
        return

    logger.info(json.dumps({"event": "capture_connected", "broker": f"{BROKER_HOST}:{BROKER_PORT}"}))
    result, _ = client.subscribe("#", qos=0)
    if result != mqtt.MQTT_ERR_SUCCESS:
        logger.error(json.dumps({"event": "subscribe_failed", "error_code": result}))


def on_disconnect(client: mqtt.Client, userdata: object, disconnect_flags: object, reason_code: object, properties: object) -> None:
    logger.warning(json.dumps({"event": "capture_disconnected", "reason": str(reason_code)}))


def on_message(client: mqtt.Client, userdata: object, message: mqtt.MQTTMessage) -> None:
    payload = bytes(message.payload)
    representation, text_preview = identify_payload(payload)
    record = {
        "event": "mqtt_message",
        "received_at": datetime.now(timezone.utc).isoformat(),
        "topic": message.topic,
        "qos": message.qos,
        "retain": bool(message.retain),
        "payload_length": len(payload),
        "payload_representation": representation,
        "payload_base64": base64.b64encode(payload).decode("ascii"),
        "payload_hex": payload.hex(),
    }
    if text_preview is not None:
        record["payload_text_preview"] = text_preview
    logger.info(json.dumps(record, ensure_ascii=True, separators=(",", ":")))


def main() -> None:
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="bms-raw-capture",
        protocol=mqtt.MQTTv311,
        clean_session=True,
    )
    client.username_pw_set(USERNAME, PASSWORD)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        stopping.set()
        client.disconnect()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    logger.info(json.dumps({"event": "capture_starting", "broker": f"{BROKER_HOST}:{BROKER_PORT}"}))
    while not stopping.is_set():
        try:
            client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
            client.loop_forever(retry_first_connection=True)
        except OSError as error:
            if stopping.wait(3):
                break
            logger.warning(json.dumps({"event": "capture_retry", "error": str(error)}))


if __name__ == "__main__":
    main()
