'use strict';
// Renders the brand mark to the PNG sizes iOS/PWA installs require.
// Usage: node make-icons.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');

const TARGETS = [
  { file: 'icon-180.png', size: 180, maskable: false },
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-512-maskable.png', size: 512, maskable: true },
];

function findBrowser() {
  for (const p of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) if (fs.existsSync(p)) return p;
  throw new Error('No Chrome/Edge found.');
}

// Maskable icons need the mark inside the 80% safe zone and a full-bleed background.
function pageFor(svg, size, maskable) {
  const inner = maskable ? 0.74 : 1;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0c0b0d;width:${size}px;height:${size}px;overflow:hidden}
    .wrap{width:${size}px;height:${size}px;display:grid;place-items:center;background:#0c0b0d}
    svg{width:${Math.round(size * inner)}px;height:${Math.round(size * inner)}px;display:block}
  </style></head><body><div class="wrap">${svg}</div></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    for (const t of TARGETS) {
      await page.setViewport({ width: t.size, height: t.size, deviceScaleFactor: 1 });
      await page.setContent(pageFor(SVG, t.size, t.maskable), { waitUntil: 'load' });
      await page.screenshot({ path: path.join(ROOT, t.file), type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: t.size, height: t.size } });
      console.log(`wrote ${t.file} (${t.size}x${t.size})`);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
