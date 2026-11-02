// Actions: the command surface used by rendered HTML.
//
// Every function here is a thin wrapper over a module that owns the behaviour.

import { byId, ARTISTS, tracksOfArtist, ensureTrack, watchUrl } from './catalog.js';
import {
  state, toggleLiked, toggleFollowed, toggleSavedAlbum, createPlaylist,
  addToPlaylist, removeFromPlaylist, renamePlaylist, deletePlaylist,
  togglePlaylistTrack, findPlaylist,
} from './library.js';
import { player } from './player.js';
import { toast, openSheet, closeSheet, openModal } from './overlays.js';
import { goTab } from './shell.js';
import { escapeHtml, jsArg, jsArrayArg } from './util.js';
import { emit } from './events.js';
import { coverForTrack, renderIcons, artistName } from './ui.js';
import { resolvePlaylist, channelTracks, openPlaylist } from './views/detail.js';
import { getTopIds } from './views/home.js';
import { searchResults } from './views/search.js';
import { isDownloaded, jobOf } from './media.js';
import { toggleDownload, downloadIds, downloadTracks, downloadAll, cancelDownloads } from './downloads.js';
import { lyricsFor, detailsFor } from './lyrics.js';
import * as Router from './router.js';

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export function playTrack(id) {
  const source = player.queue.length ? player.source : 'Queue';
  player.playTrack(id, source, player.queue.length ? null : [id]);
}

export function playAt(index) {
  const track = player.queue[index];
  if (!track) return;
  player.index = index;
  player.playTrack(track.id);
}

function playQueue(ids, source, shuffle = false) {
  if (!ids.length) {
    toast('Nothing to play here', 'list-music');
    return;
  }
  if (shuffle) player.shuffle = true;
  player.setQueue(ids, source);
  player.playTrack(ids[0], source);
  emit('mode-changed');
}

export function playPlaylist(key, shuffle) {
  const playlist = resolvePlaylist(key);
  if (!playlist || !playlist.ids.length) {
    toast('That playlist is empty', 'list-music');
    return;
  }
  playQueue(playlist.ids, playlist.name, shuffle);
}

export function playLiked() {
  if (!state.liked.length) {
    toast('No liked songs yet', 'heart');
    return;
  }
  playQueue(state.liked.slice(), 'Liked Songs');
}

export function playShuffle() {
  const ids = state.recent.filter((id) => byId[id]).map(String);
  const pool = ids.length ? ids : Object.values(byId).filter((t) => t && t.videoId).map((t) => t.id);
  if (!pool.length) {
    toast('Play something first', 'music-2');
    return;
  }
  player.shuffle = true;
  player.setQueue(pool, 'Shuffle');
  player.playTrack(pool[Math.floor(Math.random() * pool.length)], 'Shuffle');
  emit('mode-changed');
}

export function playArtist(artistId, shuffle) {
  const ids = tracksOfArtist(artistId).map((t) => t.id);
  if (!ids.length) {
    toast('No songs for this artist yet', 'alert-circle');
    return;
  }
  playQueue(ids, (ARTISTS[artistId] || {}).name || 'Artist', shuffle);
}

export function playArtistAt(artistId, index) {
  const ids = tracksOfArtist(artistId).map((t) => t.id);
  if (!ids[index]) return;
  player.setQueue(ids, (ARTISTS[artistId] || {}).name || 'Artist');
  player.playTrack(ids[index]);
}

export function playAlbum(albumId, shuffle) {
  const playlist = resolvePlaylist(albumId);
  if (!playlist) return;
  playQueue(playlist.ids, playlist.name, shuffle);
}

export function playAlbumAt(albumId, index) {
  const playlist = resolvePlaylist(albumId);
  if (!playlist || !playlist.ids[index]) return;
  player.setQueue(playlist.ids, playlist.name);
  player.playTrack(playlist.ids[index]);
}

export function playPlaylistAt(key, index) {
  const playlist = resolvePlaylist(key);
  if (!playlist || !playlist.ids[index]) return;
  player.setQueue(playlist.ids, playlist.name);
  player.playTrack(playlist.ids[index]);
}

export function playTopAt(index) {
  const ids = getTopIds();
  if (!ids[index]) return;
  player.setQueue(ids, 'Trending');
  player.playTrack(ids[index], 'Trending');
}

export function playSearchAt(index) {
  const track = searchResults[index];
  if (!track) return;
  player.setQueue(searchResults.map((t) => t.id), 'Search');
  player.playTrack(track.id, 'Search');
}

export function playSongsAt(index) {
  const pool = Object.values(byId).filter((t) => t && t.videoId).map((t) => t.id);
  if (!pool[index]) return;
  player.setQueue(pool, 'Library');
  player.playTrack(pool[index], 'Library');
}

export async function playLibraryAt(index) {
  const { libraryQueue } = await import('./views/library.js');
  const ids = libraryQueue();
  if (!ids[index]) return;
  player.setQueue(ids, 'Library');
  player.playTrack(ids[index], 'Library');
}

export async function playDownloadedAt(index) {
  const { downloadedTracks } = await import('./views/library.js');
  const ids = downloadedTracks.map((t) => t.id);
  if (!ids[index]) return;
  player.setQueue(ids, 'Downloads');
  player.playTrack(ids[index], 'Downloads');
}

export function playChannel(channelId, shuffle) {
  const key = `c:${channelId}`;
  const ids = channelTracks[key] || [];
  if (!ids.length) {
    toast('No songs loaded for this artist', 'alert-circle');
    return;
  }
  playQueue(ids, (ARTISTS[key] || {}).name || 'Artist', shuffle);
}

export function playChannelAt(channelId, index) {
  const key = `c:${channelId}`;
  const ids = channelTracks[key] || [];
  if (!ids[index]) return;
  player.setQueue(ids, (ARTISTS[key] || {}).name || 'Artist');
  player.playTrack(ids[index]);
}

export const togglePlay = () => player.toggle();
export const nextTrack = () => player.next();
export const prevTrack = () => player.prev();

export function toggleShuffle() {
  player.shuffle = !player.shuffle;
  player.reorderForShuffle();
  const on = player.shuffle;
  toast(on ? 'Shuffle on' : 'Shuffle off', 'shuffle');
  emit('mode-changed');
  return on;
}

/**
 * Repeat cycles: off → all → one → off.
 *
 * "All" loops the queue; "one" replays the current song. Both are visible in the
 * icon and in the button state, which is what the old build never updated.
 */
export function toggleRepeat() {
  player.repeat = player.repeat === 'off' ? 'all' : player.repeat === 'one' ? 'off' : 'one';
  const label = player.repeat === 'off' ? 'Repeat off' : player.repeat === 'one' ? 'Repeat this song' : 'Repeat playlist';
  toast(label, player.repeat === 'one' ? 'repeat-1' : 'repeat');
  emit('mode-changed');
  return player.repeat;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function toggleLike() {
  if (!player.current) return;
  const liked = toggleLiked(player.current.id);
  player.syncLikeIcon();
  toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs', 'heart');
  refresh();
}

export function toggleLikeById(id) {
  const liked = toggleLiked(id);
  toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs', 'heart');
  if (player.current && player.current.id === id) player.syncLikeIcon();
  refresh();
}

export function toggleFollow(artistId) {
  const followed = toggleFollowed(artistId);
  toast(followed ? `Following ${(ARTISTS[artistId] || {}).name || ''}` : 'Unfollowed', 'user-plus');
  refresh();
}

export function toggleSaveAlbum(albumId) {
  const saved = toggleSavedAlbum(albumId);
  toast(saved ? 'Added to library' : 'Removed from library');
  refresh();
}

export function offlineToggle() {
  import('./library.js').then(({ setOffline }) => {
    const value = setOffline(!state.offline);
    toast(value ? 'Offline mode on' : 'Offline mode off', 'wifi-off');
    import('./device.js').then((d) => d.refreshStats());
  });
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export function newPlaylist(name) {
  const clean = String(name || '').trim();
  if (!clean) return;
  const playlist = createPlaylist(clean);
  closeSheet();
  refresh();
  toast(`Created “${clean}”`, 'list-music');
  openPlaylist(playlist.id);
}

export function addTrackToPlaylist(playlistKey, trackId) {
  if (playlistKey === 'liked') {
    toggleLikeById(trackId);
    closeSheet();
    return;
  }
  const playlist = findPlaylist(playlistKey);
  if (!playlist) {
    toast('That playlist no longer exists', 'alert-circle');
    closeSheet();
    return;
  }
  if (playlist.ids.includes(trackId)) {
    removeFromPlaylist(playlistKey, trackId);
    toast(`Removed from ${playlist.name}`, 'x');
  } else {
    addToPlaylist(playlistKey, trackId);
    toast(`Added to ${playlist.name}`, 'check');
  }
  closeSheet();
  refresh();
}

export function removeTrackFromPlaylist(playlistKey, trackId) {
  const playlist = findPlaylist(playlistKey);
  if (!playlist) return;
  removeFromPlaylist(playlistKey, trackId);
  toast(`Removed from ${playlist.name}`);
  refresh();
}

export function toggleTrackInPlaylist(playlistKey, trackId) {
  const added = togglePlaylistTrack(playlistKey, trackId);
  refresh();
  const track = ensureTrack(trackId);
  toast(added ? `Added “${(track || {}).title || ''}”` : 'Removed', added ? 'check' : 'x');
  openSongPicker(playlistKey);
}

export function renamePlaylistTo(playlistKey, name) {
  renamePlaylist(playlistKey, name);
  refresh();
  toast('Playlist renamed');
}

export function deletePlaylistById(playlistKey) {
  deletePlaylist(playlistKey);
  closeSheet();
  Router.pop();
  refresh();
  toast('Playlist deleted', 'trash-2');
}

export function renamePlaylistPrompt(playlistKey) {
  const playlist = findPlaylist(playlistKey);
  if (!playlist) return;
  openModal('Rename playlist', 'Name', playlist.name, (name) => renamePlaylistTo(playlistKey, name));
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export function trackMenu(id, ctx) {
  const track = ensureTrack(id);
  if (!track) return;
  const liked = state.liked.includes(id);
  const artist = ARTISTS[track.artistId] || {};
  const arg = jsArg(id);

  openSheet(track.title, () => `
    <button onclick="__playTrack(${arg});__closeSheet()" class="sheet-row"><i data-lucide="play"></i>Play now</button>
    <button onclick="__playNext(${arg});__closeSheet()" class="sheet-row"><i data-lucide="list-plus"></i>Play next</button>
    <button onclick="__addToQueue(${arg});__closeSheet()" class="sheet-row"><i data-lucide="list-music"></i>Add to queue</button>
    <button onclick="__addToPlaylistMenu(${arg})" class="sheet-row"><i data-lucide="folder-plus"></i>Add to playlist</button>
    ${ctx ? `<button onclick="__removeFromPlaylist('${escapeHtml(ctx)}',${arg})" class="sheet-row danger"><i data-lucide="x"></i>Remove from playlist</button>` : ''}
    <button onclick="__toggleDownload(${arg});__closeSheet()" class="sheet-row"><i data-lucide="download"></i>Download</button>
    <button onclick="__toggleLikeById(${arg});__closeSheet()" class="sheet-row"><i data-lucide="heart"${liked ? ' style="fill:var(--copper);color:var(--copper);opacity:1"' : ''}></i>${liked ? 'Unlike' : 'Like'}</button>
    <button onclick="__showLyrics(${arg})" class="sheet-row"><i data-lucide="scroll-text"></i>Lyrics</button>
    <button onclick="__showAbout(${arg})" class="sheet-row"><i data-lucide="info"></i>Description</button>
    ${track.artistId && track.artistId.startsWith('c:') ? `<button onclick="__openArtist(${jsArg(track.artistId)});__closeSheet()" class="sheet-row"><i data-lucide="mic-2"></i>View artist</button>` : ''}
    <button onclick="__shareTrack(${arg});__closeSheet()" class="sheet-row"><i data-lucide="share-2"></i>Share</button>
    <p class="sheet-note">${escapeHtml(artist.name || '')}${track.dur ? ` · ${escapeHtml(track.dur)}` : ''}</p>`);
}

export function addToPlaylistMenu(trackId) {
  const arg = jsArg(trackId);
  const track = ensureTrack(trackId) || {};
  openSheet('Add to playlist', () => {
    let rows = `<button onclick="__addTrackToPlaylist('liked',${arg})" class="sheet-row">
      <i data-lucide="heart" style="color:var(--copper)"></i>Liked Songs
      ${state.liked.includes(trackId) ? '<span class="sheet-added">Added</span>' : ''}
    </button>`;

    rows += state.playlists.map((playlist) => `
      <button onclick="__addTrackToPlaylist(${jsArg(playlist.id)},${arg})" class="sheet-row">
        <i data-lucide="list-music"></i>${escapeHtml(playlist.name)}
        ${playlist.ids.includes(trackId) ? '<span class="sheet-added">Added</span>' : ''}
      </button>`).join('');

    rows += `<button onclick="__closeSheet();__createPlaylistPrompt()" class="sheet-row"><i data-lucide="plus" style="color:var(--copper)"></i>New playlist</button>`;
    rows += `<p class="sheet-note">${escapeHtml(track.title || '')}</p>`;
    return rows;
  });
}

export function createPlaylistPrompt() {
  openModal('New playlist', 'Playlist name', '', (name) => newPlaylist(name));
}

export function playlistMenu(key) {
  const playlist = resolvePlaylist(key);
  if (!playlist) return;

  openSheet(playlist.name, () => {
    let rows = `<button onclick="__downloadIds(${jsArrayArg(playlist.ids)});__closeSheet()" class="sheet-row"><i data-lucide="download"></i>Download all</button>`;
    if (playlist.user) {
      rows += `<button onclick="__renamePlaylistPrompt('${escapeHtml(key)}')" class="sheet-row"><i data-lucide="pencil"></i>Rename</button>`;
      rows += `<button onclick="__openSongPicker('${escapeHtml(key)}')" class="sheet-row"><i data-lucide="plus"></i>Add songs</button>`;
      rows += `<button onclick="__deletePlaylist('${escapeHtml(key)}')" class="sheet-row danger"><i data-lucide="trash-2"></i>Delete playlist</button>`;
    }
    return rows;
  });
}

export function openSongPicker(key) {
  const playlist = findPlaylist(key);
  if (!playlist) return;

  const candidates = Object.values(byId).filter((t) => t && t.videoId);
  if (!candidates.length) {
    openSheet(`Add to ${playlist.name}`, () => '<p class="sheet-note">Play or search for songs first — anything you open shows up here.</p>');
    return;
  }

  openSheet(`Add to ${playlist.name}`, () => candidates.map((track) => {
    const inPlaylist = playlist.ids.includes(track.id);
    return `
    <button onclick="__togglePlaylistTrack(${jsArg(key)},${jsArg(track.id)})" class="sheet-row">
      ${coverForTrack(track, '', 'width:36px;height:36px;border-radius:9px')}
      <span class="sheet-row-text">${escapeHtml(track.title)}</span>
      <i data-lucide="${inPlaylist ? 'circle-check' : 'plus'}" style="color:${inPlaylist ? 'var(--copper)' : 'var(--faint)'};opacity:1"></i>
    </button>`;
  }).join(''));
}

export function sleepMenu() {
  openSheet('Sleep timer', () => [5, 10, 15, 30, 45, 60]
    .map((minutes) => `<button onclick="__chooseSleep(${minutes})" class="sheet-row"><i data-lucide="clock"></i>${minutes} minutes</button>`)
    .join('') + '<button onclick="__chooseSleep(0)" class="sheet-row danger"><i data-lucide="x"></i>Turn off</button>');
}

export function chooseSleep(minutes) {
  clearTimeout(player.sleepTimer);
  if (minutes) {
    player.sleepTimer = setTimeout(() => {
      player.pause();
      toast('Sleep timer ended', 'moon');
    }, minutes * 60000);
    closeSheet();
    toast(`Sleep timer: ${minutes} min`, 'moon');
    return;
  }
  closeSheet();
  toast('Sleep timer off', 'moon');
}

export function npMore() {
  if (!player.current) return;
  const track = player.current;
  const arg = jsArg(track.id);
  openSheet(track.title, () => `
    <button onclick="__addToPlaylistMenu(${arg})" class="sheet-row"><i data-lucide="folder-plus"></i>Add to playlist</button>
    <button onclick="__toggleDownload(${arg})" class="sheet-row"><i data-lucide="download"></i>Download</button>
    <button onclick="__showLyrics(${arg})" class="sheet-row"><i data-lucide="scroll-text"></i>Lyrics</button>
    <button onclick="__showAbout(${arg})" class="sheet-row"><i data-lucide="info"></i>Description</button>
    <button onclick="__shareCurrent();__closeSheet()" class="sheet-row"><i data-lucide="share-2"></i>Share</button>
    <button onclick="__sleepMenu()" class="sheet-row"><i data-lucide="moon"></i>Sleep timer</button>
    ${track.videoId ? `<button onclick="__openArtist(${jsArg(track.artistId)});__closeSheet()" class="sheet-row"><i data-lucide="mic-2"></i>View artist</button>` : ''}`);
}

// ---------------------------------------------------------------------------
// Lyrics and description
// ---------------------------------------------------------------------------

export function showLyrics(id) {
  const track = ensureTrack(id || (player.current && player.current.id));
  if (!track) return;

  stopLyricSync();

  openSheet('Lyrics', () => `
    <div id="lyrics-body" class="lyrics-body">
      <p class="detail-note">Looking up lyrics…</p>
    </div>
    <p class="sheet-note" id="lyrics-source"></p>`);

  lyricsFor(track).then((data) => {
    const body = document.getElementById('lyrics-body');
    if (!body) return;
    if (!data || (!data.plain && !data.lines.length)) {
      body.innerHTML = `<p class="detail-note">No lyrics found for “${escapeHtml(track.title)}”.</p>`;
      return;
    }
    if (data.lines.length) {
      body.innerHTML = data.lines.map((line) => `
        <p class="lyric-line" data-time="${line.time}">${escapeHtml(line.text)}</p>`).join('');
      startLyricSync(track, data.lines);
    } else {
      body.innerHTML = String(data.plain).split(/\n{2,}/).map((block) => `
        <p class="lyric-block">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('');
    }
    const source = document.getElementById('lyrics-source');
    if (source) source.textContent = `Lyrics · ${data.source}`;
  });

  renderIcons();
}

let lyricTimer = null;

function startLyricSync(track, lines) {
  stopLyricSync();
  const paint = () => {
    const body = document.getElementById('lyrics-body');
    if (!body) { stopLyricSync(); return; }
    if (!player.current || player.current.id !== track.id) { stopLyricSync(); return; }
    const time = player.time() || 0;
    let active = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= time + 0.15) active = i;
      else break;
    }
    const nodes = body.querySelectorAll('.lyric-line');
    nodes.forEach((node, i) => node.classList.toggle('active', i === active));
    const current = nodes[active];
    if (current && active > 0) {
      const box = body;
      const target = current.offsetTop - box.clientHeight / 2 + current.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  };
  lyricTimer = setInterval(paint, 400);
  paint();
}

export function stopLyricSync() {
  if (lyricTimer) clearInterval(lyricTimer);
  lyricTimer = null;
}

export function showAbout(id) {
  const track = ensureTrack(id || (player.current && player.current.id));
  if (!track) return;

  openSheet('About this song', () => `
    <div class="about-body">
      <div class="about-head">
        ${coverForTrack(track, 'about-art')}
        <div style="min-width:0">
          <p class="about-title">${escapeHtml(track.title)}</p>
          <p class="about-sub">${escapeHtml(artistName(track) || 'Unknown artist')}</p>
        </div>
      </div>
      <div id="about-desc"><p class="detail-note">Loading description…</p></div>
    </div>`);

  detailsFor(track).then(({ description }) => {
    const box = document.getElementById('about-desc');
    if (!box) return;
    if (!description) {
      box.innerHTML = `<p class="detail-note">No description for this track.</p>`;
      return;
    }
    const linked = String(description)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    box.innerHTML = `<p class="about-description">${linked.replace(/\n/g, '<br>')}</p>`;
  });

  renderIcons();
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

export async function shareTrack(trackOrId) {
  const track = typeof trackOrId === 'object' ? trackOrId : ensureTrack(trackOrId);
  if (!track) return;
  const text = `${track.title} — ${artistName(track)} on FreePot`;
  const url = track.videoId ? watchUrl(track.videoId) : location.href;

  if (navigator.share) {
    try {
      await navigator.share({ title: track.title, text, url });
      return;
    } catch {}
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(`${text} ${url}`).catch(() => {});
    toast('Copied to clipboard', 'share-2');
  }
}

export function shareCurrent() {
  if (player.current) shareTrack(player.current);
}

/** The download button on the "could not play" card. */
export function downloadCurrent() {
  if (!player.current) return;
  toggleDownload(player.current.id);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export function refresh() {
  import('./views/home.js').then((home) => {
    home.renderRecent();
    home.renderTop();
    home.renderBrowse();
  });
  import('./views/library.js').then((library) => {
    if (library.libraryState.tab) library.openLibraryTab(library.libraryState.tab);
  });
  Router.repaint();
  import('./device.js').then((device) => device.refreshStats());
}

export { openPlaylist, openArtist } from './views/detail.js';
export { toggleDownload, downloadIds, downloadTracks, downloadAll, cancelDownloads, isDownloaded, jobOf };
