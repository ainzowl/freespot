// Shared markup: cover art, track rows, cards, and the icon refresh.
//
// Every render function returns an HTML string and is written by the caller, so
// views stay pure and there is exactly one place that knows how a track looks.
//
// Inline handlers must escape their arguments with `jsArg`: the JSON quotes would
// otherwise terminate the double-quoted attribute and leave a broken handler
// (`Unexpected end of input`), which is why download/queue buttons did nothing.

import { ARTISTS, ALBUMS, byId } from './catalog.js';
import { escapeHtml, jsArg } from './util.js';
import { get as artGet, applyAll } from './art.js';
import { player } from './player.js';

export function renderIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.7 } });
  applyAll(document);
}

export const artKeyForTrack = (track) => {
  if (!track) return 'misc:none';
  return track.videoId ? `v:${track.videoId}` : `t:${track.id}`;
};

export const artistArt = (artist) => `artist:${(artist && (artist.channelId || artist.id)) || 'unknown'}`;
export const albumArt = (album) => `album:${album && album.id ? album.id : 'unknown'}`;
export const playlistArt = (key) => `pl:${key}`;
export const genreArt = (tag) => `genre:${tag}`;

export function artImg(key, cls = '') {
  return `<img data-art="${escapeHtml(key)}" alt="" draggable="false"${cls ? ` class="${cls}"` : ''} />`;
}

function remoteImg(src, fallbackKey) {
  return `<img src="${escapeHtml(src)}" alt="" loading="lazy" draggable="false" onerror="this.onerror=null;this.src=window.__art('${escapeHtml(fallbackKey).replace(/'/g, '&#39;')}')" />`;
}

export function coverHtml(key, cls = '', style = '') {
  return `<div class="cover cover-ring ${cls}"${style ? ` style="${style}"` : ''}>${artImg(key)}</div>`;
}

export function coverForTrack(track, cls = '', style = '') {
  const key = artKeyForTrack(track);
  const inner = track && track.thumb ? remoteImg(track.thumb, key) : artImg(key);
  return `<div class="cover ${cls}"${style ? ` style="${style}"` : ''}>${inner}</div>`;
}

export const artistName = (track) => (ARTISTS[track.artistId] || {}).name || '';
export const albumName = (track) => (ALBUMS[track.albumId] || {}).name || '';

export function trackRow(track, index, opts = {}) {
  const ctx = opts.ctx ? `, ${jsArg(opts.ctx)}` : '';
  const arg = jsArg(track.id);
  const play = opts.play || `__playTrack(${arg})`;
  const live = player.current && player.current.id === track.id;
  const pending = track.pending ? ' pending' : '';

  const dlButton = opts.showDl
    ? `<button data-dl-id="${escapeHtml(track.id)}" onclick="event.stopPropagation();__toggleDownload(${arg})" class="icon-ghost" aria-label="Download"><i data-lucide="download"></i></button>`
    : '';
  const removeButton = opts.ctx
    ? `<button onclick="event.stopPropagation();__removeFromPlaylist(${jsArg(opts.ctx)},${arg})" class="icon-ghost" aria-label="Remove"><i data-lucide="x"></i></button>`
    : '';

  return `
  <div class="track-row${live ? ' playing' : ''}${pending}" onclick="${play}">
    ${opts.rank ? `<span class="track-rank">${opts.rank}</span>` : ''}
    ${coverForTrack(track, 'track-art')}
    <div class="track-meta">
      <p class="track-title">${escapeHtml(track.title)}</p>
      <p class="track-sub">${escapeHtml(artistName(track))}${opts.sub ? ' · ' + escapeHtml(opts.sub) : ''}</p>
    </div>
    ${removeButton}
    ${dlButton}
    <button onclick="event.stopPropagation();__trackMenu(${arg}${ctx})" class="icon-ghost" aria-label="More"><i data-lucide="more-horizontal"></i></button>
  </div>`;
}

export function albumCard(albumId) {
  const album = ALBUMS[albumId];
  if (!album) return '';
  return `
  <button onclick="__openAlbum(${jsArg(albumId)})" class="art-card btn-press">
    ${coverHtml(albumArt(album))}
    <p class="card-title">${escapeHtml(album.name)}</p>
    <p class="card-sub">${escapeHtml((ARTISTS[album.artistId] || {}).name || '')}</p>
  </button>`;
}

export function artistCard(artistId) {
  const artist = ARTISTS[artistId];
  if (!artist) return '';
  return `
  <button onclick="__openArtist(${jsArg(artistId)})" class="art-card artist-card btn-press">
    ${coverHtml(artistArt(artist))}
    <p class="card-title">${escapeHtml(artist.name)}</p>
    <p class="card-sub">${escapeHtml(artist.genre || 'artist')}</p>
  </button>`;
}

export const sectionHeading = (title) => `<p class="list-group-title" style="margin:20px 0 6px">${escapeHtml(title)}</p>`;

export function emptyState({ icon = 'music-2', title, sub }) {
  return `<div class="empty">
    <div class="empty-art"><i data-lucide="${icon}"></i></div>
    <p class="empty-title">${escapeHtml(title)}</p>
    <p class="empty-sub">${escapeHtml(sub)}</p>
  </div>`;
}

// Expose art to inline error handlers without leaking the whole module.
if (typeof window !== 'undefined') window.__art = artGet;
