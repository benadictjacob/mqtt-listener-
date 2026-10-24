# BMS MQTT ingestion probe

Standalone MQTT broker and raw-message capture service for onboarding and testing BMS LTE units. It is independent of the BMS monitoring frontend: the broker accepts MQTT publications, and the capture worker records the original topic and bytes as JSON Lines. It does not yet decode the provider packet or write to the BMS database.

## Message path

```text
BMS + LTE unit → MQTT broker (Mosquitto) → raw capture worker → captures/messages.jsonl
```

## Run locally

```sh
cp .env.example .env
```

Edit `.env` and set long, unique values for `MQTT_PASSWORD` and `MQTT_CAPTURE_PASSWORD`. Then start the service:

```sh
docker compose up --build -d
docker compose ps
```

The broker is bound to `127.0.0.1:1883` by default, so it is reachable only from this machine. `MQTT_USERNAME` and `MQTT_PASSWORD` are for a test publisher/LTE unit. The `MQTT_CAPTURE_*` credentials are internal to the capture worker; never enter those on the LTE unit.

Publish the synthetic examples and inspect the capture:

```sh
docker compose exec capture python publish_can_probe.py
docker compose logs --since=2m capture
tail -n 10 captures/messages.jsonl
```

The synthetic CAN examples exercise JSON, binary and hex-text payload capture. They are not vendor packets and do not validate the provider's decoder.

## Put this in a GitHub repository

Create an empty GitHub repository, then from this directory:

```sh
git init -b main
git add .
git status --short
```

Before committing, confirm `.env`, `captures/` and `mosquitto-data/` are absent from the staged files. They contain credentials or captured data and are ignored by `.gitignore`.

```sh
git commit -m "Initial standalone MQTT ingestion service"
git remote add origin <your-github-repository-url>
git push -u origin main
```

## Deploy on an Ubuntu EC2 server

1. **Confirm the LTE connection requirements with the provider first.** Ask for MQTT version, TLS support and port, broker hostname/IP fields, authentication format, topic format, QoS, keepalive, reconnect behavior, payload representation, and whether the LTE network has a fixed public source IP or private APN. Also confirm whether the module verifies the broker certificate. The current service configuration is plaintext MQTT on port 1883; credentials and battery data are not encrypted on that connection.
2. Create or select an EC2 instance and attach a security group. Keep SSH (22) restricted to your own IP. Do not open MQTT/1883 to `0.0.0.0/0`. If the provider supplies a fixed source IP, allow only that address for the pilot; otherwise, configure TLS before accepting traffic over the public internet. AWS security groups can restrict inbound rules by source IP: [AWS security group rules](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html).
3. Install Docker Engine and the Compose plugin using Docker's official Ubuntu instructions: [Docker Engine](https://docs.docker.com/engine/install/ubuntu/) and [Compose plugin](https://docs.docker.com/compose/install/linux/). Verify with `docker --version` and `docker compose version`.
4. Clone the GitHub repository and create server-only credentials:

   ```sh
   git clone <your-github-repository-url> bms-mqtt-ingestion
   cd bms-mqtt-ingestion
   cp .env.example .env
   nano .env
   chmod 600 .env
   ```

   Set strong, unique credentials. Set `MQTT_BIND_ADDRESS=0.0.0.0` only when you have configured the security group for the agreed source and connection method. The public endpoint is the EC2 Elastic IP or a DNS name pointing to it; the LTE unit uses that endpoint, port `1883`, and the test-device account. Do not use `127.0.0.1` on the LTE unit.
5. Start it as a persistent Docker service:

   ```sh
   docker compose up --build -d
   docker compose ps
   docker compose logs --tail=100 broker capture
   ```

   Both containers have a restart policy, so Docker restarts them after a server reboot. Captures and broker persistence live in local ignored directories. Set up a backup/retention policy before using real customer traffic.
6. Test from the server before connecting the LTE unit:

   ```sh
   docker compose exec capture python publish_can_probe.py
   docker compose logs --since=2m capture
   tail -n 10 captures/messages.jsonl
   ```

   Then configure the LTE unit with the public DNS/IP, agreed port, MQTT username/password, topic, and TLS setting. Watch for its connection in `docker compose logs -f broker capture`; incoming publications should appear in `captures/messages.jsonl` with topic, byte length, base64, and hex. The capture worker subscribes to `#`, so it can reveal the device's topic layout.

## Day-to-day commands

```sh
docker compose logs -f broker capture  # live service logs
docker compose ps                      # container state
docker compose restart                 # restart both containers
docker compose down                    # stop containers; data directories remain
```

Raw captures may include IMEI, GPS and battery telemetry. Treat them as sensitive customer data. The broker logs may show publisher client IDs and source addresses; neither should be assumed to be the BMS identity. The packet IMEI is the expected device identity after the provider framing is validated.

## Decoder boundary

This service stores payload bytes without guessing whether the provider sends binary, UTF-8, or hex text. Decode only after confirming the MQTT payload representation, packet framing, packet length discrepancy, CRC, byte/bit order, and CAN map with the provider. Once confirmed, a decoder can be added here or integrated with the BMS backend as a separate downstream component.
