'use strict';

const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT) || 1234,

  // The app is the project root; this whole folder is what you deploy.
  APP_DIR: path.resolve(__dirname, '..'),

  CORS: {
    // Dev only. The app is served from the same origin, so this is a courtesy
    // for tools; production hosting sets its own headers.
    origin: '*',
  },

  // DownVid: the primary download and playback source.
  //
  // Its API sends no CORS headers at all, so a browser on any other origin
  // cannot read its responses. The relay exists to add them: in development the
  // app talks to `<this server>/__relay/api/...`, in production to a deployed
  // worker (see relay/).
  DOWNVID: {
    // The only host this relay will ever contact.
    host: 'downvid-delta.vercel.app',
    base: 'https://downvid-delta.vercel.app',

    // Required by every endpoint: without it the API answers
    // 400 {"error":"Invalid request body"}.
    clientId: 'e9e3fe42-0781-4995-918a-3044faa6715d',

    // Where the relay is mounted. The app calls `/__relay/api/music/search`.
    mount: '/__relay',

    // How long a proxied request may take before it is abandoned. The file
    // endpoint streams a whole track, so this is generous.
    timeoutMs: 120000,
  },
};
