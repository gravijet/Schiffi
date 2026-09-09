/**
 * A small router over node:http.
 *
 * Deliberately dependency-free: the routing needs here are patterns like
 * `/api/worlds/:id/ports`, method dispatch, and a middleware chain.  A radix
 * tree would be overkill for a few dozen routes, and a plain segment match is
 * predictable and easy to reason about.
 */

export class Router {
  constructor() {
    this.routes = [];
    this.middleware = [];
  }

  use(fn) { this.middleware.push(fn); return this; }

  add(method, pattern, handler, options = {}) {
    const segments = pattern.split('/').filter(Boolean).map((seg) =>
      seg.startsWith(':')
        ? { param: seg.slice(1) }
        : seg === '*'
          ? { wildcard: true }
          : { literal: seg });
    this.routes.push({ method, pattern, segments, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** @returns {{handler, params, options}|null} */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let methodMismatch = false;

    for (const route of this.routes) {
      const params = {};
      let ok = true;
      let i = 0;
      for (; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.wildcard) { params['*'] = parts.slice(i).join('/'); i = parts.length; break; }
        if (i >= parts.length) { ok = false; break; }
        if (seg.param) { params[seg.param] = decodeURIComponent(parts[i]); continue; }
        if (seg.literal !== parts[i]) { ok = false; break; }
      }
      if (!ok || i < parts.length) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      return { handler: route.handler, params, options: route.options, pattern: route.pattern };
    }
    return methodMismatch ? { methodNotAllowed: true } : null;
  }
}
