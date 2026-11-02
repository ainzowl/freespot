// Search tab: debounced search across songs, artists and playlists.

import { $, escapeHtml } from '../util.js';
import { registerVideo } from '../catalog.js';
import { search } from '../sources.js';
import { trackRow, artImg, renderIcons, sectionHeading, emptyState } from '../ui.js';

let searchTimer = null;
export let searchResults = [];

export function resetSearch() {
  const results = $('#search-results');
  const browse = $('#browse-wrap');
  if (results) results.classList.add('hidden');
  if (browse) browse.classList.remove('hidden');
}

export function onSearchInput(value) {
  const query = (value || '').trim();
  if (!query) {
    clearTimeout(searchTimer);
    resetSearch();
    return;
  }
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(query), 300);
}

export async function runSearch(query) {
  const results = $('#search-results');
  const browse = $('#browse-wrap');
  if (!results) return;

  results.innerHTML = '<p class="detail-note">Searching…</p>';
  results.classList.remove('hidden');
  if (browse) browse.classList.add('hidden');

  let data;
  try {
    data = await search(query);
  } catch (err) {
    results.innerHTML = emptyState({
      icon: 'alert-circle',
      title: 'Search failed',
      sub: err.message || 'Try again in a moment.',
    });
    renderIcons();
    return;
  }

  searchResults = data.videos || [];
  const channels = data.channels || [];
  const playlists = data.playlists || [];

  let html = '';

  if (searchResults.length) {
    html += sectionHeading('Songs');
    html += `<div class="track-list">${searchResults.map((track, i) => trackRow(track, i, { play: `__playSearchAt(${i})`, showDl: true })).join('')}</div>`;
  }

  if (channels.length) {
    html += sectionHeading('Artists');
    html += channels.map((channel) => `
      <button class="list-row" onclick="__openArtist('c:${channel.id}')">
        <div class="cover cover-ring list-art" style="border-radius:50%">
          ${channel.thumb ? `<img src="${escapeHtml(channel.thumb)}" alt="" loading="lazy" draggable="false" />` : artImg(`artist:${channel.id}`)}
        </div>
        <div class="list-meta">
          <p class="list-title">${escapeHtml(channel.name)}</p>
          <p class="list-sub">${escapeHtml(channel.subscriberCount || 'Artist')}</p>
        </div>
        <i data-lucide="chevron-right" style="width:15px;height:15px;color:var(--faint)"></i>
      </button>`).join('');
  }

  if (playlists.length) {
    html += sectionHeading('Playlists');
    html += playlists.map((playlist) => `
      <button class="list-row" onclick="__openPlaylist('pl:${playlist.id}')">
        <div class="cover cover-ring list-art">
          ${playlist.thumb ? `<img src="${escapeHtml(playlist.thumb)}" alt="" loading="lazy" draggable="false" />` : artImg(`pl:${playlist.id}`)}
        </div>
        <div class="list-meta">
          <p class="list-title">${escapeHtml(playlist.title)}</p>
          <p class="list-sub">${escapeHtml(playlist.author || 'Playlist')}</p>
        </div>
        <i data-lucide="chevron-right" style="width:15px;height:15px;color:var(--faint)"></i>
      </button>`).join('');
  }

  if (!html) {
    html = emptyState({
      icon: 'search-x',
      title: 'No results',
      sub: `Nothing matched “${query}”.`,
    });
  }

  results.innerHTML = html;
  renderIcons();
}

/** Seed the search box and run a query (used by the genre tiles). */
export function searchFor(query) {
  const input = $('#search-input');
  if (input) input.value = query;
  import('../shell.js').then(({ goTab }) => goTab('search'));
  runSearch(query);
}
