# FreePot

A Spotify-shaped PWA for music from YouTube, installable on iOS. **100% static
and browser-only** — no server, no database, no accounts, and **nothing to
configure before you can listen.**

```
index.html      shell: header, tabs, dock, mini player, now playing
setup.html      optional: add a download provider key
manifest.json   PWA manifest
sw.js           shell cache + serving downloaded audio offline
assets/
  css/          base, artwork, chrome, home, lists, player, overlays
  js/           ES modules (see below)
  icons/        app icons (SVG + PNG set for iOS)
server/         dev-only static server (not needed in production)
```

## How it works

| What | How | Cost |
| --- | --- | --- |
| **Playback** | Hidden YouTube iframe player, unmuted, autoplay on first tap | Free, keyless |
| **Unplayable / embed-blocked** | Same audio through a public Invidious mirror | Free, keyless |
| **Search / artists / playlists / trending** | Public Invidious mirrors, Piped as a fallback | Free, keyless |
| **Lyrics** | LRCLIB (synced where available), lyrics.ovh fallback | Free, keyless |
| **Description** | The Invidious video record already used for playback | Free, keyless |
| **Downloads** | Public Invidious mirror first, paid provider as fallback | Free, or paid per job |

Listening never touches the paid provider. Downloads are a deliberate, separate
action you opt into.

### Playback

`player.js` drives a hidden YouTube iframe — the one officially supported,
zero-infrastructure way to play YouTube audio in a browser. It is unmuted,
autoplays from the user's first tap, and works on iOS.

```js
// assets/js/ytplayer.js — the player is never visible
Object.assign(host.style, {
  position: 'fixed', left: '-9999px', width: '1px', height: '1px',
  opacity: '0.01', pointerEvents: 'none',
});
```

`display:none` breaks playback on some engines; 1×1 off-screen does not.

### When a video cannot be embedded

Some owners disable embedding; the iframe reports error 101/150 and refuses to
play. The player remembers the video id, and reloads the same audio through
`invidious.js`, which resolves an instance-proxied audio stream (`?local=true`).
Those URLs send CORS headers and support Range requests, so the audio element
gets real duration, seeking, and a working `ended` event.

If no engine can play the track, the player **stops on it** and shows a card
saying it failed, with a Download button — rather than silently skipping, which
is what used to hide the problem.

### Queue modes

Repeat cycles `off → all → one → off`:

- **all** loops the queue when the last track ends,
- **one** replays the current song,
- **off** stops at the end.

Shuffle builds an explicit order over queue indices rather than picking a random
index each time, so a shuffled playlist never repeats the current track, has a
meaningful Previous, and walks the whole queue before wrapping.

Both are reflected in the button (colour, dot, `aria-pressed`) and in a mode line
under the track title, because a mode you cannot see is a mode that looks broken.

### Downloads

"Download" means **save it in the app so it plays offline** — not "put a file in
my Downloads folder". The bytes go into the Cache API and the player reads them
back as a Blob URL. Nothing is handed to the operating system: a browser download
leaves the app, clutters the device, and on iOS drops the user into Files to find
a track they can no longer play.

Source order:

1. **Public Invidious mirrors.** The instance proxies the media, so the bytes are
   readable. That is what makes byte-accurate progress possible, and what lets the
   audio be written as a normal typed response.
2. **video-download-api.com.** Only used when no mirror can serve the bytes. Its
   media host sends no CORS headers, so the response is opaque — it can still be
   stored and replayed.

Downloads are also fetched in parallel byte ranges: public mirrors throttle per
connection (~30 KB/s each), so four ranges turn a 5 MB track from ~166 s into
~18 s. If the server ignores `Range`, the download falls back to one stream.

### Stream URL cache

Resolving a playable URL means asking a mirror, and mirrors are slow and flaky.
Resolved URLs are cached in memory and in `localStorage` (`fp_streams_v1`), with a
real expiry read from the signed `expire` parameter. Downloading or replaying a
track within that window issues **no new resolution request**.

Mirrors sometimes revoke a URL early despite its `expire` value, so a failed
download drops the cached entry and resolves once more before reporting a
failure. The store is capped at 120 tracks to keep `localStorage` small.

### Lyrics and description

Both are lazy: nothing is fetched until the user opens them, and results are
cached in `localStorage`.

- `lyrics.js` parses `Artist - Song (Official Video)` into a query, tries an exact
  LRCLIB match, then a search, then lyrics.ovh.
- Synced lyrics are parsed from LRC and highlighted in time with playback.
- Descriptions come from the same Invidious record playback already needs.

### Library persistence

Likes, recents and playlists store **ids only** — that is what keeps them small.
The track registry that resolves those ids used to live purely in memory, so a
reload left likes showing a count of one with no rows, and playback of them failed
silently. `catalog.js` now mirrors the registry to `localStorage` and hydrates any
missing id from the mirrors.

### Why the iframe

YouTube's own APIs do not allow browser CORS, and every extraction approach needs
either a server or a signing step. The iframe player is the one officially
supported, zero-infrastructure way to play YouTube audio in a browser — it works
on iOS, it is unmuted, and it costs nothing. It plays video too, but the player is
parked off-screen at 1×1 so you only hear audio.

## Modules

| File | Responsibility |
| --- | --- |
| `main.js` | entry: wiring, `__commands` for inline handlers, boot |
| `config.js` | constants, cache names, mirror and provider endpoints |
| `util.js` | DOM/format/storage helpers, safe inline-handler arguments |
| `events.js` | event bus |
| `catalog.js` | track/artist/playlist registry, persistence, hydration |
| `invidious.js` | mirrors: metadata, audio streams, search, channels, playlists |
| `piped.js` | keyless search fallback, multi-instance racing |
| `sources.js` | provider indirection for views |
| `ytplayer.js` | hidden YouTube iframe engine |
| `lyrics.js` | lyrics lookup/parse and track descriptions |
| `player.js` | queue, transport, modes, Media Session, now-playing state |
| `media.js` | download jobs, cache, source fallback, progress |
| `provider.js` | video-download-api client |
| `downloads.js` | download buttons, progress rings, file handoff |
| `actions.js` | command surface used by rendered HTML |
| `router.js` | detail-layer stack |
| `shell.js` | tabs, scroll lock, header |
| `overlays.js` | toast, sheet, modal |
| `device.js` | storage stats, offline mode, download key |
| `views/home.js` `views/search.js` `views/library.js` `views/detail.js` | tab renderers |
| `ui.js` | shared markup |
| `art.js` | generated cover art for artists/playlists |

## Running

```bash
cd server && npm install && npm start   # http://localhost:1234
```

Or drop the folder on any static host. Install on iOS via Share → Add to Home
Screen (needs HTTPS).

### GitHub Pages

The repo deploys itself. `.github/workflows/deploy.yml` publishes the static app
on every push to `main` (or `master`), and `.nojekyll` stops Pages from running
Jekyll over it.

One-time setup, once per repo:

1. Push the folder to GitHub.
2. **Settings → Pages → Build and deployment → Source → GitHub Actions.**
3. Open `https://<user>.github.io/<repo>/` — that is the phone/shareable link.

Nothing is built and no secrets are configured. Only `index.html`, `setup.html`,
`manifest.json`, `sw.js`, `README.md` and `assets/` are published; `server/` is a
dev-only helper and is excluded from the artifact.

The app is written to work from a subpath as well as a domain root, which is what
a project site needs: relative URLs everywhere, `manifest.json` scoped to `./`,
and cache keys and the service worker resolved against the deploy base.

## Download provider key

A built-in key ships in `assets/js/config.js` (`DEFAULT_PROVIDER_KEY`) so
downloads work on a fresh install with nothing to configure. It is part of the
public bundle and must be treated as public.

- A key you set in Setup takes precedence.
- Clearing the field restores the built-in key.
- Downloads still try free public mirrors first, so the key is only touched when
  no mirror can serve a track.

Replace `DEFAULT_PROVIDER_KEY` to ship your own default.

## Notes

- Public mirrors are community-run and go down in waves. Every request walks a
  small list, remembers whichever answered, and gives up quickly on dead hosts.
- Mirror throughput varies a lot (30 KB/s to 3 MB/s). A large track can take a
  couple of minutes; progress is reported in real bytes, and a stalled transfer
  is abandoned so the queue keeps moving.
- Downloaded audio is stored as a typed response, so its size is real. The
  provider fallback is opaque, so its size cannot be inspected on the client.
- The download key lives in `localStorage` and is only read when you download.
- Nothing here is proxied through a server of ours: the app is static, and every
  request goes from the browser to a public mirror, YouTube, or the provider.
