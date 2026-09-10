/**
 * HTTP front end.
 *
 * Built on node:http directly: the surface we need is small (JSON APIs,
 * static files, one WebSocket upgrade) and every dependency is one more thing
 * that has to be trusted with session cookies.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, resolve, normalize, join } from 'node:path';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Router } from './router.js';
import { json, sendError, HttpError, badRequest, unauthorized } from './respond.js';
import { resolveSession } from '../services/auth.js';
import { can } from '../services/rbac.js';
import config from '../config.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|wasm)|image\/svg)/;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB; avatar uploads use their own path

export class HttpServer {
  constructor({ staticRoot } = {}) {
    this.router = new Router();
    this.staticRoot = staticRoot;
    this.server = createServer((req, res) => this.handle(req, res));
    this.upgradeHandler = null;
    this.server.on('upgrade', (req, socket, head) => {
      if (this.upgradeHandler) this.upgradeHandler(req, socket, head);
      else socket.destroy();
    });
  }

  onUpgrade(fn) { this.upgradeHandler = fn; }

  /**
   * Resolves with the bound address.  A listen error (EADDRINUSE, EACCES) must
   * reject rather than hang: a promise that never settles turns a port clash
   * into an unexplained freeze at boot.
   */
  listen(port, host) {
    return new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolvePromise(this.server.address());
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
  }

  /** The port actually bound (useful when listening on port 0). */
  get port() {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : null;
  }

  close() {
    return new Promise((res) => this.server.close(res));
  }

  async handle(req, res) {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendError(res, new HttpError(400, 'error.validation', 'bad url'));
    }

    // Security headers on every response, including static files.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    try {
      const match = this.router.match(req.method, url.pathname);

      if (match?.methodNotAllowed) {
        return json(res, 405, { error: true, code: 'error.notFound', message: 'method not allowed' });
      }

      if (match) {
        const ctx = await this.buildContext(req, res, url, match);
        if (match.options.auth !== false) {
          if (!ctx.user) throw unauthorized();
        }
        if (match.options.permission) {
          if (!ctx.user || !(await can(ctx.user.id, match.options.permission))) {
            throw new HttpError(403, 'error.forbidden');
          }
        }
        const result = await match.handler(ctx);
        if (result !== undefined && !res.writableEnded) json(res, 200, result);
        return;
      }

      // The single-page fallback must not swallow the API. An unknown /api/
      // path used to fall through to serveStatic and come back as the HTML
      // shell with a 200, so a client calling a route that no longer exists
      // was told it had succeeded and handed a web page to parse as JSON.
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
        throw new HttpError(404, 'error.notFound');
      }
      if (this.staticRoot) return await this.serveStatic(req, res, url);
      throw new HttpError(404, 'error.notFound');
    } catch (error) {
      if (!(error.status) && config.env !== 'test') {
        console.error(`[http] ${req.method} ${url.pathname}`, error);
      }
      if (!res.writableEnded) sendError(res, error, { exposeStack: !config.isProduction });
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 500) console.warn(`[http] slow ${req.method} ${url.pathname} ${ms.toFixed(0)}ms`);
    }
  }

  async buildContext(req, res, url, match) {
    const cookies = parseCookies(req.headers.cookie);
    const token = bearerToken(req.headers.authorization) ?? cookies.sid ?? null;
    const session = token ? await resolveSession(token) : null;

    return {
      req,
      res,
      url,
      params: match.params,
      query: Object.fromEntries(url.searchParams),
      cookies,
      token,
      sessionId: session?.sessionId ?? null,
      user: session?.user ?? null,
      ip: clientIp(req),
      locale: req.headers['accept-language'] ?? '',
      body: async () => readJsonBody(req),
      rawBody: async () => readRawBody(req),
      actor: session ? { userId: session.user.id, ip: clientIp(req) } : { userId: null, ip: clientIp(req) },
      setCookie: (name, value, options) => setCookie(res, name, value, options),
    };
  }

  async serveStatic(req, res, url) {
    const root = this.staticRoot;
    // The superadmin console's shell is served by routes/superadmin.js, to one
    // account, and by nothing else. Serving it as an ordinary static file
    // would hand the whole interface to anyone who guessed the filename.
    if (/(^|\/)console\.html$/i.test(url.pathname)) throw new HttpError(404, 'error.notFound');
    // normalize() collapses ".." before we join, so a crafted path cannot
    // escape the static root.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(root, rel);
    if (!resolve(filePath).startsWith(resolve(root))) {
      throw new HttpError(403, 'error.forbidden');
    }

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info) {
      // Single-page app fallback: unknown paths render the client shell.
      const indexPath = join(root, 'index.html');
      info = await stat(indexPath).catch(() => null);
      if (!info) throw new HttpError(404, 'error.notFound');
      filePath = indexPath;
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    // Hashed asset filenames may be cached forever; everything else revalidates.
    const immutable = /\.[0-9a-f]{8,}\.(js|css|woff2|png|webp|avif)$/i.test(filePath);
    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Last-Modified': new Date(info.mtimeMs).toUTCString(),
    };

    const encoding = negotiateEncoding(req.headers['accept-encoding'] ?? '');
    if (encoding && COMPRESSIBLE.test(type) && info.size > 1024) {
      headers['Content-Encoding'] = encoding;
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      const stream = encoding === 'br'
        ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
        : createGzip({ level: 6 });
      await pipeline(createReadStream(filePath), stream, res);
      return;
    }

    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(filePath), res);
  }
}

// ---------------------------------------------------------------------------

function negotiateEncoding(header) {
  if (/\bbr\b/.test(header)) return 'br';
  if (/\bgzip\b/.test(header)) return 'gzip';
  return null;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/', secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure ?? config.isProduction) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const existing = res.getHeader('Set-Cookie');
  const header = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, header) : header);
}

function bearerToken(header) {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export function clientIp(req) {
  // Only trust the proxy header when we are actually behind one.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && config.isProduction) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'error.validation', 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw badRequest('error.validation');
  }
}
