# Deployment

Schiffi runs at **https://superdavid.eu** on this machine (`45.141.116.154`,
`2a14:6781:1800::119`).

```
browser ──TLS──▶ Cloudflare (proxied) ──TLS──▶ nginx :443 ──▶ node :8080
                                                              │
                                                              └─▶ PostgreSQL
```

Nothing but nginx is exposed: the game server binds `127.0.0.1:8080`.

## Pieces

| What | Where |
| --- | --- |
| Service | `/etc/systemd/system/schiffi.service` (user `schiffi`) |
| Environment | `/etc/schiffi/schiffi.env` (`root:schiffi`, mode 640) |
| nginx vhost | `/etc/nginx/sites-available/superdavid.eu` |
| Certificate | Let's Encrypt, `superdavid.eu` + `www.superdavid.eu`, renewed by certbot |
| Database | PostgreSQL 15, database `schiffi`, role `schiffi` |
| Backups | `schiffi-backup.timer`, nightly `pg_dump` to `/var/backups/schiffi`, kept 14 days |
| Uploads and mail spool | `/home/benj/Schiffi/data` (owned by `schiffi`, group-writable) |

The environment file is the only place production secrets live. The
repository's own `.env` is for development and is deliberately unreadable to
the service account - the server logs that it skipped it and carries on.

## Deploying a change

```sh
git pull
npm ci
npm run build              # writes client/dist, which the server serves
sudo systemctl restart schiffi
```

Migrations run themselves at boot. A migration that has already been applied
may never be edited; add a new file instead.

## Tests

```sh
npm run test:all                                  # SQLite, the default
TEST_DATABASE_URL=postgres://…/schiffi_test npm run test:all   # PostgreSQL
```

Both dialects run the same 88 tests. The PostgreSQL run needs a throwaway
database: each suite drops and recreates its own schema inside it.

## DNS

`scripts/publish-dns.mjs` points `GAME_HOSTNAME` at this machine through the
Cloudflare API. It prints a plan and writes nothing without `--apply`.

```sh
node scripts/publish-dns.mjs            # show
node scripts/publish-dns.mjs --apply    # write
```

Mail DNS is refused by the client itself: MX records, SPF, DKIM, DMARC and
MTA-STS can only be touched by passing `allowMailRecords` explicitly, and
Cloudflare Email Routing is read-only, because enabling it rewrites a zone's
MX records.

## Known gaps

- **No SMTP relay.** `SMTP_HOST` is empty, so verification, password-reset and
  notification mail is written to `data/mail/*.eml` instead of being sent.
  Nothing in the game is gated on a verified address, so play is unaffected -
  but a player who forgets their password cannot currently recover it. Set
  `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to fix that.
  Note that `superdavid.eu` currently publishes `v=spf1 -all` and a null MX
  (`MX 0 .`), which say the domain neither sends nor receives mail; sending
  from it needs those records changed first.
- **Cloudflare SSL mode is "Full", not "Full (strict)".** The edge does not
  verify this origin's certificate. The certificate is a real Let's Encrypt
  one, so switching the zone to strict would work - it is a zone-wide setting
  and also affects `ai.superdavid.eu`.
- **The first account to register becomes the owner** (`ownerCount() === 0` in
  `services/auth.js`). The database is empty, so register before announcing
  the address.
