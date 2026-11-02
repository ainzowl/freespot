// Home tab: recently played, trending, genres.
//
// There is no bundled demo catalogue, so with nothing played yet the page shows
// what the public mirrors return and a prompt to search.

import { byId, GENRES, registerVideo, ARTISTS, ensureTrack, hydrateTracks } from '../catalog.js';
import { state } from '../library.js';
import { $, escapeHtml, jsArg } from '../util.js';
import { renderIcons, coverForTrack, artistName, trackRow, artImg, genreArt, emptyState } from '../ui.js';
import { trending } from '../sources.js';

export function renderRecent() {
  const list = $('#recent-row');
  const section = $('#recent-section');
  if (!list) return;

  const tracks = state.recent.map((id) => ensureTrack(id)).filter(Boolean);

  if (!tracks.length) {
    if (section) section.classList.add('hidden');
    return;
  }
  if (section) section.classList.remove('hidden');
  hydrateTracks(tracks.map((t) => t.id)).catch(() => {});

  list.innerHTML = tracks.map((track) => `
    <div class="art-card" style="width:126px">
      <button onclick="__playTrack(${jsArg(track.id)})" class="btn-press" style="position:relative;display:block;width:100%;border:0;background:none;padding:0">
        ${coverForTrack(track, 'cover-ring', 'width:100%;aspect-ratio:1;border-radius:18px;box-shadow:0 16px 34px -18px rgba(0,0,0,.9)')}
        <span class="play-badge" style="position:absolute;right:8px;bottom:8px"><i data-lucide="play" style="width:12px;height:12px;fill:currentColor;margin-left:1px"></i></span>
      </button>
      <p class="card-title">${escapeHtml(track.title)}</p>
      <p class="card-sub">${escapeHtml(artistName(track))}</p>
    </div>`).join('');
  renderIcons();
}

export function renderBrowse() {
  const grid = $('#browse-grid');
  if (!grid) return;
  grid.innerHTML = GENRES.map((genre) => `
    <button onclick="__searchGenre('${genre.tag}')" class="genre-tile btn-press">
      ${artImg(genreArt(genre.tag))}
      <span>${genre.name}</span>
      <i data-lucide="${genre.icon}"></i>
    </button>`).join('');
  renderIcons();
}

let topIds = [];
let topFetched = 0;
let topError = '';

const LAST_TOP = 'fp_home_top';

function loadLastTop() {
  try {
    const raw = localStorage.getItem(LAST_TOP);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.map(registerVideo).filter(Boolean).map((t) => t.id);
  } catch {
    return [];
  }
}

function saveLastTop(tracks) {
  try {
    const slim = tracks.slice(0, 20).map((t) => ({
      id: t.videoId,
      title: t.title,
      channel: (ARTISTS[t.artistId] || {}).name || '',
      channelId: String(t.artistId || '').replace(/^c:/, ''),
      thumb: t.thumb,
      dur: t.dur,
    }));
    localStorage.setItem(LAST_TOP, JSON.stringify(slim));
  } catch {}
}

export function getTopIds() {
  return topIds.map((id) => ensureTrack(id)).filter(Boolean).map((t) => t.id);
}

export async function renderTop({ force = false } = {}) {
  const list = $('#top-list');
  if (!list) return;

  if (force || !topIds.length || Date.now() - topFetched > 10 * 60 * 1000) {
    topFetched = Date.now();
    try {
      const data = await trending();
      const tracks = (data.videos || []).slice(0, 20).map(registerVideo).filter(Boolean);
      if (tracks.length) {
        topIds = tracks.map((t) => t.id);
        topError = '';
        saveLastTop(tracks);
      } else {
        throw new Error('Trending is unavailable right now');
      }
    } catch (err) {
      topError = err.message;
      topFetched = 0;
      // Public instances fail in waves; showing the previous chart beats an
      // error page while the retry in the source layer is still settling.
      if (!topIds.length) topIds = loadLastTop();
      if (topIds.length) topError = '';
    }
  }

  const tracks = topIds.map((id) => ensureTrack(id)).filter(Boolean);
  if (!tracks.length) {
    list.innerHTML = emptyState({
      icon: 'alert-circle',
      title: 'Could not load trending',
      sub: topError || 'Mirrors are busy — try again.',
    });
    renderIcons();
    return;
  }

  list.innerHTML = tracks.map((track, i) => trackRow(track, i, { rank: i + 1, play: `__playTopAt(${i})`, showDl: true })).join('');
  renderIcons();
}

export function resetHome() {
  topIds = [];
  topFetched = 0;
  topError = '';
  renderRecent();
  renderTop({ force: true });
}
