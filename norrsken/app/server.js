#!/usr/bin/env node
'use strict';
/*
 * Norrsken – IPTV-app för Titan OS (Philips) och andra smart-TV-webbläsare.
 * Kör på en dator/server i hemnätverket. TV:n öppnar http://<server>:8787/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Store } = require('./lib/store');
const { Catalog, Xtream, xtreamFromM3uUrl, normServer, dedupe } = require('./lib/provider');
const { Proxy } = require('./lib/proxy');
const ff = require('./lib/ffmpeg');
const qr = require('./lib/qr');
const { redact, fetchText, pool } = require('./lib/util');
const pkg = require('./package.json');

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const SETUP_PIN = process.env.SETUP_PIN || '';

const store = new Store(DATA_DIR);
const catalog = new Catalog(store);
const proxy = new Proxy();

/* ------------------------------------------------------------------ helpers */

function parseCaps(s) {
  const caps = {};
  for (const c of String(s || '').split(',')) if (/^\w+$/.test(c)) caps[c] = true;
  return caps;
}

/** Path prefix when opened through Home Assistant's ingress (the 'Open web UI' button). */
function ingressBase(req) {
  const p = String(req.headers['x-ingress-path'] || '');
  return /^\/api\/hassio_ingress\/[\w-]+$/.test(p) ? p : '';
}

const JSON_REPLACER = (k, v) => (k && k[0] === '_' ? undefined : v);

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, JSON_REPLACER);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const bad = (res, msg, status = 400) => send(res, status, { error: msg });

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('för stor')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      if (!t) return resolve({});
      try { resolve(JSON.parse(t)); } catch (e) { reject(new Error('ogiltig JSON')); }
    });
    req.on('error', reject);
  });
}

function profileOf(q) { return store.profile(q.get('profile') || ''); }

/* PIN-locked profiles: a correct PIN gives the device a token that playback then requires. */
function pinSecret() {
  if (!store.config.pinSecret) { store.config.pinSecret = require('crypto').randomBytes(16).toString('hex'); store.saveConfig(); }
  return store.config.pinSecret;
}
function profToken(p) { return require('crypto').createHmac('sha256', pinSecret()).update(p.id + ':' + p.pin).digest('hex').slice(0, 24); }
function pinOk(q, prof) { return !prof.pin || q.get('pt') === profToken(prof); }

function snapshot(it) {
  if (!it || !it.t) return null;
  const s = {};
  for (const k of ['k', 't', 'id', 'n', 'img', 'bd', 'num', 'cat', 'epg', 'y', 'r', 'sid', 'sn', 'se', 'ep', 'ext', 'dur', 'g']) if (it[k] !== undefined && it[k] !== '' && it[k] !== 0) s[k] = it[k];
  if (typeof s.n === 'string') s.n = s.n.slice(0, 200);
  return s;
}

/* ------------------------------------------------------------------ pages */

const ROW_KIND = { live: 'live', movie: 'poster', series: 'poster' };
const INITIAL = 24;

function row(id, title, kind, items, extra = {}) {
  return { id, title, kind, total: items.length, items: items.slice(0, extra.limit || INITIAL), ...extra };
}

/** Watched to the end? Films with long credits count as seen before the very last second. */
function isDone(pos, dur, t) {
  if (!(dur > 0)) return false;
  const left = dur - pos;
  const credits = t === 'episode' ? 120 : dur > 3600 ? 420 : 180;
  return pos / dur >= 0.92 || (left <= credits && pos / dur > 0.6);
}

function continueItems(st) {
  return Object.values(st.progress)
    .filter(p => p && p.item && (p.upnext || (p.dur > 0 && p.pos > 15 && !isDone(p.pos, p.dur, p.item.t))))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30)
    .map(p => {
      const it = { ...p.item, pos: p.pos, dur: p.dur || p.item.dur || 0, upnext: !!p.upnext };
      // episodes show the series' poster and backdrop, like the other rows
      if (it.t === 'episode' && it.sid) {
        const s = catalog.get('series', it.sid);
        if (s) { it.still = it.img; it.img = s.img || it.img; it.bd = it.bd || s.bd; it.sn = it.sn || s.n; it.r = it.r || s.r; it.y = it.y || s.y; it.g = it.g || s.g; }
      }
      return it;
    });
}

function catRow(type, cat, prof, title, loadItems = true) {
  const list = type === 'live' ? catalog.list(type, cat, prof) : dedupe(catalog.list(type, cat, prof));
  if (!list.length) return null;
  return { id: type + ':' + cat, title, kind: ROW_KIND[type], type, cat, total: list.length, items: loadItems ? list.slice(0, INITIAL) : [] };
}

function homePage(prof, st) {
  const rows = [];
  const cw = continueItems(st);
  if (cw.length) rows.push(row('cw', 'Fortsätt titta', 'poster', cw, { limit: 30 }));
  const ml = st.myList.map(m => m.item).filter(Boolean);
  const mlv = ml.filter(i => i.t !== 'live');
  if (mlv.length) rows.push(row('ml', 'Min lista', 'poster', mlv, { limit: 60 }));
  const mine = myChannels(st);
  if (mine.length) rows.push(row('rc', 'Mina kanaler', 'live', mine, { limit: 30 }));
  // skip a row that mostly repeats one already on the page (e.g. the provider's own "New films" category)
  const push = (r) => {
    if (!r) return;
    const ks = r.items.slice(0, 20).map(i => i._nk || i.k);
    if (ks.length >= 5 && rows.some(o => { const s = new Set((o.items || []).slice(0, 40).map(i => i._nk || i.k)); return ks.filter(k => s.has(k)).length / ks.length >= 0.8; })) return;
    rows.push(r);
  };
  push(catRow('movie', 'recent', prof, 'Nyligen tillagda filmer'));
  const liveCats = catalog.visibleCats('live', prof);
  if (liveCats[0] && !mine.length) push(catRow('live', liveCats[0].id, prof, 'Live: ' + liveCats[0].name));
  push(catRow('series', 'recent', prof, 'Nya och uppdaterade serier'));
  const top = dedupe(catalog.list('movie', 'top', prof)).slice(0, 10);
  if (top.length >= 5) rows.push({ id: 'top10', title: 'Topp 10 filmer med högst betyg', kind: 'top10', total: top.length, items: top });
  const mc = catalog.visibleCats('movie', prof).filter(c => catalog.list('movie', c.id, prof).length >= 6).slice(0, 8);
  const sc = catalog.visibleCats('series', prof).filter(c => catalog.list('series', c.id, prof).length >= 6).slice(0, 6);
  for (let i = 0; i < Math.max(mc.length, sc.length); i++) {
    if (mc[i]) push(catRow('movie', mc[i].id, prof, mc[i].name));
    if (sc[i]) push(catRow('series', sc[i].id, prof, sc[i].name));
  }
  if (!rows.length) {
    for (const c of liveCats.slice(0, 6)) push(catRow('live', c.id, prof, c.name));
  }
  return rows;
}

/** Favourite channels first, then recently watched ones (no duplicates). */
function myChannels(st) {
  const fav = st.myList.map(m => m.item).filter(i => i && i.t === 'live');
  const seen = new Set(fav.map(i => i.k));
  return fav.concat(st.recent.filter(i => !seen.has(i.k)));
}

function typePage(type, prof, st) {
  const rows = [];
  if (type === 'live') {
    const fav = st.myList.map(m => m.item).filter(i => i && i.t === 'live');
    if (fav.length) rows.push(row('fav', 'Favoriter', 'live', fav, { limit: 200 }));
    if (st.recent.length) rows.push(row('rc', 'Senast tittade', 'live', st.recent, { limit: 20 }));
  }
  if (type === 'movie' || type === 'series') {
    const cats = catalog.visibleCats(type, prof).map(c => ({ k: 'cat:' + c.id, t: 'cat', id: c.id, type, label: c.name, value: c.id }));
    if (cats.length > 1) rows.push({ id: 'cats', title: 'Kategorier', kind: 'pill', total: cats.length, items: cats });
  }
  if (type === 'movie') {
    const r1 = catRow('movie', 'recent', prof, 'Nyligen tillagt');
    const r2 = catRow('movie', 'top', prof, 'Högst betyg');
    if (r1) rows.push(r1);
    if (r2) rows.push(r2);
  }
  if (type === 'series') { const r = catRow('series', 'recent', prof, 'Nya och uppdaterade'); if (r) rows.push(r); }
  const cats = catalog.visibleCats(type, prof);
  cats.forEach((c, i) => {
    const r = catRow(type, c.id, prof, c.name, i < 6);
    if (r) rows.push(r);
  });
  return rows;
}

function myListPage(st) {
  const items = st.myList.map(m => m.item).filter(Boolean);
  const vod = items.filter(i => i.t !== 'live');
  const live = items.filter(i => i.t === 'live');
  const rows = [];
  const per = 7;
  for (let i = 0; i < vod.length; i += per) rows.push({ id: 'ml' + i, title: i ? '' : 'Filmer och serier', kind: 'poster', total: Math.min(per, vod.length - i), items: vod.slice(i, i + per), grid: true });
  if (live.length) rows.push(row('mll', 'Kanaler', 'live', live, { limit: 200 }));
  return rows;
}

/** Candidates for the big billboard at the top of a page. */
function featured(page, prof) {
  const pick = [];
  const take = (type, n) => {
    const recent = catalog.list(type, 'recent', prof);
    const src = recent.length ? recent : catalog.list(type, 'all', prof);
    for (const it of src.slice(0, 40)) { if (it.img || it.bd) pick.push(it); if (pick.length >= n) break; }
  };
  if (page === 'home') { take('series', 6); take('movie', 12); }
  else if (page === 'movie') take('movie', 12);
  else if (page === 'series') take('series', 12);
  // items with a wide backdrop make the best billboards
  pick.sort((a, b) => (b.bd ? 1 : 0) - (a.bd ? 1 : 0));
  return pick.slice(0, 10);
}

/* ------------------------------------------------------------------ images */

const imgCache = new (require('./lib/util').LRU)(500, 24 * 3600e3);
let imgBytes = 0;
async function serveImage(req, res, u) {
  let url;
  try { url = new URL(u); } catch (_) { return bad(res, 'url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad(res, 'url');
  const hit = imgCache.get(u);
  const head = { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' };
  if (hit) { res.writeHead(200, { ...head, 'Content-Type': hit.type, 'Content-Length': hit.buf.length }); return res.end(hit.buf); }
  try {
    const { r, done } = await require('./lib/util').fetchRaw(u, { ua: catalog.ua(), timeout: 15000 });
    try {
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\//i.test(type)) { res.writeHead(404, head); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 6e6) { res.writeHead(413, head); return res.end(); }
      if (buf.length < 600e3) {
        if (imgBytes > 80e6) { imgCache.clear(); imgBytes = 0; }
        imgCache.set(u, { buf, type });
        imgBytes += buf.length;
      }
      res.writeHead(200, { ...head, 'Content-Type': type, 'Content-Length': buf.length });
      res.end(buf);
    } finally { done(); }
  } catch (_) {
    if (!res.headersSent) { res.writeHead(502, head); res.end(); }
  }
}

/* ------------------------------------------------------------------ status */

function lanUrls() {
  const out = [];
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push('http://' + n.address + ':' + PORT);
    }
  }
  const rank = (u) => (/\/\/192\.168\./.test(u) ? 0 : /\/\/10\./.test(u) ? 1 : /\/\/172\.(1[6-9]|2\d|3[01])\./.test(u) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

function status() {
  const s = catalog.status;
  const d = catalog.data;
  return {
    version: pkg.version,
    appName: store.config.options.appName || 'Norrsken',
    configured: !!store.config.configured,
    ready: catalog.ready(),
    loading: s.loading,
    stage: s.stage,
    error: s.error,
    at: s.at,
    counts: d ? { live: d.live.items.length, movie: d.movie.items.length, series: d.series.items.length } : null,
    epg: { at: s.epgAt, count: s.epgCount, loading: s.epgLoading, error: s.epgError },
    ffmpeg: ff.has(),
    previews: store.config.options.previews || 'sound',
    parentPin: (store.config.profiles || []).some(p => !p.kids && p.pin),
    profiles: publicProfiles(),
    pinRequired: !!SETUP_PIN,
    urls: process.env.PUBLIC_URL ? [process.env.PUBLIC_URL.replace(/\/$/, '')] : lanUrls(),
  };
}

/* ------------------------------------------------------------------ setup */

function publicConfig() {
  const c = store.config;
  return {
    configured: c.configured,
    source: c.source,
    xtream: { server: c.xtream.server, username: c.xtream.username, hasPassword: !!c.xtream.password },
    m3u: { url: c.m3u.url, epgUrl: c.m3u.epgUrl },
    profiles: publicProfiles(),
    options: c.options,
  };
}

/** Profiles as shown to devices: never the PIN itself. */
function publicProfiles() {
  return (store.config.profiles || []).map(p => ({ id: p.id, name: p.name, color: p.color, kids: !!p.kids, hasPin: !!p.pin }));
}

function checkPin(req, res) {
  if (!SETUP_PIN) return true;
  if (req.headers['x-pin'] === SETUP_PIN) return true;
  bad(res, 'Fel PIN-kod', 401);
  return false;
}

function cleanProfiles(list) {
  const out = [];
  const used = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    const name = String(p.name || '').trim().slice(0, 24);
    if (!name) continue;
    let id = String(p.id || '').replace(/[^\w-]/g, '').slice(0, 20) || 'p' + Math.random().toString(36).slice(2, 8);
    while (used.has(id)) id += 'x';
    used.add(id);
    const old = (store.config.profiles || []).find(o => o.id === id) || {};
    let pin = p.pin === undefined || p.pin === null ? old.pin || '' : String(p.pin).replace(/\D/g, '').slice(0, 4);
    if (pin && pin.length !== 4) pin = '';
    out.push({ id, name, color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#35d0a0', kids: !!p.kids, pin });
    if (out.length >= 8) break;
  }
  return out.length ? out : [{ id: 'p1', name: 'Jag', color: '#35d0a0', kids: false }];
}

async function testConnection(body) {
  const ua = (body.options && body.options.userAgent) || store.config.options.userAgent || '';
  if (body.source === 'm3u') {
    const url = String((body.m3u && body.m3u.url) || '').trim();
    if (!url) throw new Error('Ange en M3U-länk');
    const text = await fetchText(url, { ua: ua || undefined, timeout: 120000 });
    const n = (text.match(/#EXTINF/g) || []).length;
    if (!n) throw new Error('Länken gav ingen giltig M3U-lista');
    return { ok: true, entries: n };
  }
  const x = body.xtream || {};
  const pass = x.password || store.config.xtream.password;
  const xt = new Xtream(x.server, x.username, pass, ua || undefined);
  if (!xt.base || !xt.u) throw new Error('Ange server och användarnamn');
  const r = await xt.api('', {}, 20000);
  if (!r || !r.user_info) throw new Error('Inget svar från servern – kontrollera adressen');
  const u = r.user_info;
  if (+u.auth === 0) throw new Error('Fel användarnamn eller lösenord');
  return {
    ok: true,
    status: u.status || '',
    exp: u.exp_date ? +u.exp_date * 1000 : 0,
    maxConnections: +u.max_connections || 0,
    activeConnections: +u.active_cons || 0,
    trial: u.is_trial === '1' || u.is_trial === 1,
  };
}

/* ------------------------------------------------------------------ routes */

const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler });
}

route('GET', '/api/status', (req, res) => ok(res, status()));

route('GET', '/img', (req, res, q) => serveImage(req, res, q.get('u') || ''));

route('GET', '/api/qr.svg', (req, res, q) => {
  const text = (q.get('text') || '').slice(0, 300);
  try { send(res, 200, qr.svg(text || 'http://localhost'), 'image/svg+xml', { 'Cache-Control': 'max-age=3600' }); } catch (e) { bad(res, e.message); }
});

route('GET', '/api/page/:page', (req, res, q, p) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  const st = store.profileState(prof.id);
  let rows;
  if (p.page === 'home') rows = homePage(prof, st);
  else if (p.page === 'mylist') rows = myListPage(st);
  else if (['live', 'movie', 'series'].includes(p.page)) rows = typePage(p.page, prof, st);
  else return bad(res, 'okänd sida', 404);
  ok(res, { rows, featured: featured(p.page, prof) });
});

route('GET', '/api/list', (req, res, q) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  const type = q.get('type');
  if (!['live', 'movie', 'series'].includes(type)) return bad(res, 'type');
  let list = type === 'live' ? catalog.list(type, q.get('cat') || 'all', prof) : dedupe(catalog.list(type, q.get('cat') || 'all', prof));
  const sort = q.get('sort');
  if (sort === 'new') list = list.slice().sort((a, b) => (b.add || 0) - (a.add || 0));
  else if (sort === 'rating') list = list.slice().sort((a, b) => (b.r || 0) - (a.r || 0));
  else if (sort === 'az') list = list.slice().sort((a, b) => a.n.localeCompare(b.n, 'sv'));
  const offset = Math.max(0, +q.get('offset') || 0);
  const limit = Math.min(3000, Math.max(1, +q.get('limit') || 40));
  ok(res, { total: list.length, items: list.slice(offset, offset + limit) });
});

route('GET', '/api/cats/:type', (req, res, q, p) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  ok(res, catalog.visibleCats(p.type, prof).map(c => ({ id: c.id, name: c.name, total: catalog.list(p.type, c.id, prof).length })));
});

route('GET', '/api/item/:type/:id', (req, res, q, p) => {
  const it = catalog.get(p.type, decodeURIComponent(p.id));
  if (!it) return bad(res, 'hittades inte', 404);
  ok(res, it);
});

route('GET', '/api/info/:type/:id', async (req, res, q, p) => {
  const id = decodeURIComponent(p.id);
  try {
    const info = p.type === 'series' ? await catalog.seriesInfo(id) : await catalog.movieInfo(id);
    if (!info) return bad(res, 'hittades inte', 404);
    const vs = p.type === 'movie' || p.type === 'series' ? catalog.versions(p.type, id, profileOf(q)) : [];
    const extra = { catName: catalog.catName(p.type, info.cat), versions: vs.length > 1 ? vs : undefined };
    ok(res, { ...info, ...extra });
  } catch (e) { bad(res, redact(e.message, catalog.secrets()), 502); }
});

route('GET', '/api/epg/now', async (req, res, q) => {
  const ids = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 80);
  ok(res, await catalog.nowNext(ids));
});

route('GET', '/api/epg/channel/:id', async (req, res, q, p) => {
  ok(res, await catalog.channelGuide(decodeURIComponent(p.id), Math.min(36, +q.get('hours') || 12), Math.min(72, +q.get('back') || 0)));
});

route('GET', '/api/search', (req, res, q) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const r = catalog.search(q.get('q') || '', profileOf(q));
  ok(res, { live: r.live, movie: r.movie, series: r.series });
});

route('GET', '/api/state/:profile', (req, res, q, p) => {
  const st = store.profileState(store.profile(p.profile).id);
  ok(res, {
    myList: st.myList.map(m => m.item && m.item.k).filter(Boolean),
    progress: Object.fromEntries(Object.entries(st.progress).map(([k, v]) => [k, { pos: v.pos, dur: v.dur, ts: v.ts, upnext: !!v.upnext }])),
    seen: st.seen || {},
    reminders: (st.reminders || []).filter(r => r.s > Date.now() - 15 * 60e3),
  });
});

route('POST', '/api/state/:profile/mylist', async (req, res, q, p) => {
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  const item = snapshot(b.item);
  if (!item) return bad(res, 'item');
  st.myList = st.myList.filter(m => m.item && m.item.k !== item.k);
  if (b.on) st.myList.unshift({ item, ts: Date.now() });
  st.myList = st.myList.slice(0, 500);
  store.saveState();
  ok(res, { on: !!b.on });
});

route('POST', '/api/state/:profile/progress', async (req, res, q, p) => {
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  const item = snapshot(b.item);
  if (!item || item.t === 'live') return bad(res, 'item');
  const pos = Math.max(0, +b.pos || 0);
  const dur = Math.max(0, +b.dur || 0);
  // one entry per series in "Fortsätt titta"
  if (item.sid) for (const k of Object.keys(st.progress)) if (k !== item.k && st.progress[k].item && st.progress[k].item.sid === item.sid) delete st.progress[k];
  const done = b.seen ? true : isDone(pos, dur, item.t);
  if (done) {
    markSeen(st, item.k, true);
    delete st.progress[item.k];
    if (item.t === 'episode' && item.sid) {
      try {
        const s = await catalog.seriesInfo(item.sid);
        const all = (s && s.seasons ? s.seasons : []).flatMap(x => x.eps);
        const i = all.findIndex(e => e.id === item.id);
        const nx = i >= 0 ? all[i + 1] : null;
        if (nx) st.progress[nx.k] = { item: snapshot({ ...nx, sn: s.n, bd: s.bd, img: nx.img || s.img }), pos: 0, dur: nx.dur || 0, ts: Date.now(), upnext: true };
      } catch (_) { /* no next */ }
    }
  } else {
    st.progress[item.k] = { item, pos, dur, ts: Date.now() };
  }
  // cap history
  const keys = Object.keys(st.progress);
  if (keys.length > 400) keys.sort((a, b) => st.progress[a].ts - st.progress[b].ts).slice(0, keys.length - 400).forEach(k => delete st.progress[k]);
  store.saveState();
  ok(res, { done });
});

route('POST', '/api/state/:profile/forget', async (req, res, q, p) => {
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  delete st.progress[String(b.k || '')];
  store.saveState();
  ok(res, { ok: true });
});

route('POST', '/api/state/:profile/recent', async (req, res, q, p) => {
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  const item = snapshot(b.item);
  if (!item || item.t !== 'live') return bad(res, 'item');
  st.recent = [item, ...st.recent.filter(i => i.k !== item.k)].slice(0, 20);
  store.saveState();
  ok(res, { ok: true });
});

route('POST', '/api/profile/:id/unlock', async (req, res, q, p) => {
  const b = await readBody(req);
  const prof = (store.config.profiles || []).find(x => x.id === p.id);
  if (!prof) return bad(res, 'profil', 404);
  const all = store.config.profiles || [];
  const from = all.find(x => x.id === b.from);
  // accepted codes: the profile's own PIN; leaving a kids profile also takes any parent's PIN
  const codes = [];
  if (prof.pin) codes.push(prof.pin);
  if (from && from.kids && !prof.kids) for (const x of all) if (!x.kids && x.pin) codes.push(x.pin);
  if (!codes.length || codes.includes(String(b.pin || ''))) return ok(res, { ok: true, token: prof.pin ? profToken(prof) : '' });
  await new Promise(r => setTimeout(r, 600)); // slow down guessing
  bad(res, 'Fel PIN-kod', 403);
});

route('POST', '/api/state/:profile/reminders', async (req, res, q, p) => {
  // reminders follow the profile, so one set on the phone also pops up on the TV
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  st.reminders = (Array.isArray(b.list) ? b.list : []).slice(0, 100).map(r => ({
    ch: snapshot(r.ch), s: +r.s || 0, t: String(r.t || '').slice(0, 200), done: !!r.done,
  })).filter(r => r.ch && r.s > Date.now() - 15 * 60e3);
  store.saveState();
  ok(res, { ok: true, n: st.reminders.length });
});

function markSeen(st, k, on) {
  if (!st.seen) st.seen = {};
  if (on) st.seen[k] = Date.now(); else delete st.seen[k];
  const keys = Object.keys(st.seen);
  if (keys.length > 3000) keys.sort((a, b) => st.seen[a] - st.seen[b]).slice(0, keys.length - 3000).forEach(x => delete st.seen[x]);
}

route('POST', '/api/state/:profile/seen', async (req, res, q, p) => {
  // mark as watched: same as reaching the end (series move on to the next episode); on:false marks as unwatched
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  if (Array.isArray(b.keys)) { // a whole season
    for (const k of b.keys.slice(0, 500)) { markSeen(st, String(k), b.on !== false); delete st.progress[String(k)]; }
    store.saveState();
    return ok(res, { ok: true });
  }
  const item = snapshot(b.item);
  if (!item) return bad(res, 'item');
  if (b.on === false) { markSeen(st, item.k, false); store.saveState(); return ok(res, { ok: true }); }
  markSeen(st, item.k, true);
  delete st.progress[item.k];
  if (item.t === 'episode' && item.sid) {
    try {
      const s = await catalog.seriesInfo(item.sid);
      const all = (s && s.seasons ? s.seasons : []).flatMap(x => x.eps);
      const i = all.findIndex(e => e.id === item.id);
      const nx = i >= 0 ? all[i + 1] : null;
      if (nx) st.progress[nx.k] = { item: snapshot({ ...nx, sn: s.n, bd: s.bd, img: nx.img || s.img }), pos: 0, dur: nx.dur || 0, ts: Date.now(), upnext: true };
    } catch (_) { /* no next */ }
  }
  store.saveState();
  ok(res, { ok: true });
});

/* "Skip intro": learned from how people in the household jump past the intro. Shared by all devices; shown once
   two jumps agree (within 15 s), using their median. A skip followed by jumping back counts against it. */
function introOf(sid) {
  const obs = ((store.state.intro || {})[sid] || []).filter(o => !o.bad);
  if (obs.length < 2) return null;
  let best = null;
  for (const o of obs) {
    const near = obs.filter(x => Math.abs(x.to - o.to) <= 15);
    if (near.length >= 2 && (!best || near.length > best.length)) best = near;
  }
  if (!best) return null;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { from: Math.max(0, med(best.map(x => x.from)) - 3), to: med(best.map(x => x.to)), n: best.length };
}
route('GET', '/api/intro/:sid', (req, res, q, p) => ok(res, introOf(decodeURIComponent(p.sid)) || {}));
route('POST', '/api/intro/:sid', async (req, res, q, p) => {
  const b = await readBody(req);
  const sid = decodeURIComponent(p.sid).slice(0, 40);
  const all = store.state.intro = store.state.intro || {};
  let list = all[sid] || [];
  if (b.bad) {
    // they skipped and then went back: forget the observations that made us show it
    const cur = introOf(sid);
    if (cur) list = list.filter(x => Math.abs(x.to - cur.to) > 15);
  } else {
    const from = +b.from, to = +b.to;
    if (!(from >= 0 && to - from >= 20 && to - from <= 180 && from <= 420)) return bad(res, 'intervall');
    list.push({ from, to, ts: Date.now() });
  }
  all[sid] = list.slice(-8);
  const keys = Object.keys(all);
  if (keys.length > 2000) delete all[keys[0]];
  store.saveState();
  ok(res, introOf(sid) || {});
});

route('GET', '/api/similar/:type/:id', async (req, res, q, p) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  const type = p.type === 'series' ? 'series' : 'movie';
  const id = decodeURIComponent(p.id);
  let base = catalog.get(type, id);
  if (!base) return ok(res, { items: [] });
  try { base = (type === 'series' ? await catalog.seriesInfo(id) : await catalog.movieInfo(id)) || base; } catch (_) { /* basic */ }
  const gs = new Set(String(base.g || '').toLowerCase().split(/[,/|&]/).map(x => x.trim()).filter(Boolean));
  const scored = [];
  for (const it of catalog.list(type, 'all', prof)) {
    if (it.id === base.id) continue;
    let sc = 0;
    if (it.cat === base.cat) sc += 2;
    for (const g of String(it.g || '').toLowerCase().split(/[,/|&]/)) if (gs.has(g.trim())) sc += 3;
    if (base.y && it.y && Math.abs(base.y - it.y) <= 5) sc += 1;
    if (it.r) sc += Math.min(2, it.r / 5);
    if (sc > 2) scored.push([sc, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const baseKey = (catalog.get(type, id) || {})._nk;
  ok(res, { items: dedupe(scored.map(x => x[1]).filter(x => !baseKey || x._nk !== baseKey)).slice(0, 30) });
});

let preparing = false;
let lastStreamAt = 0;
catalog.isBusy = () => Date.now() - lastStreamAt < 15 * 60e3 || ff.activeSessions() > 0;
route('POST', '/api/prepare/:type/:id', (req, res, q, p) => {
  // Read the file's format in the background so pressing Play starts faster – but never at the cost of a
  // provider connection someone needs: one at a time, not while anything plays, not on 1–2 connection accounts.
  const maxConn = (catalog.data && catalog.data.maxConn) || 0;
  const busy = preparing || Date.now() - lastStreamAt < 20000 || ff.activeSessions() > 0 || (maxConn && maxConn <= 2);
  if (!busy && catalog.ready() && ff.has() && (p.type === 'movie' || p.type === 'episode')) {
    const src = catalog.streamUrl(p.type, decodeURIComponent(p.id), q.get('ext'));
    if (src && src.primary) {
      preparing = true;
      proxy.allow(src.primary);
      ff.probe(src.primary, catalog.ua()).catch(() => {}).then(() => { preparing = false; });
    }
  }
  ok(res, { ok: true, skipped: busy });
});

route('GET', '/api/stream/:type/:id', async (req, res, q, p) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const type = p.type;
  const id = decodeURIComponent(p.id);
  const prof = profileOf(q);
  if (prof.kids && !catalog.allowed(type, id, prof)) return bad(res, 'Det här finns inte i barnprofilen', 403);
  if (!pinOk(q, prof)) return bad(res, 'Profilen är låst – välj den igen och ange PIN-koden', 401);
  lastStreamAt = Date.now();
  let src = catalog.streamUrl(type, id, q.get('ext'));
  if (type === 'live' && q.get('start')) src = catalog.timeshiftUrl(id, +q.get('start'), +q.get('dur') || 60) || src;
  if (!src || !src.primary) return bad(res, 'Kunde inte hitta strömmen', 404);
  const tok = (u) => { proxy.allow(u); return proxy.token(u); };
  const ing = ingressBase(req);
  const pathOf = (u) => proxy.path(u, ing);
  const kindOf = (u) => (/\.m3u8?(\?|$)/i.test(u) ? 'hls' : /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg)(\?|$)/i.test(u) ? 'file' : 'ts');
  // Direct = the TV fetches from the provider itself (fastest, no detour via this server).
  // Proxied = via this server (works even when the provider blocks browsers). The player tries them in order.
  const direct = store.config.options.directPlay !== 'off';
  const both = (kind, u) => {
    const out = [];
    if (direct) out.push({ kind, url: u, direct: true });
    out.push({ kind, url: pathOf(u) });
    return out;
  };
  if (type === 'live' && src.timeshift) {
    // MPEG-TS first; the same archive as HLS for devices without MPEG-TS support (iPhone, some TVs)
    const hls = src.primary.replace(/\.ts$/, '.m3u8');
    return ok(res, { live: false, catchup: true, sources: both('ts', src.primary).concat(both('hls', hls)) });
  }
  if (type === 'live') {
    const k1 = kindOf(src.primary);
    let list = both(k1, src.primary);
    if (src.alt) list = list.concat(both(kindOf(src.alt), src.alt));
    else if (k1 === 'ts') list.push({ kind: 'file', url: pathOf(src.primary) });
    return ok(res, { live: true, sources: list });
  }
  const ext = String(src.ext || '').toLowerCase();
  const nativeOk = ['mp4', 'm4v', 'mov', 'webm'].includes(ext);
  const t = tok(src.primary);
  const sources = [];
  const files = both('file', src.primary);
  const remux = { kind: 'remux', url: ing + '/rx/play.m3u8?t=' + t };
  if (nativeOk) sources.push(...files);
  else {
    // MKV/AVI: let the TV try the file itself if it says it can play the container, otherwise remux on the server
    if (direct) sources.push({ ...files[0], needs: ext === 'avi' ? 'video/x-msvideo' : 'video/x-matroska' });
    if (ff.has()) sources.push(remux);
    sources.push(files[files.length - 1]);
  }
  if (nativeOk && ff.has()) sources.push(remux);
  // Look inside the file: if its sound (DTS, TrueHD…) or picture can't be played on this screen as it is,
  // start with the converter instead of letting the screen play silent video or fail.
  let order = sources;
  let info = null;
  if (ff.has()) {
    const caps = parseCaps(q.get('caps'));
    try { info = await Promise.race([ff.probe(src.primary, catalog.ua()), new Promise((_, no) => setTimeout(() => no(new Error('t')), 7000))]); } catch (_) { /* unknown: keep order */ }
    const o = store.config.options;
    if (info && !ff.playsAsIs(info, caps, { audioMode: o.audioMode, maxRes: o.maxRes })) order = [remux, ...sources.filter(x => x !== remux)];
  }
  ok(res, { live: false, sources: order, t: ff.has() ? t : '', ext, media: info ? { h: info.height, v: info.video, a: (info.audio[0] || {}).codec, ch: (info.audio[0] || {}).ch } : null });
});

route('GET', '/api/probe', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  try { ok(res, await ff.probe(url, catalog.ua())); } catch (e) { bad(res, e.message, 502); }
});

route('GET', '/remux', (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  const o = store.config.options;
  ff.remux(req, res, url, { ss: Math.max(0, +q.get('ss') || 0), a: +q.get('a') || 0, ua: catalog.ua(), audioMode: o.audioMode, maxRes: o.maxRes, caps: parseCaps(q.get('caps')) });
});

// Converted playback as HLS: works in every browser, including Safari and iPhone
route('GET', '/rx/play.m3u8', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const t = q.get('t') || '';
  const url = proxy.untoken(t);
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  const o = store.config.options;
  try {
    const s = await ff.hlsSession(url, { group: t, ss: Math.max(0, +q.get('ss') || 0), a: +q.get('a') || 0, ua: catalog.ua(),
      audioMode: o.audioMode, maxRes: o.maxRes, caps: parseCaps(q.get('caps')), safe: q.get('safe') === '1' });
    const text = await ff.hlsPlaylist(s, ingressBase(req) + '/rx');
    send(res, 200, text, 'application/vnd.apple.mpegurl', { 'Access-Control-Allow-Origin': '*' });
  } catch (e) { bad(res, e.message, 502); }
});

route('POST', '/rx/stop', (req, res, q) => { ff.stopGroup(q.get('t') || ''); ok(res, { ok: true }); });

route('GET', '/rx/:id/:name', (req, res, q, p) => {
  const f = ff.hlsFile(p.id, p.name);
  if (!f) return bad(res, 'slut', 404);
  fs.stat(f, (err, st) => {
    if (err) return bad(res, 'saknas', 404);
    res.writeHead(200, { 'Content-Type': p.name.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
});

route('GET', '/subs', (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  ff.subs(req, res, url, { s: +q.get('s') || 0, ss: Math.max(0, +q.get('ss') || 0), ua: catalog.ua() });
});

route('POST', '/api/diag', async (req, res) => {
  const b = await readBody(req);
  console.log('[spelare ' + String(b.d || '?').slice(0, 20) + ']', String(b.m || '').replace(/[\r\n]/g, ' ').slice(0, 300));
  ok(res, { ok: true });
});

route('POST', '/api/refresh', async (req, res) => {
  catalog.load({ force: true });
  ok(res, { ok: true });
});

/* setup (phone) */

route('GET', '/api/setup', (req, res) => { if (checkPin(req, res)) ok(res, publicConfig()); });

route('POST', '/api/setup/test', async (req, res) => {
  if (!checkPin(req, res)) return;
  const b = await readBody(req);
  try { ok(res, await testConnection(b)); } catch (e) {
    const x = b.xtream || {};
    bad(res, redact(e.message === 'timeout' ? 'Servern svarade inte i tid' : e.message, [x.username, x.password, store.config.xtream.password]), 200);
  }
});

route('POST', '/api/setup', async (req, res) => {
  if (!checkPin(req, res)) return;
  const b = await readBody(req);
  const c = store.config;
  const before = catalog.sig();
  if (b.source === 'm3u' || b.source === 'xtream') c.source = b.source;
  if (b.xtream) {
    c.xtream.server = normServer(b.xtream.server || '');
    c.xtream.username = String(b.xtream.username || '').trim();
    if (b.xtream.password) c.xtream.password = String(b.xtream.password).trim();
  }
  if (b.m3u) {
    c.m3u.url = String(b.m3u.url || '').trim();
    c.m3u.epgUrl = String(b.m3u.epgUrl || '').trim();
    // An Xtream get.php link works better as Xtream (movies/series metadata, EPG)
    const xt = c.source === 'm3u' && b.preferXtream ? xtreamFromM3uUrl(c.m3u.url) : null;
    if (xt) { c.source = 'xtream'; c.xtream = xt; }
  }
  if (b.profiles) c.profiles = cleanProfiles(b.profiles);
  if (b.options) {
    const o = b.options;
    const opt = c.options;
    if (typeof o.appName === 'string') opt.appName = o.appName.trim().slice(0, 24) || 'Norrsken';
    for (const k of ['hideAdult', 'cleanNames']) if (k in o) opt[k] = !!o[k];
    if (['hls', 'ts'].includes(o.liveFormat)) opt.liveFormat = o.liveFormat;
    if (['auto', 'lossless', 'eac3', 'ac3', 'aac', 'copy'].includes(o.audioMode)) opt.audioMode = o.audioMode;
    if (['orig', '1080'].includes(o.maxRes)) opt.maxRes = o.maxRes;
    if (['sound', 'muted', 'off'].includes(o.previews)) opt.previews = o.previews;
    if (['auto', 'off'].includes(o.directPlay)) opt.directPlay = o.directPlay;
    for (const k of ['userAgent', 'epgUrl', 'kidsPattern']) if (typeof o[k] === 'string') opt[k] = o[k].trim().slice(0, 500);
  }
  const hasSource = c.source === 'm3u' ? !!c.m3u.url : !!(c.xtream.server && c.xtream.username && c.xtream.password);
  c.configured = hasSource;
  store.saveConfig();
  if (hasSource) {
    if (catalog.sig() !== before) { catalog.data = null; catalog.raw = null; catalog.status.error = null; catalog.load({ force: true }); }
    else if (catalog.raw) { catalog.build(catalog.raw); if (!catalog.data) catalog.load(); }
    else catalog.load();
  }
  ok(res, { ok: true, config: publicConfig() });
});

route('GET', '/api/setup/categories', (req, res) => {
  if (!checkPin(req, res)) return;
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const hidden = store.config.hidden || {};
  const out = {};
  for (const type of ['live', 'movie', 'series']) {
    const h = new Set(hidden[type] || []);
    out[type] = catalog.data[type].cats.map(c => ({ id: c.id, name: c.raw, n: catalog.data[type].byCat.get(c.id).length, hidden: h.has(c.id), adult: c.adult, kids: c.kids }));
  }
  ok(res, out);
});

route('POST', '/api/setup/categories', async (req, res) => {
  if (!checkPin(req, res)) return;
  const b = await readBody(req, 5e6);
  const h = store.config.hidden || (store.config.hidden = { live: [], movie: [], series: [] });
  for (const type of ['live', 'movie', 'series']) if (Array.isArray(b[type])) h[type] = b[type].map(String).slice(0, 20000);
  store.saveConfig();
  catalog.invalidate();
  ok(res, { ok: true });
});

route('POST', '/api/setup/reset-state', async (req, res) => {
  if (!checkPin(req, res)) return;
  const b = await readBody(req);
  if (b.profile && store.state.profiles[b.profile]) { delete store.state.profiles[b.profile]; store.saveState(); }
  ok(res, { ok: true });
});

/* ------------------------------------------------------------------ static */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let p = pathname;
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/setup' || p === '/setup/') p = '/setup.html';
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC + path.sep)) return bad(res, 'nej', 403);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Hittades inte', 'text/plain; charset=utf-8');
    const mtime = st.mtime.toUTCString();
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Last-Modified': mtime,
      'Cache-Control': /\/(vendor|fonts)\//.test(file) ? 'public, max-age=604800' : 'no-cache',
    };
    if (req.headers['if-modified-since'] === mtime) { res.writeHead(304, headers); return res.end(); }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, Content-Type, X-Pin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      return res.end();
    }
    const px = /^\/px\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(pathname);
    if (px && (req.method === 'GET' || req.method === 'HEAD')) return await proxy.handle(req, res, px[1], catalog.ua(), ingressBase(req));
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(pathname);
      if (m) return await r.handler(req, res, url.searchParams, m.groups || {});
    }
    if (pathname.startsWith('/api/')) return bad(res, 'okänd endpoint', 404);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    bad(res, 'metod', 405);
  } catch (e) {
    console.error('[http]', req.method, pathname, e && e.message);
    if (!res.headersSent) bad(res, redact((e && e.message) || 'fel', catalog.secrets()), 500);
    else res.end();
  }
});
server.keepAliveTimeout = 65000;

function start() {
  server.listen(PORT, HOST, () => {
    const urls = process.env.PUBLIC_URL ? [process.env.PUBLIC_URL.replace(/\/$/, '')] : lanUrls();
    console.log(`\n  ${store.config.options.appName || 'Norrsken'} ${pkg.version} kör på port ${PORT}`);
    console.log('  TV-appen:      ' + (urls[0] || 'http://localhost:' + PORT) + '/');
    console.log('  Inställningar: ' + (urls[0] || 'http://localhost:' + PORT) + '/setup');
    console.log('  ffmpeg:        ' + (ff.has() ? 'ja (MKV, ljudspår och undertexter stöds)' : 'nej (installera för MKV/undertexter)') + '\n');
  });
  if (store.config.configured) catalog.load();
  // background refresh: catalog every 12 h, EPG every 6 h
  setInterval(() => { if (store.config.configured && catalog.ready()) catalog.load(); }, 3600e3).unref();
  setInterval(() => { if (catalog.ready()) catalog.loadEpg().catch(() => {}); }, 30 * 60e3).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

if (require.main === module) start();

module.exports = { server, store, catalog, proxy, start, _pool: pool };
