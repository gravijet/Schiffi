/**
 * Settings.
 *
 * Every control here is bound to a value the renderer or the network layer
 * actually reads. The graphics tab shows what "Automatic" measured, so the
 * choice is explainable rather than magic, and each individual option can
 * still be overridden - which switches the preset to Custom.
 */
import { h, clear, tabs, toast } from './dom.js';
import { settings, PRESETS, FPS_OPTIONS, GRAPHICS_OPTIONS, presetValues } from '../state/settings.js';
import { t, currentLocale } from '../state/i18n.js';
import { languageGrid, setLocale } from './language.js';
import { api } from '../net/api.js';

const QUALITY_LABELS = {
  auto: 'settings.qualityAuto',
  minimum: 'settings.qualityMinimum',
  low: 'settings.qualityLow',
  medium: 'settings.qualityMedium',
  high: 'settings.qualityHigh',
  ultra: 'settings.qualityUltra',
  custom: 'settings.qualityCustom',
};

export function settingsView({ onChange } = {}) {
  const root = h('div');
  let active = 'graphics';

  const render = () => {
    clear(root);
    root.append(
      tabs([
        { key: 'general', label: t('settings.general') },
        { key: 'graphics', label: t('settings.graphics') },
        { key: 'audio', label: t('settings.audio') },
        { key: 'network', label: t('settings.network') },
      ], active, (key) => { active = key; render(); }),
      h('div', { style: { paddingTop: '12px' } },
        active === 'general' ? generalTab(render)
          : active === 'graphics' ? graphicsTab(render, onChange)
            : active === 'audio' ? audioTab()
              : networkTab(render, onChange)),
    );
  };
  render();
  return root;
}

function generalTab(rerender) {
  return h('div.stack', null,
    h('div.card', null,
      h('div.card__title', null, t('menu.language')),
      languageGrid(currentLocale(), async (code) => {
        await setLocale(code);
        rerender();
      })),
    h('div.card', null,
      h('div.card__title', null, t('profile.theme')),
      h('div.row', null,
        ...['auto', 'dark', 'light'].map((theme) =>
          h(`button${settings.get('theme') === theme ? '.primary' : '.ghost'}`, {
            onClick: () => {
              settings.set('theme', theme);
              applyTheme(theme);
              if (api.isAuthenticated()) api.updateMe({ theme }).catch(() => {});
              rerender();
            },
          }, t(`profile.theme${theme[0].toUpperCase()}${theme.slice(1)}`))))),
  );
}

function graphicsTab(rerender, onChange) {
  const detected = settings.get('autoDetected');
  const quality = settings.get('quality');
  const effective = settings.effective();

  const presetRow = h('div.row', { style: { flexWrap: 'wrap' } },
    ...['auto', ...PRESETS, 'custom'].map((preset) =>
      h(`button${quality === preset ? '.primary' : '.ghost'}`, {
        onClick: async () => {
          if (preset === 'auto') {
            const result = await settings.autoDetect();
            toast(t('settings.autoDetected', { preset: t(QUALITY_LABELS[result.preset]) }), 'info');
          } else {
            settings.setQuality(preset);
          }
          onChange?.();
          rerender();
        },
      }, t(QUALITY_LABELS[preset]))));

  const controls = h('div.stack');
  for (const [key, option] of Object.entries(GRAPHICS_OPTIONS)) {
    const label = t(`settings.${key}`);
    const value = effective[key];

    if (option.type === 'bool') {
      controls.append(h('label.row.row--between', { style: { cursor: 'pointer' } },
        h('span', null, label),
        h('input', {
          type: 'checkbox', checked: Boolean(value),
          onChange: (event) => { settings.setGraphics(key, event.target.checked); onChange?.(); rerender(); },
          style: { width: 'auto' },
        })));
      continue;
    }

    if (option.type === 'fps') {
      controls.append(h('div.field', null,
        h('label', null, t('settings.maxFps')),
        h('select', {
          onChange: (event) => {
            settings.setGraphics('maxFps', Number(event.target.value));
            onChange?.();
            rerender();
          },
        }, ...FPS_OPTIONS.map((fps) =>
          h('option', { value: String(fps), selected: value === fps },
            fps === 0 ? t('settings.unlimited') : `${fps} FPS`)))));
      continue;
    }

    controls.append(h('div.field', null,
      h('label.row.row--between', null,
        h('span', null, label),
        h('span.mono', null, formatValue(key, value))),
      h('input', {
        type: 'range', min: option.min, max: option.max, step: option.step, value,
        onInput: (event) => {
          settings.setGraphics(key, Number(event.target.value));
          onChange?.();
          event.target.parentElement.previousElementSibling?.remove?.();
          rerender();
        },
      })));
  }

  return h('div.stack', null,
    h('div.card', null,
      h('div.card__title', null, t('settings.quality')),
      presetRow,
      detected
        ? h('p.small.muted', { style: { marginTop: '8px' } },
          `${t('settings.autoDetected', { preset: t(QUALITY_LABELS[detected.preset]) })} · `
          + `score ${detected.score} · ${detected.details.cores} cores · `
          + `${detected.details.memory} GB · fill ${detected.details.fillScore}`)
        : null),
    h('div.card', null,
      h('label.row.row--between', { style: { cursor: 'pointer' } },
        h('div', null,
          h('div', null, t('settings.dataSaver')),
          h('div.small.muted', null, t('settings.dataSaverDesc'))),
        h('input', {
          type: 'checkbox', checked: settings.get('dataSaver'),
          onChange: (event) => { settings.set('dataSaver', event.target.checked); onChange?.(); rerender(); },
          style: { width: 'auto' },
        }))),
    h('div.card', null,
      h('label.row.row--between', { style: { cursor: 'pointer' } },
        h('span', null, t('settings.perfOverlay')),
        h('input', {
          type: 'checkbox', checked: settings.get('perfOverlay'),
          onChange: (event) => { settings.set('perfOverlay', event.target.checked); onChange?.(); },
          style: { width: 'auto' },
        }))),
    h('div.card', null, h('div.card__title', null, t('settings.graphics')), controls),
  );
}

function audioTab() {
  const rows = [['master', 'settings.masterVolume'], ['music', 'settings.musicVolume'], ['sfx', 'settings.sfxVolume']];
  return h('div.card', null, ...rows.map(([key, label]) =>
    h('div.field', null,
      h('label.row.row--between', null,
        h('span', null, t(label)),
        h('span.mono', null, `${Math.round(settings.get(`audio.${key}`) * 100)} %`)),
      h('input', {
        type: 'range', min: 0, max: 1, step: 0.05, value: settings.get(`audio.${key}`),
        onInput: (event) => settings.set(`audio.${key}`, Number(event.target.value)),
      }))));
}

function networkTab(rerender, onChange) {
  return h('div.card', null,
    h('div.card__title', null, t('settings.network')),
    h('label.row.row--between', { style: { cursor: 'pointer' } },
      h('div', null,
        h('div', null, t('settings.dataSaver')),
        h('div.small.muted', null, t('settings.dataSaverDesc'))),
      h('input', {
        type: 'checkbox', checked: settings.get('dataSaver'),
        onChange: (event) => { settings.set('dataSaver', event.target.checked); onChange?.(); rerender(); },
        style: { width: 'auto' },
      })));
}

function formatValue(key, value) {
  if (key === 'resolutionScale' || key === 'viewDistance') return `${value.toFixed(2)}×`;
  if (typeof value === 'number') return `${Math.round(value * 100)} %`;
  return String(value);
}

export function applyTheme(theme) {
  const resolved = theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
