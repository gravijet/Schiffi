/**
 * Discovery album and achievements.
 *
 * The album shows the full set of collectables with the ones this character
 * has actually found filled in, so an empty slot is a real gap rather than a
 * shrug. Achievement progress is the server's counter, not a local tally.
 */
import { h, add, clear, tabs, bar } from '../dom.js';
import { t, tc, tn } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { goodByKey } from '@schiffi/shared/data/goods.js';
import { currentLocale } from '../../state/i18n.js';

const date = (ms) => new Date(ms).toLocaleDateString(currentLocale());

/** How an album entry is named, which depends on what kind of thing it is. */
function entryLabel(kind, key, entry) {
  if (kind === 'animal') return t(`wildlife.${key}`);
  if (kind === 'island') return entry?.data?.name ?? t('explore.undiscovered');
  const good = goodByKey(key);
  if (good) return good.names[currentLocale()] ?? good.names.en;
  return key;
}

export function albumView(ctx) {
  const root = h('div.stack');
  const pane = h('div.stack');
  let tab = 'album';

  const header = tabs([
    { key: 'album', label: t('explore.album') },
    { key: 'achievements', label: t('profile.achievements') },
  ], tab, (key) => { tab = key; render(); });

  add(root, header, pane);

  async function render() {
    clear(pane);
    pane.append(h('p.small.muted', null, t('common.loading')));
    try {
      if (tab === 'album') {
        const [{ album }, reference] = await Promise.all([
          api.album(ctx.character.id),
          api.discoveryData(),
        ]);
        clear(pane);
        pane.append(albumBody(album, reference));
      } else {
        const data = await api.achievements(ctx.character.id);
        clear(pane);
        pane.append(achievementBody(data));
      }
    } catch (error) {
      clear(pane);
      pane.append(h('p.bad', null, t(error.code ?? 'error.generic')));
    }
  }

  render();
  return root;
}

function albumBody(album, reference) {
  const root = h('div.stack');

  // The complete set, per kind: every animal, plus every finding flagged as a
  // collectable. Islands are open-ended, so they are listed rather than gated.
  const expected = { animal: reference.wildlife.map((animal) => animal.key) };
  for (const collectable of reference.collectables ?? []) {
    (expected[collectable.kind] ??= []).push(collectable.key);
  }

  const kinds = [...new Set([...Object.keys(expected), ...Object.keys(album)])];
  let anything = 0;

  for (const kind of kinds) {
    const found = new Map((album[kind] ?? []).map((entry) => [entry.key, entry]));
    anything += found.size;
    const all = expected[kind] ?? [...found.keys()];

    // Islands are open-ended - the world holds hundreds - so that shelf shows
    // a running count rather than a fraction of a set that has no end.
    const closed = Boolean(expected[kind]);
    add(root,
      h('div.row.row--between', null,
        h('div.card__title', null, t(`albumKind.${kind}`)),
        h('span.small.muted', null, closed
          ? t('explore.albumProgress', { found: found.size, total: all.length })
          : String(found.size))));

    const grid = h('div.album-grid');
    for (const key of all) {
      const entry = found.get(key);
      grid.append(h(`div.album-cell${entry ? '.is-found' : ''}`, null,
        h('div.album-cell__name', null, entryLabel(kind, key, entry)),
        h('div.small.muted', null, entry ? date(entry.at) : '—')));
    }
    root.append(grid);
  }

  if (!anything) root.prepend(h('p.small.muted', null, t('explore.albumEmpty')));
  return root;
}

function achievementBody(data) {
  const root = h('div.stack');
  const unlocked = data.achievements.filter((entry) => entry.unlockedAt);
  const points = unlocked.reduce((sum, entry) => sum + entry.points, 0);

  add(root,
    h('dl.kv', null,
      h('dt', null, t('profile.level')), h('dd', null, String(data.level)),
      h('dt', null, t('profile.xp')), h('dd', null, `${tn(data.xp)} / ${tn(data.nextLevelXp)}`),
      ...(data.profession
        ? [h('dt', null, t('profile.profession')), h('dd', null, t(`profession.${data.profession}`))]
        : []),
      h('dt', null, t('profile.achievements')),
      h('dd', null,
        `${unlocked.length} / ${data.achievements.length} · ${t('profile.points', { count: tn(points) })}`)),
    data.profession ? h('p.small.muted', null, t('profile.professionEarned')) : null,
    bar(data.xp, data.nextLevelXp, { warnAt: 0, badAt: 0 }));

  // Nearly-done first: that is the list a player actually acts on.
  const sorted = data.achievements.slice().sort((a, b) => {
    if (Boolean(a.unlockedAt) !== Boolean(b.unlockedAt)) return a.unlockedAt ? 1 : -1;
    return (b.progress / b.goal) - (a.progress / a.goal);
  });

  for (const entry of sorted) {
    const done = Boolean(entry.unlockedAt);
    root.append(h(`div.card${done ? '.is-found' : ''}`, null,
      h('div.row.row--between', null,
        h('div.grow', null,
          h('div', null, t(`achievement.${entry.key}`),
            done ? h('span.good', null, ' ✓') : null),
          h('div.small.muted', null,
            `${t(`metric.${entry.metric}`)}: ${tn(Math.min(entry.progress, entry.goal))} / ${tn(entry.goal)}`)),
        h('span.mono.muted', null, `${entry.points}`)),
      done
        ? h('div.small.muted', null, date(entry.unlockedAt))
        : bar(Math.min(entry.progress, entry.goal), entry.goal, { warnAt: 0, badAt: 0 })));
  }
  return root;
}
