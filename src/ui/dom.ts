/** Minimal DOM helpers — the app is small enough not to need a framework. */

type Attrs = Record<string, string | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value as string);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return el;
}

/* ---------------- toast ---------------- */

let toastEl: HTMLElement | null = null;
let toastTimer: number | undefined;

export function toast(message: string, ms = 1800): void {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), ms);
}

/* ---------------- marker chip ---------------- */

/** Render a marker with its pipes subtly highlighted (display only). */
export function markerChip(marker: string): HTMLElement {
  const chip = h('code', { class: 'marker-chip' });
  const parts = marker.split('|');
  parts.forEach((part, i) => {
    chip.append(document.createTextNode(part));
    if (i < parts.length - 1) chip.append(h('span', { class: 'pipe' }, '|'));
  });
  return chip;
}

/* ---------------- clipboard fallback box ---------------- */

/** Shown when clipboard access is denied: a tap-to-select text box. */
export function showClipboardFallback(text: string): void {
  document.querySelector('.fallback-box')?.remove();
  const ta = h('textarea', { rows: '3', readonly: true, 'aria-label': 'Citation text to copy manually' }) as HTMLTextAreaElement;
  ta.value = text;
  ta.addEventListener('focus', () => ta.select());
  ta.addEventListener('click', () => ta.select());
  const box = h(
    'div',
    { class: 'fallback-box', role: 'dialog', 'aria-label': 'Copy manually' },
    h('p', {}, 'Clipboard access was blocked. Tap the text to select it, then copy.'),
    ta,
    h('button', { class: 'btn secondary block', onclick: () => box.remove() }, 'Done'),
  );
  document.body.append(box);
  ta.focus();
  ta.select();
}

export function svgIcon(path: string, size = 22): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}

export const ICONS = {
  copy: 'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.5a7.5 7.5 0 0 0-2 1.2l-2.5-1-2 3.5L4.7 10.8a7.4 7.4 0 0 0 0 2.4L2.6 14.8l2 3.5 2.5-1a7.5 7.5 0 0 0 2 1.2l.4 2.5h5l.4-2.5a7.5 7.5 0 0 0 2-1.2l2.5 1 2-3.5-2.1-1.6c.07-.4.1-.8.1-1.2z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  back: 'M19 12H5m7-7l-7 7 7 7',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  scan: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7M14 3l6 6M14 3v6h6M9 13h4M9 17h2M17 15l4 4m-1.5-2.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M16 13H8M16 17H8M10 9H8',
};
