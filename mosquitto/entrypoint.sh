#!/bin/sh
set -eu

require_value() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ] || [ "$value" = "replace-with-a-long-random-password" ] || [ "$value" = "replace-with-another-long-random-password" ]; then
    echo "Set $name in .env before starting the broker." >&2
    exit 1
  fi
}

require_value MQTT_USERNAME
require_value MQTT_PASSWORD
require_value MQTT_CAPTURE_USERNAME
require_value MQTT_CAPTURE_PASSWORD

case "${MQTT_USERNAME}${MQTT_CAPTURE_USERNAME}" in
  *[!A-Za-z0-9_.-]*) echo "MQTT usernames may contain only letters, digits, dot, underscore, and hyphen." >&2; exit 1 ;;
esac

if [ "$MQTT_USERNAME" = "$MQTT_CAPTURE_USERNAME" ]; then
  echo "MQTT_USERNAME and MQTT_CAPTURE_USERNAME must be different." >&2
  exit 1
fi

mkdir -p /mosquitto/data
# These credentials are generated from .env on each container start. Remove the
# previous hash file first because mosquitto_passwd -c refuses to overwrite it.
rm -f /mosquitto/data/passwords
mosquitto_passwd -b -c /mosquitto/data/passwords "$MQTT_USERNAME" "$MQTT_PASSWORD"
mosquitto_passwd -b /mosquitto/data/passwords "$MQTT_CAPTURE_USERNAME" "$MQTT_CAPTURE_PASSWORD"
chmod 600 /mosquitto/data/passwords

{
  printf 'user %s\ntopic write #\n' "$MQTT_USERNAME"
  printf 'user %s\ntopic read #\n' "$MQTT_CAPTURE_USERNAME"
} > /mosquitto/data/acl
chmod 600 /mosquitto/data/acl

exec mosquitto -c /mosquitto/config/mosquitto.conf
