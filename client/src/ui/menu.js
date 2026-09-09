/**
 * Main menu.
 *
 * Compact and fast: a fixed nav column and one content pane, no page loads.
 * Every screen talks to the real API - the world list is the server's world
 * list, the leaderboard is the server's leaderboard, and "Play" starts an
 * actual session.
 */
import { h, add, clear, toast, modal, confirmDialog } from './dom.js';
import { t, tc, td, currentLocale } from '../state/i18n.js';
import { api, ApiError } from '../net/api.js';
import { settings } from '../state/settings.js';
import { settingsView, applyTheme } from './settingsPanel.js';
import { languageGrid, setLocale } from './language.js';
import { adminView } from './admin.js';
import { manualView } from './manual.js';

export class MainMenu {
  constructor({ onPlay, onLogout }) {
    this.onPlay = onPlay;
    this.onLogout = onLogout;
    this.screen = 'play';
    this.session = null;
    this.root = h('div#menu-screen');
    this.nav = h('div.menu-nav');
    this.main = h('div.menu-main');
    this.root.append(h('div.menu-shell', null, this.nav, this.main));
  }

  mount(parent) {
    parent.append(this.root);
    this.render();
    return this;
  }

  unmount() { this.root.remove(); }

  async refreshSession() {
    try {
      const response = await api.me();
      this.session = response?.user ? response : null;
    } catch {
      this.session = null;
    }
    return this.session;
  }

  get canAdminister() {
    const permissions = this.session?.permissions ?? [];
    return permissions.includes('*')
      || permissions.some((p) => p.startsWith('users.') || p.startsWith('roles.') || p.startsWith('world.'));
  }

  render() {
    this.renderNav();
    this.renderMain();
  }

  renderNav() {
    clear(this.nav);
    const item = (key, label) => h(`button${this.screen === key ? '.is-active' : ''}`, {
      onClick: () => { this.screen = key; this.render(); },
    }, label);

    add(this.nav,
      h('div.logo', null,
        h('h1', null, t('app.name')),
        h('p', null, t('app.tagline'))),
      item('play', t('menu.play')),
      item('multiplayer', t('menu.multiplayer')),
      item('profile', t('menu.profile')),
      item('leaderboard', t('leaderboard.title')),
      item('manual', t('menu.manual')),
      item('news', t('menu.news')),
      item('support', t('menu.support')),
      item('settings', t('menu.settings')),
      item('server', t('menu.serverStatus')),
      // The administration entry only exists for accounts that hold a
      // permission for it: an ordinary player never sees it.
      this.canAdminister ? item('admin', t('admin.title')) : null,
      h('div.spacer'),
      this.session
        ? h('button', {
          onClick: async () => {
            await api.logout();
            this.session = null;
            this.onLogout?.();
            this.render();
          },
        }, t('menu.logout'))
        : null,
    );
  }

  renderMain() {
    clear(this.main);
    const view = {
      play: () => this.playScreen(),
      multiplayer: () => this.multiplayerScreen(),
      profile: () => this.profileScreen(),
      leaderboard: () => this.leaderboardScreen(),
      manual: () => manualView(),
      news: () => this.newsScreen(),
      support: () => this.supportScreen(),
      settings: () => this.settingsScreen(),
      server: () => this.serverScreen(),
      admin: () => adminView(this.session),
    }[this.screen];
    add(this.main, view ? view() : h('div'));
  }

  // --- play ---------------------------------------------------------------

  playScreen() {
    const root = h('div');
    root.append(
      h('h2', null, t('menu.play')),
      h('p.lede', null, t('mode.traderDesc')),
    );

    if (!this.session) {
      root.append(this.authCard());
      return root;
    }

    const list = h('div.stack');
    root.append(
      h('div.card', null,
        h('div.card__title', null, t('menu.loadGame')),
        list),
      h('div.row', { style: { marginTop: '12px' } },
        h('button.primary', { onClick: () => this.newGameDialog() }, t('menu.newGame'))),
    );

    api.characters().then(({ characters }) => {
      clear(list);
      if (characters.length === 0) {
        list.append(h('p.muted', null, t('common.empty')));
        return;
      }
      for (const character of characters) {
        list.append(h('div.card.card--pick', {
          onClick: () => this.onPlay?.(character),
        },
        h('div.row.row--between', null,
          h('div', null,
            h('strong', null, character.name),
            h('div.small.muted', null,
              `${character.worldName} · ${t(`mode.${character.mode}`)} · ${t('profile.level')} ${character.level}`)),
          h('div.right', null,
            h('div.mono', null, `${tc(character.coins)} ${t('unit.coins')}`),
            h('div.small.muted', null, td(character.lastSeenAt)))),
        ));
      }
    }).catch((error) => {
      clear(list);
      list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    });

    return root;
  }

  async newGameDialog() {
    const { worlds } = await api.worlds();
    const open = worlds.filter((w) => w.status === 'open');
    if (open.length === 0) {
      toast(t('error.worldNotFound'), 'bad');
      return;
    }

    let selectedWorld = open[0].id;
    let selectedMode = 'trader';
    const nameInput = h('input', { placeholder: t('common.name'), maxLength: 24, autofocus: true });

    const worldCards = h('div.stack', null, ...open.map((world) =>
      h(`div.card.card--pick${world.id === selectedWorld ? '.is-active' : ''}`, {
        onClick: (event) => {
          selectedWorld = world.id;
          for (const card of event.currentTarget.parentElement.children) card.classList.remove('is-active');
          event.currentTarget.classList.add('is-active');
        },
      },
      h('div.row.row--between', null,
        h('strong', null, world.name),
        h('span.small.muted', null, `${world.online} ${t('server.players', { count: world.online })}`)),
      h('div.small.muted.mono', null, `${t('server.seed')} ${world.seed}`))));

    const modeCards = h('div.grid-2', null, ...['trader', 'explorer'].map((mode) =>
      h(`div.card.card--pick${mode === selectedMode ? '.is-active' : ''}`, {
        onClick: (event) => {
          selectedMode = mode;
          for (const card of event.currentTarget.parentElement.children) card.classList.remove('is-active');
          event.currentTarget.classList.add('is-active');
        },
      },
      h('div.card__title', null, t(`mode.${mode}`)),
      h('div.small.muted', null, t(`mode.${mode}Desc`)))));

    modal({
      title: t('menu.newGame'),
      wide: true,
      body: h('div.stack', null,
        h('div.field', null, h('label', null, t('common.name')), nameInput),
        h('div', null, h('div.card__title', null, t('mode.title')), modeCards),
        h('div', null, h('div.card__title', null, t('server.worlds')), worldCards)),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('menu.play'),
          primary: true,
          onClick: async (close) => {
            const name = nameInput.value.trim();
            if (name.length < 2) { toast(t('error.validation'), 'bad'); return false; }
            try {
              const created = await api.createCharacter({ worldId: selectedWorld, name, mode: selectedMode });
              close();
              this.onPlay?.(created.character);
            } catch (error) {
              toast(t(error.code ?? 'error.generic'), 'bad');
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  // --- auth ---------------------------------------------------------------

  authCard() {
    const root = h('div.card');
    let mode = 'login';

    const render = () => {
      clear(root);
      const identifier = h('input', { placeholder: t('auth.email'), autocomplete: 'username' });
      const email = h('input', { placeholder: t('auth.email'), type: 'email', autocomplete: 'email' });
      const username = h('input', { placeholder: t('auth.username'), autocomplete: 'nickname' });
      const password = h('input', { placeholder: t('auth.password'), type: 'password', autocomplete: 'current-password' });

      const submit = async () => {
        try {
          if (mode === 'login') {
            await api.login(identifier.value.trim(), password.value);
          } else {
            await api.register({
              email: email.value.trim(),
              username: username.value.trim(),
              password: password.value,
              locale: currentLocale(),
            });
          }
          await this.refreshSession();
          toast(t('app.name'), 'good');
          this.render();
        } catch (error) {
          toast(t(error.code ?? 'error.generic'), 'bad');
        }
      };

      add(root,
        h('div.card__title', null, mode === 'login' ? t('auth.login') : t('auth.register')),
        mode === 'login'
          ? h('div.field', null, h('label', null, `${t('auth.email')} / ${t('auth.username')}`), identifier)
          : h('div', null,
            h('div.field', null, h('label', null, t('auth.email')), email),
            h('div.field', null, h('label', null, t('auth.username')), username)),
        h('div.field', null, h('label', null, t('auth.password')), password),
        h('div.row', null,
          h('button.primary', { onClick: submit }, mode === 'login' ? t('auth.login') : t('auth.register')),
          h('button.ghost', {
            onClick: () => { mode = mode === 'login' ? 'register' : 'login'; render(); },
          }, mode === 'login' ? t('auth.noAccount') : t('auth.hasAccount')),
          mode === 'login'
            ? h('button.ghost', { onClick: () => this.forgotPasswordDialog() }, t('auth.forgotPassword'))
            : null),
      );

      for (const field of [identifier, email, username, password]) {
        field.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
      }
    };

    render();
    return root;
  }

  forgotPasswordDialog() {
    const email = h('input', { type: 'email', placeholder: t('auth.email') });
    modal({
      title: t('auth.resetPassword'),
      body: h('div', null,
        h('div.field', null, h('label', null, t('auth.email')), email),
        h('p.small.muted', null, t('auth.resetSent'))),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('auth.resetPassword'),
          primary: true,
          onClick: async () => {
            await api.forgotPassword(email.value.trim()).catch(() => {});
            toast(t('auth.resetSent'), 'info');
          },
        },
      ],
    });
  }

  // --- other screens ------------------------------------------------------

  multiplayerScreen() {
    const root = h('div', null, h('h2', null, t('menu.multiplayer')), h('p.lede', null, t('server.worlds')));
    const list = h('div.stack');
    root.append(list);

    api.worlds().then(async ({ worlds }) => {
      clear(list);
      for (const world of worlds) {
        const card = h('div.card', null,
          h('div.row.row--between', null,
            h('div', null,
              h('strong', null, world.name),
              h('div.small.muted.mono', null, `${t('server.seed')} ${world.seed}`)),
            h('div.right', null,
              h('div', null, t('server.players', { count: world.online })),
              h('div.small.muted', null, world.status === 'open' ? t('server.online') : t('server.maintenance')))));
        list.append(card);

        api.worldStatus(world.id).then((status) => {
          if (!status.loaded) return;
          card.append(h('dl.kv', { style: { marginTop: '8px' } },
            h('dt', null, t('server.tick')), h('dd', null, `${status.tps.toFixed(1)} /s`),
            h('dt', null, 'NPC'), h('dd', null, String(status.npcs)),
            h('dt', null, t('weather.storm')), h('dd', null, String(status.storms)),
            h('dt', null, t('season.spring')), h('dd', null, t(seasonKey(status.season)))));
        }).catch(() => {});
      }
    }).catch(() => list.append(h('p.bad', null, t('error.network'))));

    return root;
  }

  profileScreen() {
    const root = h('div', null, h('h2', null, t('profile.title')));
    if (!this.session) { root.append(this.authCard()); return root; }

    const user = this.session.user;
    add(root,
      h('div.card', null,
        h('div.card__title', null, user.username),
        h('dl.kv', null,
          h('dt', null, t('auth.email')), h('dd', null, user.email),
          h('dt', null, t('profile.joined')), h('dd', null, td(user.createdAt)),
          h('dt', null, t('auth.verifyEmail')), h('dd', null, user.emailVerified ? '✓' : '✗'),
          h('dt', null, t('menu.language')), h('dd', null, currentLocale()),
          h('dt', null, 'Roles'), h('dd', null, (this.session.roles ?? []).join(', ') || '—'))),
      !user.emailVerified
        ? h('div.card', null,
          h('p', null, t('auth.verifySent')),
          h('button', { onClick: async () => { await api.resendVerification(); toast(t('auth.verifySent'), 'info'); } },
            t('auth.verifyEmail')))
        : null,
      h('div.card', null,
        h('div.card__title', null, t('auth.changePassword')),
        this.passwordForm()),
      h('div.card', null,
        h('div.card__title', null, t('auth.sessions')),
        this.sessionsList()),
      h('div.card', null,
        h('div.card__title', null, t('common.actions')),
        h('div.row', null,
          h('button', { onClick: () => this.exportData() }, t('auth.exportData')),
          h('button.danger', { onClick: () => this.deleteAccountDialog() }, t('auth.deleteAccount')))),
    );
    return root;
  }

  passwordForm() {
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password' });
    return h('div', null,
      h('div.field', null, h('label', null, t('auth.currentPassword')), current),
      h('div.field', null, h('label', null, t('auth.newPassword')), next),
      h('button.primary', {
        onClick: async () => {
          try {
            await api.changePassword(current.value, next.value);
            current.value = ''; next.value = '';
            toast(t('auth.resetDone'), 'good');
          } catch (error) {
            toast(t(error.code ?? 'error.generic'), 'bad');
          }
        },
      }, t('auth.changePassword')));
  }

  sessionsList() {
    const list = h('div.stack');
    api.sessions().then(({ sessions }) => {
      clear(list);
      for (const item of sessions) {
        add(list, h('div.row.row--between', null,
          h('div', null,
            h('div.small', null, item.current ? `${item.ip ?? '—'} (this device)` : (item.ip ?? '—')),
            h('div.small.muted', null, `${td(item.lastSeenAt)} · ${(item.userAgent ?? '').slice(0, 48)}`)),
          item.current ? null : h('button.ghost', {
            onClick: async () => { await api.revokeSession(item.id); toast(t('common.ok'), 'good'); },
          }, t('auth.revokeSession'))));
      }
      list.append(h('button.danger', {
        onClick: async () => { await api.revokeAllSessions(); toast(t('common.ok'), 'good'); },
      }, t('auth.revokeAll')));
    }).catch(() => list.append(h('p.bad', null, t('error.network'))));
    return list;
  }

  async exportData() {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `schiffi-export-${Date.now()}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  deleteAccountDialog() {
    const password = h('input', { type: 'password', placeholder: t('auth.password') });
    modal({
      title: t('auth.deleteAccount'),
      body: h('div', null, h('p.bad', null, t('auth.deleteWarning')),
        h('div.field', null, h('label', null, t('auth.password')), password)),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('auth.deleteAccount'), danger: true,
          onClick: async () => {
            try {
              await api.deleteAccount(password.value);
              this.session = null;
              this.onLogout?.();
              this.render();
            } catch (error) {
              toast(t(error.code ?? 'error.generic'), 'bad');
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  leaderboardScreen() {
    const root = h('div', null, h('h2', null, t('leaderboard.title')));
    const body = h('div');
    root.append(body);
    let board = 'wealth';

    const load = async () => {
      clear(body);
      const { worlds } = await api.worlds();
      if (!worlds.length) { body.append(h('p.muted', null, t('common.empty'))); return; }
      const worldId = worlds[0].id;

      body.append(h('div.row', { style: { marginBottom: '10px', flexWrap: 'wrap' } },
        ...[['wealth', 'leaderboard.wealth'], ['trade', 'leaderboard.trade'],
          ['discoveries', 'leaderboard.discoveries'], ['level', 'profile.level'],
          ['distance', 'cartography.coverage']].map(([key, label]) =>
          h(`button${board === key ? '.primary' : '.ghost'}`, {
            onClick: () => { board = key; load(); },
          }, t(label)))));

      const { entries } = await api.leaderboard(worldId, board);
      const table = h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, t('leaderboard.rank')),
          h('th', null, t('common.name')),
          h('th.right', null, t('common.total')))),
        h('tbody', null, ...entries.map((entry) =>
          h('tr', null,
            h('td.mono', null, String(entry.rank)),
            h('td', null, entry.name),
            h('td.right.mono', null, tc(entry.score))))));
      body.append(entries.length ? table : h('p.muted', null, t('common.empty')));
    };
    load().catch(() => body.append(h('p.bad', null, t('error.network'))));
    return root;
  }

  newsScreen() {
    return h('div', null,
      h('h2', null, t('news.title')),
      h('p.lede', null, t('news.noNews')));
  }

  supportScreen() {
    const subject = h('input', { placeholder: t('support.subject') });
    const message = h('textarea', { rows: 6, placeholder: t('support.message') });
    return h('div', null,
      h('h2', null, t('support.title')),
      h('div.card', null,
        h('div.card__title', null, t('support.newTicket')),
        h('div.field', null, h('label', null, t('support.subject')), subject),
        h('div.field', null, h('label', null, t('support.message')), message),
        h('button.primary', {
          onClick: async () => {
            if (!this.session) { toast(t('error.unauthorized'), 'bad'); return; }
            try {
              await api.post('/api/support/tickets', {
                subject: subject.value.trim(), body: message.value.trim(),
              });
              subject.value = ''; message.value = '';
              toast(t('support.created'), 'good');
            } catch (error) {
              toast(t(error.code ?? 'error.generic'), 'bad');
            }
          },
        }, t('support.newTicket'))));
  }

  settingsScreen() {
    return h('div', null,
      h('h2', null, t('settings.title')),
      settingsView({ onChange: () => this.onSettingsChange?.() }));
  }

  serverScreen() {
    const root = h('div', null, h('h2', null, t('server.status')));
    const body = h('div');
    root.append(body);

    api.status().then((status) => {
      clear(body);
      body.append(h('div.card', null,
        h('dl.kv', null,
          h('dt', null, t('server.status')), h('dd', null, t('server.online')),
          h('dt', null, t('server.uptime')), h('dd', null, formatDuration(status.uptimeMs)),
          h('dt', null, t('server.players', { count: status.playersOnline })), h('dd', null, String(status.playersOnline)),
          h('dt', null, t('trade.buy')), h('dd', null, String(status.goods)),
          h('dt', null, t('menu.language')), h('dd', null, String(status.locales.length)))));
    }).catch(() => body.append(h('p.bad', null, t('app.offline'))));

    return root;
  }
}

function seasonKey(season) {
  return ['season.spring', 'season.summer', 'season.autumn', 'season.winter'][season % 4];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export { applyTheme };
