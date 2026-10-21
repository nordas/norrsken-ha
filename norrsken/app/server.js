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
const { Catalog, Xtream, xtreamFromM3uUrl, normServer } = require('./lib/provider');
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

function continueItems(st) {
  return Object.values(st.progress)
    .filter(p => p && p.item && (p.upnext || (p.dur > 0 && p.pos > 15 && p.pos / p.dur < 0.95)))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30)
    .map(p => ({ ...p.item, pos: p.pos, dur: p.dur || p.item.dur || 0, upnext: !!p.upnext }));
}

function catRow(type, cat, prof, title, loadItems = true) {
  const list = catalog.list(type, cat, prof);
  if (!list.length) return null;
  return { id: type + ':' + cat, title, kind: ROW_KIND[type], type, cat, total: list.length, items: loadItems ? list.slice(0, INITIAL) : [] };
}

function homePage(prof, st) {
  const rows = [];
  const cw = continueItems(st);
  if (cw.length) rows.push(row('cw', 'Fortsätt titta', 'continue', cw, { limit: 30 }));
  const ml = st.myList.map(m => m.item).filter(Boolean);
  const mlv = ml.filter(i => i.t !== 'live');
  if (mlv.length) rows.push(row('ml', 'Min lista', 'poster', mlv, { limit: 60 }));
  if (st.recent.length) rows.push(row('rc', 'Senast tittade kanaler', 'live', st.recent, { limit: 20 }));
  const push = (r) => { if (r) rows.push(r); };
  push(catRow('movie', 'recent', prof, 'Nyligen tillagda filmer'));
  const liveCats = catalog.visibleCats('live', prof);
  if (liveCats[0]) push(catRow('live', liveCats[0].id, prof, 'Live: ' + liveCats[0].name));
  push(catRow('series', 'recent', prof, 'Nya och uppdaterade serier'));
  const top = catalog.list('movie', 'top', prof).slice(0, 10);
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

function typePage(type, prof, st) {
  const rows = [];
  if (type === 'live' && st.recent.length) rows.push(row('rc', 'Senast tittade', 'live', st.recent, { limit: 20 }));
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
    profiles: store.config.profiles,
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
    profiles: c.profiles,
    options: c.options,
  };
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
    out.push({ id, name, color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#35d0a0', kids: !!p.kids });
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
  const list = catalog.list(type, q.get('cat') || 'all', prof);
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
    const extra = { catName: catalog.catName(p.type, info.cat) };
    ok(res, { ...info, ...extra });
  } catch (e) { bad(res, redact(e.message, catalog.secrets()), 502); }
});

route('GET', '/api/epg/now', async (req, res, q) => {
  const ids = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 80);
  ok(res, await catalog.nowNext(ids));
});

route('GET', '/api/epg/channel/:id', async (req, res, q, p) => {
  ok(res, await catalog.channelGuide(decodeURIComponent(p.id), Math.min(36, +q.get('hours') || 12)));
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
  const done = dur > 0 && pos / dur >= 0.95;
  if (done) {
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

route('GET', '/api/stream/:type/:id', async (req, res, q, p) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const type = p.type;
  const id = decodeURIComponent(p.id);
  const src = catalog.streamUrl(type, id, q.get('ext'));
  if (!src || !src.primary) return bad(res, 'Kunde inte hitta strömmen', 404);
  const tok = (u) => { proxy.allow(u); return proxy.token(u); };
  const pathOf = (u) => proxy.path(u);
  const kindOf = (u) => (/\.m3u8?(\?|$)/i.test(u) ? 'hls' : /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg)(\?|$)/i.test(u) ? 'file' : 'ts');
  if (type === 'live') {
    const list = [{ kind: kindOf(src.primary), url: pathOf(src.primary) }];
    if (src.alt) list.push({ kind: kindOf(src.alt), url: pathOf(src.alt) });
    if (list[0].kind === 'ts' && !src.alt) list.push({ kind: 'file', url: list[0].url });
    return ok(res, { live: true, sources: list });
  }
  const ext = String(src.ext || '').toLowerCase();
  const nativeOk = ['mp4', 'm4v', 'mov', 'webm'].includes(ext);
  const t = tok(src.primary);
  const sources = [];
  const file = { kind: 'file', url: pathOf(src.primary) };
  const remux = { kind: 'remux', url: '/remux?t=' + t };
  if (ff.has()) {
    if (nativeOk) sources.push(file, remux); else sources.push(remux, file);
  } else sources.push(file);
  ok(res, { live: false, sources, t: ff.has() ? t : '', ext });
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
  ff.remux(req, res, url, { ss: Math.max(0, +q.get('ss') || 0), a: +q.get('a') || 0, ua: catalog.ua(), audioMode: store.config.options.audioMode });
});

route('GET', '/subs', (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  ff.subs(req, res, url, { s: +q.get('s') || 0, ss: Math.max(0, +q.get('ss') || 0), ua: catalog.ua() });
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
    if (['auto', 'aac', 'copy'].includes(o.audioMode)) opt.audioMode = o.audioMode;
    if (['sound', 'muted', 'off'].includes(o.previews)) opt.previews = o.previews;
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
    if (px && (req.method === 'GET' || req.method === 'HEAD')) return await proxy.handle(req, res, px[1], catalog.ua());
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
