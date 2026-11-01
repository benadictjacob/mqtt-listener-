#!/bin/sh
# Issue a Let's Encrypt certificate for DOMAIN (from .env) and switch the site
# to HTTPS. Run from the repository root on the server, with ports 80 and 443
# open to the internet:  sh web/enable-https.sh
set -eu

DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
[ -n "$DOMAIN" ] || { echo "Set DOMAIN=... in .env first." >&2; exit 1; }

set_env() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

mkdir -p web/certbot-www web/letsencrypt

# Serve the challenge over plain HTTP first; HTTPS cannot start without a certificate.
set_env WEB_MODE http
docker compose up -d web

docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot -d "$DOMAIN" \
  --agree-tos --register-unsafely-without-email --non-interactive

set_env WEB_MODE https
set_env COMPOSE_PROFILES web,tls
set_env WEB_ORIGIN "https://$DOMAIN"
set_env APP_URL "https://$DOMAIN"
docker compose up -d --force-recreate web api
docker compose up -d certbot

echo "HTTPS is live: https://$DOMAIN"
