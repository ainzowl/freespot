// FreePot dev server.
//
// The app itself is 100% static — this only serves the files, plus a small CORS
// relay so the browser can talk to the DownVid API in development.
//
// Why a relay exists at all: DownVid sends no CORS headers whatsoever, so a page
// on any other origin cannot read its JSON. The relay forwards the request from
// the server side and adds the headers a browser needs. In production the same
// thing runs as a Cloudflare Worker (see relay/); this copy is for local work.
//
// Production does not need THIS file: deploy `relay/worker.js` instead and point
// the app at it. Or drop the folder on any static host if you do not want DownVid.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const RELAY_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'];

// Headers the browser is allowed to send us, and headers it is allowed to read
// back. `content-length` is the one that matters: the app measures download
// progress from it, and without an explicit expose CORS hides it.
const RELAY_ALLOW_HEADERS = 'Content-Type, Accept, Accept-Language, Range, x-client-id';
const RELAY_EXPOSE_HEADERS = 'Content-Length, Content-Type, Accept-Ranges, Content-Range, Content-Disposition';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': config.CORS.origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
  });
  res.end(payload);
}

function relayCors(res, req) {
  // Echo the caller's origin so `credentials` would work too, but the app does
  // not use cookies, so `*` is enough and is what a shared relay should send.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', RELAY_METHODS.join(', '));
  res.setHeader('Access-Control-Allow-Headers', RELAY_ALLOW_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', RELAY_EXPOSE_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

/**
 * Proxy one request to DownVid and stream the answer back.
 *
 * Streaming matters: `/api/file/<id>` returns a whole track (several MB), and
 * buffering it through the server would both delay the first byte and double the
 * memory cost. The upstream body is piped straight to the client instead.
 */
function relay(req, res, incoming) {
  relayCors(res, req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Strip the mount prefix; what is left is the real upstream path + query.
  const upstreamPath = incoming.pathname.slice(config.DOWNVID.mount.length) || '/';

  // Only DownVid's own API is reachable, and only its known endpoint shapes.
  if (!/^\/(api|music)(\/|$)/.test(upstreamPath) && upstreamPath !== '/api') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Unknown relay path' }));
  }

  const headers = {
    // Force the upstream request to look same-site and always carry the client
    // id, which every endpoint requires.
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: req.headers.accept || 'application/json',
    'x-client-id': req.headers['x-client-id'] || config.DOWNVID.clientId,
    Origin: config.DOWNVID.base,
    Referer: `${config.DOWNVID.base}/music`,
    'User-Agent': req.headers['user-agent'] || 'FreePot-dev-relay',
  };
  // Range is forwarded as-is even though DownVid ignores it, so the relay is
  // honest about what the upstream supports rather than pretending.
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['content-length'] && req.method !== 'GET') {
    headers['Content-Length'] = req.headers['content-length'];
  }

  const upstream = https.request({
    protocol: config.DOWNVID.base.startsWith('https') ? 'https:' : 'http:',
    hostname: config.DOWNVID.host,
    path: upstreamPath + incoming.search,
    method: req.method,
    headers,
    timeout: config.DOWNVID.timeoutMs,
  }, (up) => {
    const out = {
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
      if (up.headers[name]) out[canon(name)] = up.headers[name];
    }

    relayCors(res, req);
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });

  upstream.on('timeout', () => {
    upstream.destroy(new Error('Upstream timed out'));
  });

  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    relayCors(res, req);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `Upstream unreachable: ${err.message}` }));
  });

  // Forward the request body. GET/HEAD have none.
  if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end();
  } else {
    req.pipe(upstream);
  }
}

const canon = (name) => name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');

function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return sendJson(res, 400, { error: 'Bad path' });
  }

  // Only the app root is public; everything else (server, relay, git) is not.
  const blocked = ['/server', '/relay', '/node_modules', '/.git'];
  for (const prefix of blocked) {
    if (decoded === prefix || decoded.startsWith(`${prefix}/`)) {
      return sendJson(res, 404, { error: 'Not found' });
    }
  }
  if (decoded.includes('\0') || decoded.includes('..')) {
    return sendJson(res, 400, { error: 'Bad path' });
  }

  let filePath = path.join(config.APP_DIR, decoded);
  if (!filePath.startsWith(config.APP_DIR)) {
    return sendJson(res, 400, { error: 'Bad path' });
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');

    fs.stat(filePath, (statErr, finalStat) => {
      if (statErr || !finalStat.isFile()) {
        return sendJson(res, 404, { error: 'Not found' });
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': finalStat.size,
        // HTML and JS must not be cached hard during development.
        'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css'
          ? 'no-cache'
          : 'public, max-age=3600',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // The relay is checked first and handles its own method rules: it must accept
  // POST, which the static path deliberately does not.
  if (url.pathname === config.DOWNVID.mount || url.pathname.startsWith(`${config.DOWNVID.mount}/`)) {
    if (!RELAY_METHODS.includes(req.method)) {
      relayCors(res, req);
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: RELAY_METHODS.join(', ') });
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    return relay(req, res, url);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': config.CORS.origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
    });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  serveStatic(req, res, url.pathname);
});

server.listen(config.PORT, () => {
  console.log(`FreePot dev server: http://localhost:${config.PORT}`);
  console.log(`Serving: ${config.APP_DIR}`);
  console.log(`DownVid relay: http://localhost:${config.PORT}${config.DOWNVID.mount}/api/music/search`);
});
