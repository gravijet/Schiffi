/**
 * The superadmin console.
 *
 * A separate document with a separate bundle, and that is the point rather
 * than a packaging detail. Nothing about it appears in the site's own build:
 * no route, no chunk reachable from index.html, and - deliberately - none of
 * its wording in the shared translation catalogues, because those catalogues
 * are downloaded by every visitor and an administrator reading one must not
 * find a string that reveals this exists. It is written in German directly,
 * for the one person who can open it.
 *
 * The server serves this page to that one account and the application shell to
 * everybody else, and every endpoint below answers 404 to anyone else. The
 * checks here decide what to draw, never what is allowed.
 */
import './styles/base.css';
import './styles/console.css';
import { h, add, clear, toast, confirmDialog } from './ui/dom.js';

const $ = (path, options = {}) => request(path, options);

async function request(path, { method = 'GET', body, file } = {}) {
  const init = { method, credentials: 'same-origin' };
  if (file) {
    init.headers = { 'Content-Type': file.type || 'application/octet-stream' };
    init.body = file;
  } else if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const root = document.getElementById('console');
const nf = new Intl.NumberFormat('de-AT');
const dt = (ms) => (ms ? new Date(Number(ms)).toLocaleString('de-AT') : '—');

let overview = null;
let screen = 'lage';

async function boot() {
  try {
    overview = await $('/api/superadmin/overview');
  } catch (error) {
    // 404 is the honest answer here too: the session is not the superadmin, or
    // it expired. Either way there is nothing to draw.
    root.append(h('div.cx-empty', null,
      h('h1', null, 'Nicht verfügbar'),
      h('p', null, error.status === 404
        ? 'Diese Sitzung darf den Leitstand nicht öffnen.'
        : error.message),
      h('a', { href: '/' }, 'Zur Startseite')));
    return;
  }
  render();
}

function render() {
  clear(root);
  const tab = (key, label) => h(`button.cx-tab${screen === key ? '.is-active' : ''}`, {
    onClick: () => { screen = key; render(); },
  }, label);

  add(root,
    h('header.cx-head', null,
      h('div', null,
        h('h1', null, 'Leitstand'),
        h('p.cx-sub', null, overview.superadminEmail)),
      h('div.row', null,
        h('a.btn', { href: '/admin' }, 'Verwaltung'),
        h('a.btn', { href: '/' }, 'Zur Seite'))),
    h('nav.cx-tabs', null,
      tab('lage', 'Lage'),
      tab('kennwoerter', 'Kennwörter'),
      tab('werbung', 'Werbung vor der Seite')),
    h('main.cx-main', null,
      screen === 'lage' ? lageView()
        : screen === 'kennwoerter' ? kennwortView()
          : werbungView()));
}

// --- overview ---------------------------------------------------------------

function lageView() {
  const vault = overview.vault;
  return h('div', null,
    h('div.cx-grid', null,
      stat('Konten', nf.format(overview.counts.users)),
      stat('Kapitäne', nf.format(overview.counts.characters)),
      stat('Offene Sitzungen', nf.format(overview.counts.activeSessions)),
      stat('Lesbare Kennwörter', nf.format(vault.readableAccounts))),
    h('div.cx-card', null,
      h('h2', null, 'Kennwort-Tresor'),
      h('dl.kv', null,
        h('dt', null, 'Status'), h('dd', { class: vault.enabled ? 'good' : 'bad' },
          vault.enabled ? 'aktiv' : 'kein Schlüssel gesetzt'),
        h('dt', null, 'Schlüsselkennung'), h('dd.mono', null, vault.keyId || '—')),
      h('p.small.muted', null,
        'Anmeldungen prüfen weiterhin ausschließlich gegen Argon2id. Daneben liegt '
        + 'eine mit PASSWORD_VAULT_KEY verschlüsselte Kopie. Wer Schlüssel und '
        + 'Datenbankkopie hat, hat jedes seither gespeicherte Kennwort - bewahre '
        + 'beides getrennt auf.'),
      !vault.enabled
        ? h('p.small.bad', null, 'Ohne Schlüssel kann kein Kennwort angezeigt werden.')
        : null),
    h('div.cx-card', null,
      h('h2', null, 'E-Mail'),
      overview.mailConfigured
        ? h('p.small.good', null, 'SMTP ist konfiguriert; Nachrichten werden versendet.')
        : h('p.small.warn', null,
          'SMTP ist nicht konfiguriert. Bestätigungs- und Zurücksetz-Mails landen in '
          + 'data/mail/*.eml und werden nie zugestellt - Kennwort-Wiederherstellung '
          + 'funktioniert für echte Nutzer damit nicht.')));
}

function stat(label, value) {
  return h('div.cx-stat', null,
    h('div.cx-stat__value', null, value),
    h('div.cx-stat__label', null, label));
}

// --- passwords --------------------------------------------------------------

/**
 * Search an account, then show its password.
 *
 * Two steps on purpose: the value is never a side effect of opening a user,
 * only of a deliberate click, and it hides itself again afterwards. When it
 * cannot be shown, the reason is named rather than swallowed - an account
 * whose password predates the vault key is gone for good, Argon2id being a
 * one-way function.
 */
function kennwortView() {
  const search = h('input', { placeholder: 'Name oder E-Mail', autofocus: true });
  const results = h('div.stack');

  const REASONS = {
    vaultDisabled: 'Der Tresor ist nicht eingerichtet (PASSWORD_VAULT_KEY fehlt).',
    notStored: 'Für dieses Konto liegt keine Kopie vor. Das Kennwort wurde gesetzt, '
      + 'bevor es den Tresor gab - Argon2id lässt sich nicht umkehren. Nach der '
      + 'nächsten Kennwortänderung ist es lesbar.',
    keyRotated: 'Die Kopie wurde mit einem anderen Schlüssel verschlüsselt.',
    undecryptable: 'Die Kopie lässt sich nicht entschlüsseln.',
  };

  const load = async () => {
    clear(results);
    try {
      const { users } = await $(`/api/admin/users?q=${encodeURIComponent(search.value.trim())}`);
      if (!users.length) { results.append(h('p.muted', null, 'Nichts gefunden.')); return; }
      for (const user of users.slice(0, 25)) results.append(userRow(user));
    } catch (error) {
      results.append(h('p.bad', null, error.message));
    }
  };

  const userRow = (user) => {
    const output = h('div');
    const button = h('button.danger.small', {
      onClick: async () => {
        button.disabled = true;
        try {
          const result = await $(`/api/superadmin/users/${user.id}/password`, { method: 'POST' });
          clear(output);
          if (result.password === null) {
            output.append(h('p.small.bad', null, REASONS[result.reason] ?? 'Nicht möglich.'));
            button.disabled = false;
            return;
          }
          output.append(h('div.cx-reveal', null,
            h('code', null, result.password),
            h('button.ghost.small', {
              onClick: () => navigator.clipboard?.writeText(result.password)
                .then(() => toast('Kopiert', 'good'))
                .catch(() => toast('Kopieren nicht möglich', 'bad')),
            }, 'Kopieren'),
            h('button.ghost.small', {
              onClick: () => { clear(output); button.disabled = false; },
            }, 'Verbergen')));
        } catch (error) {
          toast(error.message, 'bad');
          button.disabled = false;
        }
      },
    }, 'Kennwort anzeigen');

    return h('div.cx-card', null,
      h('div.row.row--between', null,
        h('div', null,
          h('strong', null, user.username),
          h('div.small.muted', null, `${user.email} · #${user.id} · seit ${dt(user.createdAt)}`)),
        button),
      output);
  };

  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });
  load();

  return h('div', null,
    h('p.lede', null, 'Zeigt das gespeicherte Kennwort im Klartext. Nur hier, nur für dieses Konto.'),
    h('div.row', { style: { marginBottom: '14px' } },
      search,
      h('button.primary', { onClick: load }, 'Suchen')),
    results);
}

// --- the advert in front of the site ----------------------------------------

function werbungView() {
  const list = h('div.stack');
  const headline = h('input', { maxLength: 120, placeholder: 'Überschrift' });
  const body = h('textarea', { rows: 3, maxLength: 600, placeholder: 'Text (optional)' });
  const target = h('input', { maxLength: 500, placeholder: 'https://… (optional)' });
  const seconds = h('input', { type: 'number', min: '0', max: '30', value: '5' });
  const file = h('input', { type: 'file', accept: 'image/webp,image/png,image/jpeg' });

  const refresh = async () => {
    clear(list);
    try {
      const { interstitials } = await $('/api/superadmin/interstitials');
      if (!interstitials.length) { list.append(h('p.muted', null, 'Noch keine Werbung angelegt.')); return; }
      for (const item of interstitials) list.append(row(item));
    } catch (error) {
      list.append(h('p.bad', null, error.message));
    }
  };

  const row = (item) => h(`div.cx-card${item.active ? '.is-active' : ''}`, null,
    h('div.row', { style: { gap: '14px', alignItems: 'flex-start' } },
      item.image ? h('img.cx-thumb', { src: item.image, alt: '' }) : null,
      h('div.grow', null,
        h('div.row.row--between', null,
          h('strong', null, item.headline),
          h('span.small', { class: item.active ? 'good' : 'muted' },
            item.active ? 'wird angezeigt' : 'inaktiv')),
        item.body ? h('p.small.muted', null, item.body) : null,
        h('div.small.mono.muted', null,
          `${item.targetUrl ?? 'kein Link'} · ${item.seconds}s · `
          + `${nf.format(item.impressions)} Aufrufe · ${nf.format(item.clicks)} Klicks`),
        h('div.row', { style: { marginTop: '8px', flexWrap: 'wrap' } },
          h('button.small', {
            onClick: async () => {
              await $(`/api/superadmin/interstitials/${item.id}`,
                { method: 'PATCH', body: { active: !item.active } });
              refresh();
            },
          }, item.active ? 'Ausschalten' : 'Anzeigen'),
          h('label.btn.small', null, 'Bild ersetzen',
            h('input', {
              type: 'file', accept: 'image/webp,image/png,image/jpeg', style: { display: 'none' },
              onChange: async (event) => {
                const picked = event.target.files?.[0];
                if (!picked) return;
                try {
                  await $(`/api/superadmin/interstitials/${item.id}/image`, { method: 'POST', file: picked });
                  toast('Bild ersetzt', 'good');
                  refresh();
                } catch (error) { toast(error.message, 'bad'); }
              },
            })),
          h('button.danger.small', {
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Werbung löschen', message: item.headline,
                confirmLabel: 'Löschen', cancelLabel: 'Abbrechen', danger: true,
              });
              if (!ok) return;
              await $(`/api/superadmin/interstitials/${item.id}`, { method: 'DELETE' });
              refresh();
            },
          }, 'Löschen')))));

  const create = async () => {
    try {
      const created = await $('/api/superadmin/interstitials', {
        method: 'POST',
        body: {
          headline: headline.value.trim(),
          body: body.value.trim(),
          targetUrl: target.value.trim() || undefined,
          seconds: Number(seconds.value) || 0,
        },
      });
      // The picture is uploaded after the row exists, so a rejected image
      // never throws away the text that was just typed.
      if (file.files?.[0]) {
        await $(`/api/superadmin/interstitials/${created.id}/image`, { method: 'POST', file: file.files[0] });
      }
      headline.value = ''; body.value = ''; target.value = ''; file.value = '';
      toast('Angelegt. Zum Anzeigen einschalten.', 'good');
      refresh();
    } catch (error) {
      toast(error.message, 'bad');
    }
  };

  refresh();

  return h('div', null,
    h('p.lede', null,
      'Wird jedem Besucher gezeigt, bevor die Seite erscheint. Es ist immer '
      + 'höchstens eine aktiv; das Einschalten einer anderen schaltet die '
      + 'bisherige ab.'),
    h('div.cx-card', null,
      h('h2', null, 'Neue Werbung'),
      h('div.field', null, h('label', null, 'Überschrift'), headline),
      h('div.field', null, h('label', null, 'Text'), body),
      h('div.field', null, h('label', null, 'Ziel-Link'), target),
      h('div.field', null, h('label', null, 'Wartezeit in Sekunden'), seconds),
      h('div.field', null, h('label', null, 'Bild (WebP, PNG oder JPEG, max. 1 MB)'), file),
      h('button.primary', { onClick: create }, 'Anlegen')),
    h('h2', null, 'Angelegte Werbung'),
    list);
}

boot();
