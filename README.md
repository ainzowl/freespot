# FreePot

A Spotify-shaped PWA for music from YouTube, installable on iOS. **100% static
and browser-only** — no database, no accounts, and **nothing to configure before
you can listen.**

```
index.html      shell: header, tabs, dock, mini player, now playing
setup.html      optional: storage and source configuration
manifest.json   PWA manifest
sw.js           shell cache + serving downloaded audio offline
assets/
  css/          base, artwork, chrome, home, lists, player, overlays
  js/           ES modules (see below)
  icons/        app icons (SVG + PNG set for iOS)
server/         dev-only static server + local CORS relay
relay/          Cloudflare Worker relay (production)
scripts/        headless boot test
```

## How it works

| What | How | Cost |
| --- | --- | --- |
| **Playback** | DownVid first, then a public Invidious mirror, then the YouTube iframe | Free |
| **Downloads** | DownVid first, Invidious mirrors second, paid provider last | Free, or paid per job |
| **Search / artists / playlists / trending** | Public Invidious mirrors, Piped as a fallback | Free, keyless |
| **Lyrics** | LRCLIB (synced where available), lyrics.ovh fallback | Free, keyless |
| **Description** | The Invidious video record already used for playback | Free, keyless |

Listening never touches the paid provider. Downloads are a deliberate, separate
action you opt into.

> **Mirror availability.** Public Invidious instances are community-run and go
> down in waves; at the time of writing all four configured mirrors were returning
> `404`/`401`/`403`. That is exactly why DownVid is the primary source and the
> mirrors are a fallback rather than the other way round.

### Source order

Every playable thing tries its sources in the same order, and each failure is
silent so the next one gets a turn rather than the user getting an error:

1. **Downloaded audio.** Always wins. Works offline, seeks instantly.
2. **DownVid.** The primary source. It resolves a search result to a finished
   audio file rather than a signed stream URL, so it still works for tracks whose
   mirrors have expired, are rate-limited, or are simply down — which is the
   common state of the public mirrors.
3. **Public Invidious mirror.** The instance proxies the media, so the URL is
   CORS-readable with real duration, seeking and an `ended` event.
4. **Hidden YouTube iframe.** The official, zero-infrastructure fallback.

If every engine fails, the player **stops on the track** and shows a card saying
it failed, with a Download button — rather than silently skipping, which is what
used to hide the problem.

#### Why DownVid playback caches first

DownVid's file URL **cannot back a seekable audio element**, for two verified
reasons:

| Behaviour | Consequence |
| --- | --- |
| **Single-use** — a second `GET` returns `404` | the element cannot re-request |
| **Ignores `Range`** — a ranged request returns `200` with the whole body | the element cannot ask for a slice |

Measured: an element pointed straight at the URL started playing but a seek to
150 s stayed at 3 s. Only the **cached** copy is a proper seekable source, so
playback fetches the file into the Cache API first and plays from there. That
fetch takes 4–20 s depending on upstream speed, so the subtitle reports real
progress (`Finding audio… → Preparing… → Loading 62%`) instead of looking hung,
and every later play of that track starts in under 100 ms. A cached track seeks
cleanly (verified 1.7 s → 121 s).

The engines run **strictly in sequence**. They share one `<audio>` element, so
running DownVid and a mirror attempt at the same time clobbers the source the
other just loaded — the mirror's dead-instance probing reassigns `audioEl.src`
mid-flight and leaves the track silently stalled.

### Why there is a relay

DownVid sends **no CORS headers at all** — verified against the live service on
every endpoint, including `OPTIONS`. A browser therefore cannot read its
responses from any other origin, which is every deployment of this app.

So the API is reached through a small relay that fetches it server-side and
re-serves the response with the headers a browser needs:

- **Development:** `server/index.js` mounts it at `/__relay`, so running the dev
  server is all that is needed.
- **Production:** deploy `relay/worker.js` as a Cloudflare Worker
  (`npx wrangler deploy`) and set the URL in **Downloads** settings, or pass
  `?relay=https://…` once.

The relay injects the `x-client-id` header the API requires, and proxies only
`/api/music/`, `/api/progress/` and `/api/file/`. See `relay/README.md`.

### Downloads that survive a locked screen

A phone locks its screen, the app is switched away from, the OS freezes the page.
Every timer stops — and when it wakes, all the timers that "should" have fired
while it was gone fire at once. That used to abort perfectly healthy transfers,
which is why downloads died the moment the screen went off.

`media.js` no longer trusts wall-clock timers. Deadlines run on an **awake-time
clock** that only advances while the page is visible, so a request paused for two
minutes in a pocket has spent none of its timeout budget. Alongside that:

- a watchdog requeues any transfer that has been silent for two minutes of awake
  time, and rebuilds the concurrency counter that a frozen page can leave stuck;
- the mirror downloader stores each 256 KB chunk as it arrives, so an interrupted
  job resumes from its stored parts instead of starting over;
- pending jobs are persisted to `localStorage`, so a reload, a crash or a
  suspension picks them back up;
- nothing new starts while the page is asleep.

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

### Session restore

What is playing, the queue, and the position are written to `localStorage` as
playback advances, and restored on launch **paused at the same second** — one tap
resumes. Playback is never forced on launch: browsers block audio until a gesture,
and silently starting sound is hostile.

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

### Bottom chrome on iOS

`env(safe-area-inset-*)` is evaluated against the layout viewport, and on iOS it
is not stable: it reads `0` at first paint, then `34px` once the toolbar collapses
or the standalone PWA settles. A `position: fixed` dock computed from a one-shot
`env()` therefore sits ~30px too high on some launches and correctly on others.

`assets/js/viewport.js` measures the real insets at runtime and republishes them
as custom properties (`--sab`, `--sat`, `--vvh`, `--vlh`, `--vvo`) on `<html>`,
re-measuring on resize, rotation, `visualViewport` changes and a settle burst after
load. CSS reads `var(--sab, env(…))`, so `env()` is only the pre-script fallback.
The dock and the mini player are both positioned from the same `--dock-space`, so
they cannot overlap or gap.

## Modules

| File | Responsibility |
| --- | --- |
| `main.js` | entry: wiring, `__commands` for inline handlers, boot |
| `config.js` | constants, cache names, mirror and provider endpoints |
| `util.js` | DOM/format/storage helpers, safe inline-handler arguments |
| `events.js` | event bus |
| `viewport.js` | measured safe-area + visual-viewport custom properties |
| `catalog.js` | track/artist/playlist registry, persistence, hydration |
| `downvid.js` | DownVid client: search, prepare, stream, download |
| `invidious.js` | mirrors: metadata, audio streams, search, channels, playlists |
| `piped.js` | keyless search fallback, multi-instance racing |
| `sources.js` | provider indirection for views |
| `ytplayer.js` | hidden YouTube iframe engine |
| `lyrics.js` | lyrics lookup/parse and track descriptions |
| `player.js` | queue, transport, modes, Media Session, now-playing state |
| `media.js` | download jobs, source fallback, resumable chunks, suspend-safe clock |
| `provider.js` | video-download-api client |
| `downloads.js` | download buttons, progress rings, file handoff |
| `actions.js` | command surface used by rendered HTML |
| `router.js` | detail-layer stack |
| `shell.js` | tabs, scroll lock, header |
| `overlays.js` | toast, sheet, modal |
| `device.js` | storage stats, offline mode, relay and key config |
| `views/home.js` `views/search.js` `views/library.js` `views/detail.js` | tab renderers |
| `ui.js` | shared markup |
| `art.js` | generated cover art for artists/playlists |

## Running

```bash
cd server && npm install && npm start   # http://localhost:1234
```

That serves the app **and** its local relay, so downloads and playback work with
nothing else running. Or drop the folder on any static host — but then deploy
`relay/` too, or DownVid is skipped and the app falls back to the mirrors.

Install on iOS via Share → Add to Home Screen (needs HTTPS).

### Boot test

```bash
cd server && npm install
node ../scripts/boot-test.js
```

Loads the app in real Chrome and fails on any console error, unhandled rejection,
failed module load, or a dock that is not anchored to the bottom. `CHROME_PATH`
overrides the browser.

### GitHub Pages

The repo deploys itself. `.github/workflows/deploy.yml` publishes the static app
on every push to `main` (or `master`), and `.nojekyll` stops Pages from running
Jekyll over it.

One-time setup, once per repo:

1. Push the folder to GitHub.
2. **Settings → Pages → Build and deployment → Source → GitHub Actions.**
3. Open `https://<user>.github.io/<repo>/` — that is the phone/shareable link.
4. Deploy `relay/` (`cd relay && npx wrangler deploy`) and set the URL in the
   app's Downloads settings, or the app will not be able to reach DownVid.

Nothing is built and no secrets are configured. Only `index.html`, `setup.html`,
`manifest.json`, `sw.js`, `README.md` and `assets/` are published; `server/`,
`relay/` and `scripts/` are excluded from the artifact.

The app is written to work from a subpath as well as a domain root, which is what
a project site needs: relative URLs everywhere, `manifest.json` scoped to `./`,
and cache keys and the service worker resolved against the deploy base.

## Fallback download provider key

A built-in key ships in `assets/js/config.js` (`DEFAULT_PROVIDER_KEY`) so the
last-resort download path works on a fresh install with nothing to configure. It
is part of the public bundle and must be treated as public.

- A key you set in Downloads settings takes precedence.
- Clearing the field restores the built-in key.
- Downloads try DownVid and the free mirrors first, so the key is only touched
  when nothing else can serve a track.

Replace `DEFAULT_PROVIDER_KEY` to ship your own default.

## Notes

- Public mirrors are community-run and go down in waves. Every request walks a
  small list, remembers whichever answered, and gives up quickly on dead hosts.
- Mirror throughput varies a lot (30 KB/s to 3 MB/s). A large track can take a
  couple of minutes; progress is reported in real bytes, and a stalled transfer
  is abandoned so the queue keeps moving.
- Downloaded audio is stored as a typed response, so its size is real. The
  provider fallback is opaque, so its size cannot be inspected on the client.
- Nothing is proxied through a server of ours in the ordinary path: the app is
  static, and requests go from the browser to a public mirror or to YouTube. The
  one exception is the DownVid relay, which exists solely because that API omits
  CORS headers.

