/**
 * Public docs.
 *
 * Same content as the in-game manual (`manual.js`'s `SECTIONS`, imported not
 * duplicated), laid out as a sidebar of topics plus one readable page at a
 * time - openfront.io-style reference docs rather than the long
 * stacked-cards scroll the dashboard used to show under "Anleitung".
 */
import { h, add, clear } from './dom.js';
import { t } from '../state/i18n.js';
import { icon } from './icons.js';
import { SECTIONS } from './manual.js';

export function docsView() {
  const page = h('div');
  const layout = h('div.docs');
  const side = h('nav.docs__side');
  const content = h('div.docs__content');
  let active = 0;

  const renderSide = () => {
    clear(side);
    add(side, ...SECTIONS.map((section, i) =>
      h(`button.docs__link${i === active ? '.is-active' : ''}`, {
        onClick: () => { active = i; render(); },
      }, t(section.title))));
  };

  const renderContent = () => {
    clear(content);
    const section = SECTIONS[active];
    add(content,
      h('h3', null, t(section.title)),
      h('ul.docs__list', null, ...section.lines.map((key) => h('li', null, t(key)))),
      section.extra
        ? h('dl.kv', { style: { marginTop: '14px' } },
          ...section.extra.flatMap((row) => [
            h('dt.mono', null, row.term),
            h('dd', null, t(row.detail)),
          ]))
        : null);
  };

  const render = () => { renderSide(); renderContent(); };
  render();

  add(layout, side, content);
  add(page,
    h('h2', null, h('span.docs__title-icon', null, icon('docs')), t('menu.docs')),
    h('p.lede', null, t('app.tagline')),
    layout);
  return page;
}
