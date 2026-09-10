/**
 * Going ashore.
 *
 * The panel is a thin shell around the server's landing report: it shows the
 * survey the server computed from the island's real terrain, offers exactly
 * the activities the server said are possible there, and appends whatever the
 * server actually handed over. Nothing here decides an outcome.
 */
import { h, add, clear, toast, modal } from '../dom.js';
import { t, tc } from '../../state/i18n.js';
import { countdown } from './missions.js';
import { goodById } from '@schiffi/shared/data/goods.js';
import { currentLocale } from '../../state/i18n.js';
import { ACTIVITY_COST } from '@schiffi/shared/data/discoveries.js';

const goodName = (goodId, fallback) => {
  const good = goodById(Number(goodId));
  return good ? (good.names[currentLocale()] ?? good.names.en) : fallback;
};

/** Terrain share of the landing area, biggest first, as readable percentages. */
function terrainRows(survey) {
  const total = Object.values(survey.terrain).reduce((sum, n) => sum + n, 0) || 1;
  return Object.entries(survey.terrain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) =>
      h('div.row.row--between', null,
        h('span', null, t(`terrain.${name}`)),
        h('span.mono.muted', null, `${Math.round((count / total) * 100)} %`)));
}

/**
 * Open the expedition dialog for a landing report.
 * `ctx` is the GameUI; `report` is the payload of an `explore.land` action.
 */
export function openExpedition(ctx, report) {
  const log = h('div.stack');
  const activityRow = h('div.row', { style: { flexWrap: 'wrap' } });
  /** Per-activity cooldown end, so a button greys out until it is usable. */
  const cooldowns = new Map();
  let ticker = null;

  const survey = report.survey;
  const title = report.name
    ?? (report.uncharted ? t('explore.undiscovered') : t('explore.title'));

  const renderActivities = () => {
    clear(activityRow);
    if (!report.activities.length) {
      activityRow.append(h('p.small.muted', null, t('explore.noActivities')));
      return;
    }
    for (const activity of report.activities) {
      const until = cooldowns.get(activity) ?? 0;
      const left = countdown(until - Date.now());
      const cost = ACTIVITY_COST[activity];
      activityRow.append(h('button.ghost', {
        disabled: Boolean(left),
        title: cost ? `${cost.minutes} min` : undefined,
        onClick: () => runActivity(activity),
      }, left ? t('explore.cooldown', { time: left }) : t(`activity.${activity}`)));
    }
  };

  const addEntry = (node) => {
    log.prepend(node);
    while (log.childElementCount > 12) log.lastChild.remove();
  };

  async function runActivity(activity) {
    try {
      const result = await ctx.socket.action('explore.gather', { activity });
      cooldowns.set(activity, Date.now() + (result.cooldownMs ?? 0));
      renderActivities();
      addEntry(activityResult(activity, result));
      ctx.refreshCharacter?.();
    } catch (error) {
      if (error.details?.waitMs) {
        cooldowns.set(activity, Date.now() + error.details.waitMs);
        renderActivities();
      }
      toast(t(error.code ?? 'error.generic'), 'bad');
    }
  }

  function activityResult(activity, result) {
    const lines = [];
    if (result.sightings) {
      lines.push(h('div.small.muted', null, t('explore.sightings')));
      for (const sighting of result.sightings) {
        lines.push(h('div.row.row--between', null,
          h('span', null, t(`wildlife.${sighting.key}`)),
          sighting.isNew ? h('span.small.good', null, t('explore.newEntry')) : h('span')));
      }
    }
    for (const entry of result.gained ?? []) {
      lines.push(h('div.row.row--between', null,
        h('span', null, goodName(entry.goodId, entry.key)),
        h('span.mono', null, `+${entry.qty}`)));
    }
    if (!lines.length) lines.push(h('div.small.muted', null, t('explore.nothingFound')));
    if (result.cargoFull) lines.push(h('div.small.warn', null, t('explore.cargoFull')));
    if (result.xp) lines.push(h('div.small.good', null, t('explore.xpGained', { xp: result.xp })));

    return h('div.card', null,
      h('div.card__title', null, t(`activity.${activity}`)), ...lines);
  }

  // --- naming --------------------------------------------------------------
  const nameBox = h('div.stack');
  const renderNaming = () => {
    clear(nameBox);
    if (report.canPropose) {
      const input = h('input', { placeholder: t('explore.namePlaceholder'), maxLength: 32 });
      add(nameBox,
        h('p.small.good', null, t('explore.firstDiscovery')),
        h('div.row', null, input, h('button.primary', {
          onClick: async () => {
            try {
              const result = await ctx.socket.action('explore.name', { name: input.value.trim() });
              report.canPropose = false;
              report.name = result.name ?? input.value.trim();
              toast(t('explore.nameSubmitted'), 'good');
              renderNaming();
            } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
          },
        }, t('explore.submitName'))));
      return;
    }
    const first = report.firstDiscoveredBy;
    if (first) {
      nameBox.append(h('p.small.muted', null, first.yours
        ? t('explore.yoursFirst')
        : t('explore.firstDiscoveryBy', {
          player: first.player,
          date: new Date(first.at).toLocaleDateString(currentLocale()),
        })));
    } else if (!report.uncharted) {
      nameBox.append(h('p.small.muted', null, t('explore.alreadyCharted')));
    }
  };
  renderNaming();
  renderActivities();

  const dialog = modal({
    title: `${t('explore.expedition')} · ${title}`,
    wide: true,
    body: h('div.stack', null,
      h('div.card', null,
        h('div.card__title', null, t('explore.survey')),
        h('div.row.row--between', null,
          h('span', null, t('explore.climate')),
          h('span.muted', null, t(`climate.${survey.climate}`))),
        h('div.row.row--between', null,
          h('span', null, t('explore.area')),
          h('span.mono.muted', null, String(survey.area))),
        ...terrainRows(survey),
        survey.hasRuins ? h('div.small.good', null, t('explore.hasRuins')) : null,
        survey.hasTreasure ? h('div.small.good', null, t('explore.hasTreasure')) : null),
      nameBox,
      h('div.card__title', null, t('explore.activities')),
      activityRow,
      h('div.card__title', null, t('explore.yield')),
      log),
    actions: [{ label: t('explore.backToShip') }],
    onClose: () => { if (ticker) clearInterval(ticker); },
  });

  // Cooldown labels have to tick down on their own, otherwise a button stays
  // greyed out until the player clicks something else.
  ticker = setInterval(() => {
    if (![...cooldowns.values()].some((until) => until > Date.now())) return;
    renderActivities();
  }, 1000);

  return dialog;
}

/** Sail-to-shore: ask the server to land, then open the dialog on its report. */
export async function land(ctx) {
  try {
    const report = await ctx.socket.action('explore.land', {});
    if (report.firstDiscovery) toast(t('explore.firstDiscovery'), 'good');
    openExpedition(ctx, report);
  } catch (error) {
    toast(t(error.code === 'error.tooFar' ? 'explore.tooFar' : (error.code ?? 'error.generic')), 'bad');
  }
}
