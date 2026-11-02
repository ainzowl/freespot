// Piped: keyless YouTube search, channels, playlists and trending.
//
// No API key, no server. Piped is a public YouTube frontend with a JSON API that
// sends permissive CORS headers, so the browser can call it directly.
//
// Public instances go down regularly, so every request races a small pool and
// uses whichever answers first. The winner is remembered for the session.

const INSTANCES = [
  'https://pipedapi.ducks.party',
  'https://pipedapi.wireway.ch',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.reallyaweso.me',
];

const TIMEOUT_MS = 7000;
let preferred = null;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

async function hit(base, path) {
  const { controller, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${base} returned ${res.status}`);
    const json = await res.json();
    preferred = base;
    return json;
  } finally {
    done();
  }
}

/**
 * Try the last-known-good instance first, then race the rest.
 * The first successful JSON response wins.
 */
async function piped(path) {
  const order = preferred
    ? [preferred, ...INSTANCES.filter((i) => i !== preferred)]
    : INSTANCES.slice();

  // Race the first three so a dead instance costs nothing. Failures are expected
  // (public instances go down constantly) so they are not logged.
  const racers = order.slice(0, 3).map((base) =>
    hit(base, path).then((json) => ({ json, base }))
  );

  try {
    const winner = await Promise.any(racers);
    preferred = winner.base;
    return winner.json;
  } catch {
    // Everything in the fast pool failed; walk the rest sequentially.
    for (const base of order.slice(3)) {
      try {
        return await hit(base, path);
      } catch {
        // keep trying
      }
    }
  }

  // A 500 usually means one instance's extractor hit YouTube's rate limit, not
  // that the data is gone. One slow retry against the whole pool recovers most
  // of those without the caller having to show an error.
  preferred = null;
  await new Promise((r) => setTimeout(r, 700));
  for (const base of INSTANCES) {
    try {
      const json = await hit(base, path);
      preferred = base;
      return json;
    } catch {
      // keep trying
    }
  }

  throw new Error('Search is unavailable right now — try again in a moment');
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const videoIdOf = (url) => {
  const match = /[?&]v=([\w-]{11})/.exec(url || '');
  return match ? match[1] : null;
};

const channelIdOf = (url) => {
  const match = /\/channel\/([\w-]+)/.exec(url || '');
  return match ? match[1] : null;
};

const playlistIdOf = (url) => {
  const match = /[?&]list=([\w-]+)/.exec(url || '');
  return match ? match[1] : null;
};

function toVideo(stream) {
  const id = videoIdOf(stream.url);
  if (!id) return null;
  return {
    id,
    title: cleanText(stream.title),
    channel: cleanText(stream.uploaderName || ''),
    channelId: channelIdOf(stream.uploaderUrl),
    thumb: stream.thumbnail || `https://i.ytimg.com/vi/${id}/hq720.jpg`,
    duration: Number(stream.duration) > 0 ? Number(stream.duration) : 0,
    durationText: '',
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function searchPiped(query) {
  const [songs, general] = await Promise.allSettled([
    piped(`/search?q=${encodeURIComponent(query)}&filter=music_songs`),
    piped(`/search?q=${encodeURIComponent(query)}&filter=music_videos`),
  ]);

  const take = (r) => (r.status === 'fulfilled' ? (r.value.items || []) : []);

  const seen = new Set();
  const videos = [];
  for (const stream of [...take(songs), ...take(general)]) {
    const video = toVideo(stream);
    if (!video || seen.has(video.id)) continue;
    seen.add(video.id);
    videos.push(video);
  }

  // Channels: derive from the uploaders of the results. Piped's search does not
  // reliably return channel items, and this avoids an extra round trip.
  const channels = [];
  const channelSeen = new Set();
  for (const stream of [...take(songs), ...take(general)]) {
    const id = channelIdOf(stream.uploaderUrl);
    if (!id || channelSeen.has(id)) continue;
    channelSeen.add(id);
    channels.push({
      id,
      name: cleanText(stream.uploaderName || 'Artist'),
      thumb: stream.uploaderAvatar || null,
      subscriberCount: '',
    });
  }

  return { videos, channels, playlists: [] };
}

export async function channelPiped(channelId, name) {
  const data = await piped(`/channel/${encodeURIComponent(channelId)}`);
  let streams = data.relatedStreams || [];

  // Auto-generated "Artist - Topic" channels report no uploads through the
  // channel endpoint. Search for the artist instead and keep only that channel's
  // videos, so artist pages are not blank.
  if (!streams.length && (name || data.name)) {
    const term = String(name || data.name).replace(/\s*-\s*Topic$/i, '');
    try {
      const found = await piped(`/search?q=${encodeURIComponent(term)}&filter=music_songs`);
      streams = (found.items || []).filter((item) => channelIdOf(item.uploaderUrl) === channelId);
    } catch {
      streams = [];
    }
  }

  return {
    channel: {
      id: channelId,
      name: cleanText(data.name || name || 'Artist').replace(/\s*-\s*Topic$/i, ''),
      thumb: data.avatarUrl || null,
      subscriberCount: subscriberText(data.subscriberCount),
    },
    videos: streams.map(toVideo).filter(Boolean),
  };
}

/** Piped reports hidden subscriber counts as -1 or 0. */
function subscriberText(value) {
  const count = Number(value);
  if (!isFinite(count) || count <= 0) return '';
  return `${count.toLocaleString()} subscribers`;
}

export async function playlistPiped(playlistId) {
  const data = await piped(`/playlists/${encodeURIComponent(playlistId)}`);
  const streams = (data.relatedStreams && data.relatedStreams.length)
    ? data.relatedStreams
    : (data.videos || []);
  return {
    playlist: {
      id: playlistId,
      title: cleanText(data.name || 'Playlist'),
      author: cleanText(data.uploader || ''),
      videoCount: streams.length,
      thumb: data.thumbnailUrl || null,
    },
    videos: streams.map(toVideo).filter(Boolean),
  };
}

export async function trendingPiped(region = 'US') {
  // Piped's /trending mirrors YouTube's general chart (gaming, news, live), which
  // is wrong for a music app. Search the music categories instead, which yields
  // actual songs. Results are cached by the caller.
  const [songs, videos] = await Promise.allSettled([
    piped(`/search?q=${encodeURIComponent('top songs this week')}&filter=music_songs`),
    piped(`/search?q=${encodeURIComponent('new music')}&filter=music_videos`),
  ]);

  const take = (r) => (r.status === 'fulfilled' ? (r.value.items || []) : []);

  const seen = new Set();
  const list = [];
  for (const stream of [...take(songs), ...take(videos)]) {
    const video = toVideo(stream);
    if (!video || seen.has(video.id)) continue;
    // Skip live streams and very long uploads — not songs.
    if (video.duration > 900) continue;
    seen.add(video.id);
    list.push(video);
    if (list.length >= 20) break;
  }

  return { videos: list };
}

export { playlistIdOf, channelIdOf, videoIdOf };
