'use strict';
/**
 * What is on the family's streaming services (Netflix, Max, Disney+, Prime Video) in Sweden, via themoviedb.org
 * (its "where to watch" data comes from JustWatch). Needs a free TMDB key (v3 API key or v4 read token) in the
 * settings. Used for search ("Finns på Netflix") and suggestions; the apps themselves play the titles.
 */
const BASE = () => (process.env.TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/$/, '');
const IMG = process.env.TMDB_IMG || 'https://image.tmdb.org/t/p/';
const REGION = 'SE';

const SERVICES = {
  netflix: { name: 'Netflix', re: /^netflix$/i, id: 8, color: '#e50914',
    web: (t) => 'https://www.netflix.com/search?q=' + encodeURIComponent(t) },
  max: { name: 'HBO Max', re: /^(hbo )?max$/i, id: 1899, color: '#002be7',
    web: (t) => 'https://play.hbomax.com/search?q=' + encodeURIComponent(t) },
  disney: { name: 'Disney+', re: /^disney ?(plus|\+)$/i, id: 337, color: '#113ccf',
    web: (t) => 'https://www.disneyplus.com/search?q=' + encodeURIComponent(t) },
  prime: { name: 'Prime Video', re: /^amazon prime video$|^prime video$/i, id: 119, color: '#00a8e1',
    web: (t) => 'https://www.primevideo.com/search/ref=atv_nb_sug?phrase=' + encodeURIComponent(t) },
};

class Services {
  constructor(getOpts) {
    this.getOpts = getOpts; // () => ({ tmdbKey, services })
    this.cache = new Map();
    this.ids = null; // provider id → service key
    this.idsAt = 0;
    this.lastError = '';
  }

  key() { return String((this.getOpts().tmdbKey) || '').trim(); }
  enabled() { return !!this.key(); }
  chosen() {
    const s = this.getOpts().services;
    return (Array.isArray(s) && s.length ? s : Object.keys(SERVICES)).filter(k => SERVICES[k]);
  }

  async get(path, params = {}, ttl = 6 * 3600e3) {
    const key = this.key();
    if (!key) throw new Error('Ingen TMDB-nyckel');
    const u = new URL(BASE() + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    const bearer = key.length > 60; // v4 read access tokens are long JWTs; v3 keys are 32 hex characters
    if (!bearer) u.searchParams.set('api_key', key);
    const ck = u.toString();
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const r = await fetch(u, { headers: bearer ? { Authorization: 'Bearer ' + key, accept: 'application/json' } : { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (r.status === 401) { this.lastError = 'TMDB-nyckeln fungerar inte'; throw new Error(this.lastError); }
    if (!r.ok) throw new Error('TMDB svarade ' + r.status);
    const v = await r.json();
    this.lastError = '';
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(ck, { at: Date.now(), v });
    return v;
  }

  /** Provider ids for Sweden, looked up by name (they rarely change; the built-in ids are the fallback). */
  async providerIds() {
    if (this.ids && Date.now() - this.idsAt < 7 * 86400e3) return this.ids;
    const ids = new Map();
    for (const [k, s] of Object.entries(SERVICES)) ids.set(s.id, k);
    try {
      for (const kind of ['movie', 'tv']) {
        const r = await this.get('/watch/providers/' + kind, { watch_region: REGION, language: 'sv-SE' }, 7 * 86400e3);
        for (const p of r.results || []) for (const [k, s] of Object.entries(SERVICES)) if (s.re.test(p.provider_name || '')) ids.set(p.provider_id, k);
      }
    } catch (_) { /* keep the built-in ids */ }
    this.ids = ids;
    this.idsAt = Date.now();
    return ids;
  }

  /** Which of the chosen services have the title in Sweden (subscription, not rent/buy). */
  async where(mt, id) {
    const ids = await this.providerIds();
    const r = await this.get('/' + mt + '/' + id + '/watch/providers', {}, 12 * 3600e3);
    const se = (r.results || {})[REGION] || {};
    const chosen = new Set(this.chosen());
    const out = [];
    for (const p of (se.flatrate || []).concat(se.ads || [])) {
      const k = ids.get(p.provider_id);
      if (k && chosen.has(k) && !out.includes(k)) out.push(k);
    }
    return out;
  }

  item(r, mt, svc) {
    const n = r.title || r.name || r.original_title || r.original_name || '';
    const date = r.release_date || r.first_air_date || '';
    return {
      t: 'ext', mt, id: String(r.id), k: 'x:' + (mt === 'tv' ? 's' : 'm') + r.id, n,
      y: date ? +date.slice(0, 4) || 0 : 0,
      img: r.poster_path ? IMG + 'w342' + r.poster_path : '',
      bd: r.backdrop_path ? IMG + 'w1280' + r.backdrop_path : '',
      p: r.overview || '', r: r.vote_average ? Math.round(r.vote_average * 10) / 10 : 0,
      svc: svc || [],
    };
  }

  /** Attach "where" to a list of TMDB results, a few at a time, keeping only titles on the chosen services. */
  async withWhere(list, limit) {
    const out = [];
    const queue = list.slice();
    const work = async () => {
      while (queue.length && out.length < limit) {
        const x = queue.shift();
        try {
          const svc = await this.where(x.mt, x.r.id);
          if (svc.length) out.push({ i: x.i, it: this.item(x.r, x.mt, svc) });
        } catch (e) { if (/nyckeln/.test(e.message)) throw e; }
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    return out.sort((a, b) => a.i - b.i).map(x => x.it).slice(0, limit);
  }

  /** Search titles on the services. */
  async search(q, { limit = 16 } = {}) {
    q = String(q || '').trim();
    if (q.length < 2) return [];
    const r = await this.get('/search/multi', { query: q, language: 'sv-SE', region: REGION, include_adult: 'false' }, 3600e3);
    const list = (r.results || []).filter(x => (x.media_type === 'movie' || x.media_type === 'tv') && (x.poster_path || x.backdrop_path))
      .slice(0, 24).map((x, i) => ({ i, r: x, mt: x.media_type }));
    return this.withWhere(list, limit);
  }

  /**
   * Suggestions: more like what the profile liked or watched (TMDB recommendations), then what's popular,
   * all on the chosen services. seeds: [{ mt, id }] (TMDB ids of liked titles), skip: Set of TMDB keys to leave out.
   */
  async suggest({ seeds = [], skip = new Set(), limit = 24 } = {}) {
    const ids = await this.providerIds();
    const chosen = this.chosen();
    const want = [...ids.entries()].filter(([, k]) => chosen.includes(k)).map(([id]) => id);
    const pool = [];
    const seen = new Set(skip);
    const add = (x, mt, because) => {
      const key = (mt === 'tv' ? 's' : 'm') + x.id;
      if (seen.has(key) || !(x.poster_path || x.backdrop_path)) return;
      seen.add(key);
      pool.push({ i: pool.length, r: x, mt, because });
    };
    for (const sd of seeds.slice(0, 4)) {
      try {
        const r = await this.get('/' + sd.mt + '/' + sd.id + '/recommendations', { language: 'sv-SE' }, 24 * 3600e3);
        for (const x of (r.results || []).slice(0, 10)) add(x, sd.mt, sd.n);
      } catch (e) { if (/nyckeln/.test(e.message)) throw e; }
    }
    for (const mt of ['movie', 'tv']) {
      try {
        const r = await this.get('/discover/' + mt, { watch_region: REGION, with_watch_providers: want.join('|'), with_watch_monetization_types: 'flatrate',
          sort_by: 'popularity.desc', language: 'sv-SE', 'vote_count.gte': 50 }, 12 * 3600e3);
        for (const x of (r.results || []).slice(0, 14)) add(x, mt, '');
      } catch (e) { if (/nyckeln/.test(e.message)) throw e; }
    }
    // the liked-based ones first, but mixed in with popular ones so the row isn't all one kind
    const liked = pool.filter(x => x.because), pop = pool.filter(x => !x.because);
    const mixed = [];
    while (liked.length || pop.length) { if (liked.length) mixed.push(liked.shift()); if (liked.length) mixed.push(liked.shift()); if (pop.length) mixed.push(pop.shift()); }
    mixed.forEach((x, i) => { x.i = i; });
    const items = await this.withWhere(mixed, limit);
    for (const it of items) { const p = mixed.find(x => String(x.r.id) === it.id); if (p && p.because) it.because = 'Eftersom du gillade ' + p.because; }
    return items;
  }

  /** Details for one title, with the services and a link per service. */
  async detail(mt, id) {
    const r = await this.get('/' + mt + '/' + id, { language: 'sv-SE', append_to_response: 'credits' }, 24 * 3600e3);
    const svc = await this.where(mt, id);
    const it = this.item(r, mt, svc);
    it.g = (r.genres || []).map(g => g.name).slice(0, 3).join(', ');
    it.dur = r.runtime ? r.runtime * 60 : 0;
    it.seasons = r.number_of_seasons || 0;
    it.cast = ((r.credits && r.credits.cast) || []).slice(0, 6).map(c => c.name).join(', ');
    it.links = svc.map(k => ({ svc: k, name: SERVICES[k].name, url: SERVICES[k].web(it.n) }));
    return it;
  }
}

function serviceInfo() {
  const out = {};
  for (const [k, s] of Object.entries(SERVICES)) out[k] = { name: s.name, color: s.color };
  return out;
}

module.exports = { Services, SERVICES, serviceInfo };
