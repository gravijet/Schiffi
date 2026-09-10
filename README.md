# Schiffi

A 2D online game of trade, exploration and seafaring. One large procedural sea,
a thousand tradable commodities, a server-authoritative simulation and nine
language variants.

The map owns the screen; the interface is a set of compact panels that float
over it. Everything the interface shows is connected to a real backend — there
are no placeholder buttons, no fabricated statistics and no mock multiplayer.

## Requirements

- Node.js **22.5 or newer** (the bundled `node:sqlite` driver is the zero-setup
  database fallback)
- PostgreSQL 14+ for production (optional in development)

## Getting started

```bash
npm install
cp .env.example .env          # then fill in SESSION_SECRET
npm run dev                   # client on :5173, API on :8080
```

On the first start the server generates a world, seeds ~20 000 market rows and
begins simulating. The first account that registers becomes the **owner**; there
is no default password anywhere.

For a production-style run:

```bash
npm run build                 # bundles the client into client/dist
npm start                     # one process serves API, WebSocket and client
```

## Configuration

All configuration is environment based; see `.env.example` for the full list.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Empty → SQLite at `SQLITE_PATH`. |
| `SESSION_SECRET` | Required in production; at least 32 characters. |
| `SMTP_HOST` … | Real SMTP delivery. Empty → messages are written to `data/mail/*.eml`. |
| `WORLD_TICK_HZ` | Simulation rate (default 20). |
| `NET_SNAPSHOT_HZ` | Snapshot rate per client (default 10). |
| `CLOUDFLARE_*` | Optional DNS integration. Prefer a scoped API token over the Global API Key. |

`npm run migrate` applies pending migrations; the server also does this on boot.

## Architecture

```
shared/    deterministic game data and rules used by both sides
  world/     terrain, islands, ports, regions, name generation
  data/      1000 goods, ships, crew, factions
  i18n/      nine language variants, plural rules, morphology
  net/       wire protocol
server/    Node, no web framework
  db/        portable layer over PostgreSQL and SQLite
  services/  auth (Argon2id), RBAC, audit, mail, Cloudflare
  game/      world instances, economy, simulation, NPCs, weather, actions
  ws/        WebSocket gateway, chat, action dispatch
client/    Vite, vanilla JS, Canvas 2D
  render/    map renderer, terrain decoding, palette
  ui/        menu, in-game panels, administration, settings
  state/     settings with hardware detection, i18n runtime
```

### The world

A world is generated from a single 32-bit seed and is reproducible: the same
seed always produces the same land. Landmasses are *placed* — continents, large
islands, archipelago chains, lone rocks — and then shaped by noise, because
pure noise yields one mega-continent surrounded by pixel speckle. Sea level and
the land elevation distribution are calibrated per seed, and ocean depth
follows a distance field, which is what gives every island a shelf.

The server generates the world once and serves the terrain grid as a compressed
blob (655 KiB → ~44 KiB Brotli). The client decodes it into a single image and
draws the whole map with one `drawImage`.

### Server authority

The client sends *intent*: a direction vector, or a request to buy twelve units
of a good. It never sends a price, a balance or a result. Every action that
moves coins, cargo or progress runs inside one database transaction on values
the server computed itself. Movement is integrated server-side against the
terrain, so speed and collision are not client decisions.

### Passwords

Logins are checked against an Argon2id hash and nothing else. The hash is
one-way and stays that way.

This installation additionally keeps a **recoverable copy** of each password,
because the operator requires a "show password" function in the superadmin
console. The copy is encrypted with AES-256-GCM under `PASSWORD_VAULT_KEY`,
which lives in the environment and never in the database, and is readable only
through `POST /api/admin/users/:id/password/reveal` behind the
`users.password_reveal` permission. Every call is written to the audit log
before the value is returned.

What that costs, stated plainly rather than buried:

- anyone holding **both** the key and a database dump holds every password
  stored since the key was configured;
- a password reused elsewhere is exposed elsewhere too;
- passwords set **before** the key existed can never be shown — Argon2id
  cannot be reversed — so `revealPassword` reports `notStored` for them until
  the account's next password change.

Leave `PASSWORD_VAULT_KEY` empty and none of this happens: no copy is written,
the reveal endpoint answers `vaultDisabled`, and the Argon2id hash is all there
is. `GET /api/admin/users/:id/security` reports `passwordReadable` per account,
which is the truth for that account rather than a blanket claim.

Roles are data, not code: an administrator with `roles.create` composes new
roles at runtime from a fixed catalogue of granular permissions. A *superadmin*
is simply an account whose role carries the `*` wildcard; the console for it
lives at `/superadmin`.

### Performance

Performance is treated as a feature, not an afterthought:

- one pre-built terrain bitmap; drawing the world costs a single `drawImage`
- viewport culling and a uniform spatial index for ports, ships and storms
- the backbuffer is scaled by `resolutionScale`, so the setting really changes
  fill cost
- the frame limiter skips frames instead of rendering and discarding them
- entity interpolation renders 120 ms in the past, turning 10 snapshots per
  second into smooth motion at any frame rate
- long lists are virtualised; locales and game data are separate cacheable chunks
- **Automatic** graphics quality runs a short canvas benchmark on the actual
  device rather than guessing from the user agent

### Languages

Deutsch, English, Italiano, Français, 简体中文 and Русский are hand written.
Altdeutsch, Tirolerisch and Piratensprache are stylised variants of German,
derived by rule from the German catalogue plus explicit overrides, so a newly
added string is never left untranslated. Commodity names agree with the noun in
Italian, French and Russian rather than being pasted together.

## Tests

```bash
npm test              # 39 unit and end-to-end tests (shared + server)
npm run test:browser  # 13 tests driving the real client in headless Chromium
npm run test:all
```

The end-to-end suite boots the real server against a throwaway database and
drives it over HTTP and WebSocket. The browser suite checks what only a browser
can: the canvas actually painting, terrain decoding, a language switch
re-rendering a running session, and a code redemption moving the coin counter.

## Content and assets

All content is original to this project: the terrain palette, the interface
design, the name generators, the commodity catalogue and its translations. No
third-party artwork, logos, text or code has been copied in.
