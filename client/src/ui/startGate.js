/**
 * The first thing a visitor can act on: a full-screen "press start" moment
 * instead of materialising straight into a menu.
 *
 * It is not only decoration. Clicking it is a genuine user gesture, and if
 * the operator's interstitial is a video, that gesture is spent immediately
 * on unmuting it - the one condition every browser actually honours for
 * unmuted autoplay. Wait past this point, even a microtask, and the browser
 * no longer considers it a gesture at all, so the interstitial is opened
 * synchronously from inside the click handler below, never awaited into.
 */
import { h } from './dom.js';
import { t } from '../state/i18n.js';
import { api } from '../net/api.js';

/**
 * Show it, and resolve when the visitor moves on.
 *
 * There is deliberately no scrubbing, pausing or volume chrome on the video
 * itself - the operator's advert plays start to finish, or is skipped once
 * the configured wait is up, and nothing in between. `unmuted` is only ever
 * true from directly inside the start gate's click handler below - that is
 * the only place a browser will actually honour it.
 */
function showInterstitial(promo, { unmuted = false } = {}) {
  return new Promise((resolve) => {
    const skip = h('button.primary', { disabled: promo.seconds > 0 });
    let left = Math.max(0, Number(promo.seconds) || 0);

    const done = () => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      layer.remove();
      resolve();
    };
    const onKey = (event) => { if (event.key === 'Escape') done(); };
    skip.addEventListener('click', done);

    const label = () => { skip.textContent = left > 0 ? `${t('promo.continueIn', { seconds: left })}` : t('promo.continue'); };
    label();
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) { left = 0; skip.disabled = false; clearInterval(timer); }
      label();
    }, 1000);

    const visit = () => {
      if (!promo.targetUrl) return;
      api.interstitialClick(promo.id).catch(() => {});
      window.open(promo.targetUrl, '_blank', 'noopener,noreferrer');
    };

    let video = null;
    const card = h('div.promo__card', null,
      promo.video
        ? (video = h('video.promo__image', {
          src: promo.video, autoplay: true, muted: !unmuted, playsInline: true,
          disablePictureInPicture: true,
          onContextMenu: (event) => event.preventDefault(),
        }))
        : promo.image
        ? h('img.promo__image', {
          src: promo.image, alt: promo.headline,
          onClick: visit,
          style: { cursor: promo.targetUrl ? 'pointer' : 'default' },
        })
        : null,
      h('h1.promo__headline', null, promo.headline),
      promo.body ? h('p.promo__body', null, promo.body) : null,
      h('div.promo__actions', null,
        promo.targetUrl ? h('button.ghost', { onClick: visit }, t('promo.visit')) : null,
        skip),
      h('p.promo__note', null, t('promo.note')));

    const layer = h('div.promo', { role: 'dialog', 'aria-modal': 'true' }, card);
    document.addEventListener('keydown', onKey);
    document.body.append(layer);
    // A muted <video autoplay> always starts on its own; an unmuted one needs
    // an explicit play() spent from the still-live click that opened this
    // dialog. If the browser refuses it anyway, fall back to muted rather
    // than leaving a paused black rectangle behind.
    if (video && unmuted) {
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    }
    skip.focus();
  });
}

function reducedMotion() {
  return document.documentElement.dataset.anim === 'off'
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function showStartGate(promo) {
  return new Promise((resolve) => {
    const onMove = reducedMotion() ? null : (event) => {
      gate.style.setProperty('--bx', `${(event.clientX / window.innerWidth) * 100}%`);
      gate.style.setProperty('--by', `${(event.clientY / window.innerHeight) * 100}%`);
    };
    if (onMove) window.addEventListener('pointermove', onMove);

    const letters = [...t('app.name')].map((letter, i) =>
      h('span.start-gate__letter', { style: { animationDelay: `${i * 40 + 100}ms` } }, letter));

    const enter = () => {
      gate.classList.add('start-gate--leaving');
      if (onMove) window.removeEventListener('pointermove', onMove);
      const done = promo ? showInterstitial(promo, { unmuted: Boolean(promo.video) }) : Promise.resolve();
      gate.addEventListener('transitionend', () => gate.remove(), { once: true });
      done.then(resolve);
    };

    const startBtn = h('button.start-gate__btn', { onClick: enter },
      h('span', null, t('app.start')),
      h('span.start-gate__btn-dot', { 'aria-hidden': 'true' }));

    const gate = h('div.start-gate', { role: 'dialog', 'aria-label': t('app.start') },
      h('div.start-gate__field', { 'aria-hidden': 'true' }),
      h('div.start-gate__center', null,
        h('h1.start-gate__title', null, ...letters),
        h('div.start-gate__rule', { 'aria-hidden': 'true' }),
        h('p.start-gate__tagline', null, t('app.tagline')),
        startBtn));

    document.body.append(gate);
    startBtn.focus();
  });
}
