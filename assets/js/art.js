// Deterministic generative cover art.
//
// Every track, album, artist, playlist and genre gets its own analog-looking
// sleeve, rendered once to a JPEG data URL and cached by key. Keys are stable,
// so the same record always looks the same.

const SIZE = 512;
const cache = new Map();
const tintCache = new Map();

const PALETTES = [
  { bg: '#101315', a: '#24403f', b: '#3f6f6a', c: '#cfa87a', h: '#0b0e0f' },
  { bg: '#150f16', a: '#3a2340', b: '#6d4667', c: '#e0a17a', h: '#100a11' },
  { bg: '#0d1118', a: '#1d2b45', b: '#3d5a80', c: '#d9b08c', h: '#090c11' },
  { bg: '#16120c', a: '#3f3120', b: '#7a5c3e', c: '#e6c79c', h: '#100c08' },
  { bg: '#111417', a: '#252c32', b: '#5b6b73', c: '#cfc6b8', h: '#0a0c0e' },
  { bg: '#160e0e', a: '#41211f', b: '#7d3f3a', c: '#e3a587', h: '#0f0909' },
  { bg: '#0e1410', a: '#24392a', b: '#4f7354', c: '#d8c8a4', h: '#0a0f0b' },
  { bg: '#120f19', a: '#2b2540', b: '#534a7d', c: '#c9b6e4', h: '#0c0a12' },
  { bg: '#17110b', a: '#4a3020', b: '#8a5a36', c: '#f0cfa8', h: '#110c08' },
  { bg: '#0f1011', a: '#232628', b: '#4a4f52', c: '#b9b2a5', h: '#080909' },
  { bg: '#0f1416', a: '#1f3a3e', b: '#4b7a72', c: '#c9dcc4', h: '#0a0e10' },
  { bg: '#191013', a: '#4a2530', b: '#8f4a5a', c: '#e8c3a3', h: '#120b0d' },
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex, a) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

let noisePattern = null;
function getNoise(ctx) {
  if (noisePattern) return noisePattern;
  const n = document.createElement('canvas');
  n.width = n.height = 160;
  const nc = n.getContext('2d');
  const img = nc.createImageData(160, 160);
  const r = rng(90210);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (r() - 0.5) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  nc.putImageData(img, 0, 0);
  noisePattern = ctx.createPattern(n, 'repeat');
  return noisePattern;
}

function glow(ctx, x, y, radius, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, hexA(color, alpha));
  g.addColorStop(0.55, hexA(color, alpha * 0.4));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function base(ctx, p, r) {
  const angle = r() * Math.PI * 2;
  const g = ctx.createLinearGradient(
    SIZE / 2 - Math.cos(angle) * SIZE,
    SIZE / 2 - Math.sin(angle) * SIZE,
    SIZE / 2 + Math.cos(angle) * SIZE,
    SIZE / 2 + Math.sin(angle) * SIZE
  );
  g.addColorStop(0, p.a);
  g.addColorStop(0.48, p.b);
  g.addColorStop(1, p.h);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  glow(ctx, SIZE * (0.2 + r() * 0.6), SIZE * (0.15 + r() * 0.4), SIZE * 0.9, p.c, 0.32);
  glow(ctx, SIZE * (0.1 + r() * 0.8), SIZE * (0.6 + r() * 0.35), SIZE * 0.7, p.b, 0.35);
}

const motifs = [
  function orb(ctx, p, r) {
    const x = SIZE * (0.42 + r() * 0.16);
    const y = SIZE * (0.38 + r() * 0.14);
    const rad = SIZE * (0.22 + r() * 0.12);
    const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.35, rad * 0.1, x, y, rad);
    g.addColorStop(0, hexA(p.c, 0.95));
    g.addColorStop(0.62, hexA(p.c, 0.35));
    g.addColorStop(1, hexA(p.c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexA(p.c, 0.35);
    ctx.lineWidth = 1.2;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(x, y, rad * (1 + i * 0.16), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = hexA(p.bg, 0.35);
    ctx.lineWidth = SIZE * 0.004;
    ctx.beginPath();
    ctx.moveTo(-10, y + rad * 1.55);
    ctx.lineTo(SIZE + 10, y + rad * 1.55);
    ctx.stroke();
  },
  function rings(ctx, p, r) {
    const x = SIZE * (0.35 + r() * 0.3);
    const y = SIZE * (0.4 + r() * 0.2);
    ctx.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.strokeStyle = hexA(i % 3 === 0 ? p.c : p.b, 0.16 + r() * 0.3);
      ctx.lineWidth = SIZE * (0.002 + r() * 0.012);
      ctx.arc(x, y, SIZE * (0.08 + i * 0.045 + r() * 0.02), 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  function arc(ctx, p, r) {
    const cx = SIZE / 2;
    const cy = SIZE * (0.72 + r() * 0.1);
    const rad = SIZE * (0.3 + r() * 0.1);
    const g = ctx.createLinearGradient(0, cy - rad, 0, cy);
    g.addColorStop(0, hexA(p.c, 0.9));
    g.addColorStop(1, hexA(p.c, 0.06));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexA(p.c, 0.5);
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, rad + i * SIZE * 0.055, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = hexA(p.bg, 0.55);
    ctx.fillRect(0, cy, SIZE, SIZE - cy);
  },
  function blocks(ctx, p, r) {
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const w = SIZE * (0.22 + r() * 0.4);
      const h = SIZE * (0.1 + r() * 0.5);
      const x = SIZE * r() * 0.7;
      const y = SIZE * (0.1 + r() * 0.7);
      ctx.fillStyle = hexA(i % 2 ? p.c : p.b, 0.12 + r() * 0.3);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hexA(p.c, 0.2);
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
  },
  function waves(ctx, p, r) {
    const bands = 5 + Math.floor(r() * 4);
    for (let i = 0; i < bands; i++) {
      const y = SIZE * (0.25 + i * (0.5 / bands));
      const amp = SIZE * (0.02 + r() * 0.05);
      ctx.beginPath();
      for (let x = -10; x <= SIZE + 10; x += 8) {
        const yy = y + Math.sin((x / SIZE) * Math.PI * (2 + r() * 2) + i) * amp;
        x === -10 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      const mid = i === Math.floor(bands / 2);
      ctx.strokeStyle = hexA(mid ? p.c : p.b, mid ? 0.6 : 0.24);
      ctx.lineWidth = mid ? 2.2 : 1;
      ctx.stroke();
    }
  },
  function sun(ctx, p, r) {
    const cx = SIZE * (0.4 + r() * 0.2);
    const cy = SIZE * (0.36 + r() * 0.16);
    const rad = SIZE * (0.17 + r() * 0.08);
    const g = ctx.createLinearGradient(0, cy - rad, 0, cy + rad);
    g.addColorStop(0, hexA(p.c, 0.95));
    g.addColorStop(1, hexA(p.c, 0.25));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - rad, cy, rad * 2, rad);
    ctx.clip();
    ctx.fillStyle = hexA(p.bg, 0.55);
    for (let i = 0; i < 7; i++) {
      ctx.fillRect(cx - rad, cy + i * (rad / 7), rad * 2, rad / 20);
    }
    ctx.restore();
  },
  function grid(ctx, p, r) {
    const step = SIZE / (8 + Math.floor(r() * 8));
    const ox = r() * step;
    const oy = r() * step;
    for (let x = ox; x < SIZE; x += step) {
      for (let y = oy; y < SIZE; y += step) {
        const d = Math.hypot(x - SIZE / 2, y - SIZE / 2) / (SIZE / 2);
        ctx.fillStyle = hexA(r() > 0.6 ? p.c : p.b, Math.max(0.06, 0.5 - d * 0.5));
        const s = step * (0.1 + (1 - d) * 0.28);
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
  },
  function ribbon(ctx, p, r) {
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(r() * Math.PI);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      const w = SIZE * (0.16 + i * 0.11);
      const h = SIZE * (0.5 + r() * 0.2);
      ctx.moveTo(-w, -h / 2);
      ctx.bezierCurveTo(w * 2, -h / 3, -w * 1.5, h / 4, w, h / 2);
      ctx.strokeStyle = hexA(i === 1 ? p.c : p.b, 0.2 + i * 0.12);
      ctx.lineWidth = SIZE * 0.035;
      ctx.stroke();
    }
    ctx.restore();
  },
];

function finish(ctx) {
  const vig = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.25, SIZE / 2, SIZE / 2, SIZE * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = getNoise(ctx);
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.restore();

  const edge = ctx.createLinearGradient(0, 0, 0, SIZE);
  edge.addColorStop(0, 'rgba(255,255,255,0.05)');
  edge.addColorStop(0.5, 'rgba(255,255,255,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

function render(key) {
  const seed = hash(String(key));
  const r = rng(seed);
  const pal = PALETTES[seed % PALETTES.length];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  base(ctx, pal, r);
  const motif = motifs[(seed >>> 8) % motifs.length];
  ctx.save();
  motif(ctx, pal, r);
  ctx.restore();
  finish(ctx);

  return canvas.toDataURL('image/jpeg', 0.74);
}

export function get(key) {
  const k = String(key);
  if (!cache.has(k)) cache.set(k, render(k));
  return cache.get(k);
}

export function tint(key) {
  const k = String(key);
  if (!tintCache.has(k)) {
    const pal = PALETTES[hash(k) % PALETTES.length];
    tintCache.set(k, pal.b);
  }
  return tintCache.get(k);
}

export function applyAll(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-art]').forEach((img) => {
    const key = img.dataset.art;
    if (!key) return;
    const src = get(key);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  });
  if (scope instanceof HTMLImageElement && scope.dataset.art && !scope.getAttribute('src')) {
    scope.src = get(scope.dataset.art);
  }
}

export default { get, tint, applyAll };
