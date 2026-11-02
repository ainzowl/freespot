export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export const fmt = (s) => {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export const fmtLong = (s) => {
  if (!isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

export const fmtBytes = (n) => {
  if (!n) return '';
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Inline handlers live inside a double-quoted attribute, so a JSON string must
// have its quotes escaped or the HTML parser truncates the attribute (which is
// why ids like "v:abc" used to break every button that took one).
export const jsArg = (value) => escapeHtml(JSON.stringify(value));

/** An array literal safe to embed inside a double-quoted `onclick` attribute. */
export const jsArrayArg = (values) => escapeHtml(JSON.stringify(values || []));

export async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const load = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
};

export const store = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

export async function apiJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && (body.error || body.message)) || `Request failed (${res.status})`);
  return body;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
