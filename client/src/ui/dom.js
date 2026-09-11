/**
 * Tiny DOM helpers.
 *
 * No framework: the interface is a few dozen components, and a hand-rolled
 * element builder keeps the shipped bundle small and the render path direct.
 * `h()` is the whole abstraction.
 */

/**
 * Create an element.
 *
 * The spec is a CSS-like shorthand: `tag`, `.class` and `#id` in any order,
 * so both "div#panel.wide" and "span.stat__value#stat-coins" work. Getting
 * that wrong is silent - the id ends up as a class and getElementById returns
 * null - so the parse is explicit rather than a split on '.'.
 *
 * @param {string} spec  e.g. "button.primary", "span.stat__value#stat-coins"
 * @param {object} props attributes, `style`, `dataset`, and on* handlers
 * @param {...(Node|string|Array|null)} children
 */
const SPEC_PATTERN = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/;

export function h(spec, props = null, ...children) {
  const match = SPEC_PATTERN.exec(spec);
  if (!match) throw new Error(`invalid element spec: ${spec}`);

  const element = document.createElement(match[1] || 'div');
  const classes = [];
  for (const token of (match[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
    if (token[0] === '#') element.id = token.slice(1);
    else classes.push(token.slice(1));
  }
  if (classes.length) element.className = classes.join(' ');

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') element.className = `${element.className} ${value}`.trim();
      else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        const eventName = key.slice(2).toLowerCase();
        element.addEventListener(eventName, (event) => {
          const result = value(event);
          // Async controls acknowledge the click in the same frame. This is
          // deliberately generic so login, admin and game actions all feel
          // immediate even while the network request is still in flight.
          if (eventName === 'click' && element.tagName === 'BUTTON' && result?.then) {
            element.disabled = true;
            element.classList.add('is-busy');
            result.then(
              () => { if (element.isConnected) { element.disabled = false; element.classList.remove('is-busy'); } },
              () => { if (element.isConnected) { element.disabled = false; element.classList.remove('is-busy'); } },
            );
          }
          return result;
        });
      } else if (key === 'html') element.innerHTML = value;
      else if (key in element && key !== 'list' && typeof value !== 'object') element[key] = value;
      else element.setAttribute(key, value === true ? '' : value);
    }
  }
  append(element, children);
  return element;
}

/**
 * Append children, skipping null/undefined/false.
 *
 * Native `Element.append(null)` inserts the text "null"; every place that
 * builds a list with conditional entries must go through this instead.
 */
export function add(parent, ...children) {
  return append(parent, children);
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// --- toasts ----------------------------------------------------------------

let toastHost = null;

export function toast(message, kind = 'info', ttl = 4200) {
  if (!toastHost) {
    toastHost = h('div#toasts');
    document.body.append(toastHost);
  }
  const node = h(`div.toast.toast--${kind}`, null, message);
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, ttl);
  return node;
}

// --- modal -----------------------------------------------------------------

/**
 * Open a modal. Returns a handle with `close()`; the promise resolves with
 * whatever `close(value)` was called with, so callers can await a dialog.
 */
/**
 * The modal's own close glyph, kept local rather than imported from
 * `icons.js` - that module imports `h` from here, and `dom.js` stays a leaf
 * with no dependencies of its own.
 */
function closeIcon() {
  return h('span.icon', {
    html: '<svg viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges" aria-hidden="true">'
      + '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6"/></svg>',
  });
}

export function modal({ title, body, actions = [], wide = false, dismissable = true, onClose } = {}) {
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });

  const backdrop = h('div.modal-backdrop');
  const dialog = h(`div.modal${wide ? '.modal--wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' });

  const close = (value) => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.(value);
    settle(value);
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && dismissable) close(undefined);
  };

  add(dialog,
    h('div.modal__head', null,
      h('div.modal__title', null, title ?? ''),
      dismissable
        ? h('button.icon-btn', { onClick: () => close(undefined), title: 'Esc' }, closeIcon())
        : null),
    h('div.modal__body', null, body),
    actions.length
      ? h('div.modal__foot', null, ...actions.map((action) =>
        h(`button${action.primary ? '.primary' : action.danger ? '.danger' : '.ghost'}`, {
          onClick: async () => {
            const value = await action.onClick?.(close);
            if (action.closes !== false && value !== false) close(action.value);
          },
        }, action.label)))
      : null,
  );

  backdrop.append(dialog);
  if (dismissable) {
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(undefined); });
  }
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);

  // Focus the first control so keyboard and screen-reader users land inside.
  queueMicrotask(() => dialog.querySelector('input, button, select, textarea')?.focus());

  return { close, result, dialog };
}

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false }) {
  const { result } = modal({
    title,
    body: h('p', null, message),
    actions: [
      { label: cancelLabel ?? 'Cancel', value: false },
      { label: confirmLabel ?? 'OK', value: true, primary: !danger, danger },
    ],
  });
  return result.then((value) => value === true);
}

// --- collapsible panel -----------------------------------------------------

export function panel({ id, title, body, collapsed = false, actions = [], onToggle }) {
  const bodyNode = h('div.panel__body', null, body);
  const root = h(`div.panel${collapsed ? '.is-collapsed' : ''}`, { id });
  const toggle = h('button.icon-btn', {
    title: 'Toggle',
    onClick: () => {
      root.classList.toggle('is-collapsed');
      const isCollapsed = root.classList.contains('is-collapsed');
      toggle.textContent = isCollapsed ? '▸' : '▾';
      onToggle?.(isCollapsed);
    },
  }, collapsed ? '▸' : '▾');

  root.append(
    h('div.panel__head', null,
      h('span.panel__title', null, title),
      ...actions,
      toggle),
    bodyNode,
  );
  root.setBody = (content) => { clear(bodyNode); append(bodyNode, [content]); };
  root.setTitle = (text) => { root.querySelector('.panel__title').textContent = text; };
  return root;
}

// --- misc ------------------------------------------------------------------

export function bar(value, max, { warnAt = 0.4, badAt = 0.18 } = {}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const kind = ratio <= badAt ? 'bad' : ratio <= warnAt ? 'warn' : '';
  return h('div.bar', null, h(`div.bar__fill${kind ? `.${kind}` : ''}`, { style: { width: `${ratio * 100}%` } }));
}

export function tabs(items, active, onSelect) {
  return h('div.tabs', null, ...items.map((item) =>
    h(`button.tab${item.key === active ? '.is-active' : ''}`, {
      onClick: () => onSelect(item.key),
    }, item.label)));
}

/** Debounce that also works for async handlers. */
export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Render only the rows that are on screen.
 *
 * A market list can hold hundreds of goods; building every row makes scrolling
 * stutter on a weak device. This keeps the DOM at roughly one screenful.
 */
export function virtualList({ container, items, rowHeight, renderRow, overscan = 6 }) {
  const spacer = h('div', { style: { height: `${items.length * rowHeight}px`, position: 'relative' } });
  const viewport = container;
  clear(viewport);
  viewport.append(spacer);

  let lastStart = -1;
  const render = () => {
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan);
    if (start === lastStart) return;
    lastStart = start;
    const visible = Math.ceil(viewport.clientHeight / rowHeight) + overscan * 2;
    clear(spacer);
    for (let i = start; i < Math.min(items.length, start + visible); i++) {
      const row = renderRow(items[i], i);
      row.style.position = 'absolute';
      row.style.top = `${i * rowHeight}px`;
      row.style.left = '0';
      row.style.right = '0';
      row.style.height = `${rowHeight}px`;
      spacer.append(row);
    }
  };

  viewport.addEventListener('scroll', render, { passive: true });
  render();
  return { render, destroy: () => viewport.removeEventListener('scroll', render) };
}
