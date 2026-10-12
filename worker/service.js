export const USER_AGENT = 'slot-cart-studio/0.1 (https://studio.slot-cfw.fyi/)';
const DAY = 86400000;
const escape = (value) => value.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, '\\$1');

export function searchQuery(artist, album) {
  return `releasegroup:"${escape(album)}"${artist ? ` AND artist:"${escape(artist)}"` : ''}`;
}

export function normalizeCandidates(data) {
  if (!Array.isArray(data['release-groups'])) throw new Error('Invalid MusicBrainz response');
  const seen = new Set();
  return data['release-groups'].filter((group) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(group.id) || seen.has(group.id)) return false;
    seen.add(group.id);
    return true;
  }).map((group) => ({
    id: group.id,
    title: String(group.title ?? ''),
    artist: (group['artist-credit'] ?? []).map((credit) => typeof credit === 'string' ? credit :
      `${credit.name ?? credit.artist?.name ?? ''}${credit.joinphrase ?? ''}`).join(''),
    year: String(group['first-release-date'] ?? '').slice(0, 4),
    type: String(group['primary-type'] ?? ''),
    score: Number(group.score) || 0,
    sourceUrl: `https://musicbrainz.org/release-group/${group.id}`,
  })).sort((a, b) => b.score - a.score || Number(b.type === 'Album') - Number(a.type === 'Album') || a.title.localeCompare(b.title)).slice(0, 8);
}

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

// A single named Durable Object paces all clients using the hosted lookup service.
export class MusicSearch {
  constructor(state) {
    this.state = state;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.ready = state.blockConcurrencyWhile(async () => { this.lastStart = await state.storage.get('lastStart') ?? 0; });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const artist = (url.searchParams.get('artist') ?? '').trim().normalize('NFC');
    const album = (url.searchParams.get('album') ?? '').trim().normalize('NFC');
    if (!album || album.length > 200 || artist.length > 200) return json({ error: 'Enter an album title and an optional artist, up to 200 characters each.' }, 400);
    const key = `search:${JSON.stringify([artist.toLowerCase(), album.toLowerCase()])}`;
    const hit = await this.state.storage.get(key);
    if (hit?.expires > Date.now()) return json(hit.result, 200, { 'Cache-Control': 'public, max-age=86400' });
    if (this.pending >= 8) return json({ error: 'Search is busy. Try again shortly.' }, 429, { 'Retry-After': '3' });
    this.pending++;
    const result = this.tail.then(async () => {
      // Recheck after waiting: duplicate searches share a result without another upstream call.
      const cached = await this.state.storage.get(key);
      if (cached?.expires > Date.now()) return json(cached.result, 200, { 'Cache-Control': 'public, max-age=86400' });
      const delay = Math.max(0, this.lastStart + 1100 - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastStart = Date.now();
      await this.state.storage.put('lastStart', this.lastStart);
      const upstream = new URL('https://musicbrainz.org/ws/2/release-group/');
      upstream.searchParams.set('query', searchQuery(artist, album));
      upstream.searchParams.set('fmt', 'json');
      upstream.searchParams.set('limit', '8');
      try {
        const response = await fetch(upstream, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          const busy = [429, 503].includes(response.status);
          return json({ error: 'MusicBrainz is unavailable. Try again later.' }, busy ? 503 : 502,
            busy ? { 'Retry-After': response.headers.get('Retry-After') ?? '3' } : {});
        }
        const body = { candidates: normalizeCandidates(await response.json()) };
        await this.state.storage.put(key, { expires: Date.now() + DAY, result: body });
        if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(Date.now() + 3600000);
        return json(body, 200, { 'Cache-Control': 'public, max-age=86400' });
      } catch {
        return json({ error: 'Album search could not reach MusicBrainz.' }, 502);
      }
    });
    this.tail = result.catch(() => {});
    try { return await result; }
    finally { this.pending--; }
  }

  async alarm() {
    let startAfter;
    do {
      const entries = await this.state.storage.list({ prefix: 'search:', limit: 500, ...(startAfter ? { startAfter } : {}) });
      const expired = [...entries].filter(([, value]) => value.expires <= Date.now()).map(([key]) => key);
      for (let i = 0; i < expired.length; i += 100) await this.state.storage.delete(expired.slice(i, i + 100));
      startAfter = entries.size === 500 ? [...entries.keys()].at(-1) : null;
    } while (startAfter);
    await this.state.storage.setAlarm(Date.now() + 3600000);
  }
}

export default {
  async fetch(request, env) {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return json({ error: 'Use GET for album search' }, 405, { ...headers, Allow: 'GET, OPTIONS' });
    if (new URL(request.url).pathname !== '/api/music/search') return json({ error: 'Not found' }, 404, headers);
    try {
      const response = await env.MUSIC_SEARCH.get(env.MUSIC_SEARCH.idFromName('musicbrainz-v1')).fetch(request);
      const output = new Response(response.body, response);
      for (const [name, value] of Object.entries(headers)) output.headers.set(name, value);
      return output;
    } catch {
      return json({ error: 'Album search is unavailable. You can still import a cover.' }, 503, { ...headers, 'Retry-After': '3' });
    }
  },
};
