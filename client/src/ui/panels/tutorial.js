/**
 * The tutorial, as a checklist that ticks itself off.
 *
 * There is no "next" button: a step is done when the server's own record says
 * it is - distance really sailed, goods really bought, a contract really
 * delivered. That makes it impossible to click through the tutorial without
 * playing the game, and it means the checklist keeps working for a player who
 * did half of it before ever opening this panel.
 */
import { h, add, clear, bar } from '../dom.js';
import { t } from '../../state/i18n.js';
import { api } from '../../net/api.js';
import { settings } from '../../state/settings.js';
import { icon } from '../icons.js';

/** How often the checklist re-reads progress while it is on screen. */
const POLL_MS = 4000;

export class Tutorial {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = null;
    this.timer = null;
    this.root = h('div#tutorial', { hidden: true });
    this.body = h('div.tutorial__body');
    this.head = h('div.tutorial__head');
    add(this.root, this.head, this.body);
  }

  mount(parent) {
    parent.append(this.root);
    return this;
  }

  start() {
    this.stop();
    this.refresh();
    // Progress changes as a result of play, not of anything in this panel, so
    // it has to be re-read rather than derived from a local action.
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    const character = this.ctx.character;
    if (!character) return;
    try {
      this.state = await api.tutorial(character.id);
    } catch {
      return; // the next tick tries again
    }
    this.render();
  }

  /** Hide it away without abandoning it: the checklist can be reopened. */
  hide() {
    settings.set('tutorialHidden', true);
    this.root.hidden = true;
  }

  show() {
    settings.set('tutorialHidden', false);
    this.refresh();
  }

  async skip() {
    try {
      this.state = await api.skipTutorial(this.ctx.character.id);
    } catch { /* the panel simply stays */ }
    this.render();
  }

  async resume() {
    try {
      this.state = await api.resumeTutorial(this.ctx.character.id);
      settings.set('tutorialHidden', false);
    } catch { /* ignore */ }
    this.render();
  }

  render() {
    const state = this.state;
    if (!state) { this.root.hidden = true; return; }

    // Finished, skipped or put away: nothing to show over the map.
    if (state.completed || state.skipped || settings.get('tutorialHidden')) {
      this.root.hidden = true;
      this.stop();
      return;
    }
    this.root.hidden = false;

    const doneCount = state.steps.filter((step) => step.done).length;
    clear(this.head);
    add(this.head,
      h('div.row.row--between', null,
        h('strong', null, t('tutorial.title')),
        h('div.row', null,
          // The list of eight steps sat across the middle of the map, which is
          // the one part of the screen the game is played on. It now shows the
          // step in hand and expands on request.
          h('button.icon-btn', {
            title: t(this.expanded ? 'common.less' : 'common.more'),
            onClick: () => { this.expanded = !this.expanded; this.render(); },
          }, this.expanded ? '▴' : '▾'),
          h('button.icon-btn', { title: t('tutorial.hide'), onClick: () => this.hide() }, '–'),
          h('button.icon-btn', { title: t('tutorial.skip'), onClick: () => this.skip() }, icon('close')))),
      h('div.small.muted', null, t('tutorial.progress', { done: doneCount, total: state.total })),
      bar(doneCount, state.total, { warnAt: 0, badAt: 0 }));

    this.root.classList.toggle('is-compact', !this.expanded);

    clear(this.body);
    for (const [index, step] of state.steps.entries()) {
      const current = index === state.step;
      this.body.append(h(`div.tutorial__step${step.done ? '.is-done' : ''}${current ? '.is-current' : ''}`, null,
        h('span.tutorial__mark', null, step.done ? '✓' : String(index + 1)),
        h('span', null, t(`tutorial.steps.${step.key}`),
          // Only the step in hand shows its counter; the rest would be noise.
          current && step.goal > 1
            ? h('span.small.muted', null, ` (${step.value}/${step.goal})`)
            : null)));
    }
  }
}

/** The tutorial's state for a menu entry, without mounting the overlay. */
export async function tutorialSummary(characterId) {
  try { return await api.tutorial(characterId); } catch { return null; }
}
