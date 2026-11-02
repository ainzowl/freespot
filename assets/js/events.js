// Tiny event bus + command registry.
//
// Modules that would otherwise import each other in a cycle talk through this:
// a player emits 'track-changed', views subscribe and re-render, and shared
// commands (refresh, goTab) are registered once at boot.

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (err) { console.error(`[${event}]`, err); }
  }
}

export const commands = {
  refresh: null,
  goTab: null,
  openLibrary: null,
};
