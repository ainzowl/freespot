// Shell chrome: scroll locking for overlays, tab switching, header state.

import { VIEWS } from './config.js';
import { $, $$ } from './util.js';
import { renderIcons } from './ui.js';

let locks = 0;

export function lock() {
  locks++;
  document.documentElement.classList.add('shell-locked');
  document.body.classList.add('shell-locked');
}

export function unlock() {
  locks = Math.max(0, locks - 1);
  if (!locks) {
    document.documentElement.classList.remove('shell-locked');
    document.body.classList.remove('shell-locked');
  }
}

export const lockCount = () => locks;

let activeView = 'home';

export function goTab(name) {
  if (!VIEWS.includes(name)) return;
  activeView = name;
  VIEWS.forEach((view) => {
    const el = $(`#view-${view}`);
    if (el) el.classList.toggle('hidden', view !== name);
  });
  $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  document.body.dataset.view = name;

  const header = $('#app-header');
  if (header) header.classList.toggle('hidden', name !== 'home');

  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderIcons();
}

export const currentView = () => activeView;

export function initTabs() {
  $$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => goTab(btn.dataset.tab)));
}

export function setGreeting() {
  const el = $('#header-greeting');
  if (!el) return;
  const hour = new Date().getHours();
  el.textContent = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
}
