// Player: queue, transport, Media Session, and now-playing state.
//
// Two engines, in order:
//   1. The hidden YouTube iframe (fast, keyless, official).
//   2. A public Invidious audio stream, for videos whose owner disabled
//      embedding and for anything the iframe refuses to play.
//
// A downloaded file always wins over both, so offline playback needs no network.
// If every engine fails, the player stops on the track and offers a download
// instead of silently skipping past it.

import { byId, ARTISTS, ALBUMS, ensureTrack } from './catalog.js';
import { state, pushRecent } from './library.js';
import { isDownloaded, cachedUrl } from './media.js';
import * as yt from './ytplayer.js';
import * as invidious from './invidious.js';
import { $, $$, fmtLong, clamp } from './util.js';
import { emit } from './events.js';
import { get as artGet } from './art.js';
import { STORAGE } from './config.js';

const audioEl = new Audio();
audioEl.preload = 'metadata';

export const player = {
  queue: [],
  order: [],
  index: 0,
  playing: false,
  shuffle: false,
  repeat: 'off',
  source: 'Queue',
  current: null,
  sleepTimer: null,
  started: false,
  seeking: false,
  mode: 'iframe',
  audioSource: null,
  token: 0,
  error: null,

  init() {
    yt.onYtEvent((event) => {
      if (this.mode !== 'iframe') return;
      if (event.type === 'state') {
        if (event.state === yt.STATE.PLAYING) {
          this.playing = true;
          this.syncPlayIcons();
        } else if (event.state === yt.STATE.PAUSED) {
          this.playing = false;
          this.syncPlayIcons();
        } else if (event.state === yt.STATE.ENDED) {
          this.onEnded();
        }
      } else if (event.type === 'error') {
        this.onPlayerError(event.code);
      }
    });

    audioEl.addEventListener('timeupdate', () => { if (this.isAudioMode()) this.onTime(); });
    audioEl.addEventListener('loadedmetadata', () => {
      const total = $('#np-duration');
      if (total && this.isAudioMode()) total.textContent = fmtLong(audioEl.duration);
    });
    audioEl.addEventListener('play', () => { if (this.isAudioMode()) { this.playing = true; this.syncPlayIcons(); } });
    audioEl.addEventListener('pause', () => { if (this.isAudioMode()) { this.playing = false; this.syncPlayIcons(); } });
    audioEl.addEventListener('ended', () => { if (this.isAudioMode()) this.onEnded(); });
    audioEl.addEventListener('error', () => {
      if (!this.isAudioMode() || !this.current) return;
      // A stream URL expired: resolve it once more before giving up.
      if (this.audioSource === 'stream' && !this.streamRetried) {
        this.streamRetried = true;
        const track = this.current;
        const token = this.token;
        setTimeout(() => {
          if (token !== this.token) return;
          this.playStream(track, token);
        }, 350);
        return;
      }
      // A corrupt cached download should not trap the user offline.
      if (this.audioSource === 'download') {
        import('./media.js').then((m) => m.removeDownload(this.current.id));
        emit('toast', { message: 'Download was incomplete — removed', icon: 'alert-circle' });
      }
    });

    // The iframe has no timeupdate event, so poll while it is driving playback.
    setInterval(() => {
      if (this.mode !== 'iframe' || !this.started || this.seeking) return;
      this.onTime();
    }, 500);

    const volume = $('#volume-slider');
    if (volume) {
      volume.value = '100';
      volume.addEventListener('input', (event) => {
        const value = Number(event.target.value);
        audioEl.volume = value / 100;
        yt.setVolume(value);
      });
    }

    this.setupMediaSession();
    yt.init().catch(() => {});
  },

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('stop', () => this.pause());
    ms.setActionHandler('seekbackward', (d) => {
      const by = (d && d.seekOffset) || 15;
      const target = Math.max(0, this.time() - by);
      if (this.isAudioMode()) audioEl.currentTime = target;
      else yt.seek(target);
    });
    ms.setActionHandler('seekforward', (d) => {
      const by = (d && d.seekOffset) || 15;
      const target = Math.min(this.duration() || 0, this.time() + by);
      if (this.isAudioMode()) audioEl.currentTime = target;
      else yt.seek(target);
    });
    ms.setActionHandler('seekto', (d) => {
      if (!isFinite(d.seekTime)) return;
      if (this.isAudioMode()) audioEl.currentTime = d.seekTime;
      else yt.seek(d.seekTime);
    });
  },

  isAudioMode() {
    return this.mode === 'audio';
  },

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  setQueue(ids, source) {
    const tracks = (ids || []).map((id) => ensureTrack(id)).filter((t) => t && t.videoId);
    this.queue = tracks;
    if (source) this.source = source;
    this.index = 0;
    this.rebuildOrder();
    emit('queue-changed', this.queue);
  },

  /**
   * Shuffle is an order over queue indices, not a random jump.
   *
   * A random jump could land on the same track twice in a row and made
   * "previous" meaningless. Keeping an explicit order gives a real shuffled
   * playlist that walks forward, wraps, and can be reversed.
   */
  rebuildOrder() {
    const indices = this.queue.map((_, i) => i);
    if (this.shuffle) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      // Keep the current track where it is so turning shuffle on does not jump.
      const at = indices.indexOf(this.index);
      if (at > 0) {
        indices.splice(at, 1);
        indices.unshift(this.index);
      }
    }
    this.order = indices;
  },

  orderPosition() {
    const at = this.order.indexOf(this.index);
    return at === -1 ? 0 : at;
  },

  reorderForShuffle() {
    const current = this.current && this.current.id;
    this.rebuildOrder();
    if (current) {
      const at = this.queue.findIndex((t) => t.id === current);
      if (at >= 0) this.index = at;
      this.queue = this.order.map((i) => this.queue[i]);
      this.index = this.queue.findIndex((t) => t.id === current);
      if (this.index < 0) this.index = 0;
      this.order = this.queue.map((_, i) => i);
    }
    emit('queue-changed', this.queue);
  },

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async playTrack(id, source, queueIds) {
    if (queueIds) this.setQueue(queueIds, source);
    else if (source) this.source = source;

    const track = ensureTrack(id);
    if (!track || !track.videoId) {
      emit('toast', { message: 'That track cannot be played', icon: 'alert-circle' });
      return;
    }

    if (state.offline && !(await isDownloaded(id))) {
      emit('toast', { message: 'Not downloaded — turn off offline mode', icon: 'wifi-off' });
      return;
    }

    const queued = this.queue.findIndex((t) => t.id === id);
    if (queued >= 0) this.index = queued;

    const token = ++this.token;
    this.streamRetried = false;
    this.current = track;
    this.clearError();
    this.renderNowPlaying();
    this.updateMediaSession();
    this.pushRecent(id);
    emit('track-changed', track);
    emit('recent-changed');

    const mini = $('#mini-player');
    if (mini) mini.classList.remove('hidden');

    // Downloaded audio plays from disk (works offline) and always wins.
    const local = await cachedUrl(id);
    if (token !== this.token) return;
    if (local) {
      this.mode = 'audio';
      this.audioSource = 'download';
      yt.pause();
      audioEl.src = local;
      audioEl.volume = this.volume();
      this.started = true;
      try {
        await audioEl.play();
      } catch {
        emit('toast', { message: 'Tap play to start', icon: 'play' });
      }
      return;
    }

    // Videos known to refuse embedding skip the iframe entirely; retrying it
    // would just fail again with error 150.
    if (isBlocked(track.videoId)) {
      if (await this.playStream(track, token)) return;
      if (token !== this.token) return;
      this.reportUnplayable(track);
      return;
    }

    this.mode = 'iframe';
    this.audioSource = null;
    audioEl.pause();
    audioEl.removeAttribute('src');

    try {
      await yt.play(track.videoId);
      if (token !== this.token) return;
      this.started = true;
    } catch {
      // The iframe failed to start at all — the mirror is still worth a try.
      if (token !== this.token) return;
      if (await this.playStream(track, token)) return;
      if (token !== this.token) return;
      this.reportUnplayable(track);
    }
  },

  volume() {
    const slider = $('#volume-slider');
    return Number((slider && slider.value) || 100) / 100;
  },

  /**
   * Play through a public Invidious mirror.
   *
   * The instance proxies the media itself, so the URL is CORS-readable and the
   * audio element gets real duration, seeking and an `ended` event. Resolves
   * true once playback actually started.
   */
  async playStream(track, token) {
    this.mode = 'audio';
    this.audioSource = 'stream';
    yt.pause();
    this.started = true;
    audioEl.volume = this.volume();

    let candidates = [];
    try {
      candidates = await invidious.audioCandidates(track.videoId);
    } catch {
      candidates = [];
    }

    for (const url of candidates) {
      if (token !== this.token) return false;
      const ready = await this.loadAudio(url);
      if (token !== this.token) return false;
      if (!ready) continue;

      try {
        await audioEl.play();
      } catch {
        emit('toast', { message: 'Tap play to start', icon: 'play' });
      }
      return true;
    }

    return false;
  },

  /**
   * Point the audio element at a URL and wait for it to become playable.
   * Resolves false rather than throwing so the caller can try another source.
   */
  loadAudio(url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audioEl.removeEventListener('loadedmetadata', ready);
        audioEl.removeEventListener('playing', ready);
        audioEl.removeEventListener('error', failed);
        resolve(ok);
      };
      const ready = () => finish(true);
      const failed = () => finish(false);
      const timer = setTimeout(() => finish(false), 9000);

      // Listeners first: a dead source can fail as soon as it is assigned.
      audioEl.addEventListener('loadedmetadata', ready);
      audioEl.addEventListener('playing', ready);
      audioEl.addEventListener('error', failed);
      audioEl.src = url;
      audioEl.load();
    });
  },

  /**
   * Neither engine could play this track.
   *
   * The old build skipped to the next song, which hid the problem. Stop here and
   * offer the one thing that actually works: download it and play from disk.
   */
  reportUnplayable(track) {
    this.playing = false;
    this.syncPlayIcons();
    this.error = {
      trackId: track.id,
      message: 'Failed to play this song',
      sub: 'Download it to play from your device.',
    };
    this.renderError();
    emit('toast', { message: 'Failed to play — download it to play this song', icon: 'alert-circle' });
  },

  renderError() {
    const box = $('#np-error');
    if (!box) return;
    if (!this.error) {
      box.classList.add('hidden');
      return;
    }
    const text = $('#np-error-text');
    const sub = $('#np-error-sub');
    if (text) text.textContent = this.error.message;
    if (sub) sub.textContent = this.error.sub;
    box.classList.remove('hidden');
  },

  clearError() {
    this.error = null;
    const box = $('#np-error');
    if (box) box.classList.add('hidden');
  },

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const track = this.current;
    const artist = (ARTISTS[track.artistId] || {}).name || 'Unknown';
    const album = (ALBUMS[track.albumId] || {}).name || '';
    const artwork = track.thumb
      ? [
        { src: track.thumb, sizes: '512x512' },
        { src: track.thumb, sizes: '256x256' },
      ]
      : [{ src: 'assets/icons/icon-512.png', type: 'image/png', sizes: '512x512' }];

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist,
        album: album || 'FreePot',
        artwork,
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {}
  },

  syncPosition() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const duration = this.isAudioMode() ? audioEl.duration : yt.getDuration();
    if (!isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: clamp(this.isAudioMode() ? audioEl.currentTime : yt.getTime(), 0, duration),
      });
    } catch {}
  },

  onPlayerError(code) {
    // 2 bad id, 5 html5 error, 100 not found, 101/150 embed blocked.
    const track = this.current;
    if (!track) return;
    const token = this.token;

    // 101/150 mean the owner disabled embedding. Anything else can still be a
    // blocked video in disguise, so the mirror is tried for every error except
    // a definitely-missing video (100) — and even there a download can work.
    if (code !== 100 && yt.getVideoId() === track.videoId) {
      markBlocked(track.videoId);
      this.playStream(track, token).then((ok) => {
        if (token !== this.token) return;
        if (!ok) this.reportUnplayable(track);
      });
      return;
    }

    this.playStream(track, token).then((ok) => {
      if (token !== this.token) return;
      if (!ok) this.reportUnplayable(track);
    });
  },

  play() {
    if (!this.current) return;
    if (this.error) {
      this.playTrack(this.current.id);
      return;
    }
    if (this.isAudioMode()) {
      audioEl.play().catch(() => {});
      this.playing = true;
      this.syncPlayIcons();
    } else {
      yt.resume();
    }
  },

  pause() {
    if (this.isAudioMode()) audioEl.pause();
    else yt.pause();
  },

  toggle() {
    if (!this.current) return;
    if (this.playing) this.pause();
    else this.play();
  },

  /**
   * Move in the queue.
   *
   * `auto` is true when a track ended by itself: then repeat decides whether to
   * wrap, and repeat-off stops at the end instead of looping forever.
   */
  next(auto = false) {
    if (!this.queue.length) return;
    if (this.queue.length === 1) {
      if (this.repeat === 'one' || (this.repeat === 'all' && auto)) {
        this.index = 0;
        this.playTrack(this.queue[0].id);
      } else if (!auto) {
        this.replay();
      } else {
        this.playing = false;
        this.syncPlayIcons();
      }
      return;
    }

    const list = this.shuffle ? this.order : this.queue.map((_, i) => i);
    const at = list.indexOf(this.index);
    const last = at >= list.length - 1;

    if (last && auto && this.repeat === 'off') {
      this.playing = false;
      this.syncPlayIcons();
      return;
    }

    const nextIndex = list[(at + 1) % list.length];
    this.index = nextIndex;
    this.playTrack(this.queue[nextIndex].id);
  },

  prev() {
    if (!this.queue.length) return;
    if (this.time() > 3) {
      this.seek(0);
      return;
    }
    const list = this.shuffle ? this.order : this.queue.map((_, i) => i);
    const at = list.indexOf(this.index);
    const prevIndex = list[(at - 1 + list.length) % list.length];
    this.index = prevIndex;
    this.playTrack(this.queue[prevIndex].id);
  },

  onEnded() {
    if (this.repeat === 'one') {
      this.replay();
      return;
    }
    this.next(true);
  },

  /** Restart the current track from the top, on whichever engine is active. */
  replay() {
    if (!this.current) return;
    if (this.isAudioMode()) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
      this.playing = true;
      this.syncPlayIcons();
      return;
    }
    yt.seek(0);
    yt.resume();
  },

  time() {
    return this.isAudioMode() ? audioEl.currentTime : yt.getTime();
  },

  duration() {
    return this.isAudioMode() ? audioEl.duration : yt.getDuration();
  },

  onTime() {
    const duration = this.duration() || 1;
    const time = this.time();
    const pct = Math.min(100, (time / duration) * 100);

    const track = $('#progress-track');
    const bar = $('#progress-bar');
    if (bar && !(track && track.classList.contains('dragging'))) bar.style.width = `${pct}%`;
    const mini = $('#mini-progress-bar');
    if (mini) mini.style.width = `${pct}%`;
    const current = $('#np-current');
    if (current) current.textContent = fmtLong(time);
    const total = $('#np-duration');
    if (total && duration > 1) total.textContent = fmtLong(duration);

    this.ticks = (this.ticks || 0) + 1;
    if (this.ticks % 4 === 0) this.syncPosition();
    emit('time', { time, duration, pct });
  },

  seek(fraction) {
    if (!this.current) return;
    const frac = clamp(fraction, 0, 1);
    const duration = this.duration();
    if (!duration) return;

    if (this.isAudioMode()) audioEl.currentTime = frac * duration;
    else yt.seek(frac * duration);

    const bar = $('#progress-bar');
    if (bar) bar.style.width = `${frac * 100}%`;
    const current = $('#np-current');
    if (current) current.textContent = fmtLong(frac * duration);
    this.syncPosition();
  },

  playNext(id) {
    const track = ensureTrack(id);
    if (!track) return;
    if (!this.queue.length) this.setQueue([track.id], this.source);
    else {
      this.queue.splice(this.index + 1, 0, track);
      this.rebuildOrder();
      emit('queue-changed', this.queue);
    }
    emit('toast', { message: `Up next: ${track.title}`, icon: 'list-plus' });
  },

  addToQueue(id) {
    const track = ensureTrack(id);
    if (!track) return;
    if (!this.queue.length) {
      this.setQueue([track.id], this.source);
    } else {
      this.queue.push(track);
      this.rebuildOrder();
      emit('queue-changed', this.queue);
    }
    emit('toast', { message: `Queued: ${track.title}`, icon: 'list-music' });
  },

  syncPlayIcons() {
    const icon = this.playing ? 'pause' : 'play';
    $$('#mini-play-icon, #big-play-icon').forEach((el) => el.setAttribute('data-lucide', icon));
    const np = $('#now-playing');
    if (np) np.classList.toggle('paused', !this.playing);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
    emit('play-state', this.playing);
  },

  renderNowPlaying() {
    if (!this.current) return;
    const track = this.current;
    const artist = (ARTISTS[track.artistId] || {}).name || 'Unknown';
    const album = (ALBUMS[track.albumId] || {}).name || '';

    const setText = (sel, value) => { const el = $(sel); if (el) el.textContent = value; };
    setText('#np-title', track.title);
    // Album names are synthesised from the channel, so avoid "Artist · Artist".
    setText('#np-sub', album && album !== artist ? `${artist} · ${album}` : artist);
    setText('#np-source', this.source);
    setText('#mini-title', track.title);
    setText('#mini-artist', artist);

    const bg = $('#np-bg');
    if (bg) bg.src = track.thumb || artGet(`v:${track.videoId || track.id}`);

    this.syncLikeIcon();
    emit('track-rendered', track);
  },

  syncLikeIcon() {
    const liked = !!(this.current && state.liked.includes(this.current.id));
    const mini = $('#mini-like');
    const np = $('#np-like');
    if (mini) mini.classList.toggle('liked', liked);
    if (np) np.classList.toggle('liked', liked);
  },

  pushRecent(id) { pushRecent(id); },
};

// Embed-blocked ids are remembered so the next attempt skips the iframe.
const blocked = new Set();
try {
  const raw = JSON.parse(localStorage.getItem(STORAGE.blocked) || '[]');
  if (Array.isArray(raw)) raw.forEach((id) => blocked.add(id));
} catch {}

function isBlocked(videoId) {
  return !!videoId && blocked.has(videoId);
}

function markBlocked(videoId) {
  if (!videoId || blocked.has(videoId)) return;
  blocked.add(videoId);
  try { localStorage.setItem(STORAGE.blocked, JSON.stringify(Array.from(blocked).slice(-200))); } catch {}
}

export function initPlayer() {
  player.init();
}

export { yt };
