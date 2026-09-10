/**
 * Client entry point.
 *
 * Boot order is chosen so the first paint is fast on a weak device:
 *   1. language (needed before any text is drawn)
 *   2. theme and quality detection (needed before the canvas is sized)
 *   3. menu - the player can already interact while the world loads
 *   4. terrain and world metadata, fetched and decoded in slices
 *   5. WebSocket, once a save game is chosen
 */
import './styles/base.css';
import './styles/layout.css';

import { h, clear, toast } from './ui/dom.js';
import { settings } from './state/settings.js';
import { loadLocale, t, onLocaleChange, detectLocale } from './state/i18n.js';
import { chooseLanguage } from './ui/language.js';
import { applyTheme } from './ui/settingsPanel.js';
import { MainMenu } from './ui/menu.js';
import { GameUI } from './ui/game.js';
import { Renderer } from './render/renderer.js';
import { decodeTerrain, buildTerrainImage, buildMinimapImage } from './render/terrain.js';
import { InputManager, shouldUseTouch } from './input/index.js';
import { socket } from './net/socket.js';
import { api } from './net/api.js';
import { CELL_SIZE, CELLS_X, CELLS_Y, FOG_X, FOG_Y, FOG_CELL_SIZE } from '@schiffi/shared/world/constants.js';

const app = document.getElementById('app');
const boot = document.getElementById('boot');
const bootFill = document.getElementById('boot-fill');
const bootStatus = document.getElementById('boot-status');

const state = {
  menu: null,
  game: null,
  renderer: null,
  input: null,
  character: null,
  world: null,
  terrain: null,
  running: false,
};

function progress(fraction, message) {
  if (bootFill) bootFill.style.width = `${Math.round(fraction * 100)}%`;
  if (bootStatus && message) bootStatus.textContent = message;
}

async function main() {
  progress(0.05, '…');

  // 1. Language first: everything after this point is rendered translated.
  await chooseLanguage();
  progress(0.2, t('app.loading'));

  // 2. Appearance and quality. Auto-detect runs once and is then remembered.
  applyTheme(settings.get('theme'));
  if (!settings.get('autoDetected')) {
    const detected = await settings.autoDetect();
    console.info('[schiffi] detected graphics preset:', detected.preset, detected);
  }
  document.documentElement.dataset.quality = settings.get('quality');
  document.documentElement.dataset.datasaver = settings.get('dataSaver') ? 'on' : 'off';
  document.documentElement.dataset.anim = settings.effective().uiAnimations ? 'on' : 'off';
  document.documentElement.dataset.touch = shouldUseTouch(settings) ? 'on' : 'off';

  onLocaleChange(() => {
    state.menu?.render();
    state.game?.renderTopbar();
    state.game?.renderActionbar();
  });

  settings.addEventListener('change', () => {
    document.documentElement.dataset.quality = settings.get('quality');
    document.documentElement.dataset.datasaver = settings.get('dataSaver') ? 'on' : 'off';
    document.documentElement.dataset.anim = settings.effective().uiAnimations ? 'on' : 'off';
    state.renderer?.resize();
  });

  // 3. Menu. The player can browse while the world downloads.
  progress(0.35, t('app.connecting'));
  state.menu = new MainMenu({
    onPlay: (character) => startGame(character),
    onLogout: () => { stopGame(); },
  });
  await state.menu.refreshSession();
  state.menu.mount(app);

  progress(1, '');
  boot?.remove();

  // A single inspection handle: useful in the console, and what the browser
  // test drives. It exposes live objects, never a way to change game state -
  // every mutation still has to go through the server.
  window.__schiffi = {
    get socket() { return socket; },
    get renderer() { return state.renderer; },
    get character() { return state.character; },
    get world() { return state.world; },
    settings,
    setLocale: (code) => import('./ui/language.js').then((m) => m.setLocale(code)),
  };
}

// ---------------------------------------------------------------------------

async function loadWorld(worldId) {
  if (state.world?.id === worldId && state.terrain) return;

  bootOverlay(true);
  progress(0.1, t('app.loading'));

  const meta = await api.world(worldId);
  state.world = meta;
  progress(0.3, t('app.loading'));

  const response = await api.terrain(worldId);
  const buffer = await response.arrayBuffer();
  state.terrain = decodeTerrain(buffer);
  progress(0.5, t('app.loading'));

  const graphics = settings.effective();
  state.terrainBitmap = await buildTerrainImage(state.terrain, {
    theme: document.documentElement.dataset.theme,
    detail: graphics.textureQuality,
    onProgress: (fraction) => progress(0.5 + fraction * 0.45, t('app.loading')),
  });
  state.minimap = buildMinimapImage(state.terrain, document.documentElement.dataset.theme);
  progress(1, '');
  bootOverlay(false);
}

function bootOverlay(show) {
  if (show) {
    if (!document.getElementById('boot')) {
      const overlay = h('div.boot#boot', null,
        h('div.boot__mark'),
        h('div.boot__text', null, t('app.name')),
        h('div.boot__bar', null, h('div.boot__fill#boot-fill')),
        h('div.boot__status#boot-status', null, t('app.loading')));
      document.body.append(overlay);
    }
  } else {
    document.getElementById('boot')?.remove();
  }
}

async function startGame(character) {
  try {
    state.character = await api.character(character.id);
  } catch (error) {
    toast(t(error.code ?? 'error.generic'), 'bad');
    return;
  }

  await loadWorld(state.character.worldId);
  state.menu.unmount();

  const canvas = h('canvas#map-canvas');
  app.append(canvas);

  state.renderer = new Renderer(canvas, { settings });
  state.renderer.setTerrain(state.terrainBitmap);
  state.renderer.setWorld(state.world);
  state.renderer.camera.x = state.character.x;
  state.renderer.camera.y = state.character.y;
  state.renderer.camera.zoom = 0.75;
  state.renderer.targetZoom = 0.75;

  state.game = new GameUI({
    socket,
    renderer: state.renderer,
    onLeave: () => { stopGame(); state.menu.mount(app); state.menu.render(); },
    // The gameplay screens change coins, cargo and crew; they ask for a
    // re-read rather than patching their own idea of the character.
    onRefresh: () => refreshCharacter(),
  });
  state.game.character = state.character;
  state.game.world = state.world;
  state.game.mount(app);
  state.game.renderShipPanel();
  state.game.refreshPort();

  state.input = new InputManager({ settings });
  state.input.attachJoystick(document.getElementById('joystick'));
  attachPointerControls(canvas);
  attachShortcuts();

  wireSocket();
  socket.connect(state.character.id);

  state.running = true;
  requestAnimationFrame(loop);
}

function stopGame() {
  state.running = false;
  socket.close();
  state.game?.unmount();
  state.input?.destroy();
  state.renderer?.destroy();
  document.getElementById('map-canvas')?.remove();
  state.game = null;
  state.renderer = null;
  state.input = null;
}

// ---------------------------------------------------------------------------

function wireSocket() {
  socket.addEventListener('welcome', (event) => {
    const message = event.detail;
    state.character = message.character;
    state.game.character = message.character;
    state.game.renderTopbar();
    state.game.renderActionbar();
    state.game.renderShipPanel();

    // The fog bitmap arrives base64 encoded; decode it once.
    const binary = atob(message.fog);
    const bits = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bits[i] = binary.charCodeAt(i);
    state.renderer.setFog(bits);

    state.game.systemMessage(t('port.arrived', { port: message.worldName }));
    api.chatHistory(message.worldId, 'global')
      .then(({ messages }) => { for (const item of messages) state.game.addChatMessage(item); })
      .catch(() => {});
  });

  socket.addEventListener('snapshot', () => {
    const graphics = settings.effective();
    const self = socket.self;
    if (!self) return;
    state.renderer.self = { ...socket.selfPosition(), v: self.v };
    state.renderer.selfStormSeverity = self.storm ? 0.7 : 0;
    state.renderer.wind = socket.wind;
    state.renderer.daylight = socket.light;
    state.renderer.storms = socket.storms;
    state.renderer.wrecks = socket.wrecks;

    // Reveal fog locally so exploration feels immediate.
    if (!self.docked) {
      const sight = (state.character?.ship?.stats?.range ?? 1200) * 0.22 * (0.55 + 0.45 * socket.light);
      state.renderer.revealFogAt(self.x, self.y, sight);
    }

    state.renderer.entities = [...socket.entities.values()].map((buffer) => {
      const position = socket.interpolate(buffer.samples);
      return position ? { ...buffer, x: position.x, y: position.y, h: position.h } : null;
    }).filter(Boolean);

    state.game.updateTopbar();
  });

  socket.addEventListener('chat', (event) => state.game.addChatMessage(event.detail));

  socket.addEventListener('game-event', (event) => {
    const message = event.detail;
    switch (message.kind) {
      case 'cargoLoss': {
        for (const loss of message.losses) {
          const good = message.losses && loss.key;
          state.game.systemMessage(t(`cargo.${loss.reason}`, { count: loss.qty, good: loss.key }));
        }
        toast(t('cargo.lossTitle') + ' — ' + t('cargo.lossNoRefund'), 'bad', 7000);
        refreshCharacter();
        break;
      }
      case 'characterUpdate':
        state.character = message.character;
        state.game.character = message.character;
        state.game.updateTopbar();
        state.game.renderShipPanel();
        state.game.renderActionbar();
        // Docking state decides what the right-hand panel may show at all;
        // without this it kept offering a market after the ship had sailed.
        state.game.refreshPort();
        // A purchase, a hire or a delivery may have finished a tutorial step.
        state.game.tutorial.refresh();
        break;
      case 'disease':
        toast(`${message.crewName}: ${t('crew.sick')} (${message.disease})`, 'warn');
        break;
      case 'crewDied':
        toast(t('crew.died', { name: message.crewName }), 'bad');
        refreshCharacter();
        break;
      case 'hunted':
        toast(t('pvp.attacked', { player: message.by }), 'bad');
        break;
      case 'sinking':
        toast(t('ship.sinking'), 'bad', 9000);
        break;
      case 'playerJoined':
      case 'playerLeft':
        state.game.systemMessage(`${message.name} · ${message.online}`);
        break;
      default:
        break;
    }
  });

  socket.addEventListener('disconnected', () => {
    state.game?.systemMessage(t('app.reconnecting'));
  });
  socket.addEventListener('reconnecting', (event) => {
    state.game?.systemMessage(`${t('app.reconnecting')} (${Math.round(event.detail.inMs / 1000)}s)`);
  });
  socket.addEventListener('kicked', (event) => {
    toast(event.detail.reason ?? t('app.offline'), 'bad');
    stopGame();
    state.menu.mount(app);
  });
  socket.addEventListener('server-error', (event) => {
    toast(t(event.detail.code ?? 'error.generic'), 'bad');
  });
}

async function refreshCharacter() {
  if (!state.character) return;
  try {
    state.character = await api.character(state.character.id);
    state.game.character = state.character;
    state.game.updateTopbar();
    state.game.renderShipPanel();
  } catch { /* the next snapshot will carry the truth */ }
}

// ---------------------------------------------------------------------------

function attachPointerControls(canvas) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const zoom = state.renderer.camera.zoom;
    state.renderer.camera.x -= (event.clientX - lastX) / zoom;
    state.renderer.camera.y -= (event.clientY - lastY) / zoom;
    state.renderer.follow = false;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.renderer.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  }, { passive: false });

  canvas.addEventListener('dblclick', () => { state.renderer.follow = true; });

  // Pinch to zoom.
  const pointers = new Map();
  let pinchDistance = 0;
  canvas.addEventListener('pointerdown', (event) => pointers.set(event.pointerId, event));
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    if (pointers.size !== 2) return;
    dragging = false;
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (pinchDistance > 0) {
      state.renderer.zoomBy(distance / pinchDistance,
        (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    }
    pinchDistance = distance;
  });
  const dropPointer = (event) => { pointers.delete(event.pointerId); pinchDistance = 0; };
  canvas.addEventListener('pointerup', dropPointer);
  canvas.addEventListener('pointercancel', dropPointer);

  // Minimap click jumps the camera.
  const minimap = document.getElementById('minimap');
  minimap?.addEventListener('click', (event) => {
    const rect = minimap.getBoundingClientRect();
    state.renderer.camera.x = ((event.clientX - rect.left) / rect.width) * CELLS_X * CELL_SIZE;
    state.renderer.camera.y = ((event.clientY - rect.top) / rect.height) * CELLS_Y * CELL_SIZE;
    state.renderer.follow = false;
  });
}

function attachShortcuts() {
  state.input.addEventListener('shortcut', (event) => {
    switch (event.detail.code) {
      case 'KeyM': state.renderer.follow = !state.renderer.follow; break;
      case 'KeyQ': state.renderer.zoomBy(1 / 1.2); break;
      case 'KeyE': state.renderer.zoomBy(1.2); break;
      case 'F3':
        event.detail.event.preventDefault();
        settings.set('perfOverlay', !settings.get('perfOverlay'));
        break;
      case 'Enter':
        state.game.chatPanel.classList.remove('is-collapsed');
        state.game.chatInput.focus();
        break;
      case 'Escape':
        document.activeElement?.blur();
        break;
      default: break;
    }
  });
}

// ---------------------------------------------------------------------------

let lastViewportSend = 0;

function loop(now) {
  if (!state.running) return;
  requestAnimationFrame(loop);

  const vector = state.input.poll();
  socket.setInput(vector.x, vector.y);

  if (state.renderer.follow && state.renderer.self) {
    state.renderer.centreOn(state.renderer.self.x, state.renderer.self.y);
  }

  const drew = state.renderer.frame(now);
  if (!drew) return;

  drawMinimap();
  state.game.updateAshoreButton();
  state.game.updatePerf();

  // Tell the server what we can see, so it only sends that.
  if (now - lastViewportSend > 1000) {
    lastViewportSend = now;
    const graphics = settings.effective();
    socket.setViewport(
      state.renderer.viewWidth * graphics.viewDistance,
      state.renderer.viewHeight * graphics.viewDistance,
      state.renderer.camera.zoom);
  }
}

function drawMinimap() {
  const canvas = document.getElementById('minimap');
  if (!canvas || !state.minimap) return;
  const ctx = canvas.getContext('2d');
  const { image, width, height } = state.minimap;

  if (!state.minimapBitmap) {
    state.minimapBitmap = document.createElement('canvas');
    state.minimapBitmap.width = width;
    state.minimapBitmap.height = height;
    state.minimapBitmap.getContext('2d').putImageData(image, 0, 0);
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.minimapBitmap, 0, 0, canvas.width, canvas.height);

  // Viewport rectangle and own position.
  const bounds = state.renderer.viewBounds();
  const scaleX = canvas.width / (CELLS_X * CELL_SIZE);
  const scaleY = canvas.height / (CELLS_Y * CELL_SIZE);
  ctx.strokeStyle = 'rgba(240, 212, 120, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bounds.x0 * scaleX, bounds.y0 * scaleY, bounds.w * scaleX, bounds.h * scaleY);

  if (state.renderer.self) {
    ctx.fillStyle = '#f0d478';
    ctx.fillRect(state.renderer.self.x * scaleX - 1.5, state.renderer.self.y * scaleY - 1.5, 3, 3);
  }
}

main().catch((error) => {
  console.error(error);
  if (bootStatus) bootStatus.textContent = String(error.message ?? error);
});
