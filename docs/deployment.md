# Deployment

Schiffi runs at **https://superdavid.eu** on this machine (`45.141.116.154`,
`2a14:6781:1800::119`).

```
browser ──TLS──▶ Cloudflare (proxied) ──TLS──▶ nginx :443 ──▶ node :8080
                                                              │
                                                              └─▶ PostgreSQL
```

Nothing but nginx is exposed: the game server binds `127.0.0.1:8080`, and
nginx answers port 443 only for connections that came from Cloudflare.

## The edge is not optional

An origin address is discoverable from historical DNS, so a proxied zone by
itself protects nothing: anyone with the IP can connect straight to nginx and
skip every WAF rule, the rate limit and the bot check. Two files close that:

| File | Job |
| --- | --- |
| `/etc/nginx/snippets/cloudflare-real-ip.conf` | restore the visitor's address from `CF-Connecting-IP` |
| `/etc/nginx/conf.d/cloudflare-origin-guard.conf` | `geo` map deciding whether a connection came from the edge |

The vhost then answers `444` (close without a response) to anything else.

The guard tests `$realip_remote_addr`, **not** `$remote_addr`. The real_ip
module runs in the preaccess phase, so by the time an access rule is evaluated
`$remote_addr` has already been rewritten to the visitor's own address - an
allow-list of Cloudflare ranges checked against it would lock out every player
and leave only the edge itself able to connect. `$realip_remote_addr` keeps the
peer that actually opened the socket.

Port 80 is deliberately left open to everyone: certbot's ACME challenge has to
be reachable directly or the certificate stops renewing.

Refresh the ranges after a Cloudflare announcement:

```sh
sudo scripts/refresh-cloudflare-ips.sh   # fetches, validates, tests, reloads
```

It refuses to install a list that came back short, and rolls back if
`nginx -t` fails - an empty allow-list here is a total outage.

### Zero Trust on /superadmin

The superadmin console is additionally behind a Cloudflare Access application,
so the request is challenged at the edge before it reaches this machine.

| | |
| --- | --- |
| Application | `superdavid.eu/superadmin`, self-hosted |
| Policy | allow, e-mail equals `hi@benjaminberger.at` |
| Identity provider | one-time PIN |
| Session | 8 hours, auto-redirect to identity |
| AUD tag | `3cf359e08294f23de15f05fd5ab5ee8ee189f521dbec44df9e9c9bb0c896d297` |

Anything else on the zone is untouched: `/` and `/api/*` stay open. This is a
second lock, not the only one - the server checks `SUPERADMIN_EMAIL` against
the session on every request behind that path and answers 404 to everyone
else, so bypassing the edge gains nothing.

### What is configured at the edge

| Setting | Value |
| --- | --- |
| SSL mode | Full |
| Always Use HTTPS | on |
| Minimum TLS | 1.2 |
| Managed WAF | Cloudflare Managed Free Ruleset, deployed |
| Bot Fight Mode | on |
| Rate limit | `/api/auth/login`, `/api/auth/register`, `/api/auth/password/reset` — 8 requests / 10 s per IP |
| Custom rules | block common scanner paths; managed challenge on registration above threat score 14 |

The Free plan caps a rate-limiting rule at a 10-second window and a 10-second
block, so that rule slows a brute force down rather than stopping it. The
server's own `login_attempts` throttle is what actually holds the line; the
edge rule is there to keep the volume off the origin.

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

Both dialects run the same 77 server tests; 27 more run in a real browser. The PostgreSQL run needs a throwaway
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
- **There is no audit trail.** It was removed on the operator's instruction,
  along with the `audit_log` table (migration `008`). Administrative actions -
  bans, deletions, role changes, password reads - now leave no record of who
  performed them.
- **`PASSWORD_VAULT_KEY` is set on this host**, so the superadmin console can
  display a stored password. See the *Passwords* section of the README for what
  that costs. Accounts whose password predates the key report `notStored` and
  stay unreadable until their next password change - Argon2id cannot be
  reversed. Back this key up separately from the database, and never in the
  same place: together they are every password on the server. The nightly
  `pg_dump` lands in `/var/backups/schiffi`, so that is precisely where the key
  must not go.
- **The Cloudflare credentials in `/etc/schiffi/schiffi.env` are a Global API
  Key.** It authorises the whole account, not just this zone, and cannot be
  scoped. Replace it with a scoped API token (`CLOUDFLARE_API_TOKEN`) limited
  to `superdavid.eu`; the client already prefers a token when one is set.
