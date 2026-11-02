// The download provider, called directly from the browser.
//
// Browser-only: both endpoints return readable CORS responses, so no relay or
// server is involved. The API key stays in localStorage and is only ever used
// here, only when the user actually downloads something.

import { PROVIDER } from './config.js';
import { providerKey, getSettings } from './settings.js';

const POLL_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 1500;

export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

function describeError(json, status) {
  const code = json && (json.error_code || json.error);
  switch (code) {
    case 'invalid_api_key':
      return 'Provider rejected the key — copy it again from the dashboard';
    case 'api_key_required':
      return 'No download key set — add one in Setup';
    case 'insufficient_balance':
      return 'Provider balance is empty — top up to download';
    default:
      return (json && (json.message || json.text)) || `Provider error ${status}`;
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function normalise(json) {
  if (!json || !json.id) throw new Error('Provider did not return a job');
  return {
    id: json.id,
    progressUrl: json.progress_url
      || `${PROVIDER.base}${PROVIDER.progress}?id=${encodeURIComponent(json.id)}`,
    title: json.title || (json.info && json.info.title) || '',
    thumb: json.thumbnail_url || (json.info && json.info.image) || '',
  };
}

/** Create one download job. This is the billable call. */
export async function createJob(videoId, format) {
  const key = providerKey();
  if (!key) throw new Error('No download key set — add one in Setup');

  const qs = new URLSearchParams({
    url: watchUrl(videoId),
    format: format || getSettings().format || 'mp3',
    apikey: key,
  });

  const res = await fetch(`${PROVIDER.base}${PROVIDER.create}?${qs}`, {
    headers: { Accept: 'application/json' },
  });
  const { json } = await readJson(res);

  if (!res.ok || !json || json.success === false) {
    throw new Error(describeError(json, res.status));
  }
  return normalise(json);
}

/** Poll until the provider has the file. No charge; this is just status. */
export async function pollJob(progressUrl, { onProgress } = {}) {
  const started = Date.now();

  while (Date.now() - started < POLL_TIMEOUT_MS) {
    let json = null;
    try {
      const res = await fetch(progressUrl, { headers: { Accept: 'application/json' } });
      json = (await readJson(res)).json;
    } catch {
      // Transient network blips are expected; keep polling.
    }

    if (json) {
      const progress = Number(json.progress) || 0;
      if (onProgress) onProgress({ progress, text: json.text || json.message || '' });

      if (progress >= 1000) {
        if (json.download_url) return json.download_url;
        throw new Error(json.text || json.message || 'Provider produced no file');
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error('Provider timed out');
}

/** Free metadata lookup (does not create a job or spend credit). */
export async function videoInfo(videoId) {
  const key = providerKey();
  if (!key) throw new Error('No download key set');

  const qs = new URLSearchParams({
    function: 'i',
    api: key,
    u: watchUrl(videoId),
  });

  const res = await fetch(`${PROVIDER.base}/ajax/api.php?${qs}`, { headers: { Accept: 'application/json' } });
  const { json } = await readJson(res);
  if (!res.ok || !json) throw new Error(describeError(json, res.status));
  return json;
}
