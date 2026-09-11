/**
 * Administration for support tickets, news and adverts.
 *
 * Each tab is gated on the permission the server checks for the same route,
 * so a role without the permission never sees a control it cannot use. All
 * three write through the real endpoints; nothing here is a mock-up.
 */
import { h, add, clear, tabs, toast, modal, confirmDialog } from './dom.js';
import { t, tc, currentLocale } from '../state/i18n.js';
import { api } from '../net/api.js';
import { LOCALES } from '@schiffi/shared/i18n/index.js';

const LIMIT_TYPES = ['once_per_character', 'once_per_account', 'unlimited'];

const dateTime = (ms) => new Date(ms).toLocaleString(currentLocale());

// --- support ---------------------------------------------------------------

export function supportTab(can) {
  const root = h('div');
  const list = h('div.stack');
  const detail = h('div.stack');
  let filter = 'open';

  const load = async () => {
    clear(list);
    list.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { tickets } = await api.adminTickets(filter);
      clear(list);
      if (!tickets.length) { list.append(h('p.small.muted', null, t('support.none'))); return; }
      for (const ticket of tickets) {
        list.append(h('div.card.card--pick', { onClick: () => open(ticket.id) },
          h('div.row.row--between', null,
            h('div.grow', null,
              h('div', null, ticket.subject),
              h('div.small.muted', null,
                `${ticket.user.username} · ${t(`support.categories.${ticket.category}`)} · ${dateTime(ticket.updatedAt)}`)),
            h('span.small', null, t(`support.${ticket.status === 'answered' ? 'answered' : ticket.status}`)))));
      }
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  const open = async (id) => {
    clear(detail);
    detail.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { ticket } = await api.ticket(id);
      clear(detail);
      const thread = h('div.stack');
      for (const message of ticket.messages) {
        thread.append(h('div.card', null,
          h('div.small.muted', null,
            `${message.staff ? t('support.staffBadge') : (message.author ?? '')} · ${dateTime(message.at)}`),
          h('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, message.body)));
      }

      const reply = h('textarea', { rows: 5, placeholder: t('support.replyPlaceholder') });
      const priority = h('select', null,
        ...['low', 'normal', 'high'].map((key) =>
          h('option', { value: key, selected: ticket.priority === key }, key)));

      add(detail,
        h('h3', null, `${t('support.ticket', { id: ticket.id })} · ${ticket.subject}`),
        thread,
        can('support.reply')
          ? h('div.stack', null,
            h('div.field', null, reply),
            h('div.row', null,
              h('button.primary', {
                onClick: async () => {
                  try {
                    await api.replyTicket(ticket.id, reply.value.trim());
                    toast(t('support.replySent'), 'good');
                    open(ticket.id);
                    load();
                  } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                },
              }, t('support.reply')),
              h('div.field', { style: { marginBottom: 0 } },
                h('label', null, t('support.priority')), priority),
              h('button.ghost', {
                onClick: async () => {
                  try {
                    await api.adminUpdateTicket(ticket.id, { priority: priority.value, assign: true });
                    toast(t('common.save'), 'good');
                    load();
                  } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                },
              }, t('common.save')),
              can('support.close')
                ? h('button.ghost', {
                  onClick: async () => {
                    try {
                      await api.closeTicket(ticket.id);
                      toast(t('support.closed'), 'info');
                      open(ticket.id);
                      load();
                    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, t('support.close'))
                : null))
          : h('p.small.muted', null, t('error.forbidden')));
    } catch (error) {
      clear(detail);
      detail.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  add(root,
    tabs([
      { key: 'open', label: t('support.open') },
      { key: 'answered', label: t('support.answered') },
      { key: 'closed', label: t('support.closed') },
      { key: 'all', label: t('common.all') },
    ], filter, (key) => { filter = key; load(); }),
    list, detail);

  load();
  return root;
}

// --- news ------------------------------------------------------------------

export function newsTab(can) {
  const root = h('div');
  const list = h('div.stack');

  const load = async () => {
    clear(list);
    list.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { posts } = await api.adminNews();
      clear(list);
      if (!posts.length) { list.append(h('p.small.muted', null, t('news.noNews'))); return; }
      for (const post of posts) {
        list.append(h('div.card', null,
          h('div.row.row--between', null,
            h('div.grow', null,
              h('div', null, post.title[currentLocale()] ?? post.title.en ?? post.title.de ?? post.slug),
              h('div.small.muted', null,
                `${post.slug} · ${post.publishedAt ? dateTime(post.publishedAt) : t('news.draft')}`)),
            can('news.publish')
              ? h('div.row', null,
                h('button.ghost', { onClick: () => editor(post, load) }, t('common.edit')),
                h('button.ghost', {
                  onClick: async () => {
                    try {
                      await api.adminUpdateNews(post.id, { publish: !post.publishedAt });
                      toast(t('news.saved'), 'good');
                      load();
                    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, post.publishedAt ? t('news.unpublish') : t('news.publish')),
                h('button.ghost.danger', {
                  onClick: async () => {
                    const yes = await confirmDialog({
                      title: t('common.delete'), message: post.slug,
                      confirmLabel: t('common.delete'), danger: true,
                    });
                    if (!yes) return;
                    try { await api.adminDeleteNews(post.id); load(); }
                    catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, t('common.delete')))
              : null)));
      }
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  add(root,
    can('news.publish')
      ? h('div.row', null,
        h('button.primary', { onClick: () => editor(null, load) }, t('news.manage')))
      : null,
    list);
  load();
  return root;
}

/**
 * The post editor.
 *
 * A post carries one text per language it has been written in. Only the
 * variants that were actually filled in are sent, so an empty box means "not
 * translated yet" rather than an empty headline in that language.
 */
function editor(post, onDone) {
  const slug = h('input', { value: post?.slug ?? '', maxLength: 80, disabled: Boolean(post) });
  const fields = new Map();
  const body = h('div.stack', null,
    h('div.field', null, h('label', null, t('news.slug')), slug));

  for (const locale of LOCALES) {
    const title = h('input', {
      value: post?.title?.[locale.code] ?? '',
      placeholder: t('common.name'), maxLength: 200,
    });
    const text = h('textarea', { rows: 4, value: post?.body?.[locale.code] ?? '' });
    fields.set(locale.code, { title, text });
    body.append(h('div.card', null,
      h('div.card__title', null, t('news.forLocale', { language: locale.nativeName })),
      h('div.field', null, title),
      h('div.field', null, text)));
  }

  modal({
    title: post ? t('common.edit') : t('news.manage'),
    wide: true,
    body,
    actions: [
      { label: t('common.cancel') },
      {
        label: t('common.save'), primary: true,
        onClick: async () => {
          const title = {};
          const text = {};
          for (const [code, field] of fields) {
            if (field.title.value.trim()) title[code] = field.title.value.trim();
            if (field.text.value.trim()) text[code] = field.text.value.trim();
          }
          if (!Object.keys(title).length || !Object.keys(text).length) {
            toast(t('error.validation'), 'bad');
            return false;
          }
          try {
            if (post) await api.adminUpdateNews(post.id, { title, body: text });
            else await api.adminCreateNews({ slug: slug.value.trim(), title, body: text });
            toast(t(post ? 'news.saved' : 'news.created'), 'good');
            onDone();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}

// --- adverts ---------------------------------------------------------------

export function adsTab(can) {
  const root = h('div');
  const list = h('div.stack');
  let filter = 'pending';

  const load = async () => {
    clear(list);
    list.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { ads } = await api.adminAds(filter);
      clear(list);
      if (!ads.length) { list.append(h('p.small.muted', null, t('ads.none'))); return; }
      for (const ad of ads) {
        const note = h('input', { placeholder: t('ads.note'), value: ad.reviewNote ?? '', maxLength: 400 });
        const review = async (status) => {
          try {
            await api.adminReviewAd(ad.id, status, note.value.trim());
            toast(t(`ads.${status}`), status === 'approved' ? 'good' : 'info');
            load();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
        };

        list.append(h('div.card', null,
          h('div.row.row--between', null,
            h('div.grow', null,
              h('div', null, ad.title),
              h('div.small.muted', null, ad.targetUrl),
              h('div.small.muted', null, t(`ads.placement.${ad.placement}`)),
              h('div.small.muted', null, ad.placement === 'reward'
                ? t('ads.statsReward', { impressions: ad.impressions, completions: ad.completions ?? 0 })
                : t('ads.stats', { impressions: ad.impressions, clicks: ad.clicks }))),
            h('span.small', null, t(`ads.${ad.status}`))),
          ad.video ? h('video.ad-card__image', { src: ad.video, controls: true, preload: 'metadata' })
            : ad.image ? h('img.ad-card__image', { src: ad.image, alt: '', loading: 'lazy' }) : null,
          h('p.small', { style: { whiteSpace: 'pre-wrap' } }, ad.body),
          can('ads.approve')
            ? h('div.stack', null,
              h('div.field', { style: { marginBottom: '6px' } }, note),
              h('div.row', null,
                h('button.primary', { onClick: () => review('approved') }, t('ads.approve')),
                h('button.ghost.danger', { onClick: () => review('rejected') }, t('ads.reject'))))
            : null));
      }
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  add(root,
    tabs([
      { key: 'pending', label: t('ads.pending') },
      { key: 'approved', label: t('ads.approved') },
      { key: 'rejected', label: t('ads.rejected') },
      { key: 'all', label: t('common.all') },
    ], filter, (key) => { filter = key; load(); }),
    list);
  load();
  return root;
}

// --- secret codes ------------------------------------------------------------

export function codesTab(can) {
  const root = h('div');
  const list = h('div.stack');

  const load = async () => {
    clear(list);
    list.append(h('p.small.muted', null, t('common.loading')));
    try {
      const { codes } = await api.adminCodes();
      clear(list);
      if (!codes.length) { list.append(h('p.small.muted', null, t('code.none'))); return; }
      for (const code of codes) {
        const expired = code.expiresAt && code.expiresAt < Date.now();
        list.append(h('div.card', null,
          h('div.row.row--between', null,
            h('div.grow', null,
              h('div.mono', null, code.code),
              h('div.small.muted', null,
                `${tc(code.rewardCoins)} ${t('unit.coins')} · ${t(`code.limit.${camel(code.limitType)}`)}`),
              h('div.small.muted', null, t('code.usesSummary', { uses: code.uses, total: code.totalCoins })),
              !code.active ? h('span.small.bad', null, t('code.deactivated'))
                : expired ? h('span.small.warn', null, t('code.expired')) : null),
            can('codes.manage')
              ? h('div.row', null,
                h('button.ghost', { onClick: () => codeEditor(code, load) }, t('common.edit')),
                h('button.ghost.danger', {
                  onClick: async () => {
                    const yes = await confirmDialog({
                      title: t('common.delete'), message: code.code,
                      confirmLabel: t('common.delete'), danger: true,
                    });
                    if (!yes) return;
                    try { await api.adminDeleteCode(code.id); load(); }
                    catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, t('common.delete')))
              : null)));
      }
    } catch (error) {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  };

  add(root,
    can('codes.manage')
      ? h('div.row', null,
        h('button.primary', { onClick: () => codeEditor(null, load) }, t('admin.createCode')))
      : null,
    list);
  load();
  return root;
}

/** 'once_per_character' -> 'oncePerCharacter', to match the locale key shape. */
function camel(key) {
  return String(key).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * The code editor.
 *
 * The code text itself is set once and never changes - editing it would
 * silently orphan every past redemption logged against the old string, so a
 * different code is a new code, created fresh and the old one deleted.
 */
function codeEditor(code, onDone) {
  const text = h('input', { value: code?.code ?? '', maxLength: 200, disabled: Boolean(code) });
  const reward = h('input', { type: 'number', min: 0, step: 1, value: code?.rewardCoins ?? 1000 });
  const limitType = h('select', null,
    ...LIMIT_TYPES.map((key) =>
      h('option', { value: key, selected: (code?.limitType ?? 'once_per_character') === key },
        t(`code.limit.${camel(key)}`))));
  const active = h('input', {
    type: 'checkbox', checked: code ? code.active : true, style: { width: 'auto' },
  });
  const expiresAt = h('input', {
    type: 'date', value: code?.expiresAt ? new Date(code.expiresAt).toISOString().slice(0, 10) : '',
  });

  modal({
    title: code ? t('common.edit') : t('admin.createCode'),
    body: h('div.stack', null,
      h('div.field', null, h('label', null, t('code.title')), text),
      h('div.field', null, h('label', null, t('code.rewardCoins')), reward),
      h('div.field', null, h('label', null, t('code.limitType')), limitType),
      h('label.row', null, active, h('span', null, t('code.active'))),
      h('div.field', null,
        h('label', null, t('code.expiresAt')), expiresAt,
        h('p.small.muted', null, t('code.noExpiry')))),
    actions: [
      { label: t('common.cancel') },
      {
        label: t('common.save'), primary: true,
        onClick: async () => {
          const payload = {
            rewardCoins: Number(reward.value),
            limitType: limitType.value,
            active: active.checked,
            expiresAt: expiresAt.value ? new Date(expiresAt.value).getTime() : null,
          };
          try {
            if (code) await api.adminUpdateCode(code.id, payload);
            else await api.adminCreateCode({ ...payload, code: text.value.trim() });
            toast(t('common.save'), 'good');
            onDone();
          } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); return false; }
          return true;
        },
      },
    ],
  });
}
