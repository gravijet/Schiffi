/**
 * In-game interface.
 *
 * The map fills the screen; everything else is a compact overlay. The top bar
 * carries the numbers a captain checks constantly (coins, hold, hull, crew),
 * the left panel is the ship, the right panel is the port or the market, and
 * the bottom panel is chat. Each collapses, and on a narrow screen they become
 * drawers driven by the same components.
 */
import { h, add, clear, panel, toast, modal, bar, tabs, virtualList, confirmDialog } from './dom.js';
import { t, tc, tn, td } from '../state/i18n.js';
import { api } from '../net/api.js';
import { settings } from '../state/settings.js';
import { goodById, allGoods } from '@schiffi/shared/data/goods.js';
import { SHIP_CLASSES, UPGRADES, upgradeCost } from '@schiffi/shared/data/ships.js';
import { currentLocale } from '../state/i18n.js';
import { settingsView } from './settingsPanel.js';
import { missionsView } from './panels/missions.js';
import { land as goAshore, nearestAnchorage } from './panels/expedition.js';
import { combatView } from './panels/combat.js';
import { guildView } from './panels/guild.js';
import { exchangeView } from './panels/exchange.js';
import { companyView } from './panels/company.js';
import { albumView } from './panels/album.js';
import { Tutorial } from './panels/tutorial.js';
import { openTradePicker, partnersInHail, onTradeEvent } from './panels/playerTrade.js';

export class GameUI {
  constructor({ socket, renderer, onLeave, onRefresh }) {
    this.socket = socket;
    this.renderer = renderer;
    this.onLeave = onLeave;
    this.onRefresh = onRefresh;
    this.character = null;
    this.world = null;
    this.portData = null;
    this.chatChannel = 'global';
    this.marketTab = 'buy';
    this.root = h('div');
    this.build();
  }

  build() {
    this.topbar = h('div#topbar');
    this.perf = h('div#perf', { hidden: !settings.get('perfOverlay') });
    this.actionbar = h('div#actionbar');
    this.joystick = h('div#joystick', null, h('div.knob'));
    this.tutorial = new Tutorial(this);
    this.minimapWrap = h('div#minimap-wrap', null,
      h('canvas#minimap', { width: 256, height: 160 }));

    this.shipPanel = panel({ id: 'panel-left', title: t('ship.title'), body: h('div') });
    this.portPanel = panel({ id: 'panel-right', title: t('port.title'), body: h('div') });
    this.chatPanel = panel({
      id: 'panel-bottom',
      title: t('chat.title'),
      collapsed: !settings.get('chatOpen'),
      onToggle: (collapsed) => settings.set('chatOpen', !collapsed),
      body: this.buildChat(),
    });

    add(this.root,
      this.topbar, this.perf, this.shipPanel, this.portPanel,
      this.chatPanel, this.minimapWrap, this.actionbar, this.joystick);
    this.tutorial.mount(this.root);
  }

  mount(parent) {
    parent.append(this.root);
    this.renderTopbar();
    this.renderActionbar();
    this.tutorial.start();
    return this;
  }

  unmount() {
    this.tutorial.stop();
    this.root.remove();
  }

  // --- top bar ------------------------------------------------------------

  renderTopbar() {
    clear(this.topbar);
    const character = this.character;
    const ship = character?.ship;
    const stat = (label, value, id) =>
      h('div.stat', null,
        h('span.stat__label', null, label),
        h(`span.stat__value#${id}`, null, value));

    add(this.topbar,
      h('span.brand', null, t('app.name')),
      stat(t('hud.coins'), character ? tc(character.coins) : '—', 'stat-coins'),
      stat(t('hud.cargo'), '—', 'stat-cargo'),
      stat(t('hud.hull'), '—', 'stat-hull'),
      stat(t('hud.crew'), character ? String(character.crew?.length ?? 0) : '—', 'stat-crew'),
      stat(t('hud.speed'), '0', 'stat-speed'),
      stat(t('hud.time'), '—', 'stat-time'),
      h('div.grow'),
      h('button.icon-btn', { title: t('menu.settings'), onClick: () => this.openSettings() }, '⚙'),
      h('button.icon-btn', { title: t('common.back'), onClick: () => this.onLeave?.() }, '⏻'),
    );
  }

  /**
   * Grey the landing button out while no beach is in reach.
   *
   * Called from the render loop, so it has to be cheap and must not touch the
   * DOM unless something actually changed.
   */
  /** A trade needs somebody to trade with; grey the button out until there is. */
  updateTradeButton() {
    const button = this.actionbar.querySelector('#act-trade');
    if (!button) return;
    const available = partnersInHail(this).length > 0;
    if (button.disabled === !available) return;
    button.disabled = !available;
    button.title = available ? '' : t('trade.nobodyNear');
  }

  /** Trade events pushed by the server, forwarded to the open trade window. */
  handleTradeEvent(message) {
    onTradeEvent(this, message);
  }

  updateAshoreButton() {
    const button = this.actionbar.querySelector('#act-explore');
    if (!button) return;
    const found = nearestAnchorage(this);
    const reachable = Boolean(found?.inReach);
    if (button.disabled === !reachable) return;
    button.disabled = !reachable;
    button.title = found && !reachable
      ? t('explore.nearestBeach', { distance: Math.round(found.distance) })
      : '';
  }

  updateTopbar() {
    const setValue = (id, value) => {
      const node = this.topbar.querySelector(`#${id}`);
      if (!node || node.textContent === value) return;
      node.textContent = value;
      if (settings.effective().uiAnimations) {
        node.classList.remove('is-flash');
        void node.offsetWidth;
        node.classList.add('is-flash');
      }
    };

    const character = this.character;
    if (!character) return;
    setValue('stat-coins', tc(character.coins));

    const used = (character.cargo ?? []).reduce((sum, lot) => sum + lot.vol * lot.qty, 0);
    const capacity = character.ship?.stats?.cargo ?? 0;
    setValue('stat-cargo', `${used}/${capacity}`);

    const self = this.socket.self;
    if (self && character.ship) {
      setValue('stat-hull', `${Math.round(self.hull)}/${Math.round(character.ship.maxHull)}`);
      setValue('stat-speed', String(Math.round(self.v)));
    }
    setValue('stat-crew', String(character.crew?.length ?? 0));

    if (this.socket.gameTimeMs !== undefined) {
      const dayMs = 24 * 3_600_000;
      const fraction = (this.socket.gameTimeMs % dayMs) / dayMs;
      const hours = Math.floor(fraction * 24);
      const minutes = Math.floor((fraction * 24 - hours) * 60);
      setValue('stat-time', `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
    }
  }

  // --- action bar ---------------------------------------------------------

  renderActionbar() {
    clear(this.actionbar);
    const docked = this.character?.docked;

    // Stable ids, so the buttons stay addressable when the bar is rearranged.
    add(this.actionbar,
      docked
        ? h('button.primary#act-port', { onClick: () => this.leavePort() }, t('port.leave'))
        : h('button.primary#act-port', { onClick: () => this.dockNearby() }, t('port.enter')),
      h('button#act-ship', { onClick: () => this.toggleShipPanel() }, t('ship.title')),
      h('button#act-market', { onClick: () => this.togglePortPanel() }, t('port.market')),
      // Ashore and gunnery only make sense at sea; the exchange only at a
      // berth. Showing the rest would be a lie.
      docked ? null : h('button#act-explore', { onClick: () => goAshore(this) }, t('explore.expedition')),
      docked ? null : h('button#act-combat', { onClick: () => this.openCombat() }, t('combat.title')),
      docked ? null : h('button#act-trade', { onClick: () => openTradePicker(this) }, t('trade.propose')),
      h('button#act-missions', { onClick: () => this.openMissions() }, t('mission.title')),
      docked ? h('button#act-exchange', { onClick: () => this.openExchange() }, t('market.title')) : null,
      h('button#act-more', { onClick: () => this.openMore() }, t('common.more')),
      h('button#act-chat', { onClick: () => this.chatPanel.classList.toggle('is-collapsed') }, t('chat.title')),
    );
  }

  // --- panels -------------------------------------------------------------

  toggleShipPanel() {
    this.shipPanel.classList.toggle('is-collapsed');
    this.shipPanel.classList.toggle('is-open');
    this.renderShipPanel();
  }

  togglePortPanel() {
    this.portPanel.classList.toggle('is-collapsed');
    this.portPanel.classList.toggle('is-open');
    if (!this.portPanel.classList.contains('is-collapsed')) this.refreshPort();
  }

  renderShipPanel() {
    const character = this.character;
    if (!character?.ship) return;
    const ship = character.ship;
    const stats = ship.stats ?? {};

    const cargoRows = (character.cargo ?? []).map((lot) => {
      const good = goodById(lot.goodId);
      return h('tr', null,
        h('td', null, good ? good.names[currentLocale()] ?? good.names.en : lot.key),
        h('td.right.mono', null, String(lot.qty)),
        h('td', { style: { width: '52px' } }, bar(lot.freshness, 1, { warnAt: 0.5, badAt: 0.25 })));
    });

    this.shipPanel.setTitle(`${ship.name} · ${t(`ship.title`)}`);
    this.shipPanel.setBody(h('div.stack', null,
      h('dl.kv', null,
        h('dt', null, t('ship.class')), h('dd', null, t(`shipClass.${ship.classKey}`)),
        h('dt', null, t('ship.speed')), h('dd', null, tn(Math.round(stats.speed ?? 0))),
        h('dt', null, t('ship.cargo')), h('dd', null, String(stats.cargo ?? 0)),
        h('dt', null, t('ship.crewSlots')), h('dd', null, `${character.crew?.length ?? 0} / ${stats.crewSlots ?? 0}`)),
      h('div', null,
        h('div.small.muted', null, t('ship.hull')),
        bar(ship.hull, ship.maxHull)),
      h('div', null,
        h('div.small.muted', null, t('ship.sail')),
        bar(ship.sail, ship.maxSail)),
      h('div.card__title', null, t('cargo.title')),
      cargoRows.length
        ? h('table', null, h('tbody', null, ...cargoRows))
        : h('p.small.muted', null, t('cargo.empty')),
      h('div.card__title', null, t('crew.title')),
      h('table', null, h('tbody', null, ...(character.crew ?? []).map((member) =>
        h('tr', null,
          h('td', null, member.name,
            h('div.small.muted', null, t(`crew.roles.${member.role}`))),
          h('td', { style: { width: '54px' } },
            bar(member.morale, 100),
            bar(member.health, 100)),
          member.disease ? h('td.bad.small', null, t('crew.sick')) : h('td'))))),
    ));
  }

  async refreshPort() {
    const character = this.character;
    if (!character?.docked || !character.portId) {
      this.portData = null;
      this.portPanel.setTitle(t('port.title'));
      this.portPanel.setBody(h('p.small.muted', null, t('error.notInPort')));
      return;
    }
    // Called on every dock change, so skip the round trip while it is closed.
    if (this.portPanel.classList.contains('is-collapsed')) return;
    this.portPanel.setBody(h('p.small.muted', null, t('common.loading')));
    try {
      this.portData = await api.port(character.worldId, character.portId, character.id);
      this.renderPortPanel();
    } catch (error) {
      this.portPanel.setBody(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  renderPortPanel() {
    const data = this.portData;
    if (!data) return;
    this.portPanel.setTitle(`${data.port.name} · ${t(`hazard.${data.port.hazard}`)}`);

    const body = h('div.stack');
    body.append(
      tabs([
        { key: 'buy', label: t('trade.buy') },
        { key: 'sell', label: t('trade.sell') },
        { key: 'shipyard', label: t('port.shipyard') },
        { key: 'crew', label: t('port.crewMarket') },
      ], this.marketTab, (key) => { this.marketTab = key; this.renderPortPanel(); }),
    );

    if (this.marketTab === 'buy' || this.marketTab === 'sell') {
      body.append(this.marketTable(this.marketTab));
    } else if (this.marketTab === 'shipyard') {
      body.append(this.shipyardView());
    } else {
      body.append(this.crewMarketView());
    }
    this.portPanel.setBody(body);
  }

  marketTable(mode) {
    const goods = this.portData.market?.goods ?? [];
    const held = new Map((this.character.cargo ?? []).map((lot) => [lot.goodId, lot.qty]));
    const locale = currentLocale();

    const rows = mode === 'sell'
      ? goods.filter((entry) => held.has(entry.id))
      : goods.slice().sort((a, b) => a.buy - b.buy);

    if (rows.length === 0) return h('p.small.muted', null, t('common.empty'));

    const container = h('div', { style: { maxHeight: '46vh', overflow: 'auto', position: 'relative' } });
    virtualList({
      container,
      items: rows,
      rowHeight: 30,
      renderRow: (entry) => {
        const good = goodById(entry.id);
        const name = good ? (good.names[locale] ?? good.names.en) : entry.key;
        return h('div.row', { style: { padding: '4px 2px', borderBottom: '1px solid rgba(255,255,255,.05)' } },
          h('div.grow', { style: { overflow: 'hidden' } },
            h('div', { style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } },
              name,
              entry.contraband ? h('span.bad.small', null, ' ⚑') : null),
            h('div.small.muted', null,
              mode === 'buy'
                ? `${t('trade.stock')} ${entry.stock}${entry.tariff ? ` · ${t('trade.tariff')} ${Math.round(entry.tariff * 100)}%` : ''}`
                : `${t('cargo.title')} ${held.get(entry.id) ?? 0}`)),
          h('div.mono.right', { style: { width: '62px' } }, tc(mode === 'buy' ? entry.buy : entry.sell)),
          h('button.ghost', {
            style: { minWidth: '54px', padding: '4px 8px', minHeight: '26px' },
            onClick: () => this.tradeDialog(entry, mode, held.get(entry.id) ?? 0),
          }, mode === 'buy' ? t('trade.buyOne') : t('trade.sellOne')));
      },
    });
    return container;
  }

  tradeDialog(entry, mode, owned) {
    const good = goodById(entry.id);
    const locale = currentLocale();
    const name = good ? (good.names[locale] ?? good.names.en) : entry.key;
    const unit = mode === 'buy' ? entry.buy : entry.sell;

    const capacity = this.character.ship?.stats?.cargo ?? 0;
    const used = (this.character.cargo ?? []).reduce((sum, lot) => sum + lot.vol * lot.qty, 0);
    const maxAffordable = Math.floor(this.character.coins / Math.max(1, unit));
    const maxSpace = good ? Math.floor((capacity - used) / good.vol) : 0;
    const max = mode === 'buy'
      ? Math.max(0, Math.min(maxAffordable, maxSpace, entry.stock - 1))
      : owned;

    const qty = h('input', { type: 'number', min: 1, max: Math.max(1, max), value: Math.min(1, max) || 1 });
    const total = h('div.mono');
    const update = () => {
      const value = Math.max(0, Math.min(max, Number(qty.value) || 0));
      total.textContent = `${tc(value * unit)} ${t('unit.coins')}`;
    };
    qty.addEventListener('input', update);
    update();

    const history = h('div.small.muted', null, t('common.loading'));
    api.priceHistory(this.character.worldId, this.character.portId, entry.id).then((stats) => {
      history.textContent = `${t('trade.average')} 24h: ${stats.average24h ?? '—'} · `
        + `7d: ${stats.average7d ?? '—'} · ${t('trade.min')} ${stats.min7d ?? '—'} · `
        + `${t('trade.max')} ${stats.max7d ?? '—'} · ${t('trade.trend')} ${stats.trend24h > 0 ? '+' : ''}${stats.trend24h}%`;
    }).catch(() => { history.textContent = ''; });

    modal({
      title: name,
      body: h('div.stack', null,
        entry.contraband ? h('p.bad', null, t('trade.contrabandWarning')) : null,
        h('dl.kv', null,
          h('dt', null, mode === 'buy' ? t('trade.buyPrice') : t('trade.sellPrice')), h('dd', null, tc(unit)),
          h('dt', null, t('trade.stock')), h('dd', null, String(entry.stock)),
          h('dt', null, t('cargo.title')), h('dd', null, String(owned))),
        history,
        h('div.field', null,
          h('label', null, `${t('trade.quantity')} (max ${max})`),
          h('div.row', null, qty,
            h('button.ghost', { onClick: () => { qty.value = String(max); update(); } }, 'max'))),
        h('div.row.row--between', null, h('span', null, t('common.total')), total)),
      actions: [
        { label: t('common.cancel') },
        {
          label: mode === 'buy' ? t('trade.buyOne') : t('trade.sellOne'),
          primary: true,
          onClick: async () => {
            const value = Math.max(0, Math.min(max, Number(qty.value) || 0));
            if (value <= 0) return false;
            try {
              const result = await this.socket.action(
                mode === 'buy' ? 'trade.buy' : 'trade.sell',
                { goodId: entry.id, qty: value });
              if (result.seized) {
                toast(t('trade.contrabandWarning'), 'bad');
              } else {
                toast(t(mode === 'buy' ? 'trade.bought' : 'trade.sold',
                  { count: value, good: name, price: result.total }), 'good');
              }
              await this.refreshPort();
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

  shipyardView() {
    const facilities = this.portData.facilities;
    if (!facilities.shipyard) return h('p.small.muted', null, t('error.notInPort'));

    const ship = this.character.ship;
    const upgrades = ship?.upgrades ?? {};

    return h('div.stack', null,
      h('div.row', null,
        h('button.primary', {
          onClick: async () => {
            try {
              const result = await this.socket.action('ship.repair', {});
              toast(result.repaired ? `${t('ship.repair')}: ${tc(result.cost)}` : t('common.ok'), 'good');
            } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, t('ship.repair'))),
      h('div.card__title', null, t('ship.upgrades')),
      ...UPGRADES.map((upgrade) => {
        const level = upgrades[upgrade.key] ?? 0;
        const cost = upgradeCost(upgrade.key, level);
        return h('div.row.row--between', { style: { padding: '3px 0' } },
          h('div', null,
            h('div', null, t(`upgrade.${upgrade.key}`)),
            h('div.small.muted', null, `${level}/${upgrade.maxLevel}`)),
          cost === null
            ? h('span.small.good', null, '✓')
            : h('button.ghost', {
              onClick: async () => {
                try {
                  await this.socket.action('ship.upgrade', { upgradeKey: upgrade.key });
                  toast(t('ship.upgrade'), 'good');
                  this.renderPortPanel();
                } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
              },
            }, tc(cost)));
      }),
      h('div.card__title', null, t('ship.buy')),
      ...SHIP_CLASSES.filter((cls) => cls.tier <= facilities.shipyardTier && cls.price > 0).map((cls) =>
        h('div.row.row--between', { style: { padding: '3px 0' } },
          h('div', null,
            h('div', null, t(`shipClass.${cls.key}`)),
            h('div.small.muted', null,
              `${t('ship.cargo')} ${cls.cargo} · ${t('ship.speed')} ${cls.speed} · ${t('ship.hull')} ${cls.hull}`)),
          h('button.ghost', {
            onClick: async () => {
              try {
                await this.socket.action('ship.buy', { classKey: cls.key });
                toast(t('ship.buy'), 'good');
                this.renderPortPanel();
              } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
            },
          }, tc(cls.price)))),
    );
  }

  crewMarketView() {
    const offers = this.portData.crewOffers ?? [];
    return h('div.stack', null,
      h('div.row', null,
        h('button', {
          onClick: async () => {
            try {
              const result = await this.socket.action('crew.pay', {});
              toast(t('crew.wagesPaid') + ` (${tc(result.paid)})`, 'good');
            } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, t('crew.payWages'))),
      ...offers.map((offer) =>
        h('div.row.row--between', { style: { padding: '3px 0' } },
          h('div', null,
            h('div', null, offer.name),
            h('div.small.muted', null,
              `${t(`crew.roles.${offer.role}`)} · ${t('crew.level')} ${offer.level} · ${t('crew.wage')} ${offer.wage}`)),
          h('button.ghost', {
            onClick: async () => {
              try {
                await this.socket.action('crew.hire', { slot: offer.slot });
                toast(t('crew.hire'), 'good');
                this.renderPortPanel();
              } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
            },
          }, tc(offer.fee)))),
    );
  }

  // --- chat ---------------------------------------------------------------

  buildChat() {
    this.chatLog = h('div#chat-log');
    this.chatInput = h('input', { placeholder: t('chat.placeholder'), maxLength: 400 });
    this.chatInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const body = this.chatInput.value.trim();
      if (!body) return;
      this.socket.chat(this.chatChannel, body);
      this.chatInput.value = '';
    });

    this.chatTabs = h('div.tabs');
    this.renderChatTabs();

    return h('div.stack', null, this.chatTabs, this.chatLog, this.chatInput);
  }

  renderChatTabs() {
    clear(this.chatTabs);
    for (const channel of ['global', 'local', 'port', 'guild', 'convoy']) {
      this.chatTabs.append(h(`button.tab${this.chatChannel === channel ? '.is-active' : ''}`, {
        onClick: () => { this.chatChannel = channel; this.renderChatTabs(); },
      }, t(`chat.${channel}`)));
    }
  }

  addChatMessage(message) {
    const atBottom = this.chatLog.scrollTop + this.chatLog.clientHeight >= this.chatLog.scrollHeight - 24;
    const time = new Date(message.at ?? Date.now());
    const body = message.system
      ? h('span', null, message.body)
      : h('span', null,
        h('span.chat-msg__from', null, `${message.from}: `),
        highlightMentions(message.body, this.character?.name));

    add(this.chatLog, h(`div.chat-msg.chat-msg--${message.system ? 'system' : message.channel}`, null,
      h('span.chat-msg__time', null,
        `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`),
      body));

    while (this.chatLog.childElementCount > 250) this.chatLog.firstChild.remove();
    if (atBottom) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  systemMessage(text) {
    this.addChatMessage({ system: true, body: text, at: Date.now() });
  }

  // --- actions ------------------------------------------------------------

  async dockNearby() {
    const self = this.socket.self;
    if (!self || !this.world) return;
    let nearest = null;
    let bestDistance = Infinity;
    for (const port of this.world.ports) {
      const distance = Math.hypot(port.x - self.x, port.y - self.y);
      if (distance < bestDistance) { bestDistance = distance; nearest = port; }
    }
    if (!nearest) return;
    try {
      const result = await this.socket.action('port.dock', { portId: nearest.id });
      toast(t('port.arrived', { port: result.portName }), 'good');
    } catch (error) {
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
  }

  async leavePort() {
    try {
      await this.socket.action('port.leave', {});
      toast(t('port.departed', { port: this.portData?.port.name ?? '' }), 'info');
    } catch (error) {
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
  }

  openCodeDialog() {
    const input = h('input', { placeholder: t('code.enter'), autocomplete: 'off' });
    modal({
      title: t('code.title'),
      body: h('div.field', null, h('label', null, t('code.enter')), input),
      actions: [
        { label: t('common.cancel') },
        {
          label: t('code.redeem'), primary: true,
          onClick: async () => {
            try {
              const result = await this.socket.action('code.redeem', { code: input.value });
              toast(t('code.reward', { amount: result.coins }), 'good');
            } catch (error) {
              toast(t(error.code ?? 'code.invalid'), 'bad');
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  // --- gameplay screens ----------------------------------------------------

  /**
   * Every screen below is a modal over the map rather than another dock: the
   * map is the game, and a contract board that pushes it aside costs more
   * than it gives. Each view fetches its own data and refreshes the HUD
   * through `refreshCharacter` when it changes something.
   */
  openMissions() {
    modal({ title: t('mission.title'), wide: true, body: missionsView(this),
      actions: [{ label: t('common.close') }] });
  }

  openCombat() {
    const view = combatView(this);
    modal({
      title: t('combat.title'), wide: true, body: view,
      actions: [{ label: t('common.close') }],
      // The target list polls; stop it when the dialog goes away.
      onClose: () => view.stopTicking?.(),
    });
  }

  openExchange() {
    modal({ title: t('market.title'), wide: true, body: exchangeView(this),
      actions: [{ label: t('common.close') }] });
  }

  openGuild() {
    modal({ title: t('guild.title'), wide: true, body: guildView(this),
      actions: [{ label: t('common.close') }] });
  }

  openCompany() {
    modal({ title: t('company.title'), wide: true, body: companyView(this),
      actions: [{ label: t('common.close') }] });
  }

  openAlbum() {
    modal({ title: t('explore.album'), wide: true, body: albumView(this),
      actions: [{ label: t('common.close') }] });
  }

  /** The screens that do not earn a permanent button of their own. */
  openMore() {
    const entry = (id, label, open) =>
      h(`button.ghost#${id}`, { onClick: () => { dialog.close(); open(); } }, label);
    const dialog = modal({
      title: t('common.more'),
      body: h('div.stack', null,
        entry('more-guild', t('guild.title'), () => this.openGuild()),
        entry('more-company', t('company.title'), () => this.openCompany()),
        entry('more-album', t('explore.album'), () => this.openAlbum()),
        entry('more-tutorial', t('tutorial.title'), () => this.tutorial.resume()),
        entry('more-code', t('code.title'), () => this.openCodeDialog()),
        entry('more-settings', t('menu.settings'), () => this.openSettings())),
      actions: [{ label: t('common.close') }],
    });
  }

  /** Re-read the character from the server; the panels call this after a change. */
  refreshCharacter() {
    this.onRefresh?.();
  }

  openSettings() {
    modal({
      title: t('settings.title'),
      wide: true,
      body: settingsView({ onChange: () => this.renderer.resize() }),
      actions: [{ label: t('common.close') }],
    });
  }

  // --- performance overlay -------------------------------------------------

  updatePerf() {
    if (!settings.get('perfOverlay')) { this.perf.hidden = true; return; }
    this.perf.hidden = false;
    const stats = this.renderer.stats;
    const graphics = settings.effective();
    const memory = performance.memory
      ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : '—';

    clear(this.perf);
    const row = (key, value) => { this.perf.append(h('span.k', null, key), h('span.v', null, value)); };
    row(t('perf.fps'), String(stats.fps));
    row(t('perf.frametime'), `${stats.frameMs.toFixed(1)} ms`);
    row(t('perf.ping'), `${this.socket.ping} ms`);
    row(t('perf.wsLatency'), `${this.socket.snapshotsPerSecond}/s`);
    row(t('perf.memory'), memory);
    row(t('perf.entities'), `${stats.entities ?? 0}/${this.socket.entities.size}`);
    row(t('perf.netUpdates'), `${(this.socket.bytesIn / 1024).toFixed(0)} KiB`);
    row(t('perf.resolution'), `${this.renderer.canvas.width}×${this.renderer.canvas.height} (${graphics.resolutionScale.toFixed(2)}×)`);
  }
}

function highlightMentions(body, ownName) {
  if (!ownName) return document.createTextNode(body);
  const fragment = document.createDocumentFragment();
  const pattern = new RegExp(`@${ownName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  let index = 0;
  for (const match of body.matchAll(pattern)) {
    fragment.append(document.createTextNode(body.slice(index, match.index)));
    fragment.append(h('mark', null, match[0]));
    index = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(body.slice(index)));
  return fragment;
}
