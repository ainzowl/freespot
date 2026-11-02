// Downloads: keep the audio inside the app.
//
// Download means "save it here so I can play it offline", not "put a file in my
// Downloads folder". The bytes go into the Cache API and stay there; the player
// reads them back as a Blob URL. Nothing is ever handed to the operating system,
// because a browser download leaves the app, clutters the device, and on iOS
// drops the user into Files to find a track they can no longer play.
//
// Bytes come from a public Invidious mirror (free, CORS-readable, real progress).
// The paid provider is only a fallback for the rare track no mirror will serve.

import { byId, ensureTrack } from './catalog.js';
import { $$ } from './util.js';
import {
  jobOf, jobState, jobPercent, jobLabel, enqueue, enqueueMany,
  cancelQueued, isDownloaded, removeDownload, onDownloadChange, cachedUrl,
} from './media.js';
import { toast } from './overlays.js';
import { renderIcons } from './ui.js';

export function toggleDownload(trackId) {
  const track = byId[trackId] || ensureTrack(trackId);
  if (!track) return;
  if (!track.videoId) {
    toast('That track has no source', 'alert-circle');
    return;
  }

  const state = jobState(trackId);
  if (state === 'downloading' || state === 'queued') {
    toast('Already downloading', 'download');
    return;
  }

  isDownloaded(trackId).then((saved) => {
    if (saved) {
      removeDownload(trackId).then(() => {
        toast('Removed download', 'trash-2');
        refreshDownloadIcons();
      });
      return;
    }
    if (enqueue(track)) toast(`Downloading “${track.title}”`, 'download');
    else toast('Could not start that download', 'alert-circle');
  });
}

export function downloadTracks(tracks) {
  const list = tracks.filter((t) => t && t.videoId);
  if (!list.length) {
    toast('Nothing to download', 'alert-circle');
    return;
  }
  const queued = enqueueMany(list);
  if (queued) toast(`Queued ${queued} download${queued === 1 ? '' : 's'}`, 'download');
}

export function downloadIds(ids) {
  downloadTracks(ids.map((id) => byId[id]).filter(Boolean));
}

export function downloadAll() {
  downloadTracks(Object.values(byId).filter((t) => t && t.videoId));
}

export function cancelDownloads() {
  cancelQueued();
  toast('Cleared the queue', 'x');
}

export async function refreshDownloadIcons() {
  const buttons = $$('[data-dl-id]');
  for (const button of buttons) {
    const id = button.dataset.dlId;
    const job = jobOf(id);
    const busy = job && (job.state === 'downloading' || job.state === 'queued');

    if (busy) {
      const pct = jobPercent(id);
      button.dataset.state = 'busy';
      button.classList.add('dl-busy');
      button.classList.remove('text-copper');
      button.innerHTML = `<span class="dl-ring" style="--pct:${pct}"><span>${pct}</span></span>`;
      button.setAttribute('aria-label', `${jobLabel(id)}`);
      continue;
    }

    button.classList.remove('dl-busy');
    if (button.dataset.state === 'busy' || !button.querySelector('i, svg')) {
      button.innerHTML = '<i data-lucide="download"></i>';
      delete button.dataset.state;
    }

    const saved = await isDownloaded(id);
    const icon = button.querySelector('i');
    if (icon) icon.setAttribute('data-lucide', saved ? 'circle-check' : 'download');
    const svg = button.querySelector('svg');
    if (svg && !icon) {
      button.innerHTML = `<i data-lucide="${saved ? 'circle-check' : 'download'}"></i>`;
    }
    button.classList.toggle('text-copper', saved);
    button.setAttribute('aria-label', saved ? 'Remove download' : 'Download');
  }
  renderIcons();
}

onDownloadChange((kind) => {
  // Progress ticks repaint the ring in place; only a real state change needs the
  // full rescan (which reads the whole audio cache).
  if (kind === 'progress') {
    paintProgressOnly();
    return;
  }
  refreshDownloadIcons();
});

function paintProgressOnly() {
  const buttons = $$('[data-dl-id]');
  for (const button of buttons) {
    const id = button.dataset.dlId;
    const job = jobOf(id);
    const busy = job && (job.state === 'downloading' || job.state === 'queued');
    if (!busy) continue;
    const pct = jobPercent(id);
    button.dataset.state = 'busy';
    button.classList.add('dl-busy');
    const ring = button.querySelector('.dl-ring');
    if (ring) {
      ring.style.setProperty('--pct', pct);
      const text = ring.querySelector('span');
      if (text) text.textContent = pct;
    }
    button.setAttribute('aria-label', jobLabel(id));
  }
}

export { isDownloaded, cachedUrl };
