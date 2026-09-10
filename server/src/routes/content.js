/**
 * Support tickets, news and adverts.
 *
 * These three share a shape: a player writes something, a member of staff with
 * the right permission reads and answers it, and the result is visible in the
 * interface. The permissions already existed and so did the tables; without
 * these routes the support form and the news page were buttons that led
 * nowhere, which is exactly what the specification forbids.
 */
import { getDatabase } from '../db/index.js';
import { badRequest, notFound, forbidden } from '../http/respond.js';
import { can } from '../services/rbac.js';
import { storeMedia, readMedia, removeMedia } from '../services/media.js';
import { activeInterstitial, countImpression, countClick } from '../services/interstitial.js';
import { LOCALES, isValidLocale, negotiateLocale } from '@schiffi/shared/i18n/index.js';

const TICKET_CATEGORIES = ['general', 'account', 'payment', 'bug', 'report', 'other'];
const TICKET_PRIORITIES = ['low', 'normal', 'high'];
const MAX_OPEN_TICKETS = 5;
const MAX_PENDING_ADS = 10;

const trim = (value, max) => String(value ?? '').trim().slice(0, max);

/** A JSON column that holds one string per locale. */
function localisedText(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const locale of LOCALES) {
      const text = value[locale.code];
      if (typeof text === 'string' && text.trim()) out[locale.code] = text.trim().slice(0, 20_000);
    }
    return out;
  }
  return null;
}

/**
 * Pick the best available translation for the reader.
 *
 * A post does not have to exist in all nine variants, so this walks the same
 * fallback chain the interface uses: the exact locale, its base language,
 * English, German, then whatever is there rather than nothing.
 */
function pick(field, locale) {
  const map = typeof field === 'string' ? JSON.parse(field || '{}') : (field ?? {});
  const base = String(locale).split('-')[0];
  return map[locale] ?? map[base] ?? map.en ?? map.de ?? Object.values(map)[0] ?? '';
}

/** The reader's language: their explicit choice first, the header second. */
function readerLocale(ctx) {
  const asked = ctx.query.locale;
  if (asked && isValidLocale(asked)) return asked;
  return negotiateLocale(ctx.locale);
}

export function registerContentRoutes(router) {
  // --- support: the player's side -----------------------------------------

  router.post('/api/support/tickets', async (ctx) => {
    const body = await ctx.body();
    const subject = trim(body.subject, 160);
    const message = trim(body.body ?? body.message, 8000);
    if (subject.length < 3 || message.length < 10) throw badRequest();

    const category = TICKET_CATEGORIES.includes(body.category) ? body.category : 'general';
    const db = getDatabase();

    return db.tx(async (tx) => {
      // A rate limit that is about people, not requests: an unanswered pile of
      // tickets from one account helps nobody.
      const open = await tx.get(
        "SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status <> 'closed'",
        [ctx.user.id]);
      if (Number(open?.n ?? 0) >= MAX_OPEN_TICKETS) {
        throw badRequest('error.rateLimited');
      }

      const now = Date.now();
      const ticketId = await tx.insert('support_tickets', {
        user_id: ctx.user.id, subject, category, priority: 'normal',
        status: 'open', created_at: now, updated_at: now,
      });
      await tx.insert('support_messages', {
        ticket_id: ticketId, user_id: ctx.user.id, body: message, is_staff: 0, at: now,
      });
      return { id: ticketId, status: 'open', createdAt: now };
    });
  });

  router.get('/api/support/tickets', async (ctx) => ({
    tickets: await ticketsFor(ctx.user.id),
  }));

  router.get('/api/support/tickets/:id', async (ctx) => {
    const ticket = await readableTicket(ctx, ctx.params.id);
    return { ticket };
  });

  router.post('/api/support/tickets/:id/messages', async (ctx) => {
    const body = await ctx.body();
    const message = trim(body.body ?? body.message, 8000);
    if (message.length < 2) throw badRequest();

    const db = getDatabase();
    const row = await db.get('SELECT * FROM support_tickets WHERE id = ?', [ctx.params.id]);
    if (!row) throw notFound();

    const own = String(row.user_id) === String(ctx.user.id);
    const staff = await can(ctx.user.id, 'support.reply');
    if (!own && !staff) throw forbidden();
    if (row.status === 'closed') throw badRequest('error.conflict');

    const now = Date.now();
    await db.insert('support_messages', {
      ticket_id: row.id, user_id: ctx.user.id, body: message,
      // Own messages are never staff messages, even for a staff member writing
      // on their own ticket: the badge says who is answering whom.
      is_staff: !own && staff ? 1 : 0,
      at: now,
    });
    await db.run("UPDATE support_tickets SET updated_at = ?, status = ? WHERE id = ?",
      [now, own ? 'open' : 'answered', row.id]);
    return { ok: true, at: now };
  });

  router.post('/api/support/tickets/:id/close', async (ctx) => {
    const db = getDatabase();
    const row = await db.get('SELECT * FROM support_tickets WHERE id = ?', [ctx.params.id]);
    if (!row) throw notFound();

    const own = String(row.user_id) === String(ctx.user.id);
    if (!own && !(await can(ctx.user.id, 'support.close'))) throw forbidden();

    await db.run("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ?",
      [Date.now(), row.id]);
    return { ok: true };
  });

  // --- support: the staff side --------------------------------------------

  router.get('/api/admin/support/tickets', async (ctx) => {
    const db = getDatabase();
    const status = ctx.query.status;
    const params = [];
    let sql = `SELECT t.*, u.username, u.email
               FROM support_tickets t JOIN users u ON u.id = t.user_id`;
    if (status && status !== 'all') { sql += ' WHERE t.status = ?'; params.push(status); }
    sql += ' ORDER BY t.updated_at DESC LIMIT 200';

    const rows = await db.all(sql, params);
    return {
      tickets: rows.map((row) => ({
        id: row.id, subject: row.subject, category: row.category,
        priority: row.priority, status: row.status,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        user: { id: row.user_id, username: row.username, email: row.email },
      })),
    };
  }, { permission: 'support.view' });

  router.patch('/api/admin/support/tickets/:id', async (ctx) => {
    const body = await ctx.body();
    const db = getDatabase();
    const row = await db.get('SELECT * FROM support_tickets WHERE id = ?', [ctx.params.id]);
    if (!row) throw notFound();

    const patch = { updated_at: Date.now() };
    if (TICKET_PRIORITIES.includes(body.priority)) patch.priority = body.priority;
    if (TICKET_CATEGORIES.includes(body.category)) patch.category = body.category;
    if (['open', 'answered', 'closed'].includes(body.status)) patch.status = body.status;
    if (body.assign === true) patch.assigned_to = ctx.user.id;
    if (body.assign === false) patch.assigned_to = null;

    const columns = Object.keys(patch);
    await db.run(`UPDATE support_tickets SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => patch[c]), row.id]);
    return { ok: true };
  }, { permission: 'support.reply' });

  // --- news ---------------------------------------------------------------

  router.get('/api/news', async (ctx) => {
    const db = getDatabase();
    const locale = readerLocale(ctx);
    const rows = await db.all(
      'SELECT * FROM news_posts WHERE published_at IS NOT NULL AND published_at <= ? ' +
      'ORDER BY published_at DESC LIMIT 40', [Date.now()]);
    return {
      posts: rows.map((row) => ({
        slug: row.slug,
        title: pick(row.title, locale),
        body: pick(row.body, locale),
        publishedAt: Number(row.published_at),
      })),
    };
  }, { auth: false });

  router.get('/api/admin/news', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all('SELECT * FROM news_posts ORDER BY created_at DESC LIMIT 200');
    return {
      posts: rows.map((row) => ({
        id: row.id, slug: row.slug,
        title: JSON.parse(row.title || '{}'),
        body: JSON.parse(row.body || '{}'),
        publishedAt: row.published_at ? Number(row.published_at) : null,
        createdAt: Number(row.created_at),
      })),
    };
  }, { permission: 'news.view' });

  router.post('/api/admin/news', async (ctx) => {
    const body = await ctx.body();
    const slug = trim(body.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    const title = localisedText(body.title);
    const text = localisedText(body.body);
    if (!slug || !title || !text) throw badRequest();

    const db = getDatabase();
    const taken = await db.get('SELECT id FROM news_posts WHERE slug = ?', [slug]);
    if (taken) throw badRequest('error.conflict');

    const now = Date.now();
    const id = await db.insert('news_posts', {
      slug, title: JSON.stringify(title), body: JSON.stringify(text),
      author_id: ctx.user.id,
      published_at: body.publish ? now : null,
      created_at: now, updated_at: now,
    });
    return { id, slug };
  }, { permission: 'news.publish' });

  router.patch('/api/admin/news/:id', async (ctx) => {
    const body = await ctx.body();
    const db = getDatabase();
    const row = await db.get('SELECT * FROM news_posts WHERE id = ?', [ctx.params.id]);
    if (!row) throw notFound();

    const patch = { updated_at: Date.now() };
    const title = localisedText(body.title);
    const text = localisedText(body.body);
    if (title) patch.title = JSON.stringify(title);
    if (text) patch.body = JSON.stringify(text);
    if (body.publish === true) patch.published_at = row.published_at ?? Date.now();
    if (body.publish === false) patch.published_at = null;

    const columns = Object.keys(patch);
    await db.run(`UPDATE news_posts SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => patch[c]), row.id]);
    return { ok: true };
  }, { permission: 'news.publish' });

  router.delete('/api/admin/news/:id', async (ctx) => {
    const db = getDatabase();
    await db.run('DELETE FROM news_posts WHERE id = ?', [ctx.params.id]);
    return { ok: true };
  }, { permission: 'news.publish' });

  // --- adverts ------------------------------------------------------------
  //
  // Submitting one needs the ads.submit permission, which the "Werbekunde"
  // role carries and nothing else does. That is the whole point of the role:
  // an ordinary player cannot upload advertising, and an account that can
  // upload advertising gains no administrative reach by doing so.

  router.post('/api/ads', async (ctx) => {
    const body = await ctx.body();
    const title = trim(body.title, 90);
    const text = trim(body.body, 400);
    const target = trim(body.targetUrl, 300);
    if (title.length < 3 || text.length < 10) throw badRequest();
    // Only plain web links, and never a javascript: or data: URL.
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(target)) throw badRequest();

    const db = getDatabase();
    const open = await db.get(
      "SELECT COUNT(*) AS n FROM ads WHERE user_id = ? AND status = 'pending'", [ctx.user.id]);
    if (Number(open?.n ?? 0) >= MAX_PENDING_ADS) throw badRequest('error.rateLimited');

    const id = await db.insert('ads', {
      user_id: ctx.user.id, title, body: text, target_url: target,
      placement: body.placement === 'sidebar' ? 'sidebar' : 'menu',
      status: 'pending', submitted_at: Date.now(),
    });
    return { id, status: 'pending' };
  }, { permission: 'ads.submit' });

  /**
   * The advert's picture, uploaded as raw bytes after the advert exists.
   *
   * Changing the image sends the advert back for review: approving a banner
   * and then having the picture swapped underneath is exactly the hole an
   * approval step is supposed to close.
   */
  router.post('/api/ads/:id/image', async (ctx) => {
    const db = getDatabase();
    const row = await db.get('SELECT * FROM ads WHERE id = ? AND user_id = ?',
      [ctx.params.id, ctx.user.id]);
    if (!row) throw notFound();

    const stored = await storeMedia(await ctx.rawBody());
    await db.run("UPDATE ads SET image_path = ?, status = 'pending' WHERE id = ?", [stored.path, row.id]);

    if (row.image_path && row.image_path !== stored.path) {
      const stillUsed = await db.get('SELECT 1 AS x FROM ads WHERE image_path = ? LIMIT 1', [row.image_path]);
      if (!stillUsed) await removeMedia(row.image_path);
    }
    return { image: `/media/ads/${stored.path}`, status: 'pending' };
  }, { permission: 'ads.submit' });

  /** An advertiser's own adverts, with the figures they earned. */
  router.get('/api/ads/mine', async (ctx) => {
    const db = getDatabase();
    const rows = await db.all(
      'SELECT * FROM ads WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 100', [ctx.user.id]);
    return { ads: rows.map(publicAd) };
  }, { permission: 'ads.submit' });

  router.delete('/api/ads/:id', async (ctx) => {
    const db = getDatabase();
    const row = await db.get('SELECT * FROM ads WHERE id = ? AND user_id = ?',
      [ctx.params.id, ctx.user.id]);
    if (!row) throw notFound();
    await db.run('DELETE FROM ads WHERE id = ?', [row.id]);
    if (row.image_path) {
      const stillUsed = await db.get('SELECT 1 AS x FROM ads WHERE image_path = ? LIMIT 1', [row.image_path]);
      if (!stillUsed) await removeMedia(row.image_path);
    }
    return { ok: true };
  }, { permission: 'ads.submit' });

  router.get('/api/ads', async (ctx) => {
    const db = getDatabase();
    const placement = ctx.query.placement === 'sidebar' ? 'sidebar' : 'menu';
    const rows = await db.all(
      "SELECT id, title, body, target_url, image_path FROM ads WHERE status = 'approved' AND placement = ? LIMIT 8",
      [placement]);
    // Impressions are counted for what is actually handed out.
    if (rows.length) {
      await db.run(
        `UPDATE ads SET impressions = impressions + 1 WHERE id IN (${rows.map(() => '?').join(',')})`,
        rows.map((row) => row.id));
    }
    return {
      ads: rows.map((row) => ({
        id: row.id, title: row.title, body: row.body, targetUrl: row.target_url,
        image: row.image_path ? `/media/ads/${row.image_path}` : null,
      })),
    };
  }, { auth: false });

  router.post('/api/ads/:id/click', async (ctx) => {
    const db = getDatabase();
    const row = await db.get("SELECT id FROM ads WHERE id = ? AND status = 'approved'", [ctx.params.id]);
    if (!row) throw notFound();
    await db.run('UPDATE ads SET clicks = clicks + 1 WHERE id = ?', [row.id]);
    return { ok: true };
  }, { auth: false });

  /**
   * Advert and interstitial images.
   *
   * The name is the file's own content hash, so this may be cached forever -
   * a replaced picture is a different URL, never a stale one.
   */
  router.get('/media/ads/:name', async (ctx) => {
    const media = await readMedia(ctx.params.name);
    if (!media) throw notFound();
    ctx.res.writeHead(200, {
      'Content-Type': media.type,
      'Content-Length': media.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    ctx.res.end(media.data);
    return undefined;
  }, { auth: false });

  // --- the advert in front of the site ------------------------------------

  /**
   * Asked for by every visitor before anything else is painted, so it answers
   * from a short-lived cache and returns null rather than 404 when there is
   * nothing to show - a missing advert is the normal case, not an error.
   */
  router.get('/api/interstitial', async () => {
    const current = await activeInterstitial();
    if (!current) return { interstitial: null };
    countImpression(current.id).catch(() => {});
    return {
      interstitial: {
        id: current.id,
        headline: current.headline,
        body: current.body,
        image: current.image,
        targetUrl: current.targetUrl,
        seconds: current.seconds,
      },
    };
  }, { auth: false });

  router.post('/api/interstitial/:id/click', async (ctx) => {
    const counted = await countClick(ctx.params.id);
    if (!counted) throw notFound();
    return { ok: true };
  }, { auth: false });

  router.get('/api/admin/ads', async (ctx) => {
    const db = getDatabase();
    const status = ctx.query.status;
    const rows = status && status !== 'all'
      ? await db.all('SELECT * FROM ads WHERE status = ? ORDER BY submitted_at DESC LIMIT 200', [status])
      : await db.all('SELECT * FROM ads ORDER BY submitted_at DESC LIMIT 200');
    return { ads: rows.map(publicAd) };
  }, { permission: 'ads.view' });

  router.post('/api/admin/ads/:id', async (ctx) => {
    const body = await ctx.body();
    if (!['approved', 'rejected', 'pending'].includes(body.status)) throw badRequest();

    const db = getDatabase();
    const row = await db.get('SELECT id FROM ads WHERE id = ?', [ctx.params.id]);
    if (!row) throw notFound();

    await db.run('UPDATE ads SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
      [body.status, ctx.user.id, Date.now(), trim(body.note, 400), row.id]);
    return { ok: true };
  }, { permission: 'ads.approve' });
}

// ---------------------------------------------------------------------------

/** One advert as both its owner and a reviewer see it. */
function publicAd(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    targetUrl: row.target_url,
    image: row.image_path ? `/media/ads/${row.image_path}` : null,
    placement: row.placement ?? 'menu',
    status: row.status,
    submittedAt: Number(row.submitted_at),
    reviewNote: row.review_note,
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
  };
}

async function ticketsFor(userId) {
  const db = getDatabase();
  const rows = await db.all(
    'SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [userId]);
  return rows.map((row) => ({
    id: row.id, subject: row.subject, category: row.category,
    status: row.status, priority: row.priority,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }));
}

/** A ticket with its messages, if this user is allowed to see it. */
async function readableTicket(ctx, ticketId) {
  const db = getDatabase();
  const row = await db.get('SELECT * FROM support_tickets WHERE id = ?', [ticketId]);
  if (!row) throw notFound();
  if (String(row.user_id) !== String(ctx.user.id) && !(await can(ctx.user.id, 'support.view'))) {
    throw forbidden();
  }

  const messages = await db.all(
    'SELECT m.*, u.username FROM support_messages m LEFT JOIN users u ON u.id = m.user_id ' +
    'WHERE m.ticket_id = ? ORDER BY m.at', [ticketId]);

  return {
    id: row.id, subject: row.subject, category: row.category,
    status: row.status, priority: row.priority,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    messages: messages.map((message) => ({
      id: message.id, body: message.body,
      staff: Number(message.is_staff) === 1,
      author: message.username ?? null,
      at: Number(message.at),
    })),
  };
}
