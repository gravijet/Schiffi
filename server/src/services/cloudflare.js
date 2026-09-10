/**
 * Cloudflare API client.
 *
 * Used for DNS records belonging to the game (a play. or api. hostname) and
 * for reading zone state.  Credentials come from the environment only.
 *
 * Two deliberate restrictions:
 *   - a scoped API token is preferred over the account-wide Global API Key;
 *     the key works, but it can do everything, including billing
 *   - mail-related DNS (MX, SPF, DKIM, DMARC, MTA-STS) is refused by default.
 *     Enabling Cloudflare Email Routing rewrites MX records, which would take
 *     an existing mail setup offline. `allowMailRecords` must be passed
 *     explicitly to touch those.
 */
import config from '../config.js';

const API = 'https://api.cloudflare.com/client/v4';

const MAIL_RECORD_NAMES = /^(_dmarc|_domainkey|dkim\._domainkey|_mta-sts|mta-sts|_smtp\._tls|autoconfig|autodiscover)\./i;
const MAIL_RECORD_TYPES = new Set(['MX']);

export class CloudflareError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'CloudflareError';
    this.errors = errors;
  }
}

function authHeaders() {
  const { apiToken, authEmail, globalKey } = config.cloudflare;
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  if (authEmail && globalKey) return { 'X-Auth-Email': authEmail, 'X-Auth-Key': globalKey };
  throw new CloudflareError('Cloudflare credentials are not configured');
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const messages = (payload.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new CloudflareError(messages || `HTTP ${response.status}`, payload.errors ?? []);
  }
  return payload.result;
}

export const isConfigured = () => config.cloudflare.configured;

/** Whether the credentials work, and which auth method is in use. */
export async function verify() {
  const usingToken = Boolean(config.cloudflare.apiToken);
  const zones = await request('/zones?per_page=50');
  return {
    ok: true,
    authMethod: usingToken ? 'scoped-token' : 'global-key',
    warning: usingToken ? null
      : 'Using the account-wide Global API Key. A scoped API token limited to ' +
        'Zone:DNS:Edit for this zone would reduce the blast radius of a leak.',
    zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
  };
}

export async function listDnsRecords({ zoneId = config.cloudflare.zoneId, type } = {}) {
  const query = new URLSearchParams({ per_page: '200' });
  if (type) query.set('type', type);
  const records = await request(`/zones/${zoneId}/dns_records?${query}`);
  return records.map((r) => ({
    id: r.id, type: r.type, name: r.name, content: r.content,
    ttl: r.ttl, proxied: r.proxied, priority: r.priority,
  }));
}

function assertSafeRecord(record, allowMailRecords) {
  if (allowMailRecords) return;
  if (MAIL_RECORD_TYPES.has(record.type) || MAIL_RECORD_NAMES.test(`${record.name}.`)) {
    throw new CloudflareError(
      `refusing to modify the mail record ${record.type} ${record.name}: ` +
      'changing it can take inbound mail for the whole domain offline. ' +
      'Pass allowMailRecords: true if that is genuinely intended.');
  }
  if (record.type === 'TXT' && /^v=(spf1|DKIM1|DMARC1|STSv1|TLSRPTv1)/i.test(record.content ?? '')) {
    throw new CloudflareError(
      'refusing to modify a mail policy TXT record (SPF/DKIM/DMARC/MTA-STS) without allowMailRecords');
  }
}

/**
 * Create or update an A/AAAA/CNAME/TXT record.
 * Matching is by (type, name), so calling it twice is idempotent.
 */
export async function upsertDnsRecord(record, { zoneId = config.cloudflare.zoneId, allowMailRecords = false, actor } = {}) {
  assertSafeRecord(record, allowMailRecords);

  const existing = (await listDnsRecords({ zoneId }))
    .find((r) => r.type === record.type && r.name === record.name);

  const payload = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 1,             // 1 = automatic
    proxied: record.proxied ?? false,
  };
  if (record.priority !== undefined) payload.priority = record.priority;

  let result;
  if (existing) {
    if (existing.content === payload.content && existing.proxied === payload.proxied) {
      return { changed: false, id: existing.id, ...existing };
    }
    assertSafeRecord(existing, allowMailRecords);
    result = await request(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PUT', body: payload });
  } else {
    result = await request(`/zones/${zoneId}/dns_records`, { method: 'POST', body: payload });
  }

  return { changed: true, id: result.id, type: result.type, name: result.name, content: result.content };
}

export async function deleteDnsRecord(recordId, { zoneId = config.cloudflare.zoneId, allowMailRecords = false, actor } = {}) {
  const records = await listDnsRecords({ zoneId });
  const record = records.find((r) => r.id === recordId);
  if (!record) throw new CloudflareError('record not found');
  assertSafeRecord(record, allowMailRecords);
  await request(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  return { deleted: true };
}

/**
 * Email Routing status.  Read-only on purpose: enabling routing replaces the
 * zone's MX records, so that decision belongs to a human with the full picture.
 */
export async function emailRoutingStatus({ zoneId = config.cloudflare.zoneId } = {}) {
  const settings = await request(`/zones/${zoneId}/email/routing`);
  const mx = await listDnsRecords({ zoneId, type: 'MX' });
  return {
    enabled: settings.enabled,
    status: settings.status,
    name: settings.name,
    currentMx: mx.map((r) => ({ name: r.name, content: r.content, priority: r.priority })),
    note: settings.enabled
      ? 'Cloudflare Email Routing is active for this zone.'
      : 'Email Routing is not enabled. Enabling it would replace the MX records listed above, ' +
        'which would break inbound mail for the current provider. Cloudflare also cannot send ' +
        'outbound mail: transactional e-mail needs an SMTP provider (SMTP_HOST in .env).',
  };
}

/** Point a hostname at this server. Used to publish the game under a subdomain. */
export async function publishGameHostname({ hostname, ip, proxied = true, actor } = {}) {
  const name = hostname ?? process.env.GAME_HOSTNAME;
  if (!name) throw new CloudflareError('no hostname given and GAME_HOSTNAME is not set');
  if (!ip) throw new CloudflareError('no target IP given');
  const type = ip.includes(':') ? 'AAAA' : 'A';
  return upsertDnsRecord({ type, name, content: ip, proxied }, { actor });
}
