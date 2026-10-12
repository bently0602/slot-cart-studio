# Music lookup service

The Worker routes `studio.slot-cfw.fyi/api/music/*` to one SQLite-backed Durable Object named
`musicbrainz-v1`. It searches MusicBrainz release groups with escaped artist/title terms and an
identifying User-Agent. Blank artist fields allow album-only queries. Up to eight normalized
candidates include ID, title, credited artist, year, type, score, and MusicBrainz source URL.
Results sort by score, with albums preferred on ties.

The singleton serializes upstream calls at least 1100 ms apart, retaining the last start time
in durable storage across restarts. Eight requests may be active/queued; overflow receives
429 with `Retry-After: 3`. Successful queries cache for 24 hours; failures are never cached.
Hourly alarms remove expired entries. CORS permits both the hosted studio and desktop localhost.
This service receives artist and album text only; audio and cover bytes stay outside it.

## Setup and deploy

Use a Cloudflare account that owns the `slot-cfw.fyi` zone and supports SQLite Durable Objects.
From the repository root:

```bash
npm ci
npx wrangler login
npm test
npx wrangler deploy --dry-run --outdir out/worker
npx wrangler deploy
curl -i 'https://studio.slot-cfw.fyi/api/music/search?artist=Daft%20Punk&album=Discovery'
```

For unattended deployment, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
environment. The token needs Worker script, Durable Object, and zone Worker route permissions.
The `v1` migration creates the namespace. Preserve it and the singleton name in later releases
so hosted website clients share one pacing queue. MusicBrainz requires no API key for this search.

Verify HTTP 200, up to eight candidates, HTTPS source URLs, and `Access-Control-Allow-Origin: *`.
Repeat the query to exercise the cache. Confirm the Worker route takes precedence over the
studio's static Pages site. Then release the website. The desktop app uses its own Rust lookup
server and does not require this Worker. Publish SNES artwork before releasing the updated studio.

## Local development

```bash
npx wrangler dev --port 8787
./run.sh
```

Open `http://127.0.0.1:8765/?musicApi=http://127.0.0.1:8787/api/music/`. Local Durable Object
storage is under `.wrangler/` and is ignored by Git. Unit tests mock MusicBrainz responses;
browser tests mock search/cover providers and use synthetic audio/images. Selected front covers
are fetched in the browser from Cover Art Archive over HTTPS at 250 pixels for suggestions and
1200 pixels after selection. A cover 404 is an unavailable image; other failures permit retry,
edited search, or manual import.

References: [MusicBrainz API requirements](https://musicbrainz.org/doc/MusicBrainz_API),
[Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API),
[music-metadata browser parser](https://github.com/Borewit/music-metadata).
