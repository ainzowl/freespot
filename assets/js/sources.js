// Source indirection: the only place that knows where catalog data comes from.
//
// Everything goes through public Invidious mirrors, which need no API key and
// expose search, channels, playlists, trending and proxied audio. Piped is kept
// as a secondary for environments where the mirrors are blocked.

import { registerVideo, registerPlaylist } from './catalog.js';
import * as invidious from './invidious.js';
import { searchPiped, channelPiped, playlistPiped, trendingPiped } from './piped.js';

export async function search(query) {
  let data = null;
  try {
    data = await invidious.searchAll(query);
  } catch {
    data = null;
  }

  if (!data || (!data.videos.length && !data.channels.length && !data.playlists.length)) {
    const fallback = await searchPiped(query);
    return {
      videos: fallback.videos.map(registerVideo).filter(Boolean),
      channels: fallback.channels,
      playlists: fallback.playlists,
    };
  }

  return {
    videos: data.videos.map(registerVideo).filter(Boolean),
    channels: data.channels,
    playlists: data.playlists,
  };
}

export async function channel(channelId, name) {
  try {
    const [info, videos] = await Promise.all([
      invidious.channel(channelId),
      invidious.channelVideos(channelId).catch(() => []),
    ]);
    const list = videos.length ? videos : info.videos;
    return {
      channel: info.channel,
      videos: list.map(registerVideo).filter(Boolean),
    };
  } catch {
    const data = await channelPiped(channelId, name);
    return {
      channel: data.channel,
      videos: data.videos.map(registerVideo).filter(Boolean),
    };
  }
}

export async function playlist(playlistId) {
  try {
    const data = await invidious.playlist(playlistId);
    const videos = data.videos.map(registerVideo).filter(Boolean);
    registerPlaylist(playlistId, {
      name: data.playlist.title,
      desc: data.playlist.author,
      ids: videos.map((t) => t.id),
    });
    return { playlist: data.playlist, videos };
  } catch {
    const data = await playlistPiped(playlistId);
    const videos = data.videos.map(registerVideo).filter(Boolean);
    registerPlaylist(playlistId, {
      name: data.playlist.title,
      desc: data.playlist.author,
      ids: videos.map((t) => t.id),
    });
    return { playlist: data.playlist, videos };
  }
}

export async function trending() {
  try {
    const tracks = (await invidious.trending()).map(registerVideo).filter(Boolean);
    if (tracks.length) return { videos: tracks };
  } catch {}

  const data = await trendingPiped();
  return { videos: data.videos.map(registerVideo).filter(Boolean) };
}
