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
 *
 * The background is a small flat scene of the game's own subject - a
 * horizon, a couple of islands, a couple of ships sailing past - drawn with
 * the same plain shapes the renderer itself uses for a ship, not a generic
 * glow-and-gradient backdrop. Quiet motion, one accent colour, nothing that
 * could not also be a loading screen for this specific game.
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

const SEA = '#0a1823';
const SEA_DEEP = '#061019';
const LAND = '#173544';
const LAND_EDGE = '#225065';
const LINE = 'rgba(128, 234, 210, 0.55)';
const HULL = 'rgba(217, 231, 232, 0.82)';

/**
 * One flat ship silhouette: the same pixel-art sprite trick the live
 * renderer uses for every ship in the game (see
 * render/renderer.js#buildShipSprite) - rasterized once at a small fixed
 * resolution, then scaled up with nearest-neighbour sampling so it reads as
 * blocky pixel art rather than a smooth vector hull. Familiar on purpose - a
 * returning player should recognise it before they have even clicked past
 * this screen.
 */
const SILHOUETTE_REF_SIZE = 10;
const SILHOUETTE_PX_PER_UNIT = 1.4;
let silhouetteSprite = null;

function buildSilhouetteSprite() {
  const size = SILHOUETTE_REF_SIZE;
  const pad = size * 0.12;
  const minX = -size * 0.7 - pad;
  const maxX = size + pad;
  const minY = -size * 0.95 - pad;
  const maxY = size * 0.55 + pad;
  const px = SILHOUETTE_PX_PER_UNIT;
  const width = Math.max(4, Math.round((maxX - minX) * px));
  const height = Math.max(4, Math.round((maxY - minY) * px));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.translate(-minX * px, -minY * px);
  c.scale(px, px);

  c.beginPath();
  c.moveTo(size, 0);
  c.lineTo(-size * 0.7, size * 0.55);
  c.lineTo(-size * 0.45, 0);
  c.lineTo(-size * 0.7, -size * 0.55);
  c.closePath();
  c.fillStyle = HULL;
  c.fill();
  c.beginPath();
  c.moveTo(-size * 0.08, -size * 0.95);
  c.lineTo(-size * 0.08, size * 0.15);
  c.strokeStyle = HULL;
  c.lineWidth = Math.max(1 / px, size * 0.1);
  c.stroke();

  return { canvas, minX, minY, width: maxX - minX, height: maxY - minY };
}

function drawShipSilhouette(ctx, x, y, size, facingRight) {
  if (!silhouetteSprite) silhouetteSprite = buildSilhouetteSprite();
  const dir = facingRight ? 1 : -1;
  const scale = size / SILHOUETTE_REF_SIZE;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * scale, scale);
  ctx.drawImage(silhouetteSprite.canvas, silhouetteSprite.minX, silhouetteSprite.minY,
    silhouetteSprite.width, silhouetteSprite.height);
  ctx.restore();
}

function drawIsland(ctx, x, baseY, width, height) {
  ctx.beginPath();
  ctx.moveTo(x - width / 2, baseY);
  ctx.quadraticCurveTo(x - width * 0.22, baseY - height, x, baseY - height * 0.86);
  ctx.quadraticCurveTo(x + width * 0.3, baseY - height * 0.5, x + width / 2, baseY);
  ctx.closePath();
  ctx.fillStyle = LAND;
  ctx.fill();
  // A single palm, two fronds - enough to read as land, not a mainland.
  const px = x + width * 0.12;
  const py = baseY - height * 0.78;
  ctx.strokeStyle = LAND_EDGE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, py + 14);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(px - 9, py - 5, px - 13, py + 2);
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(px + 9, py - 5, px + 13, py + 2);
  ctx.stroke();
}

/**
 * The scene: sky, a horizon, a couple of islands sitting on it, a couple of
 * ships sailing slowly past. Flat fills only - no blur, no glow filters - so
 * it reads as a scene rather than a light source.
 */
function paintScene(canvas, pointer) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;

  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Resizing the backing store resets context state, including this -
    // reaffirm it so the pixel-art ship sprites stay crisp, not smoothed.
    ctx.imageSmoothingEnabled = false;
  };
  resize();
  window.addEventListener('resize', resize);

  const stars = Array.from({ length: 40 }, () => ({
    x: Math.random(), y: Math.random() * 0.5, r: Math.random() < 0.85 ? 1 : 1.6,
  }));
  const islands = [
    { x: 0.1, w: 130, h: 46 },
    { x: 0.66, w: 90, h: 34 },
    { x: 0.86, w: 150, h: 52 },
  ];
  const ships = [
    { x0: -0.15, offset: 10, speed: 0.011, size: 14, right: true },
    { x0: 1.2, offset: 34, speed: 0.02, size: 24, right: false },
    { x0: 0.55, offset: 58, speed: 0.009, size: 16, right: true },
  ];

  let raf = null;
  const start = performance.now();
  const draw = (now) => {
    const time = (now - start) / 1000;
    const horizon = h * 0.6;
    const px = pointer.x * 6;

    ctx.fillStyle = SEA_DEEP;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = LINE;
    for (const s of stars) {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(s.x * w + px * 0.3, s.y * horizon, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // Sea, flat, with the horizon a single crisp line.
    ctx.fillStyle = SEA;
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();

    // Islands sit on the horizon, drifting a little slower than the ships in
    // front of them - the one bit of depth this scene allows itself.
    for (const isl of islands) {
      drawIsland(ctx, isl.x * w + px * 0.5, horizon, isl.w, isl.h);
    }

    // Ships, each looping across at its own depth and speed.
    for (const s of ships) {
      const travel = (((s.right ? s.x0 + time * s.speed : s.x0 - time * s.speed) % 1.4) + 1.4) % 1.4 - 0.2;
      const x = travel * w + px;
      const y = horizon + s.offset + Math.sin(time * 0.6 + s.x0 * 10) * 1.5;
      drawShipSilhouette(ctx, x, y, s.size, s.right);
    }

    raf = requestAnimationFrame(draw);
  };

  if (reducedMotion()) {
    draw(start);
  } else {
    raf = requestAnimationFrame(draw);
  }

  return () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
  };
}

export function showStartGate(promo) {
  return new Promise((resolve) => {
    const pointer = { x: 0, y: 0 };
    const onMove = reducedMotion() ? null : (event) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    if (onMove) window.addEventListener('pointermove', onMove);

    const canvas = h('canvas.start-gate__canvas', { 'aria-hidden': 'true' });
    let stopScene = () => {};

    const letters = [...t('app.name')].map((letter, i) =>
      h('span.start-gate__letter', { style: { animationDelay: `${i * 40 + 100}ms` } }, letter));

    const cleanup = () => {
      if (onMove) window.removeEventListener('pointermove', onMove);
      stopScene();
    };

    const enter = () => {
      gate.classList.add('start-gate--leaving');
      cleanup();
      const done = promo ? showInterstitial(promo, { unmuted: Boolean(promo.video) }) : Promise.resolve();
      gate.addEventListener('transitionend', () => gate.remove(), { once: true });
      done.then(resolve);
    };

    const startBtn = h('button.start-gate__btn', { onClick: enter }, t('app.start'));

    const gate = h('div.start-gate', { role: 'dialog', 'aria-label': t('app.start') },
      canvas,
      h('div.start-gate__center', null,
        h('h1.start-gate__title', null, ...letters),
        h('div.start-gate__rule', { 'aria-hidden': 'true' }),
        h('p.start-gate__tagline', null, t('app.tagline')),
        startBtn));

    document.body.append(gate);
    stopScene = paintScene(canvas, pointer);
    startBtn.focus();
  });
}
