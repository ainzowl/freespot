// Detail layer: artist and playlist pages.
//
// Tracks are YouTube videos, so there are no separate album pages; an artist's
// page is their uploads and a playlist page is a YouTube playlist.

import {
  ARTISTS, byId, registerVideo, ensureRemoteArtist, remotePlaylists, tracksOfArtist,
  ensureTrack, hydrateTracks,
} from '../catalog.js';
import { state, findPlaylist } from '../library.js';
import { escapeHtml, $, jsArg, jsArrayArg } from '../util.js';
import {
  trackRow, coverHtml, artistArt, playlistArt, artImg, renderIcons, emptyState,
} from '../ui.js';
import { channel as fetchChannel, playlist as fetchPlaylist } from '../sources.js';
import * as Router from '../router.js';
import { toast } from '../overlays.js';

export const channelTracks = {};

/**
 * Fill in any ids the registry has not seen, then repaint once.
 *
 * The repaint must only happen when hydration actually changed something:
 * repainting unconditionally re-entered this function (render → hydrate → show →
 * render) and locked the page in an endless loop the moment a track was unknown.
 */
const hydrateDetail = (ids) => {
  if (!ids || !ids.length) return;
  const missing = ids.filter((id) => {
    const track = byId[id];
    return !track || track.pending;
  });
  if (!missing.length) return;

  hydrateTracks(missing).then((changed) => {
    if (changed && Router.stack.length) Router.show();
  }).catch(() => {});
};

export function resolvePlaylist(key) {
  if (remotePlaylists[key]) return remotePlaylists[key];

  if (key === 'liked') {
    return { name: 'Liked Songs', desc: 'Songs you loved', ids: state.liked.slice(), user: false, icon: 'heart' };
  }

  const user = findPlaylist(key);
  if (user) return { ...user, key, user: true };

  return null;
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

export function openArtist(artistId) {
  const channelId = String(artistId).startsWith('c:') ? artistId.slice(2) : artistId;
  const known = ARTISTS[artistId] || {};

  if (!channelId || channelId === 'none') {
    toast('Artist not loaded yet', 'alert-circle');
    return;
  }

  Router.push(known.name || 'Artist', () => `
    <div class="page-center">
      ${coverHtml(`artist:${channelId}`, 'detail-art round', 'width:112px;height:112px')}
      <p class="detail-eyebrow" style="margin-top:18px">Artist</p>
      <h1 class="detail-title">${escapeHtml(known.name || 'Artist')}</h1>
      <p class="detail-sub">Loading…</p>
    </div>`);

  fetchChannel(channelId, known.name).then((data) => {
    const info = data.channel || {};
    ensureRemoteArtist(channelId, info.name);
    const videos = (data.videos || []).map(registerVideo).filter(Boolean);
    channelTracks[`c:${channelId}`] = videos.map((track) => track.id);
    const artist = ARTISTS[`c:${channelId}`] || known;
    $('#detail-title').textContent = info.name || 'Artist';
    $('#detail-content').innerHTML = channelBody(channelId, info, videos, artist);
    renderIcons();
  }).catch((err) => {
    toast(err.message || 'Could not load artist', 'alert-circle');
    $('#detail-content').innerHTML = emptyState({
      icon: 'alert-circle',
      title: 'Could not load this artist',
      sub: err.message || 'Try again in a moment.',
    });
    renderIcons();
  });
}

function channelBody(channelId, info, videos, artist) {
  const followed = state.followed.includes(`c:${channelId}`);
  const art = info.thumb
    ? `<img src="${escapeHtml(info.thumb)}" alt="" draggable="false" />`
    : artImg(`artist:${channelId}`);

  return `
    <div class="page-center">
      <div class="cover cover-ring detail-art round" style="width:112px;height:112px">${art}</div>
      <p class="detail-eyebrow" style="margin-top:18px">Artist</p>
      <h1 class="detail-title">${escapeHtml(info.name || artist.name || 'Artist')}</h1>
      <p class="detail-sub">${escapeHtml(info.subscriberCount || '')}</p>
      <div class="detail-actions" style="justify-content:center">
        <button onclick="__playChannel('${channelId}')" class="btn-copper btn-press"><i data-lucide="play" style="fill:currentColor"></i> Play</button>
        <button onclick="__playChannel('${channelId}', true)" class="btn-ghost btn-press"><i data-lucide="shuffle"></i> Shuffle</button>
        <button onclick="__toggleFollow('c:${channelId}')" class="round-btn btn-press ${followed ? 'on' : ''}" aria-label="Follow"><i data-lucide="${followed ? 'check' : 'user-plus'}"></i></button>
      </div>
    </div>
    ${info.description ? `<p class="detail-about">${escapeHtml(String(info.description).slice(0, 400))}</p>` : ''}
    <h2 class="detail-section-title">Songs</h2>
    ${videos.length
      ? `<div class="track-list">${videos.map((track, i) => trackRow(track, i, { rank: i + 1, play: `__playChannelAt('${channelId}',${i})` })).join('')}</div>`
      : emptyState({ icon: 'music-2', title: 'No songs found', sub: 'This artist has no public uploads in the music category.' })}`;
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export function playlistBody(playlist, key) {
  const remote = !!playlist.remote;

  // Ids are the source of truth, so build rows from them rather than skipping
  // anything the registry has not seen yet.
  const tracks = (playlist.ids || []).map((id) => ensureTrack(id)).filter(Boolean);
  hydrateDetail(playlist.ids);

  const rows = tracks.length
    ? tracks.map((track, i) => trackRow(track, i, {
      rank: i + 1,
      ctx: playlist.user && !remote ? key : null,
      showDl: true,
      play: `__playPlaylistAt('${key}',${i})`,
    })).join('')
    : emptyState({
      icon: 'list-music',
      title: playlist.ids.length ? 'Songs are loading' : 'Empty playlist',
      sub: playlist.ids.length ? 'Fetching the track list…' : 'Add songs from any track menu.',
    });

  const count = (playlist.ids || []).length;
  const minutes = tracks.reduce((sum, t) => sum + parseDuration(t.dur), 0);

  return `
    <div class="detail-hero" style="padding-top:22px">
      <div class="cover cover-ring detail-art" style="width:132px;height:132px">${artImg(playlistArt(key))}</div>
      <div style="min-width:0;padding-bottom:2px">
        <p class="detail-eyebrow">${playlist.user ? 'Your playlist' : 'Playlist'}</p>
        <h1 class="detail-title" style="font-size:28px">${escapeHtml(playlist.name)}</h1>
        <p class="detail-sub">${escapeHtml(playlist.desc || '')}</p>
        <p class="detail-sub" style="color:var(--faint)">${count} song${count === 1 ? '' : 's'}${minutes ? ` · ${Math.round(minutes / 60)} min` : ''}</p>
      </div>
    </div>
    <div class="detail-actions">
      <button onclick="__playPlaylist('${key}')" class="btn-copper btn-press"><i data-lucide="play" style="fill:currentColor"></i> Play</button>
      <button onclick="__playPlaylist('${key}', true)" class="round-btn btn-press" aria-label="Shuffle"><i data-lucide="shuffle"></i></button>
      ${count ? `<button onclick="__downloadIds(${jsArrayArg(playlist.ids)})" class="round-btn btn-press" aria-label="Download"><i data-lucide="download"></i></button>` : ''}
      ${playlist.user && !remote ? `<button onclick="__playlistMenu('${key}')" class="round-btn btn-press" style="margin-left:auto" aria-label="More"><i data-lucide="more-horizontal"></i></button>` : ''}
    </div>
    <div class="track-list" style="margin-top:20px">${rows}</div>
    ${playlist.user && !remote ? `<button onclick="__openSongPicker('${key}')" class="btn-ghost btn-press" style="width:100%;margin-top:16px;justify-content:center"><i data-lucide="plus"></i> Add songs</button>` : ''}`;
}

function parseDuration(text) {
  const parts = String(text || '').split(':').map(Number);
  if (parts.some((n) => !isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

export function openPlaylist(key) {
  if (String(key).startsWith('pl:')) return openRemotePlaylist(key);
  const playlist = resolvePlaylist(key);
  if (!playlist) return;
  Router.push(playlist.name, () => playlistBody(playlist, key));
}

function openRemotePlaylist(key) {
  const cached = remotePlaylists[key];
  if (cached && cached.ids.length) {
    Router.push(cached.name, () => playlistBody(cached, key));
    return;
  }

  const playlistId = key.slice(3);
  Router.push('Playlist', () => '<p class="detail-note">Loading playlist…</p>');

  fetchPlaylist(playlistId).then((data) => {
    const videos = (data.videos || []).map(registerVideo).filter(Boolean);
    const playlist = remotePlaylists[key] || {
      key,
      name: (data.playlist && data.playlist.title) || 'Playlist',
      desc: (data.playlist && data.playlist.author) || '',
      ids: videos.map((track) => track.id),
      remote: true,
    };
    remotePlaylists[key] = playlist;
    $('#detail-title').textContent = playlist.name;
    $('#detail-content').innerHTML = playlistBody(playlist, key);
    renderIcons();
  }).catch((err) => {
    toast(err.message || 'Could not load playlist', 'alert-circle');
    $('#detail-content').innerHTML = emptyState({
      icon: 'alert-circle',
      title: 'Could not load this playlist',
      sub: err.message || 'Try again in a moment.',
    });
    renderIcons();
  });
}

export { Router };
