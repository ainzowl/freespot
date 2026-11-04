// Device tab: storage, offline mode, keys, and reset.

import { state, resetLibrary } from './library.js';
import { byId } from './catalog.js';
import { $ } from './util.js';
import { isDownloaded, onDownloadChange, clearDownloads, countDownloads, cachedBytes } from './media.js';
import { getSettings, updateSettings, customProviderKey, usingDefaultProviderKey } from './settings.js';
import { toast, openSheet, closeSheet } from './overlays.js';
import { goTab } from './shell.js';
import { fmtBytes } from './util.js';

let cachedTotal = 0;
let cachedSize = 0;

export async function refreshStats() {
  const tracks = Object.values(byId).filter((t) => t && t.videoId);

  cachedTotal = 0;
  cachedSize = 0;
  for (const track of tracks) {
    if (await isDownloaded(track.id)) {
      cachedTotal++;
      cachedSize += await cachedBytes(track.id);
    }
  }

  const set = (sel, value) => { const el = $(sel); if (el) el.textContent = String(value); };

  set('#stat-liked', state.liked.length);
  set('#stat-playlists', state.playlists.length);
  set('#stat-followed', state.followed.length);
  set('#stat-offline', cachedTotal);

  const likedSub = $('#liked-sub');
  if (likedSub) likedSub.textContent = `Playlist · ${state.liked.length} songs`;

  const dlSub = $('#dl-sub');
  if (dlSub) {
    dlSub.textContent = cachedTotal
      ? `${cachedTotal} song${cachedTotal === 1 ? '' : 's'} available offline`
      : 'Nothing saved yet';
  }

  const followedSub = $('#followed-sub');
  if (followedSub) {
    followedSub.textContent = state.followed.length
      ? `${state.followed.length} artist${state.followed.length === 1 ? '' : 's'} followed`
      : 'Artists you keep coming back to';
  }

  const toggle = $('#offline-switch');
  if (toggle) {
    toggle.textContent = state.offline ? 'ON' : 'OFF';
    toggle.classList.toggle('active', state.offline);
  }

  const storageHint = $('#storage-hint');
  if (storageHint) storageHint.textContent = cachedSize ? `${fmtBytes(cachedSize)} used` : 'Nothing saved yet';

  const countHint = $('#download-count-hint');
  if (countHint) {
    countHint.textContent = cachedTotal
      ? `${cachedTotal} of ${tracks.length} downloaded`
      : 'No tracks downloaded';
  }

  const provider = $('#provider-hint');
  if (provider) {
    provider.textContent = usingDefaultProviderKey() ? 'Built-in key' : 'Your key';
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function openStorageSheet() {
  openSheet('Storage', () => `
    <button class="sheet-row" onclick="__clearAllDownloads()"><i data-lucide="trash-2"></i>Delete downloaded audio</button>
    <button class="sheet-row danger" onclick="__resetDevice(true)"><i data-lucide="eraser"></i>Reset everything</button>
    <button class="sheet-row" onclick="__resetDevice(false)"><i data-lucide="library-big"></i>Reset library only</button>
    <p class="sheet-note">Everything lives in this browser. Clearing cannot be undone.</p>`);
}

export async function clearAllDownloads() {
  await clearDownloads();
  await refreshStats();
  closeSheet();
  toast('Downloaded audio deleted', 'trash-2');
}

export async function resetDevice(removeAudio) {
  if (removeAudio) await clearDownloads();
  resetLibrary();
  await refreshStats();
  closeSheet();
  toast(removeAudio ? 'Device reset' : 'Library cleared', 'trash-2');
  goTab('device');
}

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function openKeySheet() {
  const settings = getSettings();
  const isDefault = usingDefaultProviderKey();
  const relay = String(settings.downvidRelay || '').trim();
  const usingLocalRelay = !relay;

  openSheet('Downloads', () => `
    <div style="padding:4px 13px 12px">
      <div class="provider-state ${usingLocalRelay ? '' : 'custom'}">
        <i data-lucide="${usingLocalRelay ? 'server' : 'shield-check'}"></i>
        <span>${usingLocalRelay ? 'Primary source: this server' : 'Primary source: custom relay'}</span>
      </div>
      <p class="sheet-note" style="margin:10px 0 16px">
        Songs download from DownVid first, then public mirrors, then the paid provider.
        DownVid needs a relay to reach the browser, so this is where you point the app at one.
      </p>

      <label class="sheet-note" style="display:block;margin:0 0 6px">DownVid relay URL</label>
      <input id="sheet-relay-url" class="modal-input" style="margin-top:0"
        placeholder="https://your-worker.workers.dev"
        autocomplete="off" spellcheck="false" inputmode="url"
        value="${escapeAttr(relay)}" />
      <p class="sheet-note" style="margin:6px 0 16px">
        Leave empty to use this server's built-in relay (works when the app is run locally).
        Deploy your own with <strong>relay/README.md</strong>.
      </p>

      <div class="provider-state ${isDefault ? '' : 'custom'}" style="margin-bottom:12px">
        <i data-lucide="${isDefault ? 'key-round' : 'shield-check'}"></i>
        <span>${isDefault ? 'Fallback key: built-in' : 'Fallback key: your own'}</span>
      </div>
      <label class="sheet-note" style="display:block;margin:0 0 6px">Fallback provider key (optional)</label>
      <input id="sheet-provider-key" class="modal-input" style="margin-top:0" placeholder="${escapeAttr(isDefault ? 'Leave empty to keep the built-in key' : 'video-download-api key')}" autocomplete="off" value="${escapeAttr(customProviderKey())}" />
      <p class="sheet-note" style="margin:6px 0 16px">Only used when both DownVid and the public mirrors fail. Clearing the field restores the built-in key.</p>

      <button class="btn-copper btn-press" style="width:100%;justify-content:center" onclick="__saveKeys()">Save</button>
    </div>`);
  setTimeout(() => {
    const input = $('#sheet-relay-url');
    if (input) input.focus();
  }, 80);
}

export function saveKeys() {
  const provider = $('#sheet-provider-key');
  const relay = $('#sheet-relay-url');
  updateSettings({
    providerKey: provider ? provider.value.trim() : '',
    downvidRelay: relay ? relay.value.trim() : '',
  });
  closeSheet();
  refreshStats();
  toast(getSettings().downvidRelay ? 'Relay saved' : "Using this server's relay", 'check');
}

export function toggleOffline() {
  import('./library.js').then(({ setOffline }) => {
    const value = setOffline(!state.offline);
    refreshStats();
    toast(value ? 'Offline mode on' : 'Offline mode off', 'wifi-off');
  });
}

onDownloadChange((kind) => {
  if (kind === 'progress') return;
  refreshStats();
});

export { countDownloads };
