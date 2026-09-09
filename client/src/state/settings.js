/**
 * Graphics, audio, control and data settings.
 *
 * Two rules drive the design:
 *   1. Every option is real. Each one is read by the renderer or the network
 *      layer on the frame after it changes; none of them are decoration.
 *   2. "Automatic" measures the machine instead of guessing from the user
 *      agent - a benchmark of the actual device beats a string comparison.
 */

const STORAGE_KEY = 'schiffi.settings.v1';

export const PRESETS = ['minimum', 'low', 'medium', 'high', 'ultra'];

export const FPS_OPTIONS = [30, 45, 60, 90, 120, 144, 0]; // 0 = unlimited

/** Every graphics option, with its range and the preset values. */
export const GRAPHICS_OPTIONS = {
  resolutionScale: { type: 'range', min: 0.4, max: 2, step: 0.05, presets: [0.55, 0.75, 1, 1, 1.25] },
  maxFps:          { type: 'fps', presets: [30, 45, 60, 120, 0] },
  particles:       { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.25, 0.5, 0.8, 1] },
  rain:            { type: 'bool', presets: [false, false, true, true, true] },
  lightning:       { type: 'bool', presets: [false, false, true, true, true] },
  waterAnimation:  { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.3, 0.6, 0.85, 1] },
  waves:           { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.2, 0.5, 0.8, 1] },
  shadows:         { type: 'bool', presets: [false, false, true, true, true] },
  lighting:        { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.35, 0.7, 0.9, 1] },
  antialiasing:    { type: 'bool', presets: [false, false, true, true, true] },
  postprocessing:  { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0, 0.4, 0.7, 1] },
  weatherEffects:  { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.3, 0.6, 0.85, 1] },
  fog:             { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.25, 0.6, 0.85, 1] },
  animations:      { type: 'bool', presets: [false, true, true, true, true] },
  uiAnimations:    { type: 'bool', presets: [false, true, true, true, true] },
  shipDetail:      { type: 'range', min: 0, max: 1, step: 0.05, presets: [0.15, 0.35, 0.6, 0.85, 1] },
  npcDensity:      { type: 'range', min: 0, max: 1, step: 0.05, presets: [0.2, 0.4, 0.7, 0.9, 1] },
  viewDistance:    { type: 'range', min: 0.3, max: 1.6, step: 0.05, presets: [0.45, 0.7, 1, 1.25, 1.6] },
  effectDensity:   { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.3, 0.6, 0.85, 1] },
  mapDetail:       { type: 'range', min: 0, max: 1, step: 0.05, presets: [0.2, 0.45, 0.7, 0.9, 1] },
  textureQuality:  { type: 'range', min: 0, max: 1, step: 0.05, presets: [0.25, 0.45, 0.7, 0.9, 1] },
  vegetationDensity: { type: 'range', min: 0, max: 1, step: 0.05, presets: [0, 0.3, 0.6, 0.85, 1] },
};

export const DEFAULTS = {
  locale: null,
  theme: 'auto',
  quality: 'auto',
  autoDetected: null,
  graphics: presetValues('medium'),
  dataSaver: false,
  perfOverlay: false,
  audio: { master: 0.7, music: 0.5, sfx: 0.8 },
  controls: {
    deadzone: 0.12,
    invertY: false,
    virtualJoystick: 'auto',   // auto | on | off
    keyboardLayout: 'arrows',  // arrows | wasd | both
  },
  minimap: true,
  chatOpen: true,
};

export function presetValues(preset) {
  const index = Math.max(0, PRESETS.indexOf(preset));
  const out = {};
  for (const [key, option] of Object.entries(GRAPHICS_OPTIONS)) {
    out[key] = option.presets[index];
  }
  return out;
}

/**
 * Measure the device instead of sniffing it.
 *
 * A short canvas fill benchmark plus the hardware hints gives a score that
 * maps onto a preset. It runs once, takes a few milliseconds, and is stored so
 * it does not run again unless the player asks for a re-detect.
 */
export function detectQuality() {
  const cores = navigator.hardwareConcurrency ?? 2;
  const memory = navigator.deviceMemory ?? 2;          // GiB, Chromium only
  const pixels = (screen.width * screen.height * (window.devicePixelRatio || 1)) / 1e6;
  const saveData = navigator.connection?.saveData === true;

  // Fill benchmark: how many 256x256 composites fit in ~12 ms.
  let fillScore = 0;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d', { alpha: false });
    const started = performance.now();
    let iterations = 0;
    while (performance.now() - started < 12 && iterations < 4000) {
      ctx.fillStyle = iterations % 2 ? '#123' : '#456';
      ctx.fillRect(0, 0, 256, 256);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(canvas, 0, 0);
      ctx.globalAlpha = 1;
      iterations++;
    }
    fillScore = iterations;
  } catch { fillScore = 200; }

  // WebGL renderer string, when exposed, separates integrated from discrete.
  let gpuHint = 0;
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
      ?? document.createElement('canvas').getContext('webgl');
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      if (/rtx|radeon rx|arc a|apple m[1-9]/i.test(renderer)) gpuHint = 2;
      else if (/geforce|radeon|iris xe/i.test(renderer)) gpuHint = 1;
    }
  } catch { /* WebGL unavailable: leave the hint at zero */ }

  let score = 0;
  score += Math.min(3, cores / 4);           // 0..3
  score += Math.min(2.5, memory / 4);        // 0..2.5
  score += Math.min(3, fillScore / 500);     // 0..3
  score += gpuHint;                          // 0..2
  score -= Math.min(1.5, Math.max(0, pixels - 2.5) * 0.4); // high-DPI costs
  if (saveData) score -= 2;

  let preset = 'medium';
  if (score < 2.2) preset = 'minimum';
  else if (score < 3.8) preset = 'low';
  else if (score < 5.6) preset = 'medium';
  else if (score < 7.4) preset = 'high';
  else preset = 'ultra';

  return {
    preset,
    score: Math.round(score * 100) / 100,
    details: { cores, memory, fillScore, gpuHint, megapixels: Math.round(pixels * 100) / 100, saveData },
  };
}

/** Data saver forces the cheap end of several options, without losing them. */
export function applyDataSaver(graphics) {
  return {
    ...graphics,
    resolutionScale: Math.min(graphics.resolutionScale, 0.75),
    maxFps: graphics.maxFps === 0 ? 45 : Math.min(graphics.maxFps, 45),
    particles: Math.min(graphics.particles, 0.2),
    rain: false,
    lightning: false,
    waterAnimation: Math.min(graphics.waterAnimation, 0.2),
    postprocessing: 0,
    weatherEffects: Math.min(graphics.weatherEffects, 0.3),
    npcDensity: Math.min(graphics.npcDensity, 0.35),
    viewDistance: Math.min(graphics.viewDistance, 0.7),
    effectDensity: Math.min(graphics.effectDensity, 0.2),
    textureQuality: Math.min(graphics.textureQuality, 0.4),
    vegetationDensity: Math.min(graphics.vegetationDensity, 0.2),
  };
}

export class Settings extends EventTarget {
  constructor() {
    super();
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.data = mergeDeep(structuredClone(DEFAULTS), JSON.parse(raw));
    } catch { /* corrupt or unavailable storage: keep the defaults */ }
    return this.data;
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  /** The graphics values actually in force, after preset and data saver. */
  effective() {
    const base = this.data.quality === 'custom'
      ? this.data.graphics
      : presetValues(this.data.quality === 'auto'
        ? (this.data.autoDetected?.preset ?? 'medium')
        : this.data.quality);
    return this.data.dataSaver ? applyDataSaver(base) : base;
  }

  get(path, fallback = undefined) {
    return path.split('.').reduce((node, key) => (node == null ? node : node[key]), this.data) ?? fallback;
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = this.data;
    for (const key of keys) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    if (node[last] === value) return;
    node[last] = value;
    this.save();
    this.emit(path, value);
  }

  /** Moving a single graphics slider switches the preset to custom. */
  setGraphics(key, value) {
    if (this.data.quality !== 'custom') {
      this.data.graphics = { ...this.effective() };
      this.data.quality = 'custom';
    }
    this.data.graphics[key] = value;
    this.save();
    this.emit(`graphics.${key}`, value);
  }

  setQuality(quality) {
    this.data.quality = quality;
    if (quality !== 'custom' && quality !== 'auto') {
      this.data.graphics = presetValues(quality);
    }
    this.save();
    this.emit('quality', quality);
  }

  async autoDetect() {
    const result = detectQuality();
    this.data.autoDetected = result;
    this.data.quality = 'auto';
    this.data.graphics = presetValues(result.preset);
    this.save();
    this.emit('quality', 'auto');
    return result;
  }

  emit(path, value) {
    this.dispatchEvent(new CustomEvent('change', { detail: { path, value } }));
  }

  reset() {
    const locale = this.data.locale;
    this.data = structuredClone(DEFAULTS);
    this.data.locale = locale;
    this.save();
    this.emit('*', null);
  }
}

function mergeDeep(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      mergeDeep(target[key], value);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

export const settings = new Settings();
