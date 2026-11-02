// YouTube iframe playback engine.
//
// Playback is completely keyless: a hidden YouTube player streams the audio.
// Nothing is proxied, nothing is downloaded, and no provider credit is spent.
// That means normal playback costs nothing and works with no API keys at all —
// which is the whole point: search can be our own UI, audio can be YouTube's.
//
// Downloads are a separate action (see media.js) and are the only thing that
// touches the paid provider.

const API_SRC = 'https://www.youtube.com/iframe_api';

let apiPromise = null;
let player = null;
let host = null;
let readyPromise = null;
let currentVideoId = null;

const listeners = new Set();

export function onYtEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch {}
  }
}

/** Load the iframe API once. */
function loadApi() {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }

    const existing = document.querySelector(`script[src="${API_SRC}"]`);
    if (!existing) {
      const script = document.createElement('script');
      script.src = API_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previous) previous();
      resolve(window.YT);
    };

    // Give up rather than hang if the API is blocked (offline, content blocker).
    setTimeout(() => {
      if (window.YT && window.YT.Player) resolve(window.YT);
      else reject(new Error('YouTube player did not load'));
    }, 12000);
  });

  return apiPromise;
}

/**
 * The player must be in the document to play, but it should never be visible.
 * `display:none` breaks playback on some engines, so it is parked off-screen at
 * 1x1 instead — verified to keep playing with audio.
 */
function ensureHost() {
  if (host && document.body.contains(host)) return host;

  host = document.getElementById('yt-engine-host');
  if (host) return host;

  host = document.createElement('div');
  host.id = 'yt-engine-host';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0.01',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '-1',
  });
  document.body.appendChild(host);
  return host;
}

export function isReady() {
  return !!player && readyPromise !== null;
}

export async function init() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const YT = await loadApi();
    const mount = ensureHost();

    // YT.Player replaces the element it is given, so create a fresh child.
    const target = document.createElement('div');
    mount.appendChild(target);

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) reject(new Error('YouTube player timed out'));
      }, 15000);

      player = new YT.Player(target, {
        width: '1',
        height: '1',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            settled = true;
            clearTimeout(timer);
            player.setVolume(100);
            resolve();
          },
          onStateChange: (event) => emit({ type: 'state', state: event.data }),
          onError: (event) => emit({ type: 'error', code: event.data }),
        },
      });
    });
  })();

  return readyPromise;
}

/**
 * Play a video. Must be called from a user gesture the first time (that is what
 * lets iOS start playback with sound). Later calls can come from anywhere.
 */
export async function play(videoId) {
  await init();

  if (!videoId) throw new Error('No video to play');

  if (currentVideoId !== videoId) {
    currentVideoId = videoId;
    player.loadVideoById(videoId);
  } else {
    player.playVideo();
  }

  player.unMute();
  player.setVolume(100);
}

export function pause() {
  if (player && player.pauseVideo) player.pauseVideo();
}

export function resume() {
  if (player && player.playVideo) player.playVideo();
}

export function stop() {
  if (player && player.stopVideo) player.stopVideo();
  currentVideoId = null;
}

export function seek(seconds) {
  if (player && player.seekTo) player.seekTo(seconds, true);
}

export function setVolume(percent) {
  if (!player || !player.setVolume) return;
  const value = Math.max(0, Math.min(100, percent));
  player.setVolume(value);
  if (value === 0) player.mute();
  else player.unMute();
}

export function getVolume() {
  return player && player.getVolume ? player.getVolume() : 100;
}

export function getState() {
  if (!player || !player.getPlayerState) return -1;
  return player.getPlayerState();
}

export function getTime() {
  return player && player.getCurrentTime ? player.getCurrentTime() : 0;
}

export function getDuration() {
  return player && player.getDuration ? player.getDuration() : 0;
}

export function getVideoId() {
  return currentVideoId;
}

export function destroy() {
  try { if (player && player.destroy) player.destroy(); } catch {}
  player = null;
  readyPromise = null;
  currentVideoId = null;
}

// Player states, mirrored so callers do not depend on the global YT object.
export const STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};
