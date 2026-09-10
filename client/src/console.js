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
  if (file && file.size > 1536 * 1024) return uploadChunks(path, file);
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

async function uploadChunks(path, file) {
  const chunkBytes = 1536 * 1024;
  const send = async (offset, uploadId = null) => {
    const end = Math.min(file.size, offset + chunkBytes);
    const headers = {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`,
    };
    if (uploadId) headers['X-Upload-Id'] = uploadId;
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', headers,
      body: file.slice(offset, end, file.type),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
    if (!response.ok) {
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const first = await send(0);
  const offsets = [];
  for (let offset = chunkBytes; offset < file.size; offset += chunkBytes) offsets.push(offset);
  let completed = null;
  for (let index = 0; index < offsets.length; index += 4) {
    const results = await Promise.all(offsets.slice(index, index + 4)
      .map((offset) => send(offset, first.uploadId)));
    completed = results.find((result) => result?.complete) ?? completed;
  }
  if (!completed) throw new Error('Upload konnte nicht abgeschlossen werden.');
  return completed;
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
      tab('konfiguration', 'Konfiguration'),
      tab('kennwoerter', 'Kennwörter'),
      tab('werbung', 'Werbung vor der Seite')),
    h('main.cx-main', null,
      screen === 'lage' ? lageView()
        : screen === 'konfiguration' ? konfigurationView()
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

// --- runtime configuration -------------------------------------------------

function konfigurationView() {
  const root = h('div.stack', null, h('p.muted', null, 'Konfiguration wird geladen …'));

  $('/api/superadmin/settings').then(({ settings }) => {
    clear(root);
    const publicUrl = h('input', { value: settings.publicUrl });
    const smtpHost = h('input', { value: settings.mail.host, placeholder: 'smtp.example.org' });
    const smtpPort = h('input', { type: 'number', min: 1, max: 65535, value: settings.mail.port });
    const smtpSecure = h('input', { type: 'checkbox', checked: settings.mail.secure });
    const smtpUser = h('input', { value: settings.mail.user, autocomplete: 'off' });
    const smtpPass = h('input', {
      type: 'password', autocomplete: 'new-password',
      placeholder: settings.mail.passwordConfigured ? 'Gespeichertes Passwort beibehalten' : 'SMTP-Passwort',
    });
    const mailFrom = h('input', { value: settings.mail.from });
    const startingCoins = h('input', { type: 'number', min: 0, value: settings.game.startingCoins });
    const maxPlayers = h('input', { type: 'number', min: 2, max: 5000, value: settings.game.maxPlayersPerWorld });
    const protection = h('input', { type: 'number', min: 0, max: 10080, value: settings.game.newbieProtectionMinutes });
    const adCoins = h('input', { type: 'number', min: 0, value: settings.game.adRewardCoins });
    const adCooldown = h('input', { type: 'number', min: 0, max: 86400, value: settings.game.adRewardCooldownSeconds });
    const mediaLimit = h('input', { type: 'number', min: 1, max: 1024, value: settings.uploads.maxMediaMiB });
    const testAddress = h('input', { type: 'email', value: overview.superadminEmail });

    const save = async () => {
      try {
        const { settings: saved } = await $('/api/superadmin/settings', {
          method: 'PATCH',
          body: {
            publicUrl: publicUrl.value.trim(),
            mail: {
              host: smtpHost.value.trim(), port: Number(smtpPort.value), secure: smtpSecure.checked,
              user: smtpUser.value.trim(), pass: smtpPass.value, from: mailFrom.value.trim(),
            },
            game: {
              startingCoins: Number(startingCoins.value), maxPlayersPerWorld: Number(maxPlayers.value),
              newbieProtectionMinutes: Number(protection.value),
              adRewardCoins: Number(adCoins.value), adRewardCooldownSeconds: Number(adCooldown.value),
            },
            uploads: { maxMediaMiB: Number(mediaLimit.value) },
          },
        });
        smtpPass.value = '';
        smtpPass.placeholder = saved.mail.passwordConfigured
          ? 'Gespeichertes Passwort beibehalten' : 'SMTP-Passwort';
        overview.mailConfigured = Boolean(saved.mail.host);
        toast('Konfiguration gespeichert und sofort übernommen.', 'good');
      } catch (error) { toast(error.message, 'bad'); }
    };

    add(root,
      h('p.lede', null,
        'Diese Werte werden dauerhaft gespeichert und ohne Neustart übernommen. Zugangsdaten '
        + 'werden mit dem Sitzungsschlüssel verschlüsselt in der Datenbank abgelegt.'),
      h('div.cx-card', null,
        h('h2', null, 'Seite'),
        field('Öffentliche Basis-URL', publicUrl)),
      h('div.cx-card', null,
        h('h2', null, 'E-Mail / SMTP'),
        h('div.cx-form-grid', null,
          field('SMTP-Host', smtpHost), field('Port', smtpPort),
          field('Benutzer', smtpUser), field('Passwort', smtpPass),
          field('Absender', mailFrom),
          h('label.row', null, smtpSecure, h('span', null, 'Direktes TLS (typisch Port 465)'))),
        h('div.row', null,
          testAddress,
          h('button', {
            onClick: async () => {
              try {
                const result = await $('/api/superadmin/settings/test-mail', {
                  method: 'POST', body: { to: testAddress.value.trim() },
                });
                toast(`Testnachricht: ${result.delivered}`, 'good');
              } catch (error) { toast(error.message, 'bad'); }
            },
          }, 'Testmail senden'))),
      h('div.cx-card', null,
        h('h2', null, 'Spiel und Uploads'),
        h('div.cx-form-grid', null,
          field('Startmünzen für neue Kapitäne', startingCoins),
          field('Standard-Spielerlimit pro Welt', maxPlayers),
          field('Anfängerschutz (Minuten)', protection),
          field('Münzen für eine angesehene Werbung', adCoins),
          field('Sperrfrist zwischen zwei Werbe-Münzen (Sekunden)', adCooldown),
          field('Werbe-Uploadlimit (MiB, max. 1024)', mediaLimit))),
      h('button.primary', { onClick: save }, 'Alles speichern'));
  }).catch((error) => {
    clear(root);
    root.append(h('p.bad', null, error.message));
  });

  return root;
}

function field(label, control) {
  return h('div.field', null, h('label', null, label), control);
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
  const file = h('input', { type: 'file', accept: 'image/webp,image/png,image/jpeg,video/mp4,video/webm,video/quicktime' });

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
      item.video ? h('video.cx-thumb', { src: item.video, controls: true, preload: 'metadata' })
        : item.image ? h('img.cx-thumb', { src: item.image, alt: '' }) : null,
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
          h('label.btn.small', null, 'Medium ersetzen',
            h('input', {
              type: 'file', accept: 'image/webp,image/png,image/jpeg,video/mp4,video/webm,video/quicktime', style: { display: 'none' },
              onChange: async (event) => {
                const picked = event.target.files?.[0];
                if (!picked) return;
                try {
                  await $(`/api/superadmin/interstitials/${item.id}/image`, { method: 'POST', file: picked });
                  toast('Medium ersetzt', 'good');
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
      // Optional media is uploaded after the row exists, so rejected bytes
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
      h('div.field', null, h('label', null, 'Bild oder Video (WebP, PNG, JPEG, MP4, WebM, MOV; max. 1 GB; optional)'), file),
      h('button.primary', { onClick: create }, 'Anlegen')),
    h('h2', null, 'Angelegte Werbung'),
    list);
}

boot();
