// Entry point: wires modules, exposes the command surface for inline handlers,
// and boots the app. Everything here is browser-side; there is no server.

import { setGreeting, initTabs, goTab, lock, unlock } from './shell.js';
import { initModal, openModal, closeModal, saveModal, closeSheet, openSheet, toast } from './overlays.js';
import { initPlayer, player } from './player.js';
import { on } from './events.js';
import { $, $$ } from './util.js';
import { renderIcons, coverForTrack } from './ui.js';
import { refreshDownloadIcons, toggleDownload, downloadIds, downloadTracks, downloadAll, cancelDownloads } from './downloads.js';
import { onDownloadChange, isDownloaded, resumePendingDownloads, initDownloadLifecycle } from './media.js';
import { getSettings } from './settings.js';
import { hydrateTracks, saveTracksNow } from './catalog.js';
import * as Router from './router.js';
import * as actions from './actions.js';
import * as device from './device.js';
import { renderRecent, renderTop, renderBrowse } from './views/home.js';
import { onSearchInput, searchFor } from './views/search.js';
import { openLibraryTab, refreshDownloads } from './views/library.js';
import { resolvePlaylist } from './views/detail.js';

// ---------------------------------------------------------------------------
// Command surface for rendered HTML
// ---------------------------------------------------------------------------

const commands = {
  // navigation
  goTab,
  backPage: Router.pop,
  openLibTab: openLibraryTab,
  openPlaylist: actions.openPlaylist,
  openArtist: actions.openArtist,
  openNowPlaying,
  closeNowPlaying,
  openQueue,
  closeQueue,

  // playback
  playTrack: actions.playTrack,
  playAt: actions.playAt,
  playPlaylist: actions.playPlaylist,
  playLiked: actions.playLiked,
  playShuffle: actions.playShuffle,
  playArtist: actions.playArtist,
  playArtistAt: actions.playArtistAt,
  playAlbum: actions.playAlbum,
  playAlbumAt: actions.playAlbumAt,
  playPlaylistAt: actions.playPlaylistAt,
  playTopAt: actions.playTopAt,
  playSearchAt: actions.playSearchAt,
  playSongsAt: actions.playSongsAt,
  playLibraryAt: actions.playLibraryAt,
  playDownloadedAt: actions.playDownloadedAt,
  playChannel: actions.playChannel,
  playChannelAt: actions.playChannelAt,
  playNext: (id) => player.playNext(id),
  addToQueue: (id) => player.addToQueue(id),
  togglePlay: actions.togglePlay,
  nextTrack: actions.nextTrack,
  prevTrack: actions.prevTrack,
  toggleShuffle: actions.toggleShuffle,
  toggleRepeat: actions.toggleRepeat,
  syncModeIcons,
  downloadCurrent: actions.downloadCurrent,

  // library
  toggleLike: actions.toggleLike,
  toggleLikeById: actions.toggleLikeById,
  toggleFollow: actions.toggleFollow,
  toggleSaveAlbum: actions.toggleSaveAlbum,
  offlineToggle: device.toggleOffline,
  addTrackToPlaylist: actions.addTrackToPlaylist,
  removeFromPlaylist: actions.removeTrackFromPlaylist,
  togglePlaylistTrack: actions.toggleTrackInPlaylist,
  deletePlaylist: actions.deletePlaylistById,
  renamePlaylistPrompt: actions.renamePlaylistPrompt,
  createPlaylist: actions.newPlaylist,

  // downloads
  toggleDownload,
  downloadIds,
  downloadTracks,
  downloadAll,
  cancelDownloads,

  // overlays
  trackMenu: actions.trackMenu,
  addToPlaylistMenu: actions.addToPlaylistMenu,
  playlistMenu: actions.playlistMenu,
  openSongPicker: actions.openSongPicker,
  createPlaylistPrompt: actions.createPlaylistPrompt,
  newPlaylist: actions.newPlaylist,
  npMore: actions.npMore,
  sleepMenu: actions.sleepMenu,
  chooseSleep: actions.chooseSleep,
  showLyrics: actions.showLyrics,
  showAbout: actions.showAbout,
  stopLyricSync: actions.stopLyricSync,
  openModal,
  closeModal,
  saveModal,
  closeSheet,
  openSheet,

  // share
  shareTrack: actions.shareTrack,
  shareCurrent: actions.shareCurrent,

  // device
  openStorageSheet: device.openStorageSheet,
  clearAllDownloads: device.clearAllDownloads,
  resetDevice: device.resetDevice,
  openKeySheet: device.openKeySheet,
  saveKeys: device.saveKeys,

  // search
  searchGenre: searchFor,
  searchTrending: () => searchFor('trending music'),
};

for (const [name, fn] of Object.entries(commands)) {
  window[`__${name}`] = fn;
}
window.__toast = toast;
window.__player = player;
// The now-playing markup calls this inside its onclick, next to the `__toggle*`
// command. Exposing it globally keeps both halves of that handler resolvable.
window.syncModeIcons = syncModeIcons;

// ---------------------------------------------------------------------------
// Now playing / queue
// ---------------------------------------------------------------------------

function openNowPlaying() {
  if (!player.current) return;
  const overlay = $('#now-playing');
  const queue = $('#np-queue');
  if (overlay) overlay.classList.remove('hidden');
  if (queue) queue.classList.add('hidden');
  lock();
  syncModeIcons();
  player.renderError();
  renderIcons();
}

function closeNowPlaying() {
  const overlay = $('#now-playing');
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  const queue = $('#np-queue');
  if (queue) queue.classList.add('hidden');
  actions.stopLyricSync();
  unlock();
}

function openQueue() {
  const queue = $('#np-queue');
  if (queue) queue.classList.remove('hidden');
  renderQueue();
}

function closeQueue() {
  const queue = $('#np-queue');
  if (queue) queue.classList.add('hidden');
}

/**
 * Paint shuffle/repeat state.
 *
 * Called on every mode change and on open. The icon *and* the button class are
 * updated, and `renderIcons` is re-run because lucide replaces the `<i>` element
 * it is given with a fresh `<svg>` — setting `data-lucide` alone only works
 * before the first render.
 */
export function syncModeIcons() {
  const shuffleBtn = $('#np-shuffle-btn');
  if (shuffleBtn) {
    shuffleBtn.classList.toggle('on', !!player.shuffle);
    shuffleBtn.setAttribute('aria-pressed', player.shuffle ? 'true' : 'false');
    shuffleBtn.setAttribute('aria-label', player.shuffle ? 'Shuffle on' : 'Shuffle off');
  }

  const repeatBtn = $('#np-repeat-btn');
  if (repeatBtn) {
    const on = player.repeat !== 'off';
    repeatBtn.classList.toggle('on', on);
    repeatBtn.classList.toggle('one', player.repeat === 'one');
    repeatBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    repeatBtn.setAttribute('aria-label', player.repeat === 'off'
      ? 'Repeat off'
      : player.repeat === 'one' ? 'Repeat this song' : 'Repeat playlist');
  }

  syncIcon('#np-shuffle-icon', 'shuffle');
  syncIcon('#np-repeat-icon', player.repeat === 'one' ? 'repeat-1' : 'repeat');

  const modeLabel = $('#np-mode-label');
  if (modeLabel) {
    const parts = [];
    if (player.shuffle) parts.push('Shuffle');
    if (player.repeat === 'one') parts.push('Repeat one');
    else if (player.repeat === 'all') parts.push('Repeat all');
    modeLabel.textContent = parts.join(' · ');
    modeLabel.classList.toggle('hidden', !parts.length);
  }

  // The mini player shows the same state so it is visible without the overlay.
  const miniMode = $('#mini-mode');
  if (miniMode) {
    const on = player.shuffle || player.repeat !== 'off';
    miniMode.classList.toggle('hidden', !on);
    const icon = player.shuffle ? 'shuffle' : player.repeat === 'one' ? 'repeat-1' : 'repeat';
    const holder = miniMode.querySelector('i, svg');
    if (holder && holder.getAttribute('data-lucide') !== icon) {
      holder.setAttribute('data-lucide', icon);
      if (holder.tagName.toLowerCase() === 'svg') {
        const fresh = document.createElement('i');
        fresh.setAttribute('data-lucide', icon);
        holder.replaceWith(fresh);
      }
    }
  }

  renderIcons();
}

/**
 * lucide swaps `<i data-lucide>` for `<svg>` on first render, so a later
 * `data-lucide` change on the `<i>` does nothing. Replace the svg's icon by
 * re-creating an `<i>` in place when the name differs.
 */
function syncIcon(selector, name) {
  const el = $(selector);
  if (!el) return;
  const current = el.getAttribute('data-lucide')
    || (el.classList ? Array.from(el.classList).find((c) => c.startsWith('lucide-') && c !== 'lucide') : null);
  const wanted = el.tagName.toLowerCase() === 'svg' ? `lucide-${name}` : name;

  if (el.tagName.toLowerCase() === 'svg') {
    if (current === wanted) return;
    const holder = document.createElement('i');
    holder.id = el.id;
    holder.setAttribute('data-lucide', name);
    el.replaceWith(holder);
    renderIcons();
    return;
  }
  el.setAttribute('data-lucide', name);
}

function renderQueue() {
  const list = $('#np-queue-list');
  if (!list) return;
  list.innerHTML = player.queue.map((track, i) => `
    <button class="np-queue-item ${i === player.index ? 'current' : ''}" onclick="__playAt(${i})">
      ${coverForTrack(track, 'track-art', 'width:38px;height:38px;border-radius:9px')}
      <div class="track-meta">
        <p class="track-title">${track.title}</p>
        <p class="track-sub">${track.dur || ''}</p>
      </div>
      ${i === player.index
        ? `<span class="eq">${[0, 1, 2].map(() => '<span></span>').join('')}</span>`
        : `<span class="track-side">${track.dur || ''}</span>`}
    </button>`).join('');
  renderIcons();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

on('toast', ({ message, icon }) => toast(message, icon));

on('track-changed', () => {
  const mini = $('#mini-player');
  if (mini) mini.classList.remove('hidden');
  syncModeIcons();
});

on('track-resolving', () => {
  const mini = $('#mini-player');
  if (mini) mini.classList.remove('hidden');
});

on('track-buffering', ({ track, progress }) => {
  const sub = $('#mini-artist');
  if (sub && player.current && player.current.id === track.id) {
    const pct = progress ? Math.round((progress / 1000) * 100) : 0;
    sub.textContent = pct ? `Preparing ${pct}%` : 'Preparing…';
  }
});

on('track-rendered', (track) => {
  const npArt = $('#np-art');
  const miniArt = $('#mini-art');
  if (npArt) npArt.innerHTML = coverForTrack(track).replace(/^<div[^>]*>|<\/div>$/g, '');
  if (miniArt) miniArt.innerHTML = coverForTrack(track).replace(/^<div[^>]*>|<\/div>$/g, '');
  player.syncLikeIcon();
  renderIcons();
});

on('play-state', () => renderIcons());

on('mode-changed', () => syncModeIcons());

on('queue-changed', () => {
  const overlay = $('#now-playing');
  if (overlay && !overlay.classList.contains('hidden')) renderQueue();
});

on('library-changed', () => {
  refreshDownloadIcons();
  actions.refresh();
});

on('tracks-hydrated', () => {
  actions.refresh();
});

on('settings-changed', () => {
  import('./device.js').then((d) => d.refreshStats());
  import('./views/home.js').then((h) => h.resetHome());
});

onDownloadChange((kind) => {
  if (kind === 'progress') return;
  refreshDownloadIcons();
});

// Persist the track registry before the tab goes away.
window.addEventListener('pagehide', () => {
  saveTracksNow();
  player.persistSession();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveTracksNow();
    player.persistSession();
    player.prepareForBackground();
    return;
  }
  // Coming back from the background: the OS may have dropped the media stream
  // and paused the transfer, so both engines get a chance to re-attach.
  player.resumeFromBackground();
});

// The Page Lifecycle API fires these when the browser freezes a background tab
// and when it comes back. `resume` is the reliable wake-up signal on Android and
// in installed PWAs, where `visibilitychange` alone is sometimes skipped.
document.addEventListener('freeze', () => {
  player.persistSession();
  player.prepareForBackground();
});
document.addEventListener('resume', () => player.resumeFromBackground());

window.addEventListener('online', () => player.resumeFromBackground());
window.addEventListener('pagehide', () => player.prepareForBackground());

// Downloads survive the screen locking or the app being switched away from.
// The lifecycle listeners inside media.js stop the clock while the page is
// asleep, so a transfer that was paused is resumed rather than counted as failed.
initDownloadLifecycle();

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function initSeek() {
  const track = $('#progress-track');
  if (!track) return;
  let dragging = false;

  const seekTo = (event) => {
    const rect = track.getBoundingClientRect();
    player.seek((event.clientX - rect.left) / rect.width);
  };

  track.addEventListener('pointerdown', (event) => {
    dragging = true;
    track.classList.add('dragging');
    track.setPointerCapture(event.pointerId);
    seekTo(event);
  });
  track.addEventListener('pointermove', (event) => { if (dragging) seekTo(event); });
  const stop = () => {
    dragging = false;
    track.classList.remove('dragging');
  };
  track.addEventListener('pointerup', stop);
  track.addEventListener('pointercancel', stop);
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

/**
 * Register the offline worker once the page has loaded.
 *
 * Registering on the `load` event is the friendly thing to do — it keeps the
 * worker from competing with first paint — but boot() awaits module imports
 * first, and on a warm cache `load` has already fired by then. Waiting for an
 * event that will never come meant the worker silently never registered, which
 * is what broke offline playback on GitHub Pages. So: register immediately if
 * the page is already loaded, and listen otherwise.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  setGreeting();
  initModal();
  initTabs();
  initPlayer();
  initSeek();

  const search = $('#search-input');
  if (search) search.addEventListener('input', (event) => onSearchInput(event.target.value));

  renderRecent();
  renderBrowse();
  renderTop();
  openLibraryTab('playlists');
  refreshDownloads();
  device.refreshStats();
  renderIcons();
  refreshDownloadIcons();
  syncModeIcons();

  // A reload loses nothing now: the registry is restored from storage and any
  // ids still missing are hydrated from the mirrors.
  const { state } = await import('./library.js');
  const wanted = new Set([...state.liked, ...state.recent]);
  for (const playlist of state.playlists) for (const id of playlist.ids) wanted.add(id);
  hydrateTracks(Array.from(wanted)).catch(() => {});

  // Downloads that were interrupted by a reload, a crash, or the OS suspending
  // the app are put back on the queue. Their stored parts are reused, so the
  // transfer continues instead of starting over.
  resumePendingDownloads().then((resumed) => {
    if (resumed) {
      toast(`Resuming ${resumed} download${resumed === 1 ? '' : 's'}`, 'download');
      refreshDownloadIcons();
    }
  }).catch(() => {});

  const tab = new URLSearchParams(location.search).get('tab');
  if (tab) goTab(tab);

  registerServiceWorker();

  const { byId } = await import('./catalog.js');
  window.__debug = {
    player,
    settings: getSettings(),
    resolvePlaylist,
    byId,
    state,
    isDownloaded,
  };
}

boot();
