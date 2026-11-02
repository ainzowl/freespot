// Library tab: playlists, songs, artists, downloads.

import { byId, ARTISTS, ALBUMS, tracksOfArtist, tracksOfAlbum, ensureTrack, hydrateTracks } from '../catalog.js';
import { state, findPlaylist } from '../library.js';
import { $, $$, escapeHtml, jsArg } from '../util.js';
import {
  trackRow, coverHtml, coverForTrack, artistArt, playlistArt,
  renderIcons, emptyState,
} from '../ui.js';
import {
  jobOf, jobPercent, jobLabel, isDownloaded, onDownloadChange, cancelQueued,
} from '../media.js';

const SUBS = {
  playlists: 'Your sets',
  songs: 'Everything you have played',
  artists: 'Follow the ones you keep replaying',
  albums: 'Records you saved',
  downloads: 'On this device, no signal needed',
};

export const libraryState = { tab: 'playlists' };
export let downloadedTracks = [];

function isBusy(track) {
  const job = jobOf(track.id);
  return !!job && (job.state === 'downloading' || job.state === 'queued');
}

function libraryTracks() {
  const seen = new Set();
  const out = [];
  const push = (id) => {
    const track = ensureTrack(id);
    if (track && track.videoId && !seen.has(track.id)) {
      seen.add(track.id);
      out.push(track);
    }
  };
  for (const id of state.recent) push(id);
  for (const id of state.liked) push(id);
  for (const playlist of state.playlists) for (const id of playlist.ids) push(id);
  return out;
}

export function libraryQueue() {
  return libraryTracks().map((t) => t.id);
}

export function playlistsView() {
  let html = `
    <button class="list-row" onclick="__openPlaylist('liked')">
      ${coverHtml('liked', 'list-art')}
      <div class="list-meta">
        <p class="list-title">Liked Songs</p>
        <p class="list-sub">${state.liked.length} song${state.liked.length === 1 ? '' : 's'}</p>
      </div>
      <i data-lucide="chevron-right" style="width:15px;height:15px;color:var(--faint)"></i>
    </button>`;

  html += `<p class="list-group-title">Your playlists</p>`;

  if (!state.playlists.length) {
    html += '<p class="list-note">No playlists yet. Use + to create one.</p>';
  } else {
    html += state.playlists.map((playlist) => `
      <div class="list-row" onclick="__openPlaylist('${playlist.id}')">
        ${coverHtml(playlistArt(playlist.id), 'list-art')}
        <div class="list-meta">
          <p class="list-title">${escapeHtml(playlist.name)}</p>
          <p class="list-sub">${playlist.ids.length} song${playlist.ids.length === 1 ? '' : 's'}</p>
        </div>
        <button class="icon-ghost" onclick="event.stopPropagation();__playlistMenu('${playlist.id}')" aria-label="More"><i data-lucide="more-horizontal"></i></button>
      </div>`).join('');
  }
  return html;
}

export function songsView() {
  const tracks = libraryTracks();
  if (!tracks.length) {
    return emptyState({
      icon: 'music-2',
      title: 'Nothing played yet',
      sub: 'Search for a song and play it — it shows up here.',
    });
  }
  hydrateTracks(tracks.map((t) => t.id)).catch(() => {});
  return `<div class="track-list">${tracks.map((track, i) => trackRow(track, i, { showDl: true, play: `__playLibraryAt(${i})` })).join('')}</div>`;
}

export function artistsView() {
  // Only artists the user actually touched: followed ones, or ones with a track
  // in the library. Listing every artist that ever appeared in trending turned
  // this tab into noise.
  const known = new Set();
  for (const id of [...state.recent, ...state.liked]) {
    const track = byId[id];
    if (track && track.artistId) known.add(track.artistId);
  }
  for (const playlist of state.playlists) {
    for (const id of playlist.ids) {
      const track = byId[id];
      if (track && track.artistId) known.add(track.artistId);
    }
  }
  for (const id of state.followed) known.add(id);

  const all = Array.from(known)
    .map((id) => ARTISTS[id])
    .filter((artist) => artist && artist.channelId);

  if (!all.length) {
    return emptyState({
      icon: 'mic-2',
      title: 'No artists yet',
      sub: 'Play a song or follow an artist and they show up here.',
    });
  }

  const followed = all.filter((a) => state.followed.includes(a.id));
  const rest = all.filter((a) => !state.followed.includes(a.id));
  let html = '';

  const row = (artist) => {
    const count = tracksOfArtist(artist.id).length;
    return `
    <button class="list-row" onclick="__openArtist(${jsArg(artist.id)})">
      ${coverHtml(artistArt(artist), 'list-art', 'border-radius:50%')}
      <div class="list-meta">
        <p class="list-title">${escapeHtml(artist.name)}</p>
        <p class="list-sub">${count} song${count === 1 ? '' : 's'}</p>
      </div>
      ${state.followed.includes(artist.id) ? '<i data-lucide="check" style="width:14px;height:14px;color:var(--copper)"></i>' : ''}
      <i data-lucide="chevron-right" style="width:15px;height:15px;color:var(--faint)"></i>
    </button>`;
  };

  if (followed.length) {
    html += `<p class="list-group-title" style="margin-top:2px">Following · ${followed.length}</p>`;
    html += followed.map(row).join('');
  }
  if (rest.length) {
    html += `<p class="list-group-title">In your library</p>`;
    html += rest.map(row).join('');
  }
  return html;
}

export function albumsView() {
  // Same rule as artists: an album earns a row by having a track in the library
  // or by being explicitly saved, not by appearing in a trending response.
  const known = new Set();
  for (const id of [...state.recent, ...state.liked]) {
    const track = byId[id];
    if (track && track.albumId) known.add(track.albumId);
  }
  for (const playlist of state.playlists) {
    for (const id of playlist.ids) {
      const track = byId[id];
      if (track && track.albumId) known.add(track.albumId);
    }
  }
  for (const id of state.savedAlbums) known.add(id);

  const albums = Array.from(known)
    .map((id) => ALBUMS[id])
    .filter((album) => album && album.artistId);
  const saved = albums.filter((album) => state.savedAlbums.includes(album.id));

  if (!albums.length) {
    return emptyState({
      icon: 'disc-3',
      title: 'No albums yet',
      sub: 'Play a song and its album shows up here.',
    });
  }

  const row = (album) => `
    <button class="list-row" onclick="__openPlaylist(${jsArg(album.id)})">
      ${coverHtml(`album:${album.id}`, 'list-art')}
      <div class="list-meta">
        <p class="list-title">${escapeHtml(album.name)}</p>
        <p class="list-sub">${escapeHtml((ARTISTS[album.artistId] || {}).name || '')} · ${tracksOfAlbum(album.id).length} songs</p>
      </div>
      ${state.savedAlbums.includes(album.id) ? '<i data-lucide="check" style="width:14px;height:14px;color:var(--copper)"></i>' : ''}
      <i data-lucide="chevron-right" style="width:15px;height:15px;color:var(--faint)"></i>
    </button>`;

  let html = '';
  if (saved.length) {
    html += `<p class="list-group-title" style="margin-top:2px">Saved · ${saved.length}</p>`;
    html += saved.map(row).join('');
  }
  const rest = albums.filter((album) => !state.savedAlbums.includes(album.id));
  if (rest.length) {
    html += `<p class="list-group-title">In your library</p>`;
    html += rest.map(row).join('');
  }
  return html;
}

export function downloadsView() {
  const running = Object.values(byId).filter((t) => t && t.videoId && isBusy(t));
  const failed = Object.values(byId).filter((t) => t && t.videoId && jobOf(t.id) && jobOf(t.id).state === 'error');

  let html = '';

  if (running.length) {
    html += `<div class="dl-head">
      <p class="list-group-title" style="margin:0">Downloading · ${running.length}</p>
      <button class="section-link" onclick="__cancelDownloads()">Cancel</button>
    </div>`;
    html += running.map(downloadRow).join('');
  }

  if (failed.length) {
    html += `<p class="list-group-title">Failed · ${failed.length}</p>`;
    html += failed.map((track) => `
      <div class="dl-row">
        ${coverForTrack(track, 'track-art')}
        <div class="track-meta">
          <p class="track-title">${escapeHtml(track.title)}</p>
          <p class="track-sub" style="color:#e08b7f">${escapeHtml(jobLabel(track.id))}</p>
        </div>
        <button class="icon-ghost text-copper" onclick="__toggleDownload(${jsArg(track.id)})" aria-label="Retry"><i data-lucide="rotate-cw"></i></button>
      </div>`).join('');
  }

  if (downloadedTracks.length) {
    html += `<p class="list-group-title">On this device · ${downloadedTracks.length}</p>`;
    html += `<div class="track-list">${downloadedTracks.map((track, i) => trackRow(track, i, { showDl: true, play: `__playDownloadedAt(${i})` })).join('')}</div>`;
  }

  if (!running.length && !failed.length && !downloadedTracks.length) {
    html = emptyState({
      icon: 'download',
      title: 'Nothing downloaded',
      sub: 'Playback streams from YouTube for free. Download only if you want it offline.',
    });
  }

  return html;
}

export async function refreshDownloads() {
  const candidates = Object.values(byId).filter((t) => t && t.videoId);
  const list = [];
  for (const track of candidates) {
    if (await isDownloaded(track.id)) list.push(track);
  }
  downloadedTracks = list;
  return list;
}

function downloadRow(track) {
  const pct = jobPercent(track.id);
  return `
  <div class="dl-row" data-dl-row="${escapeHtml(track.id)}">
    ${coverForTrack(track, 'track-art')}
    <div class="track-meta">
      <p class="track-title">${escapeHtml(track.title)}</p>
      <p class="track-sub">${escapeHtml(jobLabel(track.id))}</p>
      <div class="dl-track"><div class="dl-fill" style="width:${pct}%"></div></div>
    </div>
    <span class="dl-pct">${pct}%</span>
  </div>`;
}

export function paintDownloadProgress() {
  $$('[data-dl-row]').forEach((row) => {
    const id = row.dataset.dlRow;
    const pct = jobPercent(id);
    const fill = row.querySelector('.dl-fill');
    if (fill) fill.style.width = `${pct}%`;
    const label = row.querySelector('.dl-pct');
    if (label) label.textContent = `${pct}%`;
    const sub = row.querySelector('.track-sub');
    if (sub) sub.textContent = jobLabel(id);
  });
}

const VIEWS = {
  playlists: playlistsView,
  songs: songsView,
  artists: artistsView,
  albums: albumsView,
  downloads: downloadsView,
};

export async function openLibraryTab(tab) {
  libraryState.tab = tab;
  $$('.chip[data-lib]').forEach((chip) => chip.classList.toggle('active', chip.dataset.lib === tab));

  const sub = $('#library-sub');
  if (sub) sub.textContent = SUBS[tab] || '';

  const content = $('#lib-content');
  if (!content) return;

  if (tab === 'downloads') {
    await refreshDownloads();
    content.innerHTML = downloadsView();
  } else {
    content.innerHTML = (VIEWS[tab] || playlistsView)();
  }
  renderIcons();

  const { refreshDownloadIcons } = await import('../downloads.js');
  await refreshDownloadIcons();
}

let rebuildQueued = false;
onDownloadChange((kind) => {
  if (libraryState.tab !== 'downloads') return;
  const view = $('#view-library');
  if (!view || view.classList.contains('hidden')) return;

  paintDownloadProgress();

  // Only a state change can add or remove a row; progress just moves the bar.
  if (kind === 'progress') return;

  const rendered = $$('[data-dl-row]').length;
  const running = Object.values(byId).filter((t) => t && t.videoId && isBusy(t)).length;
  if (rendered === running || rebuildQueued) return;

  rebuildQueued = true;
  setTimeout(async () => {
    rebuildQueued = false;
    if (libraryState.tab !== 'downloads') return;
    await refreshDownloads();
    const content = $('#lib-content');
    if (content) {
      content.innerHTML = downloadsView();
      renderIcons();
      // The rebuild throws away the previous buttons, so the freshly rendered
      // ones are still showing the default download icon. Re-sync them or a
      // completed track keeps offering "Download".
      const { refreshDownloadIcons } = await import('../downloads.js');
      refreshDownloadIcons();
    }
  }, 220);
});

export { cancelQueued };
