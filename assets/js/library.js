// Local library state: likes, recents, follows, saved albums, playlists.

import { STORAGE } from './config.js';
import { load, store } from './util.js';
import { emit } from './events.js';

export const state = {
  liked: load(STORAGE.liked, []),
  recent: load(STORAGE.recent, []),
  followed: load(STORAGE.followed, []),
  savedAlbums: load(STORAGE.savedAlbums, []),
  playlists: load(STORAGE.playlists, []),
  offline: load(STORAGE.offline, false),
};

export function saveAll() {
  store(STORAGE.liked, state.liked);
  store(STORAGE.recent, state.recent);
  store(STORAGE.followed, state.followed);
  store(STORAGE.savedAlbums, state.savedAlbums);
  store(STORAGE.playlists, state.playlists);
  store(STORAGE.offline, state.offline);
}

const toggleIn = (list, value) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

export function toggleLiked(id) {
  state.liked = toggleIn(state.liked, id);
  saveAll();
  emit('library-changed', { kind: 'liked', id });
  return state.liked.includes(id);
}

export function toggleFollowed(id) {
  state.followed = toggleIn(state.followed, id);
  saveAll();
  emit('library-changed', { kind: 'followed', id });
  return state.followed.includes(id);
}

export function toggleSavedAlbum(id) {
  state.savedAlbums = toggleIn(state.savedAlbums, id);
  saveAll();
  emit('library-changed', { kind: 'album', id });
  return state.savedAlbums.includes(id);
}

export function pushRecent(id, limit = 10) {
  state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, limit);
  saveAll();
}

export function setOffline(flag) {
  state.offline = !!flag;
  saveAll();
  emit('library-changed', { kind: 'offline', flag });
  return state.offline;
}

export function createPlaylist(name, ids = []) {
  const playlist = { id: `u_${Date.now()}`, name, desc: 'Made by you', ids };
  state.playlists.push(playlist);
  saveAll();
  emit('library-changed', { kind: 'playlist', id: playlist.id });
  return playlist;
}

export function findPlaylist(id) {
  return state.playlists.find((p) => p.id === id) || null;
}

export function renamePlaylist(id, name) {
  const playlist = findPlaylist(id);
  if (!playlist) return null;
  playlist.name = name;
  saveAll();
  emit('library-changed', { kind: 'playlist', id });
  return playlist;
}

export function deletePlaylist(id) {
  state.playlists = state.playlists.filter((p) => p.id !== id);
  saveAll();
  emit('library-changed', { kind: 'playlist', id });
}

export function togglePlaylistTrack(id, trackId) {
  const playlist = findPlaylist(id);
  if (!playlist) return false;
  playlist.ids = toggleIn(playlist.ids, trackId);
  saveAll();
  emit('library-changed', { kind: 'playlist', id });
  return playlist.ids.includes(trackId);
}

export function addToPlaylist(id, trackId) {
  const playlist = findPlaylist(id);
  if (!playlist) return false;
  if (playlist.ids.includes(trackId)) return false;
  playlist.ids.push(trackId);
  saveAll();
  emit('library-changed', { kind: 'playlist', id });
  return true;
}

export function removeFromPlaylist(id, trackId) {
  const playlist = findPlaylist(id);
  if (!playlist) return;
  playlist.ids = playlist.ids.filter((x) => x !== trackId);
  saveAll();
  emit('library-changed', { kind: 'playlist', id });
}

export function resetLibrary({ keepPlaylists = false } = {}) {
  state.liked = [];
  state.recent = [];
  state.followed = [];
  state.savedAlbums = [];
  state.offline = false;
  if (!keepPlaylists) state.playlists = [];
  saveAll();
  emit('library-changed', { kind: 'reset' });
}
