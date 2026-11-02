// Overlays: toast, bottom sheet, modal.

import { $ } from './util.js';
import { lock, unlock } from './shell.js';
import { renderIcons } from './ui.js';

let toastTimer = null;

export function toast(message, icon = 'check') {
  const box = $('#toast');
  const text = $('#toast-msg');
  const iconEl = $('#toast-icon');
  if (!box || !text) return;
  text.textContent = message;
  if (iconEl) iconEl.setAttribute('data-lucide', icon);
  box.classList.remove('hidden');
  renderIcons();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 2400);
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

let sheetOpen = false;

export function openSheet(title, body) {
  const sheet = $('#sheet');
  const titleEl = $('#sheet-title');
  const bodyEl = $('#sheet-body');
  if (!sheet) return;

  if (titleEl) titleEl.textContent = title;
  if (bodyEl) bodyEl.innerHTML = typeof body === 'function' ? body() : body;

  sheet.classList.remove('hidden');
  if (!sheetOpen) {
    sheetOpen = true;
    lock();
  }
  renderIcons();
}

export function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;
  sheet.classList.add('hidden');
  if (sheetOpen) {
    sheetOpen = false;
    unlock();
  }
  // Lyrics highlight on a timer; closing the sheet must not leave it running
  // against detached nodes.
  if (typeof window !== 'undefined' && typeof window.__stopLyricSync === 'function') {
    window.__stopLyricSync();
  }
}

export const isSheetOpen = () => sheetOpen;

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

let modalHandler = null;
let modalOpen = false;

export function openModal(title, placeholder, value, onSave) {
  const modal = $('#modal');
  const titleEl = $('#modal-title');
  const input = $('#modal-input');
  if (!modal || !input) return;

  modalHandler = onSave;
  if (titleEl) titleEl.textContent = title;
  input.value = value || '';
  input.placeholder = placeholder || '';

  modal.classList.remove('hidden');
  if (!modalOpen) {
    modalOpen = true;
    lock();
  }
  setTimeout(() => input.focus(), 60);
}

export function closeModal() {
  const modal = $('#modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  modalHandler = null;
  if (modalOpen) {
    modalOpen = false;
    unlock();
  }
}

export function saveModal() {
  const input = $('#modal-input');
  const value = input ? input.value.trim() : '';
  if (value && modalHandler) modalHandler(value);
  closeModal();
}

export function initModal() {
  const input = $('#modal-input');
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveModal();
    });
  }
}
