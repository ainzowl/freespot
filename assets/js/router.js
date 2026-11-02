// Detail-layer stack. Kept separate so views can push pages without importing
// each other.

import { $ } from './util.js';
import { lock, unlock } from './shell.js';
import { renderIcons } from './ui.js';
import { refreshDownloadIcons } from './downloads.js';

export const stack = [];

export function push(title, body) {
  if (!stack.length) lock();
  stack.push({ title, body });
  show();
}

export function show() {
  const top = stack[stack.length - 1];
  if (!top) return;
  const layer = $('#detail-layer');
  const titleEl = $('#detail-title');
  const content = $('#detail-content');
  if (titleEl) titleEl.textContent = top.title;
  if (layer) {
    layer.classList.remove('hidden');
    layer.scrollTop = 0;
  }
  if (content) content.innerHTML = top.body();
  renderIcons();
  refreshDownloadIcons();
}

export function pop() {
  if (!stack.length) return;
  stack.pop();
  if (!stack.length) {
    const layer = $('#detail-layer');
    if (layer) layer.classList.add('hidden');
    unlock();
    return;
  }
  show();
}

export function repaint() {
  if (stack.length) show();
}
