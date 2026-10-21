'use strict';
const {
  DEFAULT_UA, fold, hashId, cleanName, tameCaps, splitYear, yearOf, fetchJson, fetchText, redact, b64decode, pool, LRU,
} = require('./util');
const { parseM3U, classify, EP_RE } = require('./m3u');
const { Epg } = require('./epg');

const TYPES = ['live', 'movie', 'series'];
const PREFIX = { live: 'l', movie: 'm', series: 's', episode: 'e' };
const ADULT_RE = /(\bxxx\b|adult|\b18\s*\+|\+\s*18\b|porn|erotic|for adults|\bsex\b|vuxen)/i;
const KIDS_RE = /(kid|barn|child|cartoon|junior|famil|animat|disney|nick|tecknat|baby|pixar|dreamworks|boomerang)/i;

/* ------------------------------------------------------------------ Xtream */

function normServer(s) {
  let u = String(s || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try {
    const url = new URL(u);
    let p = url.pathname.replace(/\/(player_api\.php|get\.php|xmltv\.php|panel_api\.php|c\/?)$/i, '').replace(/\/+$/, '');
    return url.protocol + '//' + url.host + p;
  } catch (_) { return u.replace(/\/+$/, ''); }
}

class Xtream {
  constructor(server, username, password, ua) {
    this.base = normServer(server);
    this.u = String(username || '').trim();
    this.p = String(password || '').trim();
    this.ua = ua || DEFAULT_UA;
  }
  get secrets() { return [this.u, this.p]; }
  q() { return 'username=' + encodeURIComponent(this.u) + '&password=' + encodeURIComponent(this.p); }
  async api(action, params = {}, timeout = 90000) {
    let url = this.base + '/player_api.php?' + this.q();
    if (action) url += '&action=' + action;
    for (const k of Object.keys(params)) url += '&' + k + '=' + encodeURIComponent(params[k]);
    try {
      return await fetchJson(url, { ua: this.ua, timeout });
    } catch (e) {
      throw new Error(redact(e.message || String(e), this.secrets));
    }
  }
  seg() { return encodeURIComponent(this.u) + '/' + encodeURIComponent(this.p); }
  liveUrl(id, fmt) { return this.base + '/live/' + this.seg() + '/' + id + '.' + (fmt === 'ts' ? 'ts' : 'm3u8'); }
  movieUrl(id, ext) { return this.base + '/movie/' + this.seg() + '/' + id + '.' + (ext || 'mp4'); }
  seriesUrl(id, ext) { return this.base + '/series/' + this.seg() + '/' + id + '.' + (ext || 'mp4'); }
  xmltvUrl() { return this.base + '/xmltv.php?' + this.q(); }
}

/** If someone pastes "http://host/get.php?username=a&password=b&type=m3u_plus" we can use Xtream instead. */
function xtreamFromM3uUrl(u) {
  try {
    const url = new URL(u);
    const user = url.searchParams.get('username');
    const pass = url.searchParams.get('password');
    if (user && pass && /get\.php$/i.test(url.pathname)) {
      return { server: url.protocol + '//' + url.host + url.pathname.replace(/\/get\.php$/i, ''), username: user, password: pass };
    }
  } catch (_) { /* not a url */ }
  return null;
}

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const firstOf = (v) => (Array.isArray(v) ? v.find(Boolean) || '' : str(v));

function durSecs(info) {
  if (!info) return 0;
  if (info.duration_secs) return +info.duration_secs || 0;
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(str(info.duration).trim());
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  if (info.episode_run_time) return +info.episode_run_time * 60;
  return 0;
}

/* ------------------------------------------------------------------ Catalog */

class Catalog {
  constructor(store) {
    this.store = store;
    this.status = { loading: false, stage: '', error: null, at: 0, epgAt: 0, epgCount: 0, epgLoading: false, epgError: null };
    this.data = null;
    this.epg = Epg.fromJSON(store.readCache('epg'));
    this.status.epgAt = this.epg.at;
    this.status.epgCount = this.epg.count;
    this.info = new LRU(800, 6 * 3600e3);
    this.shortEpg = new LRU(3000, 15 * 60e3);
    this.lists = new Map();
    this.epIndex = new Map(); // episodeId → { u?, ext, sid }
    this.raw = null;
    this._loading = null;
  }

  get cfg() { return this.store.config; }
  get opts() { return this.store.config.options; }
  ua() { return (this.opts.userAgent || '').trim() || DEFAULT_UA; }
  xtream() { const x = this.cfg.xtream; return new Xtream(x.server, x.username, x.password, this.ua()); }
  sig() {
    const c = this.cfg;
    return c.source === 'm3u' ? 'm3u|' + c.m3u.url : 'xt|' + normServer(c.xtream.server) + '|' + c.xtream.username + '|' + c.xtream.password;
  }
  secrets() { const c = this.cfg; return [c.xtream.username, c.xtream.password]; }
  ready() { return !!this.data; }

  stage(s) { this.status.stage = s; }

  async load({ force = false } = {}) {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      if (!this.cfg.configured) return;
      const st = this.status;
      st.loading = true;
      st.error = null;
      try {
        let raw = this.raw || this.store.readCache('catalog');
        if (raw && raw.sig !== this.sig()) raw = null;
        if (raw && !this.data) { this.build(raw); st.at = raw.at; }
        const stale = !raw || Date.now() - raw.at > 12 * 3600e3;
        if (force || stale) {
          raw = this.cfg.source === 'm3u' ? await this.fetchM3U() : await this.fetchXtream();
          raw.sig = this.sig();
          raw.at = Date.now();
          this.stage('Sparar…');
          this.store.writeCache('catalog', raw);
          this.build(raw);
          st.at = raw.at;
        }
      } catch (e) {
        st.error = redact(e.message || String(e), this.secrets());
        console.error('[catalog]', st.error);
      } finally {
        st.loading = false;
        st.stage = '';
        this._loading = null;
      }
      if (this.data) this.loadEpg({ force }).catch(() => {});
    })();
    return this._loading;
  }

  async fetchXtream() {
    const x = this.xtream();
    if (!x.base || !x.u) throw new Error('Server och användarnamn saknas');
    this.stage('Ansluter till leverantören…');
    const acct = await x.api('', {}, 30000);
    if (!acct || !acct.user_info || +acct.user_info.auth === 0) throw new Error('Inloggningen misslyckades – kontrollera användarnamn och lösenord');
    const out = { source: 'xtream', live: {}, movie: {}, series: {} };
    const cats = (list) => arr(list).map(c => ({ id: str(c.category_id), name: str(c.category_name) }));

    this.stage('Hämtar kanaler…');
    out.live.cats = cats(await x.api('get_live_categories'));
    out.live.items = arr(await x.api('get_live_streams', {}, 180000)).map(s => ({
      id: str(s.stream_id), n: str(s.name), img: str(s.stream_icon), num: +s.num || 0,
      cat: str(s.category_id), epg: str(s.epg_channel_id), arc: +s.tv_archive ? +s.tv_archive_duration || 1 : 0,
    })).filter(i => i.id);

    this.stage('Hämtar filmer…');
    out.movie.cats = cats(await x.api('get_vod_categories'));
    out.movie.items = arr(await x.api('get_vod_streams', {}, 300000)).map(s => ({
      id: str(s.stream_id), n: str(s.name), img: str(s.stream_icon || s.cover), cat: str(s.category_id),
      r: num(s.rating), add: +s.added || 0, ext: str(s.container_extension) || 'mp4',
      y: yearOf(s.year || s.releaseDate || s.release_date), g: str(s.genre), p: str(s.plot),
      bd: firstOf(s.backdrop_path),
    })).filter(i => i.id);

    this.stage('Hämtar serier…');
    out.series.cats = cats(await x.api('get_series_categories'));
    out.series.items = arr(await x.api('get_series', {}, 300000)).map(s => ({
      id: str(s.series_id), n: str(s.name), img: str(s.cover), cat: str(s.category_id),
      r: num(s.rating), add: +s.last_modified || 0, y: yearOf(s.releaseDate || s.release_date || s.year),
      g: str(s.genre), p: str(s.plot), bd: firstOf(s.backdrop_path),
    })).filter(i => i.id);
    return out;
  }

  async fetchM3U() {
    const url = this.cfg.m3u.url;
    if (!url) throw new Error('M3U-länk saknas');
    this.stage('Hämtar spellistan…');
    let text;
    try { text = await fetchText(url, { ua: this.ua(), timeout: 300000 }); } catch (e) {
      throw new Error(redact(e.message, this.secrets()));
    }
    if (!/#EXTINF/i.test(text.slice(0, 200000))) throw new Error('Länken gav ingen giltig M3U-lista');
    this.stage('Läser spellistan…');
    const { header, entries } = parseM3U(text);
    const out = { source: 'm3u', live: { cats: [], items: [] }, movie: { cats: [], items: [] }, series: { cats: [], items: [] }, eps: {} };
    out.epgUrl = header['url-tvg'] || header['x-tvg-url'] || '';
    const catIds = { live: new Map(), movie: new Map(), series: new Map() };
    const catOf = (type, name) => {
      const n = name || 'Övrigt';
      let id = catIds[type].get(n);
      if (!id) { id = 'g' + hashId(type + '|' + n).slice(0, 8); catIds[type].set(n, id); out[type].cats.push({ id, name: n }); }
      return id;
    };
    const seriesMap = new Map();
    let liveNum = 0;
    for (const e of entries) {
      const c = classify(e);
      const a = e.attrs;
      const logo = a['tvg-logo'] || a.logo || '';
      if (c.type === 'live') {
        liveNum++;
        out.live.items.push({
          id: hashId(e.url), n: e.title, img: logo, num: +a['tvg-chno'] || liveNum,
          cat: catOf('live', e.group), epg: a['tvg-id'] || '', _u: e.url,
        });
      } else if (c.type === 'movie') {
        out.movie.items.push({
          id: hashId(e.url), n: e.title, img: logo, cat: catOf('movie', e.group), r: 0, add: 0,
          ext: (/\.([a-z0-9]{2,4})(\?|$)/i.exec(e.url) || [])[1] || 'mp4', _u: e.url,
        });
      } else {
        const m = c.ep || EP_RE.exec(e.title);
        const sname = (m && m[1].trim()) || e.title;
        const cat = catOf('series', e.group);
        const sid = hashId('s|' + e.group + '|' + fold(sname));
        let s = seriesMap.get(sid);
        if (!s) {
          s = { id: sid, n: sname, img: logo, cat, r: 0, add: 0, y: 0, g: '', p: '' };
          seriesMap.set(sid, s);
          out.series.items.push(s);
          out.eps[sid] = [];
        }
        const se = m ? +m[2] : 1;
        const ep = m ? +m[3] : out.eps[sid].length + 1;
        out.eps[sid].push({
          id: hashId(e.url), sid, se, ep, n: (m && m[4] && m[4].trim()) || 'Avsnitt ' + ep, img: logo,
          ext: (/\.([a-z0-9]{2,4})(\?|$)/i.exec(e.url) || [])[1] || 'mp4', _u: e.url,
        });
      }
    }
    return out;
  }

  /** Build in-memory indexes from raw catalog data (cheap; re-run when options change). */
  build(raw) {
    this.raw = raw;
    const opts = this.opts;
    let kidsRe = KIDS_RE;
    if (opts.kidsPattern) { try { kidsRe = new RegExp(opts.kidsPattern, 'i'); } catch (_) { /* keep default */ } }
    const data = {};
    for (const type of TYPES) {
      const src = raw[type] || { cats: [], items: [] };
      const d = { cats: [], items: [], byId: new Map(), byCat: new Map(), catById: new Map() };
      for (const c of src.cats || []) {
        const cat = { id: c.id, name: (opts.cleanNames ? tameCaps(cleanName(c.name, true)) : c.name) || c.name, raw: c.name, adult: ADULT_RE.test(c.name), kids: kidsRe.test(c.name) };
        if (d.catById.has(cat.id)) continue;
        d.cats.push(cat);
        d.catById.set(cat.id, cat);
        d.byCat.set(cat.id, []);
      }
      for (const r of src.items || []) {
        const it = Object.assign({}, r);
        it.t = type;
        it.k = PREFIX[type] + ':' + it.id;
        let n = cleanName(r.n, opts.cleanNames);
        if (type === 'movie' || type === 'series') {
          const sy = splitYear(n);
          n = sy.n;
          if (!it.y && sy.y) it.y = sy.y;
        }
        it.n = n || r.n || 'Okänd';
        it._f = fold(it.n);
        if (!d.catById.has(it.cat)) {
          const cat = { id: it.cat || '_', name: 'Övrigt', raw: 'Övrigt', adult: false, kids: false };
          it.cat = cat.id;
          if (!d.catById.has(cat.id)) { d.cats.push(cat); d.catById.set(cat.id, cat); d.byCat.set(cat.id, []); }
        }
        if (d.byId.has(it.id)) continue;
        d.byId.set(it.id, it);
        d.items.push(it);
        d.byCat.get(it.cat).push(it);
      }
      if (type === 'live') {
        const hasNum = d.items.some(i => i.num);
        if (hasNum) for (const list of d.byCat.values()) list.sort((a, b) => (a.num || 1e9) - (b.num || 1e9));
      }
      data[type] = d;
    }
    // m3u episodes
    this.epIndex = new Map();
    if (raw.eps) {
      for (const sid of Object.keys(raw.eps)) for (const e of raw.eps[sid]) this.epIndex.set(e.id, { u: e._u, ext: e.ext, sid });
    }
    this.data = data;
    this.lists.clear();
    this.info.clear();
  }

  /* -------------------------------------------------- visibility & lists */

  visibleCats(type, prof) {
    const d = this.data && this.data[type];
    if (!d) return [];
    const hidden = new Set((this.cfg.hidden && this.cfg.hidden[type]) || []);
    const hideAdult = this.opts.hideAdult !== false || (prof && prof.kids);
    return d.cats.filter(c => !hidden.has(c.id) && !(hideAdult && c.adult) && (!(prof && prof.kids) || c.kids) && d.byCat.get(c.id).length);
  }

  profKey(prof) {
    const h = this.cfg.hidden || {};
    return (prof && prof.kids ? 'k' : 'a') + (this.opts.hideAdult !== false ? 1 : 0) + ':' + (h.live || []).length + '.' + (h.movie || []).length + '.' + (h.series || []).length;
  }

  invalidate() { this.lists.clear(); }

  list(type, cat, prof) {
    const d = this.data && this.data[type];
    if (!d) return [];
    if (cat && cat !== 'all' && cat !== 'recent' && cat !== 'top') {
      const vis = this.visibleCats(type, prof).some(c => c.id === cat);
      return vis ? d.byCat.get(cat) || [] : [];
    }
    const key = type + '|' + (cat || 'all') + '|' + this.profKey(prof);
    let l = this.lists.get(key);
    if (l) return l;
    if (!cat || cat === 'all') {
      l = [];
      for (const c of this.visibleCats(type, prof)) for (const it of d.byCat.get(c.id)) l.push(it);
    } else if (cat === 'recent') {
      l = this.list(type, 'all', prof).filter(i => i.add > 0).sort((a, b) => b.add - a.add).slice(0, 300);
    } else if (cat === 'top') {
      const minY = new Date().getFullYear() - 8;
      l = this.list(type, 'all', prof).filter(i => i.r > 0 && i.r <= 10 && (!i.y || i.y >= minY)).sort((a, b) => b.r - a.r || b.add - a.add).slice(0, 300);
    }
    // dedupe (an item can appear in several categories in some m3u lists)
    const seen = new Set();
    l = l.filter(i => (seen.has(i.k) ? false : (seen.add(i.k), true)));
    this.lists.set(key, l);
    return l;
  }

  get(type, id) {
    const d = this.data && this.data[type];
    return d ? d.byId.get(String(id)) : undefined;
  }

  catName(type, cat) {
    const d = this.data && this.data[type];
    const c = d && d.catById.get(cat);
    return c ? c.name : '';
  }

  search(q, prof, limit = 40) {
    const tokens = fold(q).split(/\s+/).filter(Boolean);
    const out = {};
    for (const type of TYPES) {
      if (!tokens.length) { out[type] = []; continue; }
      const full = tokens.join(' ');
      const hits = [];
      for (const it of this.list(type, 'all', prof)) {
        const f = it._f;
        let ok = true;
        for (const t of tokens) if (f.indexOf(t) < 0) { ok = false; break; }
        if (!ok) continue;
        const score = f.startsWith(full) ? 0 : (' ' + f).indexOf(' ' + tokens[0]) >= 0 ? 1 : 2;
        hits.push([score, it]);
      }
      hits.sort((a, b) => a[0] - b[0] || a[1].n.length - b[1].n.length);
      out[type] = hits.slice(0, limit).map(h => h[1]);
    }
    return out;
  }

  /* -------------------------------------------------- details */

  async movieInfo(id) {
    const it = this.get('movie', id);
    if (!it) return null;
    const key = 'm:' + id;
    const cached = this.info.get(key);
    if (cached) return cached;
    let res = { ...it };
    if (this.cfg.source === 'xtream') {
      try {
        const r = await this.xtream().api('get_vod_info', { vod_id: id }, 20000);
        const info = (r && r.info) || {};
        const md = (r && r.movie_data) || {};
        res = {
          ...it,
          p: str(info.plot || info.description) || it.p,
          g: str(info.genre) || it.g,
          cast: str(info.cast || info.actors),
          dir: str(info.director),
          y: it.y || yearOf(info.releasedate || info.release_date || info.year),
          r: it.r || num(info.rating),
          dur: durSecs(info),
          bd: firstOf(info.backdrop_path) || it.bd,
          img: it.img || str(info.movie_image || info.cover_big),
          ext: str(md.container_extension) || it.ext,
          trailer: str(info.youtube_trailer),
          age: str(info.age || info.mpaa_rating),
        };
      } catch (e) { /* fall back to basic item */ }
    }
    this.info.set(key, res);
    return res;
  }

  async seriesInfo(id) {
    const it = this.get('series', id);
    if (!it) return null;
    const key = 's:' + id;
    const cached = this.info.get(key);
    if (cached) return cached;
    let res;
    if (this.cfg.source === 'xtream') {
      const r = await this.xtream().api('get_series_info', { series_id: id }, 30000);
      const info = (r && r.info) || {};
      const epsBy = (r && r.episodes) || {};
      const seasonMeta = {};
      for (const s of arr(r && r.seasons)) seasonMeta[+s.season_number] = s;
      const seasons = [];
      const keys = Object.keys(epsBy).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
      for (const sn of keys) {
        const eps = arr(epsBy[sn]).map((e, i) => {
          const ei = e.info || {};
          const epNum = +e.episode_num || i + 1;
          let title = str(e.title).trim();
          const m = /S\d{1,2}\s*E\d{1,4}\s*[-–:]?\s*(.*)$/i.exec(title);
          if (m) title = m[1].trim();
          if (!title || fold(title) === fold(it.n)) title = 'Avsnitt ' + epNum;
          const ep = {
            k: 'e:' + e.id, t: 'episode', id: str(e.id), sid: it.id, sn: it.n, se: sn, ep: epNum, n: title,
            img: str(ei.movie_image || ei.cover_big) || '', p: str(ei.plot), dur: durSecs(ei),
            ext: str(e.container_extension) || 'mp4',
          };
          this.epIndex.set(ep.id, { ext: ep.ext, sid: it.id });
          return ep;
        }).sort((a, b) => a.ep - b.ep);
        if (eps.length) seasons.push({ n: sn, name: str(seasonMeta[sn] && seasonMeta[sn].name) || 'Säsong ' + sn, eps });
      }
      res = {
        ...it,
        p: str(info.plot) || it.p, g: str(info.genre) || it.g, cast: str(info.cast), dir: str(info.director),
        y: it.y || yearOf(info.releaseDate || info.release_date), r: it.r || num(info.rating),
        bd: firstOf(info.backdrop_path) || it.bd, img: it.img || str(info.cover), trailer: str(info.youtube_trailer),
        seasons,
      };
    } else {
      const eps = ((this.raw && this.raw.eps && this.raw.eps[id]) || []).map(e => ({
        k: 'e:' + e.id, t: 'episode', id: e.id, sid: it.id, sn: it.n, se: e.se, ep: e.ep, n: e.n, img: e.img, p: '', dur: 0, ext: e.ext,
      }));
      const bySeason = new Map();
      for (const e of eps) { if (!bySeason.has(e.se)) bySeason.set(e.se, []); bySeason.get(e.se).push(e); }
      const seasons = [...bySeason.keys()].sort((a, b) => a - b).map(n => ({ n, name: 'Säsong ' + n, eps: bySeason.get(n).sort((a, b) => a.ep - b.ep) }));
      res = { ...it, seasons };
    }
    this.info.set(key, res);
    return res;
  }

  /** Provider URL for something playable. */
  streamUrl(type, id, ext) {
    const xt = this.cfg.source === 'xtream';
    if (type === 'live') {
      const it = this.get('live', id);
      if (!it) return null;
      if (xt) {
        const x = this.xtream();
        return { primary: x.liveUrl(id, this.opts.liveFormat === 'ts' ? 'ts' : 'm3u8'), alt: x.liveUrl(id, this.opts.liveFormat === 'ts' ? 'm3u8' : 'ts') };
      }
      return { primary: it._u };
    }
    if (type === 'movie') {
      const it = this.get('movie', id);
      if (!it) return null;
      return { primary: xt ? this.xtream().movieUrl(id, safeExt(ext) || it.ext) : it._u, ext: safeExt(ext) || it.ext };
    }
    if (type === 'episode') {
      const e = this.epIndex.get(String(id));
      if (xt) { const x = (e && e.ext) || safeExt(ext) || 'mp4'; return { primary: this.xtream().seriesUrl(id, x), ext: x }; }
      return e ? { primary: e.u, ext: e.ext } : null;
    }
    return null;
  }

  /* -------------------------------------------------- EPG */

  epgUrl() {
    if (this.opts.epgUrl) return this.opts.epgUrl;
    if (this.cfg.source === 'xtream') return this.xtream().xmltvUrl();
    return this.cfg.m3u.epgUrl || (this.raw && this.raw.epgUrl) || '';
  }

  async loadEpg({ force = false } = {}) {
    const st = this.status;
    if (st.epgLoading) return;
    const url = this.epgUrl();
    if (!url) return;
    if (!force && this.epg.at && Date.now() - this.epg.at < 8 * 3600e3 && this.epg.count) return;
    st.epgLoading = true;
    st.epgError = null;
    try {
      const wanted = new Set();
      for (const it of this.data.live.items) if (it.epg) wanted.add(it.epg);
      const e = new Epg();
      await e.load(url, { wanted, ua: this.ua() });
      this.epg = e;
      st.epgAt = e.at;
      st.epgCount = e.count;
      this.store.writeCache('epg', e.toJSON());
    } catch (e) {
      st.epgError = redact(e.message || String(e), this.secrets());
      console.error('[epg]', st.epgError);
    } finally { st.epgLoading = false; }
  }

  /** now/next for a set of live ids, using XMLTV if available and Xtream short EPG as fallback. */
  async nowNext(ids) {
    const out = {};
    const need = [];
    const now = Date.now();
    for (const id of ids) {
      const it = this.get('live', id);
      if (!it) continue;
      if (it.epg && this.epg.has(it.epg)) { out[id] = this.epg.nowNext(it.epg, now); continue; }
      const c = this.shortEpg.get(id);
      if (c) { out[id] = pickNowNext(c, now); continue; }
      if (this.cfg.source === 'xtream') need.push(id);
    }
    if (need.length) {
      const x = this.xtream();
      await pool(need.slice(0, 40), 4, async (id) => {
        let list = [];
        try {
          const r = await x.api('get_short_epg', { stream_id: id, limit: 4 }, 8000);
          list = arr(r && r.epg_listings).map(p => ({
            t: b64decode(p.title), d: b64decode(p.description),
            s: (+p.start_timestamp || Date.parse(p.start)) * (p.start_timestamp ? 1000 : 1),
            e: (+p.stop_timestamp || Date.parse(p.end || p.stop)) * (p.stop_timestamp ? 1000 : 1),
          })).filter(p => p.s && p.e).sort((a, b) => a.s - b.s);
        } catch (_) { /* no epg */ }
        this.shortEpg.set(id, list);
        out[id] = pickNowNext(list, now);
      });
    }
    return out;
  }

  async channelGuide(id, hours = 12) {
    const it = this.get('live', id);
    if (!it) return [];
    const now = Date.now();
    if (it.epg && this.epg.has(it.epg)) return this.epg.range(it.epg, now - 3600e3, now + hours * 3600e3);
    await this.nowNext([id]);
    return this.shortEpg.get(id) || [];
  }
}

function pickNowNext(list, now) {
  if (!list || !list.length) return null;
  let cur = null;
  let next = null;
  for (const p of list) {
    if (p.s <= now && p.e > now) cur = p;
    else if (p.s > now && !next) next = p;
  }
  return { now: cur, next };
}

function safeExt(e) { return /^[a-z0-9]{2,5}$/i.test(String(e || '')) ? String(e).toLowerCase() : ''; }

module.exports = { Catalog, Xtream, normServer, xtreamFromM3uUrl, ADULT_RE, KIDS_RE, PREFIX };
