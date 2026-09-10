#!/usr/bin/env bash
#
# Refresh the two nginx files that depend on Cloudflare's published IP ranges:
#
#   snippets/cloudflare-real-ip.conf     - restores the visitor's real address
#   conf.d/cloudflare-origin-guard.conf  - refuses anything not from the edge
#
# Cloudflare changes these ranges rarely, but a stale list has two failure
# modes and both are bad: a *removed* range keeps a hole open, and an *added*
# range makes the edge look like an attacker and takes the site down. Run this
# after a Cloudflare announcement, or from cron a few times a year.
#
# It refuses to install a list it could not fetch or that came back suspiciously
# short, because writing an empty allow-list here means a total outage.
#
# Usage: sudo scripts/refresh-cloudflare-ips.sh
set -euo pipefail

SNIPPETS=/etc/nginx/snippets
CONFD=/etc/nginx/conf.d
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 -o "$WORK/v4"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 -o "$WORK/v6"

v4=$(grep -c '[0-9]' "$WORK/v4" || true)
v6=$(grep -c '[0-9]' "$WORK/v6" || true)
if [ "$v4" -lt 8 ] || [ "$v6" -lt 4 ]; then
  echo "refusing to install: got $v4 IPv4 and $v6 IPv6 ranges, which is too few to be real" >&2
  exit 1
fi

stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  echo "# Cloudflare edge IP ranges -> restore real visitor IP."
  echo "# Generated $stamp from cloudflare.com/ips-v4 + ips-v6."
  grep '[0-9]' "$WORK/v4" | sed 's/^/set_real_ip_from /; s/$/;/'
  grep '[0-9]' "$WORK/v6" | sed 's/^/set_real_ip_from /; s/$/;/'
  echo "real_ip_header CF-Connecting-IP;"
} > "$WORK/cloudflare-real-ip.conf"

{
  echo "# Which connections actually came from Cloudflare."
  echo "#"
  echo "# Tests \$realip_remote_addr, not \$remote_addr: the real_ip module runs"
  echo "# before the access phase, so \$remote_addr is already the visitor's own"
  echo "# address by then and an allow-list checked against it would lock out"
  echo "# every real player."
  echo "#"
  echo "# Generated $stamp from cloudflare.com/ips-v4 + ips-v6."
  echo ""
  echo "geo \$realip_remote_addr \$schiffi_from_cloudflare {"
  echo "    default 0;"
  echo "    127.0.0.1 1;   # local health checks and deploy scripts"
  echo "    ::1       1;"
  grep '[0-9]' "$WORK/v4" | sed 's/^/    /; s/$/ 1;/'
  grep '[0-9]' "$WORK/v6" | sed 's/^/    /; s/$/ 1;/'
  echo "}"
} > "$WORK/cloudflare-origin-guard.conf"

# Keep the old files: nginx -t passing is not the same as the site still being
# reachable, and a rollback should not need a second download.
for f in "$SNIPPETS/cloudflare-real-ip.conf" "$CONFD/cloudflare-origin-guard.conf"; do
  [ -f "$f" ] && cp -a "$f" "$f.bak"
done

cp "$WORK/cloudflare-real-ip.conf" "$SNIPPETS/cloudflare-real-ip.conf"
cp "$WORK/cloudflare-origin-guard.conf" "$CONFD/cloudflare-origin-guard.conf"

if ! nginx -t; then
  echo "nginx rejected the new configuration - rolling back" >&2
  for f in "$SNIPPETS/cloudflare-real-ip.conf" "$CONFD/cloudflare-origin-guard.conf"; do
    [ -f "$f.bak" ] && mv "$f.bak" "$f"
  done
  exit 1
fi

systemctl reload nginx
echo "installed $v4 IPv4 and $v6 IPv6 ranges, nginx reloaded"
