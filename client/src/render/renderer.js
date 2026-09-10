/**
 * Map renderer.
 *
 * Canvas 2D, one pass, no framework. The design targets weak hardware:
 *
 *   - the whole terrain is one pre-built ImageBitmap; drawing the world costs
 *     a single drawImage regardless of how much of it is on screen
 *   - everything else is culled against the viewport before it is drawn
 *   - the backbuffer is sized by resolutionScale, so dropping to 0.55 really
 *     does quarter the fill cost
 *   - the frame budget is enforced: maxFps skips frames rather than rendering
 *     them and letting the browser drop them
 *   - every effect (waves, rain, lightning, fog, particles) checks its own
 *     setting and costs exactly nothing when it is off
 */
import { CELL_SIZE, CELLS_X, CELLS_Y, FOG_CELL_SIZE, FOG_X, FOG_Y } from '@schiffi/shared/world/constants.js';
import { clamp, clamp01, TAU } from '@schiffi/shared/util/math.js';
import { UI, FACTION_COLOURS } from './palette.js';

const MIN_ZOOM = 0.06;
const MAX_ZOOM = 3.5;

export class Renderer {
  constructor(canvas, { settings }) {
    this.canvas = canvas;
    this.settings = settings;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.camera = { x: CELLS_X * CELL_SIZE / 2, y: CELLS_Y * CELL_SIZE / 2, zoom: 0.35 };
    this.targetZoom = this.camera.zoom;
    this.follow = true;

    this.terrainBitmap = null;
    this.world = null;         // world metadata: ports, regions, anchorages
    this.fogBits = null;
    this.fogCanvas = null;
    this.fogDirty = true;

    this.entities = [];
    this.storms = [];
    this.wrecks = [];
    this.self = null;
    this.wind = { a: 0, s: 0 };
    this.daylight = 1;

    this.time = 0;
    this.lastFrame = performance.now();
    this.frameBudget = 0;
    this.stats = { fps: 0, frameMs: 0, drawn: 0, culled: 0, frames: 0, since: performance.now() };

    this.particles = [];
    this.lightningUntil = 0;

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
  }

  get graphics() { return this.settings.effective(); }

  resize() {
    const scale = clamp(this.graphics.resolutionScale ?? 1, 0.3, 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = this.canvas.clientWidth || window.innerWidth;
    const cssHeight = this.canvas.clientHeight || window.innerHeight;

    this.viewWidth = cssWidth;
    this.viewHeight = cssHeight;
    // Backbuffer resolution is the honest lever: everything else is detail.
    this.canvas.width = Math.max(320, Math.round(cssWidth * dpr * scale));
    this.canvas.height = Math.max(240, Math.round(cssHeight * dpr * scale));
    this.pixelScale = this.canvas.width / cssWidth;
    this.ctx.imageSmoothingEnabled = Boolean(this.graphics.antialiasing);
  }

  setTerrain(bitmap) { this.terrainBitmap = bitmap; }
  setWorld(meta) {
    this.world = meta;
    this.portIndex = buildSpatialIndex(meta.ports, 4096);
    this.anchorageIndex = buildSpatialIndex(meta.anchorages, 4096);
  }

  setFog(bits) {
    this.fogBits = bits;
    this.fogDirty = true;
  }

  /** Reveal fog locally so the effect is immediate, not one snapshot late. */
  revealFogAt(worldX, worldY, radiusWorld) {
    if (!this.fogBits) return;
    const cx = Math.floor(worldX / FOG_CELL_SIZE);
    const cy = Math.floor(worldY / FOG_CELL_SIZE);
    const r = Math.max(1, Math.ceil(radiusWorld / FOG_CELL_SIZE));
    let changed = false;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= FOG_Y) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = cx + dx;
        if (x < 0 || x >= FOG_X) continue;
        const index = y * FOG_X + x;
        const byte = index >> 3;
        const mask = 1 << (index & 7);
        if ((this.fogBits[byte] & mask) === 0) { this.fogBits[byte] |= mask; changed = true; }
      }
    }
    if (changed) this.fogDirty = true;
  }

  centreOn(x, y, { snap = false } = {}) {
    if (snap) { this.camera.x = x; this.camera.y = y; }
    else {
      this.camera.x += (x - this.camera.x) * 0.18;
      this.camera.y += (y - this.camera.y) * 0.18;
    }
  }

  zoomBy(factor, anchorX, anchorY) {
    const before = this.screenToWorld(anchorX ?? this.viewWidth / 2, anchorY ?? this.viewHeight / 2);
    this.targetZoom = clamp(this.targetZoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.camera.zoom = this.targetZoom;
    const after = this.screenToWorld(anchorX ?? this.viewWidth / 2, anchorY ?? this.viewHeight / 2);
    // Keep the world point under the cursor fixed while zooming.
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.follow = false;
  }

  worldToScreen(x, y) {
    return {
      x: (x - this.camera.x) * this.camera.zoom + this.viewWidth / 2,
      y: (y - this.camera.y) * this.camera.zoom + this.viewHeight / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: (x - this.viewWidth / 2) / this.camera.zoom + this.camera.x,
      y: (y - this.viewHeight / 2) / this.camera.zoom + this.camera.y,
    };
  }

  /** World-space rectangle currently visible, with a margin. */
  viewBounds(margin = 0) {
    const halfW = this.viewWidth / 2 / this.camera.zoom + margin;
    const halfH = this.viewHeight / 2 / this.camera.zoom + margin;
    return {
      x0: this.camera.x - halfW, x1: this.camera.x + halfW,
      y0: this.camera.y - halfH, y1: this.camera.y + halfH,
      w: halfW * 2, h: halfH * 2,
    };
  }

  /** @returns {boolean} whether a frame was actually drawn. */
  frame(now = performance.now()) {
    const graphics = this.graphics;
    const delta = now - this.lastFrame;

    // Frame limiting: skipping is cheaper than drawing and discarding.
    if (graphics.maxFps > 0) {
      this.frameBudget += delta;
      const interval = 1000 / graphics.maxFps;
      if (this.frameBudget < interval) { this.lastFrame = now; return false; }
      this.frameBudget = Math.min(this.frameBudget - interval, interval);
    }
    this.lastFrame = now;
    this.time += delta / 1000;

    const started = performance.now();
    this.draw(delta / 1000, graphics);
    this.stats.frameMs = performance.now() - started;

    this.stats.frames++;
    if (now - this.stats.since >= 500) {
      this.stats.fps = Math.round((this.stats.frames * 1000) / (now - this.stats.since));
      this.stats.frames = 0;
      this.stats.since = now;
    }
    return true;
  }

  draw(dt, g) {
    const ctx = this.ctx;
    const scale = this.pixelScale;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = Boolean(g.antialiasing);

    this.drawWater(ctx, g);
    this.drawTerrain(ctx, g);
    if (g.waves > 0) this.drawWaves(ctx, g);
    this.drawRegions(ctx, g);
    this.drawPorts(ctx, g);
    this.drawStorms(ctx, g, dt);
    this.drawWrecks(ctx, g);
    this.drawEntities(ctx, g);
    this.drawSelf(ctx, g);
    if (g.fog > 0) this.drawFog(ctx, g);
    if (g.lighting > 0) this.drawLighting(ctx, g);
    if (g.weatherEffects > 0) this.drawWeatherOverlay(ctx, g, dt);
    this.drawCompass(ctx, g);
  }

  drawWater(ctx, g) {
    // A flat ground colour behind everything: cheaper than clearing.
    ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#9db3c4' : '#06121e';
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
  }

  drawTerrain(ctx, g) {
    if (!this.terrainBitmap) return;
    const bounds = this.viewBounds();

    // Source rectangle in cell space, clamped to the map.
    const sx = clamp(bounds.x0 / CELL_SIZE, 0, CELLS_X);
    const sy = clamp(bounds.y0 / CELL_SIZE, 0, CELLS_Y);
    const sw = clamp(bounds.w / CELL_SIZE, 1, CELLS_X - sx);
    const sh = clamp(bounds.h / CELL_SIZE, 1, CELLS_Y - sy);

    const topLeft = this.worldToScreen(sx * CELL_SIZE, sy * CELL_SIZE);
    const dw = sw * CELL_SIZE * this.camera.zoom;
    const dh = sh * CELL_SIZE * this.camera.zoom;

    // Smoothing matters when magnified: one image pixel is one terrain cell,
    // so at close zoom each pixel covers ~24 world units and would otherwise
    // read as a grid of squares. Zoomed out, nearest-neighbour keeps coasts
    // crisp instead of blurring islands away.
    const smooth = g.antialiasing && this.camera.zoom > 0.3;
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage(this.terrainBitmap, sx, sy, sw, sh, topLeft.x, topLeft.y, dw, dh);
    ctx.imageSmoothingEnabled = Boolean(g.antialiasing);
  }

  /**
   * Animated swell. Drawn as a handful of long sine strokes rather than
   * per-pixel work, so the cost is a few dozen paths at most and it scales
   * down smoothly with the `waves` setting.
   */
  drawWaves(ctx, g) {
    if (this.camera.zoom < 0.18) return;
    const bounds = this.viewBounds();
    const spacing = 130 / Math.max(0.25, g.waves);
    const amplitude = 3.2 * g.waves * this.camera.zoom;
    const phase = this.time * (0.35 + g.waterAnimation);
    const lines = Math.min(46, Math.ceil(this.viewHeight / (spacing * this.camera.zoom)) + 2);

    ctx.save();
    ctx.strokeStyle = `rgba(190, 220, 240, ${0.05 + 0.07 * g.waves})`;
    ctx.lineWidth = Math.max(0.6, this.camera.zoom * 1.2);
    ctx.beginPath();
    for (let i = 0; i < lines; i++) {
      const worldY = Math.floor(bounds.y0 / spacing) * spacing + i * spacing;
      const start = this.worldToScreen(bounds.x0, worldY);
      const steps = 14;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = start.x + t * this.viewWidth;
        const y = start.y + Math.sin(phase + t * 6 + i * 0.7 + this.wind.a) * amplitude;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  drawRegions(ctx, g) {
    if (!this.world || this.camera.zoom > 0.25 || g.mapDetail < 0.3) return;
    const bounds = this.viewBounds(3000);
    ctx.save();
    // Region names are orientation, not content: small, faint and capped, so
    // they never compete with the coastline for attention.
    const size = clamp(9 + this.camera.zoom * 40, 9, 15);
    ctx.font = `${size}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center';
    ctx.fillStyle = document.documentElement.dataset.theme === 'light'
      ? 'rgba(22, 35, 46, 0.30)' : 'rgba(236, 227, 210, 0.26)';
    for (const region of this.world.regions) {
      if (region.x < bounds.x0 || region.x > bounds.x1 || region.y < bounds.y0 || region.y > bounds.y1) continue;
      const p = this.worldToScreen(region.x, region.y);
      ctx.fillText(region.name, p.x, p.y);
    }
    ctx.restore();
  }

  drawPorts(ctx, g) {
    if (!this.world) return;
    const bounds = this.viewBounds(200);
    const zoom = this.camera.zoom;
    const showLabels = zoom > 0.16 && g.mapDetail > 0.25;
    let drawn = 0;
    let culled = 0;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `${Math.max(9, Math.min(14, 11 * Math.max(0.8, zoom)))}px ui-sans-serif, system-ui`;

    for (const port of queryIndex(this.portIndex, bounds)) {
      if (port.x < bounds.x0 || port.x > bounds.x1 || port.y < bounds.y0 || port.y > bounds.y1) { culled++; continue; }
      // Small ports disappear first when zoomed out: the map stays readable.
      if (zoom < 0.12 && port.size < 3) { culled++; continue; }
      if (zoom < 0.06 && port.size < 4) { culled++; continue; }

      const p = this.worldToScreen(port.x, port.y);
      const radius = clamp(2 + port.size * 1.2 * Math.max(0.6, zoom * 2), 2, 12);

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, TAU);
      ctx.fillStyle = FACTION_COLOURS[port.faction] ?? UI.port;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = UI.portRing;
      ctx.stroke();

      if (showLabels && (port.size >= 2 || zoom > 0.4)) {
        ctx.fillStyle = document.documentElement.dataset.theme === 'light'
          ? 'rgba(22, 35, 46, 0.9)' : 'rgba(236, 227, 210, 0.88)';
        ctx.fillText(port.name, p.x, p.y - radius - 3);
      }
      drawn++;
    }

    // Landing beaches on uncharted islands, once they are close enough to see.
    if (zoom > 0.2) {
      ctx.fillStyle = UI.anchorage;
      for (const anchorage of queryIndex(this.anchorageIndex, bounds)) {
        if (anchorage.x < bounds.x0 || anchorage.x > bounds.x1) continue;
        if (anchorage.y < bounds.y0 || anchorage.y > bounds.y1) continue;
        const p = this.worldToScreen(anchorage.x, anchorage.y);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 5);
        ctx.lineTo(p.x + 4, p.y + 3);
        ctx.lineTo(p.x - 4, p.y + 3);
        ctx.closePath();
        ctx.fill();
        drawn++;
      }
    }

    ctx.restore();
    this.stats.drawn = drawn;
    this.stats.culled = culled;
  }

  drawStorms(ctx, g, dt) {
    if (g.weatherEffects <= 0) return;
    const bounds = this.viewBounds(1000);
    ctx.save();
    for (const storm of this.storms) {
      if (storm.x + storm.r < bounds.x0 || storm.x - storm.r > bounds.x1) continue;
      if (storm.y + storm.r < bounds.y0 || storm.y - storm.r > bounds.y1) continue;

      const p = this.worldToScreen(storm.x, storm.y);
      const r = storm.r * this.camera.zoom;
      const intensity = storm.i * g.weatherEffects;

      const gradient = ctx.createRadialGradient(p.x, p.y, r * 0.15, p.x, p.y, r);
      const tint = storm.k === 'ice' ? '198, 216, 228' : storm.k === 'fog' ? '190, 196, 204' : '90, 106, 130';
      gradient.addColorStop(0, `rgba(${tint}, ${0.42 * intensity})`);
      gradient.addColorStop(0.7, `rgba(${tint}, ${0.22 * intensity})`);
      gradient.addColorStop(1, `rgba(${tint}, 0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();

      if (g.mapDetail > 0.4) {
        ctx.strokeStyle = UI.stormRing;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -this.time * 12;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /**
   * Floating wreckage.
   *
   * Small and easy to miss on purpose - finding one is the reward for sailing
   * over a battle site. Drawn under the ships so a fight above a wreck stays
   * readable.
   */
  drawWrecks(ctx, g) {
    if (!this.wrecks.length) return;
    const bounds = this.viewBounds(60);
    const zoom = this.camera.zoom;
    const size = Math.max(2.5, 7 * zoom);

    ctx.save();
    ctx.strokeStyle = UI.wreck;
    ctx.lineWidth = Math.max(1, 1.4 * zoom);
    for (const wreck of this.wrecks) {
      if (wreck.x < bounds.x0 || wreck.x > bounds.x1 || wreck.y < bounds.y0 || wreck.y > bounds.y1) continue;
      const p = this.worldToScreen(wreck.x, wreck.y);
      // A broken spar: two crossed strokes, no fill, cheap at any zoom.
      ctx.beginPath();
      ctx.moveTo(p.x - size, p.y - size * 0.45);
      ctx.lineTo(p.x + size, p.y + size * 0.45);
      ctx.moveTo(p.x - size * 0.55, p.y + size * 0.7);
      ctx.lineTo(p.x + size * 0.8, p.y - size * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawEntities(ctx, g) {
    const bounds = this.viewBounds(120);
    const zoom = this.camera.zoom;
    const detail = g.shipDetail;
    const limit = Math.round(40 + 260 * g.npcDensity);
    let drawn = 0;

    ctx.save();
    for (const entity of this.entities) {
      if (drawn >= limit) break;
      if (entity.x < bounds.x0 || entity.x > bounds.x1 || entity.y < bounds.y0 || entity.y > bounds.y1) continue;
      const p = this.worldToScreen(entity.x, entity.y);
      this.drawShip(ctx, p.x, p.y, entity.h, colourFor(entity), zoom, detail, entity);
      drawn++;
    }
    ctx.restore();
    this.stats.entities = drawn;
  }

  drawSelf(ctx, g) {
    if (!this.self) return;
    const p = this.worldToScreen(this.self.x, this.self.y);
    this.drawShip(ctx, p.x, p.y, this.self.h, UI.self, this.camera.zoom, Math.max(0.6, g.shipDetail), null, true);

    // Wake, only when moving and only if animations are on.
    if (g.animations && (this.self.v ?? 0) > 4 && this.camera.zoom > 0.25) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = 'rgba(220, 236, 248, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 1; i <= 4; i++) {
        const back = i * 9;
        const spread = i * 2.6;
        const bx = p.x - Math.cos(this.self.h) * back;
        const by = p.y - Math.sin(this.self.h) * back;
        ctx.moveTo(bx - Math.sin(this.self.h) * spread, by + Math.cos(this.self.h) * spread);
        ctx.lineTo(bx + Math.sin(this.self.h) * spread, by - Math.cos(this.self.h) * spread);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * One ship.
   *
   * At low zoom this is a triangle, which is all that is legible anyway; at
   * higher zoom and detail it grows a hull outline and a sail. That is the
   * entire level-of-detail scheme, and it is why hundreds of ships are cheap.
   */
  drawShip(ctx, x, y, heading, colour, zoom, detail, entity = null, isSelf = false) {
    const size = clamp(4 + 10 * zoom, 3, isSelf ? 16 : 13) * (0.7 + detail * 0.5);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);

    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, size * 0.55);
    if (detail > 0.5 && zoom > 0.3) {
      ctx.lineTo(-size * 0.45, 0);
    }
    ctx.lineTo(-size * 0.7, -size * 0.55);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();

    if (detail > 0.35 && zoom > 0.35) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(10, 18, 25, 0.75)';
      ctx.stroke();
      // A sail: a short perpendicular bar, which reads as rigging at a glance.
      ctx.beginPath();
      ctx.moveTo(-size * 0.1, -size * 0.75);
      ctx.lineTo(-size * 0.1, size * 0.75);
      ctx.strokeStyle = 'rgba(236, 227, 210, 0.8)';
      ctx.lineWidth = Math.max(1, size * 0.14);
      ctx.stroke();
    }
    ctx.restore();

    // Health bar and name for other ships, only when zoomed in.
    if (entity && zoom > 0.5 && detail > 0.4) {
      if (entity.hp !== null && entity.hp !== undefined && entity.hp < 100) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x - 12, y - size - 9, 24, 3);
        ctx.fillStyle = entity.hp > 50 ? UI.player : entity.hp > 22 ? '#d99a2b' : '#d3593f';
        ctx.fillRect(x - 12, y - size - 9, 24 * (entity.hp / 100), 3);
      }
      if (entity.name && zoom > 0.8) {
        ctx.font = '10px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(236, 227, 210, 0.8)';
        ctx.fillText(entity.name, x, y - size - 12);
      }
    }
  }

  /**
   * Fog of war.
   *
   * Rebuilt into a small offscreen canvas only when the bitmap changes, then
   * stretched over the view. A per-frame rebuild of 40k cells would be the
   * single most expensive thing on screen; this way it is one drawImage.
   */
  drawFog(ctx, g) {
    if (!this.fogBits) return;
    if (this.fogDirty || !this.fogCanvas) this.rebuildFogCanvas();

    const bounds = this.viewBounds();
    const sx = clamp(bounds.x0 / FOG_CELL_SIZE, 0, FOG_X);
    const sy = clamp(bounds.y0 / FOG_CELL_SIZE, 0, FOG_Y);
    const sw = clamp(bounds.w / FOG_CELL_SIZE, 1, FOG_X - sx);
    const sh = clamp(bounds.h / FOG_CELL_SIZE, 1, FOG_Y - sy);
    const topLeft = this.worldToScreen(sx * FOG_CELL_SIZE, sy * FOG_CELL_SIZE);

    ctx.save();
    ctx.globalAlpha = clamp01(g.fog);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, sx, sy, sw, sh,
      topLeft.x, topLeft.y,
      sw * FOG_CELL_SIZE * this.camera.zoom, sh * FOG_CELL_SIZE * this.camera.zoom);
    ctx.restore();
  }

  rebuildFogCanvas() {
    if (!this.fogCanvas) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = FOG_X;
      this.fogCanvas.height = FOG_Y;
    }
    const fogCtx = this.fogCanvas.getContext('2d');
    const image = fogCtx.createImageData(FOG_X, FOG_Y);
    const words = new Uint32Array(image.data.buffer);
    // Unexplored cells are opaque; explored ones are clear.
    const opaque = (0xdb << 24) | (0x12 << 16) | (0x0c << 8) | 0x06;
    for (let i = 0; i < FOG_X * FOG_Y; i++) {
      const explored = (this.fogBits[i >> 3] >> (i & 7)) & 1;
      words[i] = explored ? 0 : opaque;
    }
    fogCtx.putImageData(image, 0, 0);
    this.fogDirty = false;
  }

  /** Night is a colour wash, not a light simulation: cheap and readable. */
  drawLighting(ctx, g) {
    const darkness = (1 - this.daylight) * 0.62 * g.lighting;
    if (darkness < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgba(${Math.round(90 - darkness * 60)}, ${Math.round(110 - darkness * 60)}, ${Math.round(160 - darkness * 40)}, ${darkness})`;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
    ctx.restore();

    // A lantern glow around the ship at night, if lighting is turned up.
    if (this.self && g.lighting > 0.4 && darkness > 0.15) {
      const p = this.worldToScreen(this.self.x, this.self.y);
      const radius = 160 * this.camera.zoom + 60;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      glow.addColorStop(0, `rgba(240, 212, 120, ${0.16 * g.lighting})`);
      glow.addColorStop(1, 'rgba(240, 212, 120, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }

  /** Rain, lightning and spray, each gated by its own setting. */
  drawWeatherOverlay(ctx, g, dt) {
    const severity = this.selfStormSeverity ?? 0;
    if (severity <= 0.02) { this.particles.length = 0; return; }

    if (g.rain && g.particles > 0) {
      const target = Math.round(severity * 260 * g.particles * g.effectDensity);
      while (this.particles.length < target) {
        this.particles.push({
          x: Math.random() * this.viewWidth,
          y: Math.random() * this.viewHeight,
          l: 6 + Math.random() * 14,
          s: 380 + Math.random() * 360,
        });
      }
      if (this.particles.length > target) this.particles.length = target;

      const angle = this.wind.a;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      ctx.save();
      ctx.strokeStyle = `rgba(178, 202, 224, ${0.22 + 0.28 * severity})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const drop of this.particles) {
        drop.x += dx * drop.s * dt;
        drop.y += (dy * 0.4 + 1) * drop.s * dt;
        if (drop.y > this.viewHeight) { drop.y = -10; drop.x = Math.random() * this.viewWidth; }
        if (drop.x > this.viewWidth) drop.x = 0;
        if (drop.x < 0) drop.x = this.viewWidth;
        ctx.moveTo(drop.x, drop.y);
        ctx.lineTo(drop.x - dx * drop.l, drop.y - (dy * 0.4 + 1) * drop.l);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (g.lightning && severity > 0.5) {
      const now = performance.now();
      if (now > this.lightningUntil && Math.random() < 0.006 * severity) {
        this.lightningUntil = now + 90;
      }
      if (now < this.lightningUntil) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = `rgba(210, 226, 255, ${0.20 * severity})`;
        ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
        ctx.restore();
      }
    }
  }

  /** Wind rose in the corner: direction and strength, always readable. */
  drawCompass(ctx, g) {
    if (g.mapDetail < 0.2) return;
    const size = 34;
    const x = this.viewWidth - size - 16;
    const y = 60;

    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, TAU);
    ctx.stroke();

    ctx.rotate(this.wind.a);
    const strength = clamp01((this.wind.s ?? 0) / 30);
    ctx.beginPath();
    ctx.moveTo(size / 2 - 4, 0);
    ctx.lineTo(-size / 4, size / 6);
    ctx.lineTo(-size / 4, -size / 6);
    ctx.closePath();
    ctx.fillStyle = `rgba(201, 162, 39, ${0.45 + strength * 0.5})`;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(236, 227, 210, 0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(this.wind.s ?? 0)} kn`, x, y + size / 2 + 12);
    ctx.restore();
  }
}

function colourFor(entity) {
  if (entity.kind === 1) return UI.player;
  switch (entity.npcKind) {
    case 'pirate': return UI.npcPirate;
    case 'navy': return UI.npcNavy;
    case 'fisher': return UI.npcFisher;
    default: return entity.faction ? (FACTION_COLOURS[entity.faction] ?? UI.npcMerchant) : UI.npcMerchant;
  }
}

/**
 * Uniform grid index over static points.
 *
 * With ~450 ports a linear scan per frame would be fine, but the same index
 * serves the minimap and the click-to-select hit test, and it keeps the cost
 * flat if a world ever grows.
 */
function buildSpatialIndex(items, cellSize) {
  const buckets = new Map();
  for (const item of items) {
    const key = `${Math.floor(item.x / cellSize)},${Math.floor(item.y / cellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(item);
  }
  return { buckets, cellSize };
}

function* queryIndex(index, bounds) {
  if (!index) return;
  const { buckets, cellSize } = index;
  const x0 = Math.floor(bounds.x0 / cellSize);
  const x1 = Math.floor(bounds.x1 / cellSize);
  const y0 = Math.floor(bounds.y0 / cellSize);
  const y1 = Math.floor(bounds.y1 / cellSize);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const bucket = buckets.get(`${x},${y}`);
      if (bucket) yield* bucket;
    }
  }
}

export { buildSpatialIndex, queryIndex, MIN_ZOOM, MAX_ZOOM };
