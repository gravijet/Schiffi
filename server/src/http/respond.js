/** Response helpers, plus the error shape every route uses. */
import { createHash } from 'node:crypto';

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function noContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

export function text(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * Errors carry a translation key in `code` so the client renders them in the
 * player's language instead of showing an English server string.
 */
export class HttpError extends Error {
  constructor(status, code, message = code, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code = 'error.validation', details) => new HttpError(400, code, code, details);
export const unauthorized = (code = 'error.unauthorized') => new HttpError(401, code);
export const forbidden = (code = 'error.forbidden') => new HttpError(403, code);
export const notFound = (code = 'error.notFound') => new HttpError(404, code);
export const conflict = (code = 'error.conflict') => new HttpError(409, code);
export const tooMany = (code = 'error.rateLimited') => new HttpError(429, code);

export function sendError(res, error, { exposeStack = false } = {}) {
  const status = Number(error.status) || 500;
  const body = {
    error: true,
    code: error.code || (status === 500 ? 'error.generic' : 'error.generic'),
    message: status === 500 && !exposeStack ? 'internal error' : error.message,
  };
  if (error.details) body.details = error.details;
  if (exposeStack && status === 500) body.stack = error.stack;
  json(res, status, body);
}

/** Weak ETag over a JSON payload, for cacheable read endpoints. */
export function etagFor(value) {
  return `W/"${createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('base64url')}"`;
}
