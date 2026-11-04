# FreePot relay

A tiny proxy that adds CORS to the **DownVid** API, which FreePot uses as its
primary download and playback source.

## Why this exists

DownVid sends **no CORS headers at all**. This was verified against the live
service, not assumed:

| Request | Result |
| --- | --- |
| `POST /api/music/search` with `Origin` | `200`, **no `access-control-*` header** |
| `POST /api/music/download` with `Origin` | `200`, no CORS headers |
| `GET /api/progress/<id>` | `200`, no CORS headers |
| `GET /api/file/<id>` | `200`, no CORS headers |
| `OPTIONS` on any of them | `204`, no CORS headers |

A browser therefore cannot read any of those responses from a page served on a
different origin — which is every deployment of this app. The API is perfectly
usable from a server, so a relay that fetches it server-side and re-serves the
result with the right headers is the whole fix.

The relay also always injects the `x-client-id` header the API requires; without
it every endpoint answers `400 {"error":"Invalid request body"}`.

## Two ways to run it

### 1. Local development — nothing to deploy

`server/index.js` already mounts the relay at `/__relay`:

```bash
node server/index.js         # http://localhost:1234
```

The app then calls `http://localhost:1234/__relay/api/music/search` with no
configuration, because that is the default relay base when the app itself is
served from `localhost`.

### 2. Production — deploy the Worker

The app is static and usually lives on GitHub Pages, so it needs a relay with a
URL of its own:

```bash
cd relay
npx wrangler deploy
```

That prints a URL such as
`https://freepot-relay.<your-subdomain>.workers.dev`. Point the app at it in one
of two ways:

- **Settings → DownVid relay** (stored in `localStorage`, survives reloads), or
- append `?relay=https://freepot-relay.<your-subdomain>.workers.dev` to the app
  URL — handy for a one-off test.

No `wrangler.toml` edits, secrets or bindings are required. The Worker has no
state: it is a pure pass-through.

## URL shapes

The app always calls `<relay-base>/api/...`, and the relay forwards to the same
path on the upstream host:

| App calls | Relay fetches |
| --- | --- |
| `<relay>/api/music/search` | `https://downvid-delta.vercel.app/api/music/search` |
| `<relay>/api/music/download` | `https://downvid-delta.vercel.app/api/music/download` |
| `<relay>/api/progress/<id>` | `https://downvid-delta.vercel.app/api/progress/<id>` |
| `<relay>/api/file/<id>` | `https://downvid-delta.vercel.app/api/file/<id>` |

Only `/api/music/`, `/api/progress/` and `/api/file/` are proxied. Everything
else is a `404`, so the relay is not an open proxy.

## Two upstream quirks the app has to live with

Neither is fixed by the relay; both are handled in `assets/js/downvid.js`.

1. **File URLs are single-use.** The first `GET /api/file/<id>` returns the audio
   with a real `Content-Length` and `Content-Type: audio/mp4`; an immediate second
   request for the same URL returns `404`. The app therefore fetches a finished
   file exactly once and stores it in the Cache API.
2. **`Range` is ignored.** A ranged request comes back `200` with the *whole* body
   instead of `206` with a slice, so the multi-chunk downloader used for Invidious
   mirrors cannot be used here. DownVid downloads run as a single stream with
   progress measured from real byte counts.

## Checking it works

```bash
curl -sS -D - -X POST \
  -H 'Content-Type: application/json' \
  --data-binary '{"query":"twenty one pilots"}' \
  http://localhost:1234/__relay/api/music/search
```

A working relay returns `200` with `access-control-allow-origin: *` and a body
containing `sessionId` and `suggestions`.

## Swapping the upstream

The upstream host, client id and mount point live in one place — the `DOWNVID`
object in `server/config.js` for development, and the constants at the top of
`relay/worker.js` for production. Changing source means editing those and nothing
else in the app.
