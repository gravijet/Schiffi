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

const GLITCH_CHARS = '01<>[]{}#/\\+=-_*^%$§⚓';

function reducedMotion() {
  return document.documentElement.dataset.anim === 'off'
    || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Per-letter decode: static noise resolving into the real word, left to right. */
function decodeText(el, finalText, { onDone } = {}) {
  if (reducedMotion()) { el.textContent = finalText; onDone?.(); return () => {}; }
  const letters = [...finalText];
  const settleAt = letters.map((_, i) => 6 + Math.floor((i / letters.length) * 14) + Math.floor(Math.random() * 4));
  let frame = 0;
  const totalFrames = Math.max(...settleAt) + 1;
  const id = setInterval(() => {
    let out = '';
    for (let i = 0; i < letters.length; i++) {
      if (letters[i] === ' ' || frame >= settleAt[i]) out += letters[i];
      else out += GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
    }
    el.textContent = out;
    frame++;
    if (frame > totalFrames) { el.textContent = finalText; clearInterval(id); onDone?.(); }
  }, 45);
  return () => clearInterval(id);
}

/**
 * A slow perspective grid receding to a horizon, with a radar sweep and a
 * drifting starfield - drawn fresh each frame rather than as a looping video
 * or a library, so it costs nothing to ship and nothing to load.
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
  };
  resize();
  window.addEventListener('resize', resize);

  const stars = Array.from({ length: 90 }, () => ({
    x: Math.random(), y: Math.random() * 0.55,
    r: Math.random() * 1.4 + 0.3, tw: Math.random() * Math.PI * 2,
  }));

  let raf = null;
  const start = performance.now();
  const draw = (now) => {
    const time = (now - start) / 1000;
    const horizon = h * 0.56;
    const px = pointer.x * 14;
    const py = pointer.y * 8;
    ctx.clearRect(0, 0, w, h);

    // Sky glow behind the horizon.
    const sky = ctx.createRadialGradient(w / 2 + px, horizon + py, 0, w / 2 + px, horizon + py, w * 0.55);
    sky.addColorStop(0, 'rgba(53, 214, 180, 0.16)');
    sky.addColorStop(1, 'rgba(53, 214, 180, 0)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Starfield above the horizon.
    for (const s of stars) {
      const a = 0.35 + Math.sin(time * 1.4 + s.tw) * 0.25;
      ctx.fillStyle = `rgba(128, 234, 210, ${Math.max(0, a)})`;
      ctx.beginPath();
      ctx.arc(s.x * w + px * 0.4, s.y * horizon + py * 0.4, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Converging verticals - the grid's perspective.
    const vpX = w / 2 + px;
    const vpY = horizon + py;
    ctx.strokeStyle = 'rgba(53, 214, 180, 0.14)';
    ctx.lineWidth = 1;
    const cols = 22;
    for (let i = 0; i <= cols; i++) {
      const nx = (i / cols - 0.5) * 2;
      ctx.beginPath();
      ctx.moveTo(vpX + nx * w * 0.015, vpY);
      ctx.lineTo(vpX + nx * w * 0.95, h);
      ctx.stroke();
    }

    // Scrolling horizontals, spaced to feel like they approach the viewer.
    const rows = 18;
    for (let i = 0; i < rows; i++) {
      const p = ((i / rows) + (time * 0.09)) % 1;
      const y = vpY + (p ** 2.3) * (h - vpY);
      if (y <= vpY) continue;
      const alpha = 0.05 + 0.22 * p;
      ctx.strokeStyle = `rgba(53, 214, 180, ${Math.min(0.27, alpha)})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // The horizon line itself, bright.
    ctx.strokeStyle = 'rgba(128, 234, 210, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, vpY);
    ctx.lineTo(w, vpY);
    ctx.stroke();

    // A slow radar sweep, centred a little above the horizon. Older engines
    // without conic gradients just keep the rings below, quietly.
    const cx = w / 2 + px * 0.6;
    const cy = horizon - h * 0.1 + py * 0.6;
    const radius = Math.min(w, h) * 0.34;
    if (typeof ctx.createConicGradient === 'function') {
      const sweep = time * 0.6;
      const sweepGrad = ctx.createConicGradient(sweep, cx, cy);
      sweepGrad.addColorStop(0, 'rgba(53, 214, 180, 0.28)');
      sweepGrad.addColorStop(0.06, 'rgba(53, 214, 180, 0)');
      sweepGrad.addColorStop(1, 'rgba(53, 214, 180, 0)');
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = sweepGrad;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
    }
    for (const ring of [0.34, 0.66, 1]) {
      ctx.strokeStyle = 'rgba(53, 214, 180, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * ring, 0, Math.PI * 2);
      ctx.stroke();
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

/**
 * Show it, and resolve when the visitor moves on to the advert (if any) and
 * dismisses that too.
 *
 * `unmuted` on the interstitial is only ever true here, spent from directly
 * inside the click below - see the module doc for why that is the only safe
 * place for it.
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
          src: promo.video, controls: true, autoplay: true, muted: !unmuted, playsInline: true,
          onClick: (event) => event.stopPropagation(),
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

export function showStartGate(promo) {
  return new Promise((resolve) => {
    const pointer = { x: 0, y: 0 };
    const onMove = (event) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove);

    const canvas = h('canvas.start-gate__canvas', { 'aria-hidden': 'true' });
    // Started only once this is actually laid out in the document - a canvas
    // sized before that has zero width and height, and everything painted to
    // it is painted to nothing.
    let stopScene = () => {};

    const particles = h('div.start-gate__particles', { 'aria-hidden': 'true' },
      ...Array.from({ length: 20 }, (_, i) => h('span', {
        style: {
          left: `${(i * 137.5) % 100}%`,
          animationDuration: `${8 + (i % 5) * 2}s`,
          animationDelay: `${-(i * 1.7) % 14}s`,
        },
      })));

    const spokes = Array.from({ length: 8 }, (_, i) =>
      h('div.start-gate__spoke', { style: { transform: `rotate(${i * 45}deg)` } }));

    const title = h('div.start-gate__title', { 'aria-label': t('app.name') }, '');
    const tagline = h('div.start-gate__tagline', null, `// ${t('app.tagline')}`);

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      stopScene();
    };

    const enter = () => {
      gate.classList.add('start-gate--leaving');
      cleanup();
      const done = promo ? showInterstitial(promo, { unmuted: Boolean(promo.video) }) : Promise.resolve();
      gate.addEventListener('transitionend', () => gate.remove(), { once: true });
      done.then(resolve);
    };

    const startBtn = h('button.start-gate__btn', { onClick: enter },
      h('span.start-gate__btn-label', null, t('app.start')));

    const gate = h('div.start-gate', { role: 'dialog', 'aria-label': t('app.start') },
      canvas,
      h('div.start-gate__scanlines', { 'aria-hidden': 'true' }),
      particles,
      h('div.start-gate__center', null,
        h('div.start-gate__wheel', { 'aria-hidden': 'true' },
          ...spokes,
          h('span.start-gate__mark', null, '⚓')),
        title,
        tagline,
        startBtn));

    document.body.append(gate);
    stopScene = paintScene(canvas, pointer);
    decodeText(title, t('app.name'));
    startBtn.focus();
  });
}
