// Headless boot test for FreePot.
//
// Starts the dev server, loads the app in real Chrome, and fails loudly on any
// console error, unhandled rejection, or failed module load. This is the check
// that catches a typo in an ES module, which a syntax check alone does not: the
// browser has to actually resolve and execute every import.
//
// Run with: node scripts/boot-test.js

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const PORT = Number(process.env.BOOT_PORT) || 1261;
const ROOT = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOut = '';
  server.stdout.on('data', (d) => { serverOut += d.toString(); });
  server.stderr.on('data', (d) => { serverOut += d.toString(); });

  const stop = async () => {
    try { server.kill(); } catch {}
    // On Windows a child node process can outlive kill(); make sure the port frees.
    await sleep(300);
  };

  // Wait for the server to announce itself rather than guessing a delay.
  for (let i = 0; i < 60; i++) {
    if (/dev server:/.test(serverOut)) break;
    await sleep(150);
  }
  if (!/dev server:/.test(serverOut)) {
    console.error('Server never started. Output:\n' + serverOut);
    await stop();
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });

  const problems = [];
  const page = await browser.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    // Third-party noise that is not the app's fault: fonts and the icon CDN are
    // allowed to be blocked in a headless sandbox.
    if (/fonts\.googleapis|fonts\.gstatic|unpkg\.com/.test(url)) return;
    problems.push(`requestfailed: ${url} — ${req.failure() && req.failure().errorText}`);
  });

  const url = `http://localhost:${PORT}/index.html`;
  const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

  if (!response || !response.ok()) {
    problems.push(`navigation failed: ${response && response.status()}`);
  }

  // Give the module graph time to finish and boot() to run.
  await sleep(3500);

  // Probe the running app for the things boot() is supposed to have produced.
  const probe = await page.evaluate(() => {
    const out = {
      hasPlayer: !!(window.__player && typeof window.__player.playTrack === 'function'),
      hasCommands: typeof window.__goTab === 'function',
      dockRect: null,
      miniHidden: null,
      viewportVars: {},
      tabButtons: document.querySelectorAll('.tab-btn').length,
    };

    const dock = document.querySelector('.dock-wrap');
    if (dock) {
      const r = dock.getBoundingClientRect();
      out.dockRect = {
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        height: Math.round(r.height),
        innerHeight: window.innerHeight,
        gapToBottom: Math.round(window.innerHeight - r.bottom),
      };
    }

    const mini = document.getElementById('mini-player');
    out.miniHidden = mini ? mini.classList.contains('hidden') : null;

    const root = getComputedStyle(document.documentElement);
    for (const name of ['--sab', '--sat', '--dock-space', '--vvh']) {
      out.viewportVars[name] = root.getPropertyValue(name).trim();
    }

    return out;
  });

  await browser.close();
  await stop();

  console.log('\n--- probe ---');
  console.log(JSON.stringify(probe, null, 2));

  if (!probe.hasPlayer) problems.push('window.__player missing — boot() did not complete');
  if (!probe.hasCommands) problems.push('__goTab missing — command surface did not install');
  if (probe.tabButtons !== 3) problems.push(`expected 3 tab buttons, found ${probe.tabButtons}`);

  // The dock must be anchored to the bottom. On a desktop headless viewport the
  // safe-area inset is 0, so the gap is the design's 10px; a value near half the
  // viewport height is the "floating too high" bug.
  if (probe.dockRect) {
    const gap = probe.dockRect.gapToBottom;
    if (gap < 0 || gap > 80) {
      problems.push(`dock is not anchored to the bottom: ${gap}px gap (expected 0-80)`);
    }
  } else {
    problems.push('dock element not found');
  }

  if (problems.length) {
    console.error('\n--- FAILURES (' + problems.length + ') ---');
    for (const p of problems) console.error('  • ' + p);
    if (serverOut) console.error('\n--- server output ---\n' + serverOut);
    process.exit(1);
  }

  console.log('\nBOOT OK — no console errors, dock anchored, player and commands live.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
