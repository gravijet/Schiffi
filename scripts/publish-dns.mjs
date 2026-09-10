/**
 * Point the game's hostname at this machine.
 *
 * Reads GAME_HOSTNAME and the Cloudflare credentials from the environment,
 * works out this host's public addresses, and upserts the records through the
 * same client the server uses - including its refusal to touch mail DNS.
 *
 * Nothing is written without --apply: the default is a plan you can read.
 *
 *   node scripts/publish-dns.mjs                 # show the plan
 *   node scripts/publish-dns.mjs --apply         # write it
 *   node scripts/publish-dns.mjs --ip 1.2.3.4    # override the detected IPv4
 */
import { networkInterfaces } from 'node:os';
import config from '../server/src/config.js';
import { openDatabase, closeDatabase } from '../server/src/db/index.js';
import * as cf from '../server/src/services/cloudflare.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const apply = flag('apply');
const hostname = value('hostname') ?? process.env.GAME_HOSTNAME ?? '';
const zoneName = config.cloudflare.zoneName;

if (!hostname) throw new Error('GAME_HOSTNAME is not set and no --hostname was given');
if (!cf.isConfigured()) throw new Error('Cloudflare credentials are not configured');
if (zoneName && hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
  throw new Error(`${hostname} is not inside the configured zone ${zoneName}`);
}

/**
 * This machine's public addresses.
 *
 * The trace endpoint reports whichever family the request went out on, so it
 * settles one of the two; the other is taken from the interfaces, filtered to
 * globally routable addresses. A NAT'd host therefore publishes only the
 * address the outside world actually sees.
 */
function localAddresses() {
  const out = { 4: null, 6: null };
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4' && !out[4] && isGlobalV4(entry.address)) out[4] = entry.address;
      if (entry.family === 'IPv6' && !out[6] && isGlobalV6(entry.address)) out[6] = entry.address;
    }
  }
  return out;
}

const isGlobalV4 = (ip) =>
  !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
// Global unicast is 2000::/3; everything else is link-local, ULA or special.
const isGlobalV6 = (ip) => /^[23]/.test(ip) && !ip.startsWith('2002:');

async function tracedAddress() {
  try {
    const response = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) });
    const line = (await response.text()).split('\n').find((l) => l.startsWith('ip='));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}

const traced = await tracedAddress();
const local = localAddresses();
const detected = {
  4: traced && traced.includes('.') ? traced : local[4],
  6: traced && traced.includes(':') ? traced : local[6],
};

const ipv4 = value('ip') ?? detected[4];
const ipv6 = flag('no-ipv6') ? null : (value('ip6') ?? detected[6]);
if (!ipv4 && !ipv6) throw new Error('could not determine this machine\'s public address; pass --ip');

const isApex = hostname === zoneName;
const plan = [];
if (ipv4) plan.push({ type: 'A', name: hostname, content: ipv4, proxied: true });
if (ipv6) plan.push({ type: 'AAAA', name: hostname, content: ipv6, proxied: true });
if (isApex) plan.push({ type: 'CNAME', name: `www.${hostname}`, content: hostname, proxied: true });

console.log(`zone ${zoneName} (${config.cloudflare.zoneId})`);
for (const record of plan) {
  console.log(`  ${record.type.padEnd(5)} ${record.name} -> ${record.content}  proxied=${record.proxied}`);
}

if (!apply) {
  console.log('\nplan only - pass --apply to write it');
  process.exit(0);
}

// The audit trail lives in the database, so open it before writing anything.
await openDatabase();
try {
  for (const record of plan) {
    const result = await cf.upsertDnsRecord(record, { actor: { ip: 'cli' } });
    console.log(`${result.changed ? 'wrote  ' : 'already'} ${record.type} ${record.name}`);
  }
} finally {
  await closeDatabase();
}
