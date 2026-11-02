// Catalog: everything the app can browse or play, sourced from YouTube.
//
// Tracks are keyed by YouTube video id (`v:<id>`), artists by channel id
// (`c:<id>`) and playlists by playlist id (`pl:<id>`). There is no bundled demo
// catalogue: everything is resolved keylessly from public sources.
//
// The registry is mirrored to localStorage. Likes, recents and playlists only
// store ids, so without this a reload would leave those ids unresolvable — the
// list would show a count but no rows, and playback would silently fail.

import { YT_WATCH, YT_PLAYLIST, STORAGE } from './config.js';
import { fmt, hashStr, load, store } from './util.js';

export const ARTISTS = {};
export const ALBUMS = {};
export const remoteById = {};

export const byId = new Proxy(remoteById, { get: (t, p) => t[p] });

export const tracksOfArtist = (artistId) =>
  Object.values(remoteById).filter((t) => t.artistId === artistId);

export const albumsOfArtist = (artistId) =>
  Object.values(ALBUMS).filter((a) => a.artistId === artistId);

export const tracksOfAlbum = (albumId) =>
  Object.values(remoteById).filter((t) => t.albumId === albumId);

export const remotePlaylists = {};

export const GENRES = [
  { name: 'Pop', icon: 'music-2', tag: 'pop' },
  { name: 'Electronic', icon: 'audio-waveform', tag: 'electronic' },
  { name: 'Hip-Hop', icon: 'mic-2', tag: 'hiphop' },
  { name: 'Rock', icon: 'guitar', tag: 'rock' },
  { name: 'Lo-Fi', icon: 'cloud-moon', tag: 'lofi' },
  { name: 'Acoustic', icon: 'disc-3', tag: 'acoustic' },
];

const VIDEO_ID = /^[\w-]{11}$/;
const MAX_STORED = 800;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function ensureRemoteArtist(channelId, name) {
  if (!channelId) return 'c:none';
  const id = `c:${channelId}`;
  const display = cleanArtistName(name);
  if (!ARTISTS[id]) {
    ARTISTS[id] = { id, name: display || 'Unknown artist', genre: 'artist', remote: true, channelId };
  } else if (display && ARTISTS[id].name !== display) {
    ARTISTS[id].name = display;
  }
  const albumId = `al:${channelId}`;
  if (!ALBUMS[albumId]) {
    ALBUMS[albumId] = {
      id: albumId,
      name: ARTISTS[id].name,
      artistId: id,
      year: new Date().getFullYear(),
      remote: true,
    };
  }
  return id;
}

// YouTube suffixes auto-generated artist channels with " - Topic"; the app
// should show the artist, not the channel plumbing.
function cleanArtistName(name) {
  return String(name || '').replace(/\s*-\s*Topic$/i, '').trim();
}

/**
 * Register a track from a source.
 *
 * This runs more than once per video (source layer, then each view), so it has
 * to be idempotent: a track that is already registered is returned as-is.
 */
export function registerVideo(video) {
  if (!video) return null;
  if (video.id && video.videoId && remoteById[video.id]) {
    updateTrack(remoteById[video.id], video);
    return remoteById[video.id];
  }

  const rawId = String(video.videoId || video.id || '').replace(/^v:/, '');
  if (!VIDEO_ID.test(rawId)) return null;

  const key = `v:${rawId}`;
  const existing = remoteById[key];
  if (existing) {
    updateTrack(existing, video);
    return existing;
  }
  const artistId = ensureRemoteArtist(video.channelId, video.channel);
  const track = {
    id: key,
    title: video.title || 'Untitled',
    artistId,
    albumId: `al:${video.channelId || 'none'}`,
    dur: video.durationText || (video.duration ? fmt(video.duration) : ''),
    src: null,
    videoId: rawId,
    thumb: video.thumb || null,
    remote: true,
  };
  remoteById[key] = track;
  scheduleSave();
  return track;
}

function updateTrack(track, video) {
  let changed = false;
  if (video.thumb && !track.thumb) { track.thumb = video.thumb; changed = true; }
  if (video.durationText && !track.dur) { track.dur = video.durationText; changed = true; }
  if (!track.title && video.title) { track.title = video.title; changed = true; }
  if (changed) scheduleSave();
}

export function registerPlaylist(playlistId, { name, desc, ids }) {
  const key = `pl:${playlistId}`;
  remotePlaylists[key] = {
    key,
    id: playlistId,
    name: name || 'Playlist',
    desc: desc || '',
    ids: ids || [],
    remote: true,
  };
  return remotePlaylists[key];
}

// ---------------------------------------------------------------------------
// Stubs and hydration
// ---------------------------------------------------------------------------

/**
 * Resolve an id to a track, creating a placeholder if the registry has not seen
 * it yet.
 *
 * Likes, recents and playlists only store ids. A track can be missing after a
 * reload (or because it was saved before it finished registering), and dropping
 * those rows is what made a liked song show a count of one but no entry.
 */
export function ensureTrack(id) {
  if (!id) return null;
  const key = String(id);
  if (remoteById[key]) return remoteById[key];
  if (!key.startsWith('v:')) return null;

  const videoId = key.slice(2);
  if (!VIDEO_ID.test(videoId)) return null;

  const artistId = ensureRemoteArtist('', '');
  const track = {
    id: key,
    title: 'Loading…',
    artistId,
    albumId: 'al:none',
    dur: '',
    src: null,
    videoId,
    thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    remote: true,
    pending: true,
  };
  remoteById[key] = track;
  return track;
}

let hydrating = null;
let hydrateQueued = [];
let hydrateAgain = false;

/**
 * Fill in placeholders from Invidious metadata.
 *
 * Batched so a list of ten unknown ids costs one refresh, not ten. A failed
 * lookup marks the track as attempted rather than leaving it pending: leaving it
 * pending made every repaint queue it again, which turned into an endless
 * hydrate → repaint → hydrate loop on tracks the mirrors could not resolve.
 */
export function hydrateTracks(ids) {
  const targets = (ids || [])
    .map((id) => remoteById[id])
    .filter((track) => track && track.pending && !track.hydrating);
  if (!targets.length) return Promise.resolve(false);

  for (const track of targets) {
    track.hydrating = true;
    if (!hydrateQueued.includes(track)) hydrateQueued.push(track);
  }

  if (hydrating) {
    hydrateAgain = true;
    return hydrating;
  }

  hydrating = (async () => {
    let changed = false;

    while (hydrateQueued.length) {
      const batch = hydrateQueued.splice(0, hydrateQueued.length);
      await Promise.all(batch.map(async (track) => {
        try {
          const { video } = await import('./invidious.js');
          const info = await video(track.videoId);
          if (!info || !info.title) return;
          const artistId = ensureRemoteArtist(info.authorId, info.author);
          track.title = info.title;
          track.artistId = artistId;
          track.albumId = `al:${info.authorId || 'none'}`;
          track.thumb = info.thumb || track.thumb;
          track.dur = info.lengthSeconds ? fmt(info.lengthSeconds) : track.dur;
          track.description = info.description;
          changed = true;
        } catch {
          // Mark as attempted so this id is not retried on every repaint.
          if (track.title === 'Loading…') track.title = 'Unavailable track';
        } finally {
          track.pending = false;
          track.hydrating = false;
        }
      }));
    }

    hydrating = null;
    hydrateAgain = false;
    if (changed) {
      save();
      const { emit } = await import('./events.js');
      emit('tracks-hydrated');
    }
    return changed;
  })();

  return hydrating;
}

// ---------------------------------------------------------------------------
// Local persistence
// ---------------------------------------------------------------------------

const TRACKS_KEY = STORAGE.tracks;
let saveTimer = null;

function slim(track) {
  return {
    id: track.id,
    title: track.title,
    artistId: track.artistId,
    albumId: track.albumId,
    dur: track.dur,
    videoId: track.videoId,
    thumb: track.thumb,
    artistName: (ARTISTS[track.artistId] || {}).name || '',
    albumName: (ALBUMS[track.albumId] || {}).name || '',
  };
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 250);
}

export function saveTracksNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  save();
}

function save() {
  try {
    const list = Object.values(remoteById).slice(-MAX_STORED).map(slim);
    store(TRACKS_KEY, list);
  } catch {}
}

function restore() {
  const list = load(TRACKS_KEY, []);
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (!item || !item.videoId || !VIDEO_ID.test(String(item.videoId))) continue;
    const rawId = String(item.videoId);
    const key = `v:${rawId}`;
    if (remoteById[key]) continue;
    const channelId = String(item.artistId || '').replace(/^c:/, '');
    const artistId = ensureRemoteArtist(channelId, item.artistName);
    const albumId = item.albumId || `al:${channelId || 'none'}`;
    if (!ALBUMS[albumId]) {
      ALBUMS[albumId] = {
        id: albumId,
        name: item.albumName || (ARTISTS[artistId] || {}).name || 'Album',
        artistId,
        year: new Date().getFullYear(),
        remote: true,
      };
    }
    remoteById[key] = {
      id: key,
      title: item.title || 'Untitled',
      artistId,
      albumId,
      dur: item.dur || '',
      src: null,
      videoId: rawId,
      thumb: item.thumb || null,
      remote: true,
    };
  }
}

restore();

export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
export const playlistUrl = (playlistId) => `https://www.youtube.com/playlist?list=${playlistId}`;
export const gradFor = (seed) => `g${hashStr(seed) % 8}`;
