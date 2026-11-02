export const APP = {
  name: 'FreePot',
  mediaCache: 'freepot-media-v2',
};

export const YT_WATCH = 'https://www.youtube.com/watch?v=';
export const YT_PLAYLIST = 'https://www.youtube.com/playlist?list=';

// Video download provider. Called directly from the browser: its endpoints
// return readable CORS responses, so no relay is involved. It is the *fallback*
// download source; public Invidious mirrors are tried first.
export const PROVIDER = {
  base: 'https://p.savenow.to',
  create: '/ajax/download.php',
  progress: '/api/progress',
};

// Built-in provider key, used when the user has not set their own.
//
// This ships in the bundle and is therefore public: anyone who loads the app can
// read it. It exists so downloads work on a fresh install with nothing to
// configure. Replace it in Setup at any time; a custom key always wins.
export const DEFAULT_PROVIDER_KEY = '080bd90d506c89cf16a61b8685826a7450386a87';

// Public Invidious mirrors. They serve metadata, audio streams (proxied, with
// CORS + range support) and are the primary download source. Community-run, so
// the app walks the list and remembers whichever answered.
export const INVIDIOUS = [
  'https://yt.chocolatemoo53.com',
  'https://yt.omada.cafe',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
];

export const LYRICS = {
  lrclib: 'https://lrclib.net/api',
  ovh: 'https://api.lyrics.ovh/v1',
};

export const STORAGE = {
  liked: 'fp_liked',
  recent: 'fp_recent',
  followed: 'fp_followed',
  savedAlbums: 'fp_savedAlbums',
  playlists: 'fp_playlists',
  offline: 'fp_offline',
  blocked: 'fp_blocked',
  meta: 'fp_meta_v1',
  tracks: 'fp_tracks_v1',
  streams: 'fp_streams_v1',
};

export const SETTINGS_KEY = 'fp_settings_v1';

export const VIEWS = ['home', 'search', 'library', 'device'];
