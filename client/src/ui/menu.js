/**
 * The site outside the game.
 *
 * Every screen here is a real page with a real address - /support, /news,
 * /advertise and the rest - so a link can be sent, a tab bookmarked and the
 * back button trusted. Navigation stays client-side (nothing is re-downloaded
 * on a click) while the URL follows along, and the server returns the same
 * shell for all of these paths so a reload lands where the visitor was.
 *
 * What is deliberately absent: any mention of a superadmin console. That is a
 * separate document, served by the server to one account, and nothing in this
 * bundle links to it, names it or knows it exists.
 */
import { h, add, clear, toast, modal, confirmDialog } from './dom.js';
import { t, tc, td, currentLocale } from '../state/i18n.js';
import { api, ApiError } from '../net/api.js';
import { settings } from '../state/settings.js';
import { settingsView, applyTheme } from './settingsPanel.js';
import { languageGrid, setLocale } from './language.js';
import { adminView } from './admin.js';
import { manualView } from './manual.js';
import { avatarCard, placeholder } from './avatar.js';
import { countdown } from './panels/missions.js';

/**
 * Every address the site answers to.
 *
 * The server returns the application shell for all of them, so these are real
 * URLs rather than fragments: /support can be linked to, reloaded and shared.
 */
const ROUTES = {
  '/': 'play',
  '/play': 'play',
  '/worlds': 'multiplayer',
  '/leaderboard': 'leaderboard',
  '/news': 'news',
  '/manual': 'manual',
  '/support': 'support',
  '/advertise': 'ads',
  '/profile': 'profile',
  '/settings': 'settings',
  '/status': 'status',
  '/admin': 'admin',
};

/** The canonical path for a screen: the first entry that names it. */
const PATHS = Object.entries(ROUTES).reduce((out, [path, screen]) => {
  if (!(screen in out)) out[screen] = path;
  return out;
}, { notFound: '/404' });

export class MainMenu {
  constructor({ onPlay, onLogout }) {
    this.onPlay = onPlay;
    this.onLogout = onLogout;
    this.screen = 'play';
    this.session = null;
    this.root = h('div#menu-screen');
    this.nav = h('nav.site-nav');
    this.main = h('main.site-main');
    this.brand = h('a.site-brand', { href: '/', onClick: (e) => { e.preventDefault(); this.go('play'); } },
      h('span.site-brand__mark', { 'aria-hidden': 'true' }),
      h('span.site-brand__name', null, 'Schiffi'));
    this.account = h('div.site-account');
    this.footer = h('footer.site-footer');
    this.root.append(
      h('header.site-header', null,
        h('div.site-header__inner', null, this.brand, this.nav, this.account)),
      this.main,
      this.footer);
  }

  mount(parent) {
    parent.append(this.root);
    this.render();
    this.loadBackdrop();
    return this;
  }

  /**
   * Put the actual world behind the menu.
   *
   * The image is the server's portrait of the world this installation runs -
   * one small PNG, cached immutably, decoded by the browser off the main
   * thread. It is set as a custom property so the stylesheet owns how it is
   * presented, and a failure here is silent by design: the menu already looks
   * finished without it, and a player on a bad connection should not be shown
   * an error about a background.
   */
  async loadBackdrop() {
    if (this.backdropLoaded) return;
    // Data saver means the player asked not to download decoration.
    if (settings.get('dataSaver')) return;

    try {
      const { worlds } = await api.worlds();
      const world = worlds?.[0];
      if (!world) return;
      const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      const url = `/api/worlds/${world.id}/portrait.png?theme=${theme}`;

      // Decode before showing it: swapping the property while the PNG is still
      // arriving makes the menu flash a half-painted map.
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      this.root.style.setProperty('--world-portrait', `url("${url}")`);
      this.backdropLoaded = true;
    } catch { /* no backdrop: the gradient stands on its own */ }
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
    return permissions.some((p) =>
      p.startsWith('users.') || p.startsWith('roles.') || p.startsWith('world.')
      || p.startsWith('support.') || p.startsWith('news.') || p === 'ads.view');
  }

  /**
   * The screen behind a path, and the path behind a screen.
   *
   * One table, read in both directions, so a URL and a nav button can never
   * drift apart. An unknown path is not silently turned into the home page -
   * it becomes the notFound screen, because a mistyped address that quietly
   * shows something else is worse than one that says so.
   */
  static routeFor(pathname) {
    const path = String(pathname || '/').replace(/\/+$/, '') || '/';
    return ROUTES[path] ?? 'notFound';
  }

  static pathFor(screen) {
    return PATHS[screen] ?? '/';
  }

  applyRoute() {
    this.screen = MainMenu.routeFor(location.pathname);
  }

  /** Go to a screen and put its address in the bar. */
  go(screen, { push = true } = {}) {
    if (this.screen === screen && push) return;
    this.screen = screen;
    const wanted = MainMenu.pathFor(screen);
    if (push && location.pathname !== wanted) {
      history.pushState({ screen }, '', wanted);
    }
    this.render();
    this.main.scrollTop = 0;
  }

  render() {
    this.renderNav();
    this.renderMain();
    this.renderFooter();
  }

  /**
   * Footer: the pages that do not earn a place in the header, and the adverts.
   *
   * The adverts are real ones - approved by a reviewer, counted by the server
   * when they are handed out, and counted again when they are clicked. Data
   * saver skips the request entirely, because somebody who asked for less
   * traffic should not be spending it on advertising.
   */
  renderFooter() {
    clear(this.footer);
    const link = (screen, label) => h('button.site-footer__link', {
      onClick: () => this.go(screen),
    }, label);

    const ads = h('div.site-ads');
    add(this.footer,
      ads,
      h('div.site-footer__links', null,
        link('status', t('menu.serverStatus')),
        link('ads', t('ads.mine')),
        link('support', t('menu.support')),
        link('manual', t('menu.manual')),
        h('span.grow'),
        h('span.small.muted', null, `Schiffi · ${new Date().getFullYear()}`)));

    if (settings.get('dataSaver')) return;
    api.ads().then(({ ads: items }) => {
      if (!items.length) return;
      for (const ad of items) {
        add(ads, h('a.site-ad', {
          href: ad.targetUrl, target: '_blank', rel: 'noopener noreferrer sponsored',
          onClick: () => { api.adClick(ad.id).catch(() => {}); },
        },
        ad.image ? h('img.site-ad__image', { src: ad.image, alt: '', loading: 'lazy' }) : null,
        h('div', null,
          h('strong', null, ad.title),
          h('div.small.muted', null, ad.body))));
      }
      ads.append(h('div.small.muted.site-ads__label', null, t('promo.note')));
    }).catch(() => { /* no adverts: the footer stands without them */ });
  }

  renderNav() {
    clear(this.nav);
    clear(this.account);

    // Only rebuild what changed: the active class is the only thing a click
    // alters up here, so the buttons themselves are created once per render
    // and the handler never touches the rest of the page.
    const item = (key, label) => h(`button.site-nav__link${this.screen === key ? '.is-active' : ''}`, {
      onClick: () => this.go(key),
    }, label);

    add(this.nav,
      item('play', t('menu.play')),
      item('multiplayer', t('menu.multiplayer')),
      item('leaderboard', t('leaderboard.title')),
      item('news', t('menu.news')),
      item('manual', t('menu.manual')),
      item('support', t('menu.support')),
      // Advertising is only offered to accounts that may actually submit one.
      this.can('ads.submit') ? item('ads', t('ads.mine')) : null,
      // The administration entry only exists for accounts that hold a
      // permission for it: an ordinary player never sees it.
      this.canAdminister ? item('admin', t('admin.title')) : null,
    );

    add(this.account,
      h('button.icon-link', { onClick: () => this.go('settings'), title: t('menu.settings') }, '\u2699'),
      this.session
        ? h('div.site-account__user', null,
          h('button.site-account__name', { onClick: () => this.go('profile') },
            this.session.user.username),
          h('button.ghost.small', {
            onClick: async () => {
              await api.logout();
              this.session = null;
              this.onLogout?.();
              this.go('play', { push: false });
            },
          }, t('menu.logout')))
        : h('button.primary.small', { onClick: () => this.go('play') }, t('auth.login')),
    );
  }

  /** Does the signed-in account hold this permission? */
  can(permission) {
    return (this.session?.permissions ?? []).includes(permission);
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
      status: () => this.serverScreen(),
      ads: () => this.adsScreen(),
      admin: () => adminView(this.session),
      notFound: () => this.notFoundScreen(),
    }[this.screen];
    add(this.main, view ? view() : h('div'));
  }

  // --- play ---------------------------------------------------------------

  playScreen() {
    const root = h('div');

    // Signed out, this is the front page rather than a form on an empty
    // screen: what the game is, what the server is doing right now, and the
    // sign-in beside it.
    if (!this.session) {
      const facts = h('div.hero__facts');
      api.status().then((status) => {
        clear(facts);
        add(facts,
          fact(String(status.goods), t('app.factGoods')),
          fact(String(status.locales.length), t('app.factLanguages')),
          fact(String(status.playersOnline), t('app.factOnline')));
      }).catch(() => { /* the hero reads fine without the numbers */ });

      add(root, h('div.hero', null,
        h('div.hero__text', null,
          h('h2', null, t('app.tagline')),
          h('p.lede', null, t('mode.traderDesc')),
          facts),
        this.authCard()));
      return root;
    }

    root.append(
      h('h2', null, t('menu.play')),
      h('p.lede', null, t('mode.traderDesc')),
    );

    const list = h('div.stack');
    // Filled in once the character list is known: with no captain it offers to
    // start one immediately, with a captain it offers to sail on.
    const lead = h('div.lead-action');

    root.append(
      lead,
      h('div.card', null,
        h('div.card__title', null, t('menu.loadGame')),
        list),
      h('div.row', { style: { marginTop: '12px' } },
        h('button', { onClick: () => this.newGameDialog() }, t('menu.newGame'))),
    );

    api.characters().then(({ characters }) => {
      clear(list);
      clear(lead);

      if (characters.length === 0) {
        // Nothing between a new account and the sea but one button. The
        // dialog is still there for anyone who wants to choose a name, a mode
        // and a world - it is just no longer compulsory.
        lead.append(
          h('button.primary.btn-lead', { onClick: () => this.quickStart() }, t('menu.quickStart')),
          h('p.small.muted', null, t('menu.quickStartHint')));
        list.append(h('p.muted', null, t('common.empty')));
        return;
      }

      // One captain is the common case; sail on without making the player
      // pick out of a list of one.
      const recent = [...characters].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
      lead.append(
        h('button.primary.btn-lead', { onClick: () => this.onPlay?.(recent) },
          `${t('menu.continue')} · ${recent.name}`),
        h('p.small.muted', null,
          `${recent.worldName} · ${t(`mode.${recent.mode}`)} · ${t('profile.level')} ${recent.level}`));
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

/**
   * Start playing in one click.
   *
   * Picks the first open world and the trader mode, and names the captain
   * after the account. Everything it chooses can be changed later in the game;
   * what it removes is the three-screen gap between registering and seeing the
   * sea, which is where every new player was being lost.
   */
  async quickStart() {
    try {
      const { worlds } = await api.worlds();
      const world = worlds.find((w) => w.status === 'open');
      if (!world) { toast(t('error.worldNotFound'), 'bad'); return; }

      const base = (this.session?.user?.username ?? 'Kapitaen').slice(0, 24);
      const created = await api.createCharacter({ worldId: world.id, name: base, mode: 'trader' });
      this.onPlay?.(created.character);
    } catch (error) {
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
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
    // Pre-filled from the account name: a blank required field is the most
    // common reason a player bounces off a character creation screen.
    const nameInput = h('input', {
      placeholder: t('common.name'), maxLength: 24, autofocus: true,
      value: this.session?.user?.username ?? '',
    });

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
            h('dt', null, t('hud.season')), h('dd', null, t(seasonKey(status.season)))));
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
      avatarCard(this.session, (avatar) => { user.avatar = avatar; }),
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

  /**
   * Rankings, live and frozen.
   *
   * The live boards are recomputed from current state every time they are
   * asked for; a closed season's boards are the standings as they stood when
   * it ended. Both come from the server, and the season picker makes clear
   * which of the two is on screen.
   */
  leaderboardScreen() {
    const root = h('div', null, h('h2', null, t('leaderboard.title')));
    const body = h('div');
    root.append(body);
    let board = 'wealth';
    let seasonId = null;

    const BOARDS = [
      ['wealth', 'leaderboard.wealth'],
      ['trade', 'leaderboard.trade'],
      ['discoveries', 'leaderboard.discoveries'],
      ['level', 'leaderboard.level'],
      ['distance', 'leaderboard.distance'],
    ];

    const load = async () => {
      clear(body);
      const [{ worlds }, seasonInfo] = await Promise.all([
        api.worlds(),
        api.seasons().catch(() => null),
      ]);
      if (!worlds.length) { body.append(h('p.muted', null, t('common.empty'))); return; }
      const worldId = worlds[0].id;

      if (seasonInfo?.current) {
        const closed = seasonInfo.seasons.filter((season) => season.closedAt);
        const left = countdown(seasonInfo.current.endsAt - Date.now());
        body.append(h('div.row', { style: { marginBottom: '10px', flexWrap: 'wrap' } },
          h(`button${seasonId === null ? '.primary' : '.ghost'}`, {
            onClick: () => { seasonId = null; load(); },
          }, `${t('leaderboard.current')}${left ? ` · ${t('leaderboard.endsIn', { time: left })}` : ''}`),
          ...closed.map((season) =>
            h(`button${String(seasonId) === String(season.id) ? '.primary' : '.ghost'}`, {
              onClick: () => { seasonId = season.id; load(); },
            }, t('leaderboard.season', { number: season.number })))));
      }

      body.append(h('div.row', { style: { marginBottom: '10px', flexWrap: 'wrap' } },
        ...BOARDS.map(([key, label]) =>
          h(`button${board === key ? '.primary' : '.ghost'}`, {
            onClick: () => { board = key; load(); },
          }, t(label)))));

      const { entries } = seasonId === null
        ? await api.leaderboard(worldId, board)
        : await api.seasonBoard(seasonId, worldId, board);

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
      body.append(entries.length
        ? table
        : h('p.muted', null, t(seasonId === null ? 'common.empty' : 'leaderboard.empty')));
    };
    load().catch(() => body.append(h('p.bad', null, t('error.network'))));
    return root;
  }

  newsScreen() {
    const root = h('div', null, h('h2', null, t('news.title')));
    const body = h('div.stack', null, h('p.small.muted', null, t('common.loading')));
    root.append(body);

    api.news(currentLocale()).then(({ posts }) => {
      clear(body);
      if (!posts.length) {
        body.append(h('p.lede', null, t('news.noNews')));
        return;
      }
      for (const post of posts) {
        body.append(h('div.card', null,
          h('div.card__title', null, post.title),
          h('div.small.muted', null,
            t('news.published', { date: new Date(post.publishedAt).toLocaleDateString(currentLocale()) })),
          // Server text, so it goes in as text: never as markup.
          h('p', { style: { whiteSpace: 'pre-wrap' } }, post.body)));
      }
    }).catch((error) => {
      clear(body);
      body.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    });

    return root;
  }

  /**
   * Support.
   *
   * A ticket is a real conversation: it is stored, staff can answer it and the
   * answer shows up here. The form used to post to a route that did not exist,
   * which made it a button that could only ever fail.
   */
  supportScreen() {
    const root = h('div', null, h('h2', null, t('support.title')));
    if (!this.session) {
      root.append(h('div.card', null, h('p', null, t('error.unauthorized'))), this.authCard());
      return root;
    }

    const list = h('div.stack');
    const detail = h('div.stack');

    const refresh = async () => {
      clear(list);
      list.append(h('p.small.muted', null, t('common.loading')));
      try {
        const { tickets } = await api.tickets();
        clear(list);
        if (!tickets.length) {
          list.append(h('p.small.muted', null, t('support.none')));
          return;
        }
        for (const ticket of tickets) {
          list.append(h('div.card.card--pick', {
            onClick: () => openTicket(ticket.id),
          },
          h('div.row.row--between', null,
            h('div.grow', null,
              h('div', null, ticket.subject),
              h('div.small.muted', null,
                `${t(`support.categories.${ticket.category}`)} · `
                + `${new Date(ticket.updatedAt).toLocaleString(currentLocale())}`)),
            h('span.small', { class: ticket.status === 'closed' ? 'muted' : 'good' },
              t(`support.${ticket.status === 'answered' ? 'answered' : ticket.status}`)))));
        }
      } catch (error) {
        clear(list);
        list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
      }
    };

    const openTicket = async (id) => {
      clear(detail);
      detail.append(h('p.small.muted', null, t('common.loading')));
      try {
        const { ticket } = await api.ticket(id);
        clear(detail);
        const thread = h('div.stack');
        for (const message of ticket.messages) {
          thread.append(h('div.card', null,
            h('div.small.muted', null,
              `${message.staff ? t('support.staffBadge') : (message.author ?? '')} · `
              + new Date(message.at).toLocaleString(currentLocale())),
            h('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, message.body)));
        }

        const reply = h('textarea', { rows: 4, placeholder: t('support.replyPlaceholder') });
        add(detail,
          h('h3', null, `${t('support.ticket', { id: ticket.id })} · ${ticket.subject}`),
          thread,
          ticket.status === 'closed'
            ? h('p.small.muted', null, t('support.closedNotice'))
            : h('div.stack', null,
              h('div.field', null, reply),
              h('div.row', null,
                h('button.primary', {
                  onClick: async () => {
                    try {
                      await api.replyTicket(ticket.id, reply.value.trim());
                      toast(t('support.replySent'), 'good');
                      openTicket(ticket.id);
                      refresh();
                    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, t('support.reply')),
                h('button.ghost', {
                  onClick: async () => {
                    try {
                      await api.closeTicket(ticket.id);
                      toast(t('support.closed'), 'info');
                      openTicket(ticket.id);
                      refresh();
                    } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
                  },
                }, t('support.close')))));
      } catch (error) {
        clear(detail);
        detail.append(h('p.bad', null, t(error.code ?? 'error.generic')));
      }
    };

    const subject = h('input', { placeholder: t('support.subject'), maxLength: 160 });
    const category = h('select', null,
      ...['general', 'account', 'payment', 'bug', 'report', 'other'].map((key) =>
        h('option', { value: key }, t(`support.categories.${key}`))));
    const message = h('textarea', { rows: 6, placeholder: t('support.message') });

    add(root,
      h('div.card', null,
        h('div.card__title', null, t('support.newTicket')),
        h('div.field', null, h('label', null, t('support.subject')), subject),
        h('div.field', null, h('label', null, t('support.category')), category),
        h('div.field', null, h('label', null, t('support.message')), message),
        h('button.primary', {
          onClick: async () => {
            try {
              const ticket = await api.createTicket({
                subject: subject.value.trim(),
                category: category.value,
                body: message.value.trim(),
              });
              subject.value = '';
              message.value = '';
              toast(t('support.created'), 'good');
              await refresh();
              openTicket(ticket.id);
            } catch (error) {
              toast(t(error.code === 'error.rateLimited' ? 'support.tooMany'
                : (error.code ?? 'error.generic')), 'bad');
            }
          },
        }, t('support.newTicket'))),
      h('div.card__title', null, t('support.yourTickets')),
      list,
      detail);

    refresh();
    return root;
  }

  settingsScreen() {
    return h('div', null,
      h('h2', null, t('settings.title')),
      settingsView({ onChange: () => this.onSettingsChange?.() }));
  }

  /**
   * Advertising.
   *
   * Real from end to end: the picture is uploaded to the server, the advert
   * waits for a reviewer, and the impression and click figures shown here are
   * the ones the server counted. An account without the permission is told
   * exactly what is missing rather than shown a form that would 403.
   */
  adsScreen() {
    const root = h('div');
    add(root,
      h('h2', null, t('ads.mine')),
      h('p.lede', null, t('ads.lede')));

    if (!this.session) {
      root.append(this.authCard());
      return root;
    }
    if (!this.can('ads.submit')) {
      root.append(h('div.card', null,
        h('div.card__title', null, t('ads.noPermission')),
        h('p.small.muted', null, t('ads.noPermissionHint')),
        h('button', { onClick: () => this.go('support') }, t('menu.support'))));
      return root;
    }

    const list = h('div.stack');
    const title = h('input', { placeholder: t('ads.adTitle'), maxLength: 90 });
    const body = h('textarea', { rows: 3, placeholder: t('ads.adBody'), maxLength: 400 });
    const target = h('input', { placeholder: 'https://…', maxLength: 300 });
    const file = h('input', { type: 'file', accept: 'image/webp,image/png,image/jpeg' });

    const refresh = async () => {
      clear(list);
      list.append(h('p.small.muted', null, t('common.loading')));
      try {
        const { ads } = await api.myAds();
        clear(list);
        if (!ads.length) { list.append(h('p.muted', null, t('ads.none'))); return; }
        for (const ad of ads) list.append(adCard(ad, refresh));
      } catch (error) {
        clear(list);
        list.append(h('p.bad', null, t(error.code ?? 'error.generic')));
      }
    };

    const submit = async () => {
      try {
        const created = await api.submitAd({
          title: title.value.trim(),
          body: body.value.trim(),
          targetUrl: target.value.trim(),
        });
        // The picture is optional, and it is uploaded after the advert exists
        // so a failed image never loses the text the advertiser just typed.
        if (file.files?.[0]) await api.uploadAdImage(created.id, file.files[0]);
        title.value = ''; body.value = ''; target.value = ''; file.value = '';
        toast(t('ads.submitted'), 'good');
        refresh();
      } catch (error) {
        toast(t(error.code ?? 'error.generic'), 'bad');
      }
    };

    add(root,
      h('div.card', null,
        h('div.card__title', null, t('ads.newAd')),
        h('div.field', null, h('label', null, t('ads.adTitle')), title),
        h('div.field', null, h('label', null, t('ads.adBody')), body),
        h('div.field', null, h('label', null, t('ads.targetUrl')), target),
        h('div.field', null, h('label', null, t('ads.image')), file,
          h('p.small.muted', null, t('ads.imageHint'))),
        h('button.primary', { onClick: submit }, t('ads.submit'))),
      h('h3', null, t('ads.yours')),
      list);

    refresh();
    return root;
  }

  /**
   * An address that is not a page.
   *
   * Shown for anything the route table does not know, including /superadmin
   * when the visitor is not the one account that may open it - the answer has
   * to be identical to a genuine typo, or the address itself becomes a hint.
   */
  notFoundScreen() {
    return h('div.notfound', null,
      h('h2', null, '404'),
      h('p.lede', null, t('error.pageNotFound')),
      h('button.primary', { onClick: () => this.go('play') }, t('menu.play')));
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

/**
 * One of an advertiser's own adverts.
 *
 * The status badge is the honest one: "pending" means a person still has to
 * look at it, and the figures are what the server counted, not an estimate.
 */
function adCard(ad, onChange) {
  return h('div.card.ad-card', null,
    ad.image ? h('img.ad-card__image', { src: ad.image, alt: '', loading: 'lazy' }) : null,
    h('div.grow', null,
      h('div.row.row--between', null,
        h('strong', null, ad.title),
        h(`span.small.badge.badge--${ad.status}`, null, t(`ads.${ad.status}`))),
      h('p.small.muted', { style: { margin: '4px 0' } }, ad.body),
      h('div.small.mono.muted', null, ad.targetUrl),
      ad.reviewNote ? h('p.small.warn', null, ad.reviewNote) : null,
      h('div.row', { style: { marginTop: '6px' } },
        h('span.small.muted', null,
          t('ads.stats', { impressions: ad.impressions, clicks: ad.clicks })),
        h('span.grow'),
        h('button.ghost.small.danger', {
          onClick: async () => {
            try { await api.deleteAd(ad.id); onChange(); }
            catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, t('common.delete')))));
}

function fact(value, label) {
  return h('div.hero__fact', null,
    h('div.hero__fact-value', null, value),
    h('div.hero__fact-label', null, label));
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
