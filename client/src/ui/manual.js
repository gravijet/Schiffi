/**
 * The docs' content, as data.
 *
 * `docs.js` (the public, site-level documentation) lays this out as
 * navigable pages - one source of truth for the game's mechanics, kept
 * separate from the UI code that renders it so a numbers change never has to
 * touch layout. There is no in-game duplicate of this any more: the
 * in-game "manual" action just opens this same page.
 */

export const SECTIONS = [
  {
    title: 'mode.title',
    lines: ['mode.traderDesc', 'mode.explorerDesc'],
  },
  {
    title: 'hud.setSail',
    lines: ['hud.clickToSail'],
    extra: [
      { term: '🖱️ / 👆', detail: 'hud.clickToSail' },
      { term: 'M', detail: 'docs.toggleFollow' },
      { term: 'Q / E', detail: 'docs.zoomOutIn' },
      { term: 'F3', detail: 'settings.perfOverlay' },
      { term: 'Enter', detail: 'chat.send' },
    ],
  },
  {
    title: 'trade.buy',
    lines: [
      'trade.buyPrice', 'trade.sellPrice', 'trade.demand', 'trade.supply', 'trade.tariff',
      'docs.priceModel', 'docs.seasonSwing',
    ],
  },
  {
    title: 'cargo.title',
    lines: ['cargo.perishable', 'cargo.lossNoRefund', 'ship.cargoProtect', 'ship.cooling', 'docs.perishability'],
  },
  {
    title: 'crew.title',
    lines: ['crew.morale', 'crew.health', 'crew.wage', 'crew.understaffed'],
  },
  {
    title: 'weather.storm',
    lines: ['weather.stormApproaching', 'weather.iceField', 'ship.stormResist', 'docs.stormBelt', 'docs.iceBelt'],
  },
  {
    title: 'explore.title',
    lines: ['explore.undiscovered', 'explore.firstDiscovery', 'explore.nameIsland', 'cartography.title'],
  },
  {
    title: 'company.title',
    lines: [
      'fleet.hint', 'company.routes', 'company.outposts', 'company.createRoute', 'company.buildOutpost',
      'docs.founding', 'docs.outpostCost', 'docs.routeShip',
    ],
  },
  {
    title: 'pvp.protected',
    lines: ['hazard.pvpOff', 'hazard.pvpOn', 'pvp.bounty', 'docs.combatRange', 'docs.boarding', 'docs.bountyMin'],
  },
  {
    title: 'port.title',
    lines: ['docs.dockRangeFact'],
  },
  {
    title: 'tutorial.title',
    lines: [
      'docs.tutorialGoals.move', 'docs.tutorialGoals.buy', 'docs.tutorialGoals.sail',
      'docs.tutorialGoals.dock', 'docs.tutorialGoals.sell', 'docs.tutorialGoals.crew',
      'docs.tutorialGoals.contract', 'docs.tutorialGoals.deliver',
    ],
  },
  {
    title: 'code.title',
    lines: ['docs.codesIntro', 'docs.codesLimit'],
  },
];
