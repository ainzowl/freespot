// Measured viewport contract for iOS/Android chrome.
//
// WHY THIS EXISTS
// The bottom dock is `position: fixed; bottom: calc(env(safe-area-inset-bottom) + 10px)`.
// env() is resolved against the LAYOUT viewport, and on iOS it is not stable:
//   - Safari reads it as 0px at first paint, then as 34px once the URL bar
//     collapses / the page settles, so the dock visibly jumps ~30px;
//   - in a standalone PWA the same inset can lag the first frames after launch;
//   - during the toolbar animation a frame is painted with a stale inset, and a
//     fixed element computed from it lands in the wrong place.
// A one-shot CSS env() therefore cannot be trusted on its own. This module
// MEASURES the real insets once the compositor has settled and republishes them
// as custom properties on <html>; CSS reads var(--sab, env(...)) with env() as
// the pre-script fallback only.
//
// It also publishes the visual-viewport box so full-bleed overlays (.np,
// .detail, .sheet) can size themselves against what is actually on screen
// instead of a stale 100vh.
//
// Self-running ES module: imports nothing, exports nothing, safe to load with a
// plain <script type="module"> before main.js.

const root = document.documentElement;

const PROBE_ID = 'fp-viewport-probe';

/** @type {HTMLElement | null} */
let probe = null;

let frame = 0;
let last = '';
let burstTimers = [];

/**
 * Parse a computed `padding-bottom`/`padding-top` ("34px") into a number.
 * Returns 0 for anything that does not parse, so a weird UA can never produce
 * a NaN custom property (which would blank out the whole calc()).
 */
function px(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The probe must be a real, rendered element for env() to resolve: a
 * `display: none` node computes to the initial value and would always report 0.
 * Zero-size + visibility:hidden + fixed keeps it out of layout and paint while
 * still being laid out.
 */
function ensureProbe() {
  if (probe && probe.isConnected) return probe;
  const existing = document.getElementById(PROBE_ID);
  if (existing) {
    probe = existing;
    return probe;
  }
  probe = document.createElement('div');
  probe.id = PROBE_ID;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'padding-top:env(safe-area-inset-top,0px)',
    'padding-bottom:env(safe-area-inset-bottom,0px)',
    'overflow:hidden',
    'visibility:hidden',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(probe);
  return probe;
}

function readInsets() {
  const el = ensureProbe();
  const cs = getComputedStyle(el);
  return {
    sab: px(cs.paddingBottom),
    sat: px(cs.paddingTop),
  };
}

function setVar(name, value) {
  if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
}

/**
 * Measure everything and publish it. Called on every trigger; the rAF throttle
 * keeps a resize/scroll storm from thrashing layout (each pass forces style).
 */
function measure() {
  const { sab, sat } = readInsets();
  const vv = window.visualViewport;
  const layoutH = Math.round(window.innerHeight || 0);

  // visualViewport is the truth about what the user can actually see: it
  // shrinks with the keyboard and the collapsing toolbar. Fall back to the
  // layout viewport where it does not exist (older desktop browsers).
  //
  // Guard against pinch-zoom: when scale > 1 the visual viewport shrinks to the
  // zoomed region, and sizing a fixed overlay from it would leave a gap. Only
  // publish the visual height while the page is at 1:1; otherwise report the
  // layout viewport, which is what fixed positioning actually uses.
  const scale = vv && Number.isFinite(vv.scale) ? vv.scale : 1;
  const zoomed = scale > 1.01;
  const rawVisualH = vv && Number.isFinite(vv.height) ? vv.height : layoutH;
  const visualH = Math.round(zoomed ? layoutH : rawVisualH);
  const offsetTop = !zoomed && vv && Number.isFinite(vv.offsetTop) ? Math.round(vv.offsetTop) : 0;

  const signature = `${sab}|${sat}|${visualH}|${layoutH}|${offsetTop}`;
  if (signature === last) return;
  last = signature;

  setVar('--sab', `${sab}px`);
  setVar('--sat', `${sat}px`);
  // Never publish a zero height: the overlays size themselves from these, and
  // a 0 would collapse them. Leave the CSS dvh fallback in place instead.
  if (visualH > 0) setVar('--vvh', `${visualH}px`);
  if (layoutH > 0) setVar('--vlh', `${layoutH}px`);
  setVar('--vvo', `${offsetTop}px`);

  // Tag the document so CSS can apply notched-only rules without repeating the
  // inset measurement, and so desktop is provably 0/0.
  if (sab > 0 || sat > 0) root.setAttribute('data-safe-area', 'inset');
  else root.setAttribute('data-safe-area', 'none');
}

/** rAF-throttled measure: many triggers collapse into one paint. */
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    measure();
  });
}

/**
 * iOS settles its insets over the first second or so (URL bar collapse, PWA
 * launch chrome, rotation). Re-measure on a short burst instead of trusting a
 * single post-load sample. Cheap: measure() bails when nothing changed.
 */
function settleBurst() {
  burstTimers.forEach(clearTimeout);
  burstTimers = [0, 50, 150, 400, 1000].map((ms) => setTimeout(schedule, ms));
}

function attachVisualViewport() {
  const vv = window.visualViewport;
  if (!vv || typeof vv.addEventListener !== 'function') return;
  // resize covers keyboard + toolbar collapse; scroll covers the URL bar
  // pushing the visual viewport around. Both are passive.
  vv.addEventListener('resize', schedule, { passive: true });
  vv.addEventListener('scroll', schedule, { passive: true });
}

function init() {
  measure(); // synchronous first pass: before the first meaningful paint
  settleBurst();
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', settleBurst, { passive: true });
  attachVisualViewport();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// `load` fires after fonts/images settle and is the point at which iOS has the
// most accurate inset; re-run the burst there too.
window.addEventListener('load', () => {
  settleBurst();
  attachVisualViewport();
}, { passive: true, once: true });

// Orientation changes can be followed by a second layout pass a beat later.
window.addEventListener('pageshow', settleBurst, { passive: true });
