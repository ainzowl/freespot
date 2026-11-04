// FreePot relay: a Cloudflare Worker that adds CORS to the DownVid API.
//
// DownVid is the app's primary download and playback source, but it sends no
// CORS headers at all — verified against the live service, on every endpoint
// (`/api/music/search`, `/api/music/download`, `/api/progress/<id>`,
// `/api/file/<id>`) and on `OPTIONS`. A browser therefore cannot read any of its
// responses from a page served anywhere else, which is every deployment of this
// app. Fetching from the Worker's server side and re-serving the bytes with the
// headers a browser needs is the whole job of this file.
//
// Deploy with `npx wrangler deploy` (see relay/README.md), then point the app at
// it — Settings → DownVid relay, or `?relay=https://<worker-url>`.
//
// Everything the upstream returns is untrusted data. It is forwarded as bytes and
// never interpreted.

const UPSTREAM = 'https://downvid-delta.vercel.app';
const UPSTREAM_HOST = 'downvid-delta.vercel.app';

// Required on every request. Without it the API answers
// 400 {"error":"Invalid request body"}.
const CLIENT_ID = 'e9e3fe42-0781-4995-918a-3044faa6715d';

// Only these paths are proxied. Anything else is a 404 rather than a proxy for
// the whole internet.
const ALLOWED_PREFIXES = ['/api/music/', '/api/progress/', '/api/file/'];

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'];

const EXPOSE_HEADERS = 'Content-Length, Content-Type, Accept-Ranges, Content-Range, Content-Disposition';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Language, Range, x-client-id',
  'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

const json = (status, body, extra) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
});

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!ALLOWED_METHODS.includes(request.method)) {
      return json(405, { error: 'Method not allowed' }, { Allow: ALLOWED_METHODS.join(', ') });
    }

    if (!ALLOWED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return json(404, { error: 'Unknown relay path' });
    }

    const target = new URL(url.pathname + url.search, UPSTREAM);

    // Defence in depth: the path prefixes above already constrain the target,
    // but never issue a request to a host that is not the one intended.
    if (target.host !== UPSTREAM_HOST) return json(400, { error: 'Bad relay target' });

    const headers = new Headers();
    headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    headers.set('Accept', request.headers.get('Accept') || 'application/json');
    headers.set('x-client-id', request.headers.get('x-client-id') || CLIENT_ID);
    // Presenting as same-site keeps the upstream happy and costs nothing.
    headers.set('Origin', UPSTREAM);
    headers.set('Referer', `${UPSTREAM}/music`);
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        // A redirect would otherwise be followed to an unexpected host.
        redirect: 'manual',
      });
    } catch (err) {
      return json(502, { error: `Upstream unreachable: ${(err && err.message) || 'unknown'}` });
    }

    const out = new Headers(CORS_HEADERS);
    for (const [name, value] of upstreamResponse.headers) {
      // Copy only what the app actually needs; hop-by-hop and CSP headers from
      // the upstream are not useful here and some are actively wrong.
      if (/^(content-type|content-length|content-range|accept-ranges|content-disposition)$/i.test(name)) {
        out.set(name, value);
      }
    }
    if (!out.has('Content-Type')) out.set('Content-Type', 'application/octet-stream');
    out.set('Cache-Control', 'no-store');

    // Stream the body straight through: `/api/file/<id>` is a whole track, and
    // buffering it would delay the first byte and burn the Worker's memory.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: out,
    });
  },
};
