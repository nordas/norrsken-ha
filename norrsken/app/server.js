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
const sport = require('./lib/sport');
const tsbuf = require('./lib/tsbuf');
const storage = require('./lib/storage');
const downloads = require('./lib/downloads');
const airtest = require('./lib/airtest');
const airlog = require('./lib/airlog');
const crests = require('./lib/crests');
const { Services, serviceInfo } = require('./lib/services');
const { redact, fetchText, pool } = require('./lib/util');
const pkg = require('./package.json');

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const SETUP_PIN_OPTION = process.env.SETUP_PIN || ''; // the add-on's own setting (setup_pin)

const store = new Store(DATA_DIR);
const vault = require('./lib/vault');
const catalog = new Catalog(store);
catalog.secrets = () => acctSecrets(); // errors and logs from the catalog hide the M3U/guide link account too
const proxy = new Proxy();
// provider addresses (with the account's password) are encrypted in every address handed to a TV or phone
if (!store.config.proxySecret) { store.config.proxySecret = require('crypto').randomBytes(32).toString('hex'); store.saveConfig(); }
proxy.setSecret(store.config.proxySecret);

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
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, JSON_REPLACER);
  // JSON answers (the start page is 150 kB) go compressed to browsers that ask for it: a quicker start over Wi-Fi.
  // Never playlists or media: TVs fetch those.
  if (res._gz && status === 200 && /^application\/json/.test(type) && data.length > 2000 && !extra['Content-Encoding']) {
    data = require('zlib').gzipSync(data, { level: 4 });
    extra = { ...extra, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };
  }
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
/**
 * A short-lived token for one downloaded file (what a video element's address carries instead of the profile's own
 * token, which never changes): valid 12 hours, for that file only.
 */
function fileToken(id, exp = Date.now() + 12 * 3600e3) {
  const e = Math.floor(exp / 1000).toString(36);
  // its own key (derived from the secret), so it can never equal a profile's token whatever ids and PINs exist
  const key = require('crypto').createHmac('sha256', pinSecret()).update('norrsken-filtoken').digest();
  return e + '.' + require('crypto').createHmac('sha256', key).update(id + ':' + e).digest('hex').slice(0, 24);
}
function fileTokenOk(id, t) {
  const m = /^([0-9a-z]{1,10})\.([0-9a-f]{24})$/.exec(String(t || ''));
  if (!m || parseInt(m[1], 36) * 1000 < Date.now()) return false;
  return sameText(fileToken(id, parseInt(m[1], 36) * 1000), t);
}

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

/* ------------------------------------------------------------------ "Föreslaget för dig"
   Learns from what the profile watched, finished, liked, saved and disliked: genres, actors, director, category and
   era of those titles become a taste profile, and every other title is scored against it. Runs on the server, no
   data leaves the house. */
function tasteSignals(st) {
  const sig = new Map(); // catalog key (m:id / s:id) -> weight
  const add = (k, w) => { if (k) sig.set(k, (sig.get(k) || 0) + w); };
  const titleKey = (k, item) => {
    if (k.startsWith('e:')) { const sid = item && item.sid; return sid ? 's:' + sid : null; }
    return k.startsWith('m:') || k.startsWith('s:') ? k : null;
  };
  for (const [k, ts] of Object.entries(st.seen || {})) {
    let sk = k.startsWith('m:') ? k : null;
    if (k.startsWith('e:')) { const e = catalog.epSeries ? catalog.epSeries(k.slice(2)) : null; if (e) sk = 's:' + e; }
    add(sk, 2);
  }
  for (const p of Object.values(st.progress || {})) if (p.item) add(titleKey(p.item.k, p.item), p.upnext ? 2 : 1.5);
  for (const m of st.myList || []) if (m.item) add(titleKey(m.item.k, m.item), 1.5);
  for (const [k, v] of Object.entries(st.likes || {})) add(k, v > 0 ? 5 : -6);
  return sig;
}
function tasteTokens(it) {
  const out = [];
  for (const g of String(it.g || '').toLowerCase().split(/[,/|&]/)) { const t = g.trim(); if (t) out.push(['g:' + t, 1]); }
  for (const n of String(catalog.people.get(it.k) || '').split(/,/).slice(0, 6)) { const t = n.trim(); if (t.length > 2) out.push(['p:' + t, 1.4]); }
  if (it.cat) out.push(['c:' + it.t + ':' + it.cat, 0.6]);
  if (it.y) out.push(['y:' + Math.floor(it.y / 10), 0.3]);
  return out;
}
function recommendations(prof, st, limit = 30) {
  const sig = tasteSignals(st);
  if (!sig.size) return [];
  const taste = new Map();
  const why = new Map(); // token -> best source title
  for (const [k, w] of sig) {
    const it = catalog.get(k[0] === 's' ? 'series' : 'movie', k.slice(2));
    if (!it) continue;
    for (const [t, tw] of tasteTokens(it)) {
      taste.set(t, (taste.get(t) || 0) + w * tw);
      if (w > 0 && (!why.has(t) || why.get(t).w < w)) why.set(t, { w, n: it.n });
    }
  }
  const skip = new Set([...sig.keys()]);
  const out = [];
  for (const type of ['movie', 'series']) {
    for (const it of dedupe(catalog.list(type, 'all', prof))) {
      if (skip.has(it.k)) continue;
      let sc = 0, best = null, bestV = 0;
      for (const [t, tw] of tasteTokens(it)) {
        const v = (taste.get(t) || 0) * tw;
        sc += v;
        if (v > bestV && why.has(t)) { bestV = v; best = why.get(t).n; }
      }
      if (sc <= 0) continue;
      sc += (it.r || 0) * 0.15 + (it.add && Date.now() / 1000 - it.add < 30 * 86400 ? 0.5 : 0);
      out.push([sc, it, best]);
    }
  }
  out.sort((a, b) => b[0] - a[0]);
  return out.slice(0, limit).map(([, it, best]) => (best ? { ...it, because: 'Eftersom du sett ' + best } : it));
}

function homePage(prof, st) {
  const rows = [];
  const cw = continueItems(st);
  if (cw.length) rows.push(row('cw', 'Fortsätt titta', 'poster', cw, { limit: 30 }));
  const rec = recommendations(prof, st);
  if (rec.length >= 4) rows.push(row('rec', 'Föreslaget för dig', 'poster', rec, { limit: 30 }));
  const svc = serviceRow(prof);
  if (svc) rows.push(svc);
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
/** Loopback, private and link-local addresses (and localhost): the home network, not the internet. */
function privateHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); // "localhost." is localhost too
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { const [a, b] = h.split('.').map(Number); return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  if (h.indexOf(':') < 0) return false; // a name (fcdn.example.com is not an IPv6 address)
  return h === '::1' || h === '::' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h) || h.startsWith('::ffff:');
}
/** The provider's own servers (host and port): its logos may live there even when it is on the home network. */
function providerHosts() {
  const c = store.config, out = [];
  for (const u of [c.xtream && c.xtream.server, c.m3u && c.m3u.url, c.m3u && c.m3u.epgUrl, c.options && c.options.epgUrl]) {
    try { if (u && !vault.isSealed(u)) out.push(new URL(/^https?:/i.test(u) ? u : 'http://' + u).host.toLowerCase()); } catch (_) { /* skip */ }
  }
  return out;
}
/** May /img fetch this address? Not the home network, except the provider's own server (host and port). */
function imageAllowed(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !privateHost(url.hostname) || providerHosts().includes(url.host.toLowerCase());
}
async function serveImage(req, res, u) {
  let url;
  try { url = new URL(u); } catch (_) { return bad(res, 'url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad(res, 'url');
  if (!imageAllowed(url)) return bad(res, 'url', 403); // not a door into the home network
  const hit = imgCache.get(u);
  const head = { 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' };
  if (hit) { res.writeHead(200, { ...head, 'Content-Type': hit.type, 'Content-Length': hit.buf.length }); return res.end(hit.buf); }
  try {
    // redirects are followed by hand: every step has to pass the same check (a public name may point inside)
    let cur = url, got = null;
    for (let hop = 0; hop < 5; hop++) {
      const x = await require('./lib/util').fetchRaw(cur.href, { ua: catalog.ua(), timeout: 15000, redirect: 'manual' });
      if (x.r.status >= 300 && x.r.status < 400 && x.r.headers.get('location')) {
        x.done(); try { await x.r.body?.cancel(); } catch (_) { /* ignore */ }
        let next;
        try { next = new URL(x.r.headers.get('location'), cur); } catch (_) { return bad(res, 'url'); }
        if (!imageAllowed(next)) return bad(res, 'url', 403);
        cur = next;
        continue;
      }
      got = x; break;
    }
    if (!got) { res.writeHead(502, head); return res.end(); }
    const { r, done } = got;
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
    lan: lanUrls()[0] || '', // the address an Apple TV can reach (AirPlay); the add-on runs on the host network
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
    pause: { mode: store.config.options.pauseMode || 'auto', max: +store.config.options.pauseMax || 60, rec: ff.has() },
    storage: storage.info(),
    downloads: ff.has(),
    parentPin: (store.config.profiles || []).some(p => !p.kids && p.pin),
    profiles: publicProfiles(),
    pinRequired: !!setupPin(),
    urls: process.env.PUBLIC_URL ? [process.env.PUBLIC_URL.replace(/\/$/, '')] : lanUrls(),
  };
}

/* ------------------------------------------------------------------ setup */

const vaultClear = (v) => (vault.isSealed(v) ? '' : v);
/** A link with the account in it, shown without the password: "…password=***" (Xtream paths too). */
/** Text that may contain the provider's address: the user name and password taken out. */
/** Everything that is the account: the Xtream login and the secret parts of the M3U and guide links. */
function acctSecrets() {
  const c = store.config;
  const secrets = [c.xtream.username, c.xtream.password];
  for (const u of [c.m3u.url, c.m3u.epgUrl, c.options.epgUrl]) secrets.push(...linkSecrets(u));
  return secrets.filter(x => x && x.length > 2 && !vault.isSealed(x));
}
function redactAcct(msg) { return maskUrl(redact(msg, acctSecrets())); }
/** The account parts of a link: user:pass@, ?password=/token=…, /live/<user>/<pass>/. */
function linkSecrets(u) {
  const out = [];
  if (!u || vault.isSealed(u)) return out;
  let m = /^[a-z]+:\/\/([^:@/]+):([^@/]+)@/i.exec(u);
  if (m) out.push(m[1], m[2]);
  for (const q of String(u).matchAll(/(?:username|user|password|passwd|pass|pwd|token|key)=([^&#]+)/gi)) out.push(q[1]);
  m = /\/(?:live|movie|series|hls|playlist|timeshift)\/([^/]+)\/([^/]+)(?:\/|$)/i.exec(u);
  if (m) out.push(m[1], m[2]);
  // as written in the link and as they read decoded ("a%20b" and "a b")
  for (const x of out.slice()) { try { const d = decodeURIComponent(x.replace(/\+/g, ' ')); if (d !== x) out.push(d); } catch (_) { /* not encoded */ } }
  return out;
}
/** A link sent back from the page: *** where the saved link had its password is filled in again from the saved one. */
/**
 * A link sent back from the page with *** in it: each *** gets back exactly what stood in that place in the saved
 * link (that parameter, that path segment, that user:password), and only for the same server. A link to another
 * server never gets the saved password: null, and the password has to be typed in again.
 */
function unmaskUrl(sent, saved) {
  if (!sent || sent.indexOf('***') < 0) return sent;
  if (!saved || vault.isSealed(saved)) return null;
  let a, b;
  try { a = new URL(sent); b = new URL(saved); } catch (_) { return null; }
  if (a.protocol !== b.protocol || a.host.toLowerCase() !== b.host.toLowerCase()) return null;
  if (a.password === '***') { if (!b.password) return null; a.password = b.password; }
  const sp = a.pathname.split('/'), bp = b.pathname.split('/');
  for (let i = 0; i < sp.length; i++) if (sp[i] === '***') { if (bp[i] === undefined || sp.length !== bp.length) return null; sp[i] = bp[i]; }
  a.pathname = sp.join('/');
  let out = a.origin.replace(/^([a-z]+:\/\/)/i, '$1' + (a.username ? a.username + (a.password ? ':' + a.password : '') + '@' : '')) + a.pathname + sent.replace(/^[^?#]*/, '');
  // query: each name=*** gets that parameter's value from the saved link, as it was written there
  let bad = false;
  out = out.replace(/([?&])([^=&#]+)=\*\*\*/g, (m, sep, name) => {
    const r = new RegExp('[?&]' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&#]*)').exec(saved);
    if (!r) { bad = true; return m; }
    return sep + name + '=' + r[1];
  });
  return bad || out.indexOf('***') >= 0 ? null : out;
}
function maskUrl(u) {
  if (!u || vault.isSealed(u)) return '';
  let s = String(u).replace(/((?:password|passwd|pass|pwd|token|key)=)[^&#\s]*/gi, '$1***');
  s = s.replace(/^([a-z]+:\/\/[^:@/]+:)[^@/]+@/i, '$1***@');
  s = s.replace(/(\/(?:live|movie|series|hls|playlist|timeshift)\/[^/]+\/)[^/\s]+(\/|$)/gi, '$1***$2');
  return s;
}
function publicConfig() {
  const c = store.config;
  return {
    configured: c.configured,
    source: c.source,
    // fields that couldn't be opened (key missing) are shown empty: type them in again
    xtream: { server: c.xtream.server, username: vaultClear(c.xtream.username), hasPassword: !!vaultClear(c.xtream.password) },
    m3u: { url: maskUrl(c.m3u.url), epgUrl: maskUrl(c.m3u.epgUrl) },
    vault: { ...require('./lib/vault').status(), locked: !!store.locked },
    profiles: publicProfiles(),
    // the key itself never goes back out; '••••' means "one is saved"
    options: { ...c.options, tmdbKey: c.options.tmdbKey ? '••••' : '', epgUrl: maskUrl(c.options.epgUrl) },
  };
}

/** Profiles as shown to devices: never the PIN itself. */
function publicProfiles() {
  return (store.config.profiles || []).map(p => ({ id: p.id, name: p.name, color: p.color, kids: !!p.kids, hasPin: !!p.pin }));
}

/**
 * /setup always has a PIN (it holds the provider account): the add-on's setup_pin if set, otherwise one made on the
 * first start and shown only in the add-on log in Home Assistant. NSK_SETUP_OPEN=1 turns it off (tests only).
 */
function setupPin() {
  if (process.env.NSK_SETUP_OPEN === '1') return '';
  if (SETUP_PIN_OPTION) return SETUP_PIN_OPTION;
  if (!store.config.setupPin) { store.config.setupPin = String(require('crypto').randomInt(100000, 1000000)); store.saveConfig(); }
  return store.config.setupPin;
}

/** Wrong PINs from one address: after five, a wait that doubles (2 s … 15 min) before the next try is looked at. */
const pinFails = new Map(); // key → { n, until }
function pinLocked(key) {
  const f = pinFails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function pinFailed(key) {
  const f = pinFails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60, 2 ** (f.n - 4)) * 1000;
  pinFails.set(key, f);
  if (pinFails.size > 500) pinFails.clear();
}
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && require('crypto').timingSafeEqual(x, y);
}
function clientKey(req) { return String((req.socket && req.socket.remoteAddress) || '?'); }

function checkPin(req, res) {
  const pin = setupPin();
  if (!pin) return true;
  const key = 'setup:' + clientKey(req);
  const wait = pinLocked(key);
  if (wait) { bad(res, 'För många fel PIN-koder – vänta ' + (wait > 90 ? Math.ceil(wait / 60) + ' min' : wait + ' s'), 429); return false; }
  const sent = req.headers['x-pin'];
  if (sent && sameText(sent, pin)) { pinFails.delete(key); return true; }
  if (sent) pinFailed(key);
  bad(res, sent ? 'Fel PIN-kod' : 'PIN-kod krävs', 401);
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
    let url = String((body.m3u && body.m3u.url) || '').trim();
    url = url && url === maskUrl(store.config.m3u.url) ? store.config.m3u.url : unmaskUrl(url, store.config.m3u.url); // shown masked: the saved one
    if (url === null) throw new Error('Lösenordet i länken kan inte fyllas i automatiskt (ny server eller ändrad länk) – skriv in det igen');
    if (!url) throw new Error('Ange en M3U-länk');
    const text = await fetchText(url, { ua: ua || undefined, timeout: 120000 });
    const n = (text.match(/#EXTINF/g) || []).length;
    if (!n) throw new Error('Länken gav ingen giltig M3U-lista');
    return { ok: true, entries: n };
  }
  const x = body.xtream || {};
  // the saved password only goes to the saved server and user name: never to an address someone else typed in
  const same = normServer(x.server || '') === store.config.xtream.server && String(x.username || '').trim() === store.config.xtream.username;
  const pass = x.password || (same ? store.config.xtream.password : '');
  if (!pass) throw new Error('Ange lösenordet');
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
  if (p.page === 'home' || p.page === 'live') { const mr = matchRow(prof, st, ingressBase(req)); if (mr) rows.unshift(mr); }
  ok(res, { rows, featured: featured(p.page, prof), sport: p.page === 'home' || p.page === 'live' ? sportNow(prof, st, ingressBase(req)) : null });
});

// the clubs' own abbreviations, as on the scoreboard
const ABBR = { lulea: 'LHF', bjorkloven: 'IFB', brynas: 'BIF', djurgarden: 'DIF', frolunda: 'FHC', farjestad: 'FBK', hv71: 'HV71', linkoping: 'LHC', malmo: 'MIF', rogle: 'RBK', skelleftea: 'SAIK', timra: 'TIK', vaxjo: 'VLH', orebro: 'ÖRE', leksand: 'LIF', modo: 'MODO', aik: 'AIK', 'tre-kronor': 'SWE', damkronorna: 'SWE', juniorkronorna: 'SWE', 'sverige-fotboll': 'SWE', 'sverige-fotboll-dam': 'SWE', 'sverige-u21': 'SWE', 'sverige-handboll': 'SWE', 'sverige-handboll-dam': 'SWE', 'sverige-bandy': 'SWE', 'sverige-bandy-dam': 'SWE', 'sverige-innebandy': 'SWE', 'sverige-innebandy-dam': 'SWE', 'sverige-basket': 'SWE', 'sverige-basket-dam': 'SWE', 'sverige-curling': 'SWE', 'sverige-curling-dam': 'SWE',
  arsenal: 'ARS', 'aston-villa': 'AVL', bournemouth: 'BOU', brentford: 'BRE', brighton: 'BHA', chelsea: 'CHE', coventry: 'COV', 'crystal-palace': 'CRY', everton: 'EVE', fulham: 'FUL', hull: 'HUL', ipswich: 'IPS', leeds: 'LEE', liverpool: 'LIV', 'man-city': 'MCI', 'man-utd': 'MUN', newcastle: 'NEW', nottingham: 'NFO', sunderland: 'SUN', tottenham: 'TOT' };
/*
 * Club crests are the clubs' own: none ship with Norrsken. The user's own picture files are shown when they are put in
 * Home Assistant's config folder: /config/norrsken/crests/<team>.png (or .svg, .webp, .jpg), e.g. lulea.png, hv71.png.
 */
// the ones uploaded in /setup first (Norrsken's own folder), then a folder of the user's own
const CREST_UP = path.join(DATA_DIR, 'crests');
const CREST_DIRS = [CREST_UP, process.env.NSK_CREST_DIR, '/homeassistant/norrsken/crests'].filter(Boolean);
const CREST_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const CREST_ID = /^[a-z0-9-]{2,46}$/;
function crestFile(id) {
  if (!CREST_ID.test(id)) return '';
  for (const d of CREST_DIRS) for (const e of Object.keys(CREST_TYPES)) { const f = path.join(d, id + e); try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* not there */ } }
  return '';
}
/** The crest's address, with its file time: a new picture is shown at once, not after the hour it may be cached. */
function crestUrl(id, base) {
  const f = crestFile(id);
  if (!f) return '';
  let v = 0; try { v = Math.round(fs.statSync(f).mtimeMs / 1000); } catch (_) { /* gone */ }
  return base + '/crest/' + id + '?v=' + v;
}
/** Every picture there is (team ids, nat-…, comp-…, club-…): the clubs are looked up by name among these. */
let crestKeyCache = { at: 0, keys: [] };
function crestKeys() {
  if (Date.now() - crestKeyCache.at < 30e3) return crestKeyCache.keys;
  const keys = new Set();
  for (const d of CREST_DIRS) { try { for (const f of fs.readdirSync(d)) { const m = /^([a-z0-9-]{2,46})\.(png|svg|webp|jpe?g)$/.exec(f); if (m) keys.add(m[1]); } } catch (_) { /* no folder */ } }
  crestKeyCache = { at: Date.now(), keys: [...keys] };
  return crestKeyCache.keys;
}
/** A competition's logo ("Champions League", "SHL" …), when one was uploaded. */
function compImg(comp, base) { const k = crests.compKey(comp); return k ? crestUrl(k, base) : ''; }
route('GET', '/crest/:id', (req, res, q, p) => {
  const f = crestFile(p.id);
  if (!f) return bad(res, 'finns inte', 404);
  // an SVG is shown as a picture only (never as a page): no scripts run from it
  res.writeHead(200, { 'Content-Type': CREST_TYPES[path.extname(f)], 'Cache-Control': 'max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(f).pipe(res);
});

/** The profile's favourite team playing now or soon (start page billboard). */
function sportNow(prof, st, base = '') {
  const tid = teamsOf(st); // none: no team, but Sweden and the skiing world cups still show
  const key = prof.id + '|' + tid.join(',') + '|' + catalog.epg.at;
  let hit = sportCache.get(key);
  if (!hit || Date.now() - hit.at >= 60e3) {
    let m = null;
    try {
      m = sport.findMatch(tid, sportChannels(prof), catalog.epg);
      if (m) m.chans = m.chans.slice(0, 12);
    } catch (e) { console.error('[sport]', e.message); }
    hit = { at: Date.now(), m };
    sportCache.set(key, hit);
    if (sportCache.size > 50) sportCache.clear();
  }
  // the match recording (if any) is looked up fresh every time: it grows while we look
  const m = hit.m;
  if (!m) return m;
  const r = matchRecs.get(m.team.id + '|' + m.s);
  const rec = r ? recInfo(r, base) : null;
  // not recorded yet because something else plays (the provider gives one connection): say so instead of nothing
  const waits = !rec && Date.now() - (matchWait.get(m.team.id + '|' + m.s) || 0) < 90e3;
  // both teams' colours and short names, for the match card (no crests: those are the clubs' own)
  const side = (n) => matchSide(n, m, base);
  return Object.assign({}, m, { rec, compImg: compImg(m.kind && m.kind.comp, base), d: matchDesc(m), autoRec: autoRecs(m), recWait: waits ? 'Spelas in när det som spelas nu stängs' : '', sides: m.home && m.away ? [side(m.home), side(m.away)] : null });
}
/** The profile's favourite teams (ids). Old profiles have one team; no choice at all means Luleå. */
/** The programme's own text without the guide's HTML; or a plain sentence of who meets whom. */
function matchDesc(m) {
  const d = String(m.d || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (d && d.length > 20 && !/^matcher från/i.test(d)) return d.slice(0, 400);
  const what = (m.label || '').split(' · ');
  return m.home && m.away ? (what[0] || 'Match') + (what[1] ? ' i ' + what[1] : '') + ': ' + m.home + ' möter ' + m.away + '.' : d.slice(0, 400);
}
/** Is this recorded by itself (Luleå; the skiing world cups when switched on)? */
function autoRecs(m) {
  return m.team.id === MATCH_TEAM || ((m.team.id === 'langd' || m.team.id === 'skidskytte') && (store.config.options || {}).skiRec === true);
}
function teamsOf(st) {
  const p = (st && st.prefs) || {};
  const ids = Array.isArray(p.teams) ? p.teams : [p.team === undefined ? 'lulea' : p.team];
  // before 1.16.3 Sweden's hockey and football matches were always followed; until the profile chooses its
  // national teams itself (the team picker saves `nations`), they still are
  return sport.teamIds(p.nations ? ids : ids.concat(sport.NATION_DEFAULT));
}
/** One side of a match for the card: short name, colours, abbreviation, the user's crest picture. */
function matchSide(n, m, base) {
  // Sweden in a national team's match: that team (its own crest: SvFF's for football, Tre Kronor's for hockey …)
  // (the crest you uploaded for that team, else the sport's main team's – SvFF's, Tre Kronor's – else the flag)
  if (n && m.team && m.team.group === 'Landslag' && /sverige|sweden|kronorna|bl[åa]gult|landslaget/i.test(n)) {
    const sp = m.kind && m.kind.sport;
    const img = crestUrl(m.team.id, base) || (sp === 'Ishockey' ? crestUrl('tre-kronor', base) : sp === 'Fotboll' ? crestUrl('sverige-fotboll', base) : '');
    return { id: m.team.id, n: 'Sverige', col: m.team.col, ab: 'SWE', img, flag: 'SE' };
  }
  // the other side of a national team's match: a country – its team's crest when uploaded, else its flag
  if (n && m.team && m.team.group === 'Landslag') { const c = sport.countryOf(n); if (c) return { n, col: null, ab: c.ab, img: crestUrl(crests.nationKey(n), base), flag: c.flag }; }
  const foot = m.kind && m.kind.sport === 'Fotboll';
  const pool = sport.TEAMS.filter(x => x.sport !== 'nation' && (x.sport === 'football') === foot);
  const t = n && pool.find(x => x.re.test(n));
  if (t) return { id: t.id, n: t.short, col: t.col, ab: ABBR[t.id] || '', img: crestUrl(t.id, base) };
  if (!n) return null;
  // any other club (Bayern, Real Madrid …): its uploaded crest found by its name
  const ck = crests.clubKey(n, crestKeys());
  return { n, col: null, ab: '', img: ck ? crestUrl(ck, base) : '' };
}
const sportCache = new Map();
/** The live channels with their country (from the category name), so a match is shown and recorded on a Swedish one. */
let sportChanCache = { key: '', list: [] };
function sportChannels(prof) {
  const list = catalog.list('live', 'all', prof);
  const key = prof.id + '|' + catalog.status.at + '|' + list.length;
  if (sportChanCache.key === key) return sportChanCache.list;
  const names = new Map(((catalog.data && catalog.data.live && catalog.data.live.cats) || []).map(c => [c.id, c.raw || c.name]));
  const out = list.map(c => Object.assign({}, c, { region: sport.regionOf(names.get(c.cat)) }));
  sportChanCache = { key, list: out };
  return out;
}
/** The favourite teams' matches the days ahead (whatever league or cup), for the list on the start page. */
function upcomingMatches(prof, st, base = '') {
  const ids = teamsOf(st);
  if (!ids.length) return [];
  const key = 'up|' + prof.id + '|' + ids.join(',') + '|' + catalog.epg.at;
  let hit = sportCache.get(key);
  if (!hit || Date.now() - hit.at >= 60e3) {
    let list = [];
    try { list = sport.upcoming(ids, sportChannels(prof), catalog.epg, { days: 8 }).slice(0, 40); } catch (e) { console.error('[sport]', e.message); }
    hit = { at: Date.now(), list };
    sportCache.set(key, hit);
    if (sportCache.size > 50) sportCache.clear();
  }
  return hit.list.map(m => ({
    team: m.team, label: m.label, state: Date.now() >= m.s ? 'live' : 'soon', title: m.title, s: m.s, e: m.e, ch: m.ch, chName: m.chName, chans: m.chans.slice(0, 6), foreign: !!m.foreign,
    arena: m.arena || '', compImg: compImg(m.kind && m.kind.comp, base), d: matchDesc(m), autoRec: autoRecs(m), rec: (() => { const r = matchRecs.get(m.team.id + '|' + m.s); return r ? recInfo(r, base) : null; })(),
    sides: m.home && m.away ? [matchSide(m.home, m, base), matchSide(m.away, m, base)] : null,
  }));
}
/** The same as a row of channel cards (TV and phone start page): each card says which match and when. */
function matchRow(prof, st, base) {
  const list = upcomingMatches(prof, st, base);
  if (!list.length) return null;
  const items = list.map(m => Object.assign({}, m.ch, { k: m.ch.k + '@' + m.s, mt: { t: m.title, s: m.s, e: m.e, label: m.label, foreign: m.foreign, ch: m.chName, arena: m.arena, compImg: m.compImg, comp: (m.label || '').split(' · ').pop(), sides: m.sides, col: m.team.col } }));
  return row('matches', 'Dina lags matcher', 'live', items, { limit: 40 });
}

route('GET', '/api/sport', (req, res, q) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  const st = store.profileState(prof.id);
  ok(res, { match: sportNow(prof, st, ingressBase(req)), teams: sport.list(), upcoming: upcomingMatches(prof, st, ingressBase(req)) });
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
  } catch (e) { bad(res, redactAcct(e.message), 502); }
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
    likes: st.likes || {},
    prefs: st.prefs || {},
  });
});

route('POST', '/api/state/:profile/prefs', async (req, res, q, p) => {
  // the profile's own choices: subtitle and sound language, favourite team
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  const pr = st.prefs || (st.prefs = {});
  for (const k of ['sub', 'audio']) if (typeof b[k] === 'string') pr[k] = b[k].toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12);
  // several favourite teams; `team` (the first, or 'none') stays for a screen still running the older app
  if (Array.isArray(b.teams)) { pr.teams = sport.teamIds(b.teams); pr.team = pr.teams[0] || 'none'; pr.nations = true; }
  else if (typeof b.team === 'string') { pr.team = sport.teamId(b.team); pr.teams = sport.teamIds(pr.team); }
  store.saveState();
  ok(res, { ok: true, prefs: pr });
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
  const lockKey = 'prof:' + prof.id + ':' + clientKey(req); // per profile: a child's guesses don't lock the parents' profile
  const wait = pinLocked(lockKey);
  if (wait) return bad(res, 'För många fel PIN-koder – vänta ' + (wait > 90 ? Math.ceil(wait / 60) + ' min' : wait + ' s'), 429);
  const all = store.config.profiles || [];
  const from = all.find(x => x.id === b.from);
  // accepted codes: the profile's own PIN; leaving a kids profile also takes any parent's PIN
  const codes = [];
  if (prof.pin) codes.push(prof.pin);
  if (from && from.kids && !prof.kids) for (const x of all) if (!x.kids && x.pin) codes.push(x.pin);
  if (!codes.length || codes.includes(String(b.pin || ''))) { pinFails.delete(lockKey); return ok(res, { ok: true, token: prof.pin ? profToken(prof) : '' }); }
  pinFailed(lockKey);
  await new Promise(r => setTimeout(r, 600)); // slow down guessing
  bad(res, 'Fel PIN-kod', 403);
});

route('POST', '/api/state/:profile/like', async (req, res, q, p) => {
  // thumbs up / down (v: 1, -1, or 0 to clear); feeds "Föreslaget för dig"
  const b = await readBody(req);
  const st = store.profileState(store.profile(p.profile).id);
  const k = String(b.k || '');
  if (!/^[ms]:[\w.-]{1,40}$/.test(k)) return bad(res, 'k');
  st.likes = st.likes || {};
  if (+b.v === 1 || +b.v === -1) st.likes[k] = +b.v; else delete st.likes[k];
  store.saveState();
  const sc = svcRows.get(store.profile(p.profile).id);
  if (sc && !sc.busy) sc.at = 0; // new taste: work the services row out again
  ok(res, { ok: true });
});

route('GET', '/api/recommend', (req, res, q) => {
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  ok(res, { items: recommendations(prof, store.profileState(prof.id), 60) });
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
let lastPlayAt = 0; // the last time something real (not a preview) played; devices report every minute while they play
const services = new Services(() => store.config.options);

/** The title in the library ("Finns i Norrsken"), if it is there. */
function localTwin(it, prof) {
  const type = it.mt === 'tv' ? 'series' : 'movie';
  const hit = catalog.byTitle(type, it.n, it.y, prof);
  return hit ? { t: hit.t, id: hit.id, k: hit.k, n: hit.n, img: hit.img, y: hit.y } : null;
}

/** TMDB titles for what the profile liked or watched most: the seeds for "på dina tjänster". */
async function serviceSeeds(st) {
  const sig = [...tasteSignals(st).entries()].filter(([, w]) => w > 1).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const out = [];
  for (const [k] of sig) {
    const type = k[0] === 's' ? 'series' : 'movie';
    const it = catalog.get(type, k.slice(2));
    if (!it) continue;
    const info = catalog.info.get(k) || {};
    const mt = type === 'series' ? 'tv' : 'movie';
    let id = info.tmdb;
    if (!id) {
      try {
        const r = await services.get('/search/' + mt, { query: it.n, year: mt === 'movie' ? it.y : '', first_air_date_year: mt === 'tv' ? it.y : '', language: 'sv-SE' }, 7 * 86400e3);
        id = r.results && r.results[0] && r.results[0].id;
      } catch (e) { if (/nyckeln/.test(e.message)) throw e; }
    }
    if (id) out.push({ mt, id: String(id), n: it.n });
  }
  return out;
}

/*
 * "Föreslaget på dina tjänster" on the start page: worked out in the background (it takes a few dozen TMDB
 * lookups the first time) and shown from then on, refreshed every few hours.
 */
const svcRows = new Map(); // profile id → { at, items, busy }
function serviceRow(prof) {
  if (!services.enabled() || prof.kids) return null;
  let c = svcRows.get(prof.id);
  if (!c || (Date.now() - c.at > 4 * 3600e3 && !c.busy)) {
    c = c || { at: 0, items: [] };
    c.busy = true;
    svcRows.set(prof.id, c);
    const st = store.profileState(prof.id);
    serviceSeeds(st).then(seeds => services.suggest({ seeds, limit: 30 }))
      .then(items => { c.items = items.filter(it => !localTwin(it, prof)).slice(0, 24); c.at = Date.now(); })
      .catch(e => { console.error('[tjänster]', e.message); c.at = Date.now() - 3.5 * 3600e3; })
      .finally(() => { c.busy = false; });
  }
  return c.items.length >= 4 ? row('svc', 'Föreslaget på dina tjänster', 'poster', c.items, { limit: 24 }) : null;
}

route('GET', '/api/services/where/:mt/:id', async (req, res, q, p) => {
  if (!services.enabled() || !['movie', 'tv'].includes(p.mt) || !/^\d+$/.test(p.id)) return ok(res, { svc: [] });
  try { ok(res, { svc: await services.where(p.mt, p.id) }); } catch (e) { ok(res, { svc: [], error: e.message }); }
});

route('GET', '/api/extras/:mt/:id', async (req, res, q, p) => {
  if (!services.enabled() || !['movie', 'tv'].includes(p.mt) || !/^\d+$/.test(p.id)) return ok(res, { cast: [], videos: [] });
  try {
    const x = await services.extras(p.mt, p.id);
    if (profileOf(q).kids) x.videos = []; // no YouTube links from a kids profile
    ok(res, x);
  } catch (e) { ok(res, { cast: [], videos: [], error: e.message }); }
});

route('GET', '/api/services', (req, res) => ok(res, { enabled: services.enabled(), chosen: services.chosen(), info: serviceInfo(), error: services.lastError }));

route('GET', '/api/services/search', async (req, res, q) => {
  if (!services.enabled()) return ok(res, { enabled: false, items: [] });
  const prof = profileOf(q);
  if (prof.kids) return ok(res, { enabled: true, items: [] }); // kids profiles: only what's in the library
  try {
    const items = await services.search(q.get('q') || '');
    for (const it of items) it.local = localTwin(it, prof);
    ok(res, { enabled: true, items });
  } catch (e) { ok(res, { enabled: true, items: [], error: e.message }); }
});

route('GET', '/api/services/suggest', async (req, res, q) => {
  if (!services.enabled()) return ok(res, { enabled: false, items: [] });
  const prof = profileOf(q);
  if (prof.kids) return ok(res, { enabled: true, items: [] });
  const st = store.profileState(prof.id);
  try {
    const seeds = await serviceSeeds(st);
    const skip = new Set(Object.keys(st.extSkip || {}));
    let items = await services.suggest({ seeds, skip, limit: 30 });
    // what is in the library already plays here: leave it out of the services row
    items = items.filter(it => !localTwin(it, prof)).slice(0, 24);
    ok(res, { enabled: true, items });
  } catch (e) { ok(res, { enabled: true, items: [], error: e.message }); }
});

route('GET', '/api/services/title/:mt/:id', async (req, res, q, p) => {
  if (!services.enabled()) return bad(res, 'Ingen TMDB-nyckel', 404);
  if (!['movie', 'tv'].includes(p.mt) || !/^\d+$/.test(p.id)) return bad(res, 'id');
  try {
    const it = await services.detail(p.mt, p.id);
    it.local = localTwin(it, profileOf(q));
    ok(res, it);
  } catch (e) { bad(res, e.message, 502); }
});

catalog.isBusy = () => Date.now() - lastStreamAt < 15 * 60e3 || ff.activeSessions() > 0 || tsbuf.recording() > 0 || downloads.active() > 0;
/* A device that plays (also straight from the provider, which the server never sees) says so every minute:
   the match recording then waits instead of taking the one connection. */
route('POST', '/api/watching', async (req, res) => {
  lastStreamAt = lastPlayAt = Date.now();
  let b = {};
  try { b = await readBody(req); } catch (_) { /* nothing */ }
  // a device playing straight from the provider (the server can't see that connection): a download gives way to it
  if (!b.dl) dlYield('en enhet spelar');
  // watching the channel of a match whose recording is due: the player asks for the channel again and gets the recording
  const ch = b && b.ch ? String(b.ch) : '';
  const recNow = !!(ch && !tsbuf.matchSession() && dueMatch(ch));
  // Luleå's match starts while this device plays something else straight from the provider (a connection the
  // server can't end): on a one-connection account it has to give way, so the player switches to the match
  let matchOn = null;
  const maxConn = (catalog.data && catalog.data.maxConn) || 1;
  if (!recNow && !b.dl && maxConn <= 2 && !tsbuf.matchSession()) { // a downloaded film uses no provider connection
    const due = dueAny();
    if (due && !(due.m.chans || [due.m.ch]).some(c => String(c.id) === ch)) matchOn = { title: due.m.title, ch: due.m.ch };
  }
  ok(res, { ok: true, recNow, matchOn });
});

route('POST', '/api/prepare/:type/:id', (req, res, q, p) => {
  // Read the file's format in the background so pressing Play starts faster – but never at the cost of a
  // provider connection someone needs: one at a time, not while anything plays, not on 1–2 connection accounts.
  const maxConn = (catalog.data && catalog.data.maxConn) || 0;
  const busy = preparing || Date.now() - lastStreamAt < 20000 || downloads.active() > 0 || ff.activeSessions() > 0 || tsbuf.pauseActive() > 0 || proxy.activeCount() > 0 || tsbuf.matchSession() || (maxConn && maxConn <= 2);
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
  const busy = matchRecBusy(type, id, !!q.get('start'));
  if (busy) return bad(res, busy, 409);
  // the channel whose match is being recorded: the recording at its live edge, never a second provider connection
  if (type === 'live' && !q.get('start') && !q.get('pv') && !q.get('air')) matchTakeover(id);
  const rec = type === 'live' && !q.get('start') ? sameChannelRec(id, ingressBase(req)) : null;
  if (rec && q.get('pv')) return bad(res, 'Matchen spelas in på kanalen', 409); // no preview from the recording's start
  if (rec) return ok(res, { live: true, sources: [{ kind: 'hls', url: rec.url }], rec });
  // downloaded to the storage disk: played from there, no provider connection (and nothing else is cut off)
  const dl = type === 'live' ? null : downloads.doneFor(type, id);
  if (dl) {
    // its sound tracks (read from the local file, fast): the player offers them although nothing is converted
    const it = downloads.get(dl.id);
    let timer = null;
    const pr = it && ff.has() ? await Promise.race([ff.probe(downloads.fileOf(it)).catch(() => null), new Promise(r => { timer = setTimeout(() => r(null), 5000); })]).finally(() => clearTimeout(timer)) : null;
    return ok(res, { live: false, sources: [{ kind: 'file', url: ingressBase(req) + '/dl/' + dl.file + '?ft=' + fileToken(dl.id) }], ext: 'mp4', t: '', downloaded: true,
      probe: pr ? { audio: pr.audio || [], subs: [], dur: pr.dur || 0 } : null });
  }
  // one connection: a new stream ends a paused channel; a preview (start page, guide) gives way to it instead
  const air = !!q.get('air'); // AirPlay preparation: just the addresses, it must not end what plays or open a connection
  if (q.get('pv') && (tsbuf.pauseActive() > 0 || ff.activeSessions() > 0 || proxy.activeCount() > 0 || downloads.active() > 0)) return bad(res, 'Något annat spelas just nu', 409);
  if (!air) takeConnection('ny ström'); // and a film being converted (the newest stream wins, as when a film starts)
  if (!air) { lastStreamAt = Date.now(); if (!q.get('pv')) lastPlayAt = lastStreamAt; }
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
  if (ff.has() && !air) {
    const caps = parseCaps(q.get('caps'));
    try { info = await Promise.race([ff.probe(src.primary, catalog.ua()), new Promise((_, no) => setTimeout(() => no(new Error('t')), 7000))]); } catch (_) { /* unknown: keep order */ }
    const o = store.config.options;
    // judge by the track that plays: the file's default sound track, which isn't always the first
    const a0 = info ? Math.max(0, info.audio.findIndex(x => x.def)) : 0;
    if (info && !ff.playsAsIs(info, caps, { a: a0, audioMode: o.audioMode, maxRes: o.maxRes })) order = [remux, ...sources.filter(x => x !== remux)];
  }
  ok(res, { live: false, sources: order, t: ff.has() ? t : '', ext, media: info ? { h: info.height, w: info.width || 0, hdr: info.hdr || '', sar: info.sar || '', dar: info.dar || '', v: info.video, a: (info.audio.find(x => x.def) || info.audio[0] || {}).codec, ch: (info.audio.find(x => x.def) || info.audio[0] || {}).ch, na: info.audio.length } : null });
});

/* ------------------------------------------------------------------ match recording (the whole match, 24 h) */
const MATCH_TEAM = 'lulea';
const MATCH_LEAD_MS = 5 * 60e3; // start a little before the puck drops
const MATCH_TAIL_MS = 10 * 60e3; // and go on a little after the final whistle
const KEEP_MATCH_MS = 24 * 3600e3;
const matchRecs = new Map(); // team|start → { key, mid, s, e, title, chId, chName, sessId, parts }
const MATCH_FILE = path.join(DATA_DIR, 'matchrecs.json');
/** The match recordings survive a restart of the add-on (an update in the middle of a match must not lose its start). */
function saveMatchRecs() {
  try { fs.writeFileSync(MATCH_FILE, JSON.stringify({ recs: [...matchRecs.values()], stopped: [...matchStopped] })); } catch (e) { console.error('[match] kunde inte spara listan:', e.message); }
}
/** The recordings (all parts) of the match recordings the server lists, younger than a day: never tidied away. */
function matchRecIdsOnFile() {
  try {
    const j = JSON.parse(fs.readFileSync(MATCH_FILE, 'utf8'));
    const list = Array.isArray(j) ? j : (j.recs || []);
    const ids = [];
    for (const r of list) if (r && Date.now() - r.s < KEEP_MATCH_MS) ids.push(...(r.parts || []), r.sessId);
    return ids.filter(Boolean);
  } catch (_) { return []; }
}
// match recordings start only once the earlier ones are back (or it is clear they cannot be): otherwise a restart in
// the middle of a match would start a new recording and forget the one with the start of the match
let matchRecReady = true; // start() holds it back until the earlier recordings are back
function loadMatchRecs(keptIds) {
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(MATCH_FILE, 'utf8'));
    list = Array.isArray(j) ? j : (j.recs || []);
    // a match the viewer stopped stays stopped after a restart
    for (const [k, t] of (Array.isArray(j) ? [] : j.stopped || [])) if (Date.now() - t < KEEP_MATCH_MS) matchStopped.set(k, t);
  } catch (_) { return; }
  const kept = new Set(keptIds);
  for (const r of list) {
    if (!r || !r.key || Date.now() - r.s > KEEP_MATCH_MS) continue;
    const parts = [...(r.parts || []), r.sessId].filter(id => kept.has(id));
    if (!parts.length) continue;
    r.sessId = parts[parts.length - 1];
    r.parts = parts.slice(0, -1);
    r.mid = r.mid || Math.random().toString(36).slice(2, 10);
    r.tries = 0; r.gaveUp = false;
    matchRecs.set(r.key, r);
  }
  if (matchRecs.size) console.log('[match] fortsätter:', [...matchRecs.values()].map(r => r.title).join(', '));
}
/** Every recording of a match in order (earlier parts first: the provider dropped it, or the add-on restarted). */
const recParts = (r) => [...(r.parts || []), r.sessId].map(id => tsbuf.get(id)).filter(Boolean);
const matchStopped = new Map(); // team|start → when the viewer stopped it: not started again for that match
let matchWaitLog = 0;
const matchFailAt = new Map(); // team|start → when starting its recording last failed (so nobody loops on it)
/**
 * How long after the recording stopped before it is started again: 15 s, 30 s, then every minute; after ten breaks in
 * a row every five minutes (the provider is down: don't hammer it, and don't keep cutting off what others watch).
 */
const matchBackoff = (tries) => ((tries || 0) >= 10 ? 5 * 60e3 : Math.min(60e3, 15e3 * 2 ** (tries || 0)));
/** '' when a match recording of this channel can start now, otherwise why not (no channel, no ffmpeg, disk full). */
function startMatchPreflight(ch) {
  const src = catalog.streamUrl('live', ch.id);
  if (!src || !src.primary) return 'kanalen saknas';
  if (!ff.has()) return 'ffmpeg saknas';
  return tsbuf.preflight();
}
const matchWait = new Map(); // team|start → when the recording last had to wait for another stream (shown on the start page)

/** A match is being recorded on another channel: the reason to refuse a new stream (the provider gives one). */
/** A download holds a provider connection: on accounts with one or two, whatever else wants one goes first. */
function dlYield(why) { if (((catalog.data && catalog.data.maxConn) || 1) <= 2) downloads.yieldTo(why); }
/** A new stream takes the provider's one connection: a paused channel, a conversion and proxied streams end. */
function takeConnection(why) {
  dlYield(why); // a download uses a connection too
  tsbuf.stopPauses(why);
  ff.stopAll();
  proxy.abortAll();
}

function matchRecBusy(type, id, archive) {
  const ms = tsbuf.matchSession();
  if (!ms) return '';
  const r = [...matchRecs.values()].find(x => x.sessId === ms.id);
  if (r && type === 'live' && r.chId === id && !archive) return '';
  return 'Matchen ' + (r ? r.title + ' ' : '') + 'spelas in. Stoppa inspelningen först (leverantören skickar bara en kanal åt gången).';
}

/** The running match recording when it is on this channel: { id, url, edge } to play instead of the channel. */
function sameChannelRec(id, base) {
  const ms = tsbuf.matchSession();
  if (!ms) return null;
  const r = [...matchRecs.values()].find(x => x.sessId === ms.id);
  if (!r || String(r.chId) !== String(id)) return null;
  return { id: ms.id, url: base + '/mrec/' + r.mid + '/index.m3u8', edge: true };
}

function recInfo(r, base) {
  const s = r && tsbuf.get(r.sessId);
  if (!s) return null;
  const sec = recParts(r).reduce((n, x) => n + tsbuf.length(x), 0);
  return { id: s.id, url: base + '/mrec/' + r.mid + '/index.m3u8', sec: Math.round(sec), recording: !s.done && !s.dead, title: r.title, ch: r.chName, chId: r.chId, s: r.s, e: r.e, parts: recParts(r).length };
}
route('GET', '/mrec/:mid/index.m3u8', async (req, res, q, p) => {
  const r = [...matchRecs.values()].find(x => x.mid === p.mid);
  if (!r) return bad(res, 'Inspelningen finns inte längre', 404);
  for (const x of recParts(r)) tsbuf.get(x.id); // someone watches: keeps them
  try { send(res, 200, await tsbuf.playlistMulti(recParts(r), ingressBase(req) + '/pause', { edge: q.get('edge') === '1' }), 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); } catch (e) { bad(res, e.message, 502); }
});

route('GET', '/mrec/:mid/live.m3u8', (req, res, q, p) => {
  const r = [...matchRecs.values()].find(x => x.mid === p.mid);
  if (!r) return bad(res, 'Inspelningen finns inte längre', 404);
  const w = Math.max(6, Math.min(100000, parseInt(q.get('w'), 10) || 0)) || undefined;
  const t = tsbuf.livePlaylist(recParts(r), ingressBase(req) + '/pause', w ? { window: w } : {});
  if (!t) return bad(res, 'Inspelningen kom inte igång', 503);
  send(res, 200, t, 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
});

/** Records every match of the favourite team (Luleå Hockey) from just before it starts until the end, if it's on a channel we have. */
/** What records by itself today: Luleå's matches, and the skiing world cups when that is switched on. Nothing else. */
function recList(now) {
  return sport.recToday(MATCH_TEAM, (store.config.options || {}).skiRec === true, sportChannels(store.profile('')), catalog.epg, { now });
}
function matchRecTick() {
  if (!catalog.ready() || !matchRecReady) return;
  const now = Date.now();
  for (const [k, t] of matchStopped) if (now - t > KEEP_MATCH_MS) matchStopped.delete(k);
  for (const [k, r] of matchRecs) {
    if (now - r.s > KEEP_MATCH_MS) { for (const id of [r.sessId].concat(r.parts || [])) { const s = tsbuf.get(id); if (s) tsbuf.stop(s, 'ett dygn gånget'); } matchRecs.delete(k); saveMatchRecs(); }
  }
  if ((store.config.options || {}).matchRec === false) return;
  let list = [];
  try { list = recList(now); } catch (e) { return; }
  for (const m of list) {
    const key = m.team.id + '|' + m.s;
    if (now < m.s - MATCH_LEAD_MS || now > m.e + MATCH_TAIL_MS) continue;
    if (matchStopped.has(key)) continue; // the viewer said stop
    const had = matchRecs.get(key);
    if (had) {
      // still recording, or finished as planned: nothing to do; it stopped early (provider dropped it): go on
      const hs = tsbuf.get(had.sessId);
      // the channel is tested, always: no picture 18 s after it was opened means it does not work – stop waiting
      if (hs && !hs.done && !hs.full && now - hs.started > 18e3 && tsbuf.length(hs) === 0) {
        console.log('[match]', m.title, '–', had.chName, 'ger ingen bild');
        try { if (hs.proc) hs.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
        hs.done = true;
      }
      if (hs && (!hs.done || hs.full)) continue;
      if (!hs) continue; // removed by the viewer
      had.tries = had.tries || 0;
      // a channel that never gave a picture: the next one that shows the match at once (Full HD first, then the
      // others, another country's last); after a whole round of them, with the usual wait between tries
      const dry = tsbuf.length(hs) === 0;
      if (dry && !had.dryAt) { had.dryAt = hs.started; had.chIdx = (had.chIdx || 0) + 1; }
      const round = m.chans.length + (m.alt || []).length;
      // the whole match matters: never give up while it is on; wait a little longer each time (at most a minute)
      if (!(dry && (had.chIdx || 0) < round * 2) && now - (had.restartAt || 0) < matchBackoff(had.tries)) continue;
      if (had.tries && had.tries % 10 === 0 && had.loggedTries !== had.tries) { had.loggedTries = had.tries; console.log('[match] inspelningen av', m.title, 'har avbrutits', had.tries, 'gånger – fortsätter försöka'); }
    }
    if (tsbuf.matchSession()) break; // the provider gives one connection: the recording that runs goes on
    // Luleå's matches are always recorded from the start of the broadcast. Someone watching something else on a
    // one-connection account gives way (their player is told to switch to the match); with more connections both go.
    if (now - (matchFailAt.get(key) || 0) < matchBackoff(had ? had.tries : 0) * (matchFailAt.has(key) ? 2 : 1)) continue; // it could not start a moment ago
    // check that it can start (channel, disk) before anyone's picture is cut off for it
    const pre = startMatchPreflight(m.ch);
    if (pre) { matchFailAt.set(key, now); if (now - (matchWaitLog || 0) > 5 * 60e3) { matchWaitLog = now; console.error('[match]', m.title, '– kan inte spela in:', pre); } continue; }
    const maxConn = (catalog.data && catalog.data.maxConn) || 1;
    if (maxConn <= 2 && (ff.activeSessions() > 0 || tsbuf.pauseActive() > 0 || proxy.activeCount() > 0 || Date.now() - lastStreamAt < 3 * 60e3)) {
      // skiing never cuts off what someone is watching: it is recorded when the connection is free (or when they watch it)
      if (m.team.id !== MATCH_TEAM) { matchWait.set(key, now); continue; }
      if (now - (matchWaitLog || 0) > 5 * 60e3) { matchWaitLog = now; console.log('[match]', m.title, 'börjar – matchinspelningen tar leverantörens anslutning före annat tittande'); }
      matchWait.set(key, now);
      takeConnection('matchinspelning');
    }
    // the Swedish channel first; when it will not start (three tries in a row) the others take turns with it, another
    // country's broadcast last – a match recorded from Norway is better than no match
    let ch = m.ch;
    if (had && had.chIdx) { const cand = m.chans.concat(m.alt || []); ch = cand[had.chIdx % cand.length] || m.ch; had.dryAt = 0; console.log('[match]', m.title, '– byter till', ch.n); }
    try { startMatchRec(m, key, had, ch, now); } catch (e) { matchFailAt.set(key, now); console.error('[match]', e.message); }
  }
}

/** Start (or restart) the recording of a match on channel `ch`. Throws when ffmpeg or the disk can't. */
function startMatchRec(m, key, had, ch, now = Date.now()) {
  const src = catalog.streamUrl('live', ch.id);
  if (!src || !src.primary) throw new Error('kanalen saknas: ' + (ch.n || ch.id));
  downloads.yieldTo('matchinspelning');
  const chName = (m.chans && m.chans[0] === ch && m.chName) || ch.n;
  const sess = tsbuf.start(src.primary, { ua: catalog.ua(), maxMin: Math.ceil((m.e + MATCH_TAIL_MS - now) / 60e3), ch: m.title + ' på ' + chName, match: true });
  if (had) {
    console.log('[match] inspelningen av', m.title, 'avbröts – startar om');
    const prev = tsbuf.get(had.sessId);
    if (prev && tsbuf.length(prev) > 600) had.tries = 0; // it ran ten minutes: a new break, not the same one
    had.restartAt = now; had.tries = (had.tries || 0) + 1;
    const old = tsbuf.get(had.sessId); had.sessId = sess.id; had.chId = ch.id; had.chName = chName; had.parts = (had.parts || []).concat(old ? [old.id] : []);
  } else matchRecs.set(key, { key, mid: Math.random().toString(36).slice(2, 10), s: m.s, e: m.e, title: m.title, chId: ch.id, chName, sessId: sess.id, parts: [] });
  saveMatchRecs();
  return sess;
}

/**
 * The favourite's match on this channel when its recording should be running now (or starts within `aheadMs`) but
 * isn't: { m, key, had, ch }. Someone watching or pausing that channel then gets the recording instead of the
 * channel, so one provider connection gives both "from the start" and live.
 */
function dueMatch(chId, now = Date.now(), aheadMs = 0) {
  if (!chId || !catalog.ready() || (store.config.options || {}).matchRec === false) return null;
  let list = [];
  try { list = recList(now); } catch (e) { return null; }
  for (const m of list) {
    // (any channel that shows the match, another country's too: whoever watches it there is watching the recording)
    const ch = (m.chans || [m.ch]).concat(m.alt || []).find(c => String(c.id) === String(chId));
    if (!ch) continue;
    const key = m.team.id + '|' + m.s;
    if (matchStopped.has(key)) continue;
    if (now < m.s - MATCH_LEAD_MS - aheadMs || now > m.e + MATCH_TAIL_MS) continue;
    const had = matchRecs.get(key);
    if (had) {
      const hs = tsbuf.get(had.sessId);
      if (hs && !hs.dead && (!hs.done || hs.full)) continue; // already recording (or finished as planned)
      if (now - (had.restartAt || 0) < matchBackoff(had.tries)) continue; // it just stopped: not again at once
    }
    if (now - (matchFailAt.get(key) || 0) < 60e3) continue; // it could not start a moment ago (disk, channel)
    return { m, key, had, ch };
  }
  return null;
}

/** Pause on the match channel before the window opens: record from now to the end of the match. */
function matchTakeoverPause(id, aheadMs) {
  if (tsbuf.matchSession()) return false;
  const due = dueMatch(id, Date.now(), aheadMs);
  if (!due) return false;
  takeConnection('matchinspelning');
  try { startMatchRec(due.m, due.key, due.had, due.ch); console.log('[match]', due.m.title, '– pausad på kanalen: pausen blir matchinspelningen'); return true; } catch (e) { matchFailAt.set(due.key, Date.now()); console.error('[match]', e.message); return false; }
}

/** Luleå's match whose recording should run now, on whichever channel. */
function dueAny(now = Date.now()) {
  if (!catalog.ready() || (store.config.options || {}).matchRec === false) return null;
  let list = [];
  try { list = recList(now); } catch (e) { return null; }
  for (const m of list) {
    const key = m.team.id + '|' + m.s;
    if (m.team.id !== MATCH_TEAM) continue; // only Luleå's match moves a viewer over to it
    if (matchStopped.has(key) || now < m.s - MATCH_LEAD_MS || now > m.e + MATCH_TAIL_MS) continue;
    return { m, key };
  }
  return null;
}

/** A viewer asks for this live channel: start its match recording first when one is due, so they watch through it. */
function matchTakeover(id) {
  if (tsbuf.matchSession()) return false;
  const due = dueMatch(id);
  if (!due) return false;
  takeConnection('matchinspelning');
  try {
    startMatchRec(due.m, due.key, due.had, due.ch);
    console.log('[match]', due.m.title, '– du tittar på kanalen: spelar in och visar inspelningen live (en anslutning)');
    return true;
  } catch (e) { matchFailAt.set(due.key, Date.now()); console.error('[match]', e.message); return false; }
}

route('GET', '/api/matchrec', (req, res) => {
  const base = ingressBase(req);
  const recs = [...matchRecs.values()].map(r => recInfo(r, base)).filter(Boolean);
  const on = recs.find(x => x.recording) || null;
  ok(res, { active: on ? { id: on.id, chId: on.chId, chName: on.ch, title: on.title } : null, recs });
});
route('POST', '/api/matchrec/stop', (req, res) => {
  let n = 0;
  for (const [k, r] of matchRecs) {
    matchStopped.set(k, Date.now());
    for (const id of [r.sessId].concat(r.parts || [])) { // a recording that was restarted has earlier parts too
      const s = tsbuf.get(id);
      if (s && !s.dead) { tsbuf.stop(s, 'borttagen av användaren'); n++; }
    }
    matchRecs.delete(k);
  }
  saveMatchRecs();
  ok(res, { ok: true, stopped: n });
});

/* ------------------------------------------------------------------ pause live TV (record to disk) */
route('POST', '/api/pause/start', async (req, res, q) => {
  const b = await readBody(req);
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  if (!ff.has()) return bad(res, 'ffmpeg saknas på servern', 501);
  const o = store.config.options;
  if ((o.pauseMode || 'auto') !== 'auto') return bad(res, 'Paus med inspelning är avstängd i inställningarna', 403);
  const prof = profileOf(q);
  const id = String(b.id || '');
  if (prof.kids && !catalog.allowed('live', id, prof)) return bad(res, 'Det här finns inte i barnprofilen', 403);
  if (!pinOk(q, prof)) return bad(res, 'Profilen är låst', 401);
  const src = catalog.streamUrl('live', id);
  if (!src || !src.primary) return bad(res, 'Kunde inte hitta kanalen', 404);
  // a match is being recorded: pausing the same channel uses that recording, another channel has to wait
  const ms = tsbuf.matchSession();
  if (ms) {
    const r = [...matchRecs.values()].find(x => x.sessId === ms.id);
    if (r && String(r.chId) === id) return ok(res, { id: ms.id, url: ingressBase(req) + '/mrec/' + r.mid + '/index.m3u8', max: ms.maxMin, match: true });
    return bad(res, 'Matchinspelningen pågår på ' + (r ? r.chName : 'en annan kanal') + '. Avbryt den först.', 409);
  }
  // pausing the favourite's match channel shortly before or during the match: the pause is the match recording
  if (matchTakeoverPause(id, (+o.pauseMax || 60) * 60e3)) {
    const ms2 = tsbuf.matchSession();
    const r2 = ms2 && [...matchRecs.values()].find(x => x.sessId === ms2.id);
    if (ms2 && r2) return ok(res, { id: ms2.id, url: ingressBase(req) + '/mrec/' + r2.mid + '/index.m3u8', max: ms2.maxMin, match: true });
  }
  lastStreamAt = Date.now();
  dlYield('paus'); ff.stopAll(); proxy.abortAll(); // one connection: a film being converted or proxied ends when a channel is paused
  try {
    const it = catalog.get('live', id) || {};
    // the Time Capsule's disk may be asleep: a pause waits for it rather than trust an old answer; live on an iPhone
    // never waits more than a moment (without the Time Capsule it plays from memory, it only cannot pause back)
    // live on an iPhone/iPad (and AirPlay of a live channel) only passes through the server's memory: nothing is
    // recorded, the Time Capsule is not used. A real pause waits for its disk, which may be asleep.
    if (!b.live) await tsbuf.wakeTC();
    // live on an iPhone goes through this recording the whole time it is watched: long enough for an evening
    const s = tsbuf.start(src.primary, { ua: catalog.ua(), maxMin: b.live ? 360 : (+o.pauseMax || 60), ch: it.n || id, live: !!b.live });
    ok(res, { id: s.id, url: ingressBase(req) + '/pause/' + s.id + '/index.m3u8', max: s.maxMin, relay: !!s.ring });
  } catch (e) { bad(res, e.message, 507); }
});
route('POST', '/api/pause/:id/alive', (req, res, q, p) => {
  const s = tsbuf.get(p.id);
  if (s && !s.match) lastStreamAt = Date.now(); // someone is paused on a channel: still watching
  if (!s) return bad(res, 'slut', 404);
  ok(res, { ok: true, sec: tsbuf.length(s), full: s.full, done: s.done });
});
route('POST', '/api/pause/:id/stop', (req, res, q, p) => {
  const s = tsbuf.get(p.id);
  if (s && !s.match) tsbuf.stop(s, 'gick till live'); // a match recording is not the viewer's to stop
  ok(res, { ok: true });
});
route('GET', '/pause/:id/index.m3u8', async (req, res, q, p) => {
  const s = tsbuf.get(p.id);
  if (!s) return bad(res, 'Inspelningen finns inte längre', 404);
  try { send(res, 200, await tsbuf.playlist(s, ingressBase(req) + '/pause', { edge: q.get('edge') === '1' }), 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); } catch (e) { bad(res, e.message, 502); }
});
// AirPlay of live: an ordinary sliding live playlist of the newest pieces (see tsbuf.livePlaylist)
route('GET', '/pause/:id/live.m3u8', (req, res, q, p) => {
  const s = tsbuf.get(p.id);
  if (!s) return bad(res, 'Inspelningen finns inte längre', 404);
  const w = Math.max(6, Math.min(100000, parseInt(q.get('w'), 10) || 0)) || undefined;
  const t = tsbuf.livePlaylist([s], ingressBase(req) + '/pause', w ? { window: w } : {});
  if (!t) return bad(res, 'Inspelningen kom inte igång', 503);
  send(res, 200, t, 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
});
route('GET', '/pause/:id/:name', async (req, res, q, p) => {
  const f = await tsbuf.fileReady(p.id, p.name);
  if (!f) return bad(res, 'slut', 404);
  fs.stat(f, (err, st) => {
    if (err) return bad(res, 'saknas', 404);
    res.writeHead(200, { 'Content-Type': p.name.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
});


/* ------------------------------------------------------------------ downloads (to the storage disk) */
downloads.configure({
  busy: () => Date.now() - lastPlayAt < 3 * 60e3 || Date.now() - lastStreamAt < 20000 || ff.activeSessions() > 0 || tsbuf.recording() > 0 || proxy.activeCount() > 0 || !catalog.ready(),
  maxConn: () => (catalog.data && catalog.data.maxConn) || 1,
  probe: (u, ua) => ff.probe(u, ua),
  url: (type, id, ext) => catalog.streamUrl(type, id, ext),
  ua: () => catalog.ua(),
});

/** A URL part, or null when it isn't valid percent-encoding (then: 400, not a server error). */
function dec(x) { try { return decodeURIComponent(x); } catch (_) { return null; } }
/** What this profile may see of the downloads (a kids profile: only what its library shows). */
const dlVisible = (prof) => (x) => !prof.kids || catalog.allowed(x.type === 'episode' ? 'episode' : 'movie', x.mid, prof);
route('GET', '/api/downloads', (req, res, q) => {
  const prof = profileOf(q);
  if (!pinOk(q, prof)) return bad(res, 'Profilen är låst', 401);
  ok(res, { items: downloads.list().filter(dlVisible(prof)), storage: storage.info(), on: ff.has(), wait: tsbuf.matchSession() ? 'match' : '' });
});

route('POST', '/api/downloads', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'Nedladdning kräver ffmpeg', 503);
  if (!catalog.ready()) return bad(res, 'inte redo', 503);
  const prof = profileOf(q);
  if (!pinOk(q, prof)) return bad(res, 'Profilen är låst – välj den igen och ange PIN-koden', 401);
  const b = await readBody(req);
  const list = (Array.isArray(b.items) ? b.items : [b]).slice(0, 60);
  const out = [];
  const at = Date.now(); // one batch (a season) stays together and in order
  for (const x of list) {
    const type = x && x.type;
    const id = x && String(x.id == null ? '' : x.id);
    if (!id || (type !== 'movie' && type !== 'episode')) continue;
    if (prof.kids && !catalog.allowed(type, id, prof)) continue; // kids profiles: only what their library shows
    try { out.push(downloads.add({ type, id, ext: x.ext, title: x.title, sub: x.sub, img: x.img, at })); } catch (e) { return bad(res, e.message, 400); }
  }
  if (!out.length) return bad(res, 'Inget att ladda ner', 400);
  ok(res, { items: out });
});

/** A download this profile may change: a locked profile needs its PIN, a kids profile can't delete or retry. */
function dlFor(req, res, q, p) {
  const prof = profileOf(q);
  if (!pinOk(q, prof)) { bad(res, 'Profilen är låst', 401); return null; }
  if (prof.kids) { bad(res, 'Barnprofilen kan inte ändra nedladdningar', 403); return null; }
  const id = dec(p.id);
  if (id === null) { bad(res, 'Ogiltig adress', 400); return null; }
  return id;
}
route('POST', '/api/downloads/:id/delete', (req, res, q, p) => { const id = dlFor(req, res, q, p); if (id !== null) ok(res, { ok: downloads.remove(id) }); });
route('POST', '/api/downloads/:id/retry', (req, res, q, p) => {
  const id = dlFor(req, res, q, p);
  if (id === null) return;
  const it = downloads.get(id);
  if (!it) return bad(res, 'Finns inte', 404);
  if (it.status === 'error') { it.status = 'queued'; it.err = ''; downloads.pump(); }
  ok(res, { ok: true });
});

/** A finished download: played from the server (Range, so seeking works) or saved to the device (?dl=1). */
route('GET', '/dl/:id/:name', (req, res, q, p) => {
  const id = dec(p.id);
  if (id === null) return bad(res, 'Ogiltig adress', 400);
  const it = downloads.get(id);
  if (!it || it.status !== 'done') return bad(res, 'Filen finns inte', 404);
  // a player's address carries a token for this file (made after the profile checks in /api/stream); saving to the
  // device carries the profile: a kids profile only gets what its library shows
  if (!fileTokenOk(it.id, q.get('ft'))) {
    const prof = profileOf(q);
    if (!pinOk(q, prof) || !dlVisible(prof)(it)) return bad(res, 'Filen finns inte', 404);
  }
  const f = downloads.fileOf(it);
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return bad(res, 'Filen saknas på lagringsdisken', 404);
    const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range' };
    if (q.get('dl')) h['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent((it.title || 'film').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.mp4');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let a = 0;
    let z = st.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { a = +m[1]; if (m[2]) z = Math.min(+m[2], z); } else { a = Math.max(0, st.size - +m[2]); }
      if (a > z || a >= st.size) { res.writeHead(416, { ...h, 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': 'bytes ' + a + '-' + z + '/' + st.size, 'Content-Length': z - a + 1 });
    } else res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(f, { start: a, end: z });
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  });
});

/* AirPlay test page: four forms of one test clip, to see which the TV's AirPlay plays (no provider involved). */
route('GET', '/airtest', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas på servern', 501);
  // the same PIN as /setup (it shows what is being recorded and starts test encodings); asked for in the page
  const pin = setupPin();
  if (pin) {
    const key = 'airtest:' + clientKey(req);
    const wait = pinLocked(key);
    const sent = q.get('pin') || '';
    if (wait) return send(res, 429, airtest.pinPage('För många fel PIN-koder – vänta ' + wait + ' s'), 'text/html; charset=utf-8');
    if (!sent || !sameText(sent, pin)) { if (sent) pinFailed(key); return send(res, 401, airtest.pinPage(sent ? 'Fel PIN-kod' : ''), 'text/html; charset=utf-8'); }
    pinFails.delete(key);
  }
  await airtest.ensure();
  airtest.startLive();
  const lan = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : (lanUrls()[0] || '');
  // the match being recorded (or the last one): the real thing, next to the test clips
  // what Norrsken records right now (a match, a paused channel, live on the iPhone): the real channel, as the TV gets it
  // each in three forms, so the TV shows which one it takes: the recording from its start, the recording "12 s before
  // its end" (what live sent the TV up to 1.14.8), and the sliding live playlist live sends it now
  const extra = [];
  for (const x of tsbuf.list().slice(0, 1)) {
    const who = (x.match ? 'Matchinspelning: ' : 'Kanal just nu: ') + x.ch;
    extra.push({ name: who + ' – från början', url: '/pause/' + x.id + '/index.m3u8' });
    extra.push({ name: who + ' – nära slutet (som live gjorde förut)', url: '/pause/' + x.id + '/index.m3u8?edge=1' });
    extra.push({ name: who + ' – live, 40 s bakåt', url: '/pause/' + x.id + '/live.m3u8?w=10' });
    extra.push({ name: who + ' – live, 15 min bakåt', url: '/pause/' + x.id + '/live.m3u8?w=225' });
    extra.push({ name: who + ' – live, allt bakåt (det tv:n får nu)', url: '/pause/' + x.id + '/live.m3u8' });
  }
  send(res, 200, airtest.page(lan, extra), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
});
/* What fetched the recordings lately (a TV over AirPlay fetches them itself): the same PIN as /airtest. */
route('GET', '/airlog', (req, res, q) => {
  const pin = setupPin();
  if (pin) {
    const key = 'airtest:' + clientKey(req);
    const wait = pinLocked(key);
    const sent = q.get('pin') || '';
    if (wait) return send(res, 429, airtest.pinPage('För många fel PIN-koder – vänta ' + wait + ' s'), 'text/html; charset=utf-8');
    if (!sent || !sameText(sent, pin)) { if (sent) pinFailed(key); return send(res, 401, airtest.pinPage(sent ? 'Fel PIN-kod' : ''), 'text/html; charset=utf-8'); }
    pinFails.delete(key);
  }
  const d = airlog.summary();
  if (q.get('json')) return ok(res, d);
  const esc = (x) => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = (t) => new Date(t).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const rows = d.clients.map(c => `<tr class="${c.playing ? 'on' : ''}"><td><b>${esc(c.kind)}</b><br><small>${esc(c.ip)}</small></td><td>${c.playing ? 'Spelar nu' : 'Slutade ' + clock(c.last)}<br><small>började ${clock(c.first)} · ${c.secs} s</small></td><td>${c.lists} spellistor<br>${c.pieces} bitar · ${c.mb} MB</td><td class="${c.errors ? 'bad' : ''}">${c.errors} fel${c.lastErr ? '<br><small>' + esc(c.lastErr) + '</small>' : ''}</td><td><small>${esc(c.ua)}</small></td></tr>`).join('');
  const lines = d.log.map(e => `<tr class="${e.status >= 400 ? 'bad' : ''}"><td>${clock(e.t)}</td><td>${esc(e.kind)}</td><td>${esc(e.file)}</td><td>${e.status}</td><td>${e.ms} ms</td></tr>`).join('');
  send(res, 200, `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>AirPlay-logg</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;background:#0b0b0d;color:#eee;margin:20px}h1{font-size:22px}h2{font-size:16px;margin-top:26px;color:#aaa}table{border-collapse:collapse;width:100%}td{padding:7px 10px;border-bottom:1px solid #222;vertical-align:top}small{color:#999}tr.on td:first-child{box-shadow:inset 3px 0 #30d158}.bad,tr.bad td{color:#ff6961}p{color:#aaa;max-width:60em}</style>
<h1>AirPlay-logg</h1><p>Vilka enheter som hämtar bild från Norrsken just nu. När du skickar till tv:n med AirPlay ska tv:n dyka upp här som en egen rad och stå som ”Spelar nu”. Sidan uppdateras var femte sekund.</p>
<h2>Enheter</h2><table>${rows || '<tr><td>Ingen har hämtat något ännu. Starta en kanal på iPhonen.</td></tr>'}</table>
<h2>Senaste hämtningarna</h2><table>${lines}</table>`, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
});
route('GET', '/airtest/:v/:name', (req, res, q, p) => {
  if (p.name === 'index.m3u8' && airtest.LIVE[p.v]) {
    const t = airtest.livePlaylist(p.v);
    if (!t) return bad(res, 'inte igång än', 404);
    return send(res, 200, t, 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  }
  const f = airtest.file(p.v, p.name);
  if (!f) return bad(res, 'finns inte', 404);
  const type = p.name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : p.name.endsWith('.ts') ? 'video/mp2t' : p.name.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4';
  const size = fs.statSync(f).size;
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let a = 0, z = size - 1;
  if (m && (m[1] || m[2])) {
    if (m[1]) { a = +m[1]; if (m[2]) z = Math.min(+m[2], z); } else a = Math.max(0, size - +m[2]);
    if (a > z) { res.writeHead(416, { ...h, 'Content-Range': 'bytes */' + size }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': 'bytes ' + a + '-' + z + '/' + size, 'Content-Length': z - a + 1 });
  } else res.writeHead(200, { ...h, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f, { start: a, end: z }).pipe(res);
});

/*
 * Speed test: how fast the provider sends this title to the server (the leg other players skip: they fetch
 * straight from the provider), and how fast the server sends to the device. Run with the player stopped:
 * the provider gives one connection.
 */
let speedBusy = false;
route('GET', '/api/speedtest', async (req, res, q) => {
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  if (tsbuf.matchSession()) return bad(res, 'En match spelas in just nu – testa efter matchen', 409);
  if (downloads.active() > 0) return bad(res, 'En nedladdning pågår – testa när den är klar', 409);
  if (ff.activeSessions() > 0) return bad(res, 'Något annat spelas via servern just nu – testa när det är stängt', 409);
  if (tsbuf.pauseActive() > 0) return bad(res, 'En pausad kanal spelas in just nu – testa när den är stängd', 409);
  if (proxy.activeCount() > 0) return bad(res, 'Något spelas via servern just nu – testa när det är stängt', 409);
  if (speedBusy) return bad(res, 'Ett test pågår redan', 409);
  speedBusy = true;
  try { await speedTest(req, res, q, url); } finally { speedBusy = false; }
});
async function speedTest(req, res, q, url) {
  const sec = Math.min(15, Math.max(3, +q.get('sec') || 8));
  const t0 = Date.now();
  let bytes = 0, first = 0, err = '';
  try {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const { r, done } = await require('./lib/util').fetchRaw(url, { ua: catalog.ua(), timeout: (sec + 10) * 1000, signal: ac.signal });
    try {
      if (!r.ok) throw new Error('leverantören svarade ' + r.status);
      const rd = r.body.getReader();
      for (;;) {
        const { value, done: end } = await rd.read();
        if (end) break;
        if (!first) first = Date.now();
        bytes += value.length;
        if (Date.now() - t0 > sec * 1000 || bytes > 200e6) { try { await rd.cancel(); } catch (_) { /* ignore */ } break; }
      }
    } finally { done(); }
  } catch (e) { err = e.message; }
  const ms = Math.max(1, Date.now() - (first || t0));
  let br = 0;
  // the device went away: no new provider connection for the probe (it is cached when the film played anyway)
  if (!res.writableEnded && !res.destroyed) { try { br = (await ff.probe(url, catalog.ua())).br || 0; } catch (_) { /* unknown */ } }
  const mbps = bytes * 8 / ms / 1000;
  err = redactAcct(err);
  console.log('[hastighet] leverantören → servern', mbps.toFixed(1), 'Mbit/s', br ? '· filmen behöver ' + (br / 1e6).toFixed(1) + ' Mbit/s' : '', err ? '· ' + err : '');
  ok(res, { mbps, bytes, ms, firstMs: first ? first - t0 : 0, need: br / 1e6, err });
}
let downBusy = 0;
route('GET', '/api/speedtest/down', (req, res, q) => {
  if (downBusy >= 2) return bad(res, 'Ett test pågår redan', 429);
  downBusy++;
  res.on('close', () => { downBusy--; });
  const mb = Math.min(40, Math.max(2, +q.get('mb') || 20));
  const chunk = require('crypto').randomBytes(1 << 20); // random: nothing on the way can compress it
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': mb << 20, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  let n = 0;
  const more = () => { while (n < mb) { n++; if (!res.write(chunk)) { res.once('drain', more); return; } } res.end(); };
  more();
});

route('GET', '/api/probe', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const url = proxy.untoken(q.get('t'));
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  if (downloads.active() > 0 && (((catalog.data && catalog.data.maxConn) || 1) <= 2)) return bad(res, 'En nedladdning pågår', 409);
  try { ok(res, await ff.probe(url, catalog.ua())); } catch (e) { bad(res, e.message, 502); }
});

// Converted playback as HLS: works in every browser, including Safari and iPhone
route('GET', '/rx/play.m3u8', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const t = q.get('t') || '';
  const url = proxy.untoken(t);
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  const busy = matchRecBusy('movie', '');
  if (busy) return bad(res, busy, 409);
  dlYield('film startad'); tsbuf.stopPauses('film startad'); proxy.abortAll(); // one connection (other conversions are replaced by hlsSession; the same one is kept)
  const o = store.config.options;
  try {
    const s = await ff.hlsSession(url, { group: t, ss: Math.max(0, +q.get('ss') || 0), a: +q.get('a') || 0, ua: catalog.ua(),
      audioMode: o.audioMode, maxRes: o.maxRes, caps: parseCaps(q.get('caps')), safe: q.get('safe') === '1' });
    const text = await ff.hlsPlaylist(s, ingressBase(req) + '/rx');
    send(res, 200, text, 'application/vnd.apple.mpegurl', { 'Access-Control-Allow-Origin': '*' });
  } catch (e) { bad(res, redactAcct(e.message), 502); }
});

route('POST', '/rx/stop', (req, res, q) => { ff.stopGroup(q.get('t') || ''); ok(res, { ok: true }); });
route('GET', '/rx/stat', (req, res, q) => ok(res, ff.sessionStat(q.get('t') || '') || { speed: 0, out: 0, none: true }));

route('GET', '/rx/:id/:name', (req, res, q, p) => {
  const f = ff.hlsFile(p.id, p.name);
  if (!f) return bad(res, 'slut', 404);
  fs.stat(f, (err, st) => {
    if (err) return bad(res, 'saknas', 404);
    res.writeHead(200, { 'Content-Type': p.name.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(f).pipe(res);
  });
});

/*
 * Subtitles of a film: written by the conversion itself (the same read of the file), never by a second
 * connection to the provider. The player converts on the server whenever such a subtitle is on.
 */
route('GET', '/subs', async (req, res, q) => {
  if (!ff.has()) return bad(res, 'ffmpeg saknas', 501);
  const t = q.get('t') || '';
  const url = proxy.untoken(t);
  if (!proxy.isAllowed(url)) return bad(res, 'forbidden', 403);
  const i = +q.get('s') || 0;
  let closed = false;
  req.on('close', () => { closed = true; });
  // the conversion may still be starting (the player asks for both at once)
  let ss = null;
  for (let k = 0; k < 60 && !closed; k++) {
    ss = ff.subSession(t, i);
    if (ss && (!ss.has || fs.existsSync(ss.file))) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (closed) return;
  if (!ss) return bad(res, 'Undertexterna kommer från serverns konvertering – den är inte igång', 409);
  if (!ss.has) return bad(res, 'Undertexten är en bild och kan inte visas', 415);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.write('WEBVTT\n\n');
  const off = ss.s.ss || 0;
  let pos = 0, buf = '';
  const shift = (line) => line.replace(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/g, (m, hh, mm, s2, ms) => vttTime((+hh || 0) * 3600 + +mm * 60 + +s2 + +ms / 1000 + off));
  const pump = () => {
    if (closed) return;
    let chunk = '';
    try {
      const fd = fs.openSync(ss.file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size > pos) { const b = Buffer.alloc(size - pos); fs.readSync(fd, b, 0, b.length, pos); pos = size; chunk = b.toString('utf8'); }
      } finally { fs.closeSync(fd); }
    } catch (_) { /* not written yet / removed */ }
    buf += chunk.replace(/\r/g, '');
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx).trim(); buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      lines[ti] = shift(lines[ti]);
      res.write(lines.slice(ti).join('\n') + '\n\n');
    }
    if (ss.s.dead || (ss.s.done && !chunk)) { if (buf.includes('-->')) { const l = buf.trim().split('\n'); const ti = l.findIndex(x => x.includes('-->')); l[ti] = shift(l[ti]); res.write(l.slice(ti).join('\n') + '\n'); } return res.end(); }
    setTimeout(pump, 700);
  };
  pump();
});
function vttTime(sec) {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const p2 = (n, w = 2) => String(n).padStart(w, '0');
  return p2(Math.floor(ms / 3600000)) + ':' + p2(Math.floor(ms / 60000) % 60) + ':' + p2(Math.floor(ms / 1000) % 60) + '.' + p2(ms % 1000, 3);
}

route('POST', '/api/diag', async (req, res) => {
  const b = await readBody(req);
  console.log('[spelare ' + String(b.d || '?').slice(0, 30) + ']', String(b.m || '').replace(/[\r\n]/g, ' ').slice(0, 300));
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
    const sent = [x.username, x.password].concat(linkSecrets(String((b.m3u && b.m3u.url) || '')));
    bad(res, redactAcct(redact(e.message === 'timeout' ? 'Servern svarade inte i tid' : e.message, sent)), 200);
  }
});

route('POST', '/api/setup', async (req, res) => {
  if (!checkPin(req, res)) return;
  const b = await readBody(req);
  const snap = JSON.stringify(store.config); // a refused save leaves everything as it was
  const refuse = (msg) => { store.config = JSON.parse(snap); bad(res, msg, 400); };
  const c = store.config;
  const before = catalog.sig();
  if (b.source === 'm3u' || b.source === 'xtream') c.source = b.source;
  if (b.xtream) {
    const server = normServer(b.xtream.server || '');
    const user = String(b.xtream.username || '').trim();
    // a field the page showed empty because it couldn't be opened (key missing) is kept as it is
    const keepUser = !user && vault.isSealed(c.xtream.username);
    const moved = server !== c.xtream.server || (!keepUser && user !== c.xtream.username);
    c.xtream.server = server;
    if (!keepUser) c.xtream.username = user;
    if (b.xtream.password) c.xtream.password = String(b.xtream.password).trim();
    else if (moved) c.xtream.password = ''; // another server or account: the old password doesn't go with it
  }
  if (b.m3u) {
    // links come back masked (password=***): the saved one is kept unless a new link was typed
    const url = String(b.m3u.url || '').trim();
    const epg = String(b.m3u.epgUrl || '').trim();
    const nu = !(url === '' && vault.isSealed(c.m3u.url)) && url !== maskUrl(c.m3u.url) ? unmaskUrl(url, c.m3u.url) : c.m3u.url;
    const ne = !(epg === '' && vault.isSealed(c.m3u.epgUrl)) && epg !== maskUrl(c.m3u.epgUrl) ? unmaskUrl(epg, c.m3u.epgUrl) : c.m3u.epgUrl;
    if (nu === null || ne === null) return refuse('Lösenordet i länken kan inte fyllas i automatiskt (ny server eller ändrad länk) – skriv in det igen');
    c.m3u.url = nu;
    c.m3u.epgUrl = ne;
    // An Xtream get.php link works better as Xtream (movies/series metadata, EPG)
    const xt = c.source === 'm3u' && b.preferXtream ? xtreamFromM3uUrl(c.m3u.url) : null;
    if (xt) { c.source = 'xtream'; c.xtream = xt; }
  }
  if (b.profiles) c.profiles = cleanProfiles(b.profiles);
  if (b.options) {
    const o = b.options;
    const opt = c.options;
    if (typeof o.appName === 'string') opt.appName = o.appName.trim().slice(0, 24) || 'Norrsken';
    for (const k of ['hideAdult', 'cleanNames', 'skiRec']) if (k in o) opt[k] = !!o[k];
    if (['hls', 'ts'].includes(o.liveFormat)) opt.liveFormat = o.liveFormat;
    if (['auto', 'lossless', 'eac3', 'ac3', 'aac', 'copy'].includes(o.audioMode)) opt.audioMode = o.audioMode;
    if (['orig', '1080'].includes(o.maxRes)) opt.maxRes = o.maxRes;
    if (['sound', 'muted', 'off'].includes(o.previews)) opt.previews = o.previews;
    if (['auto', 'off'].includes(o.directPlay)) opt.directPlay = o.directPlay;
    if (['auto', 'archive', 'off'].includes(o.pauseMode)) opt.pauseMode = o.pauseMode;
    if ([30, 60, 120, 180].includes(+o.pauseMax)) opt.pauseMax = +o.pauseMax;
    if (typeof o.tmdbKey === 'string' && o.tmdbKey !== '••••') opt.tmdbKey = o.tmdbKey.trim().slice(0, 400);
    if (Array.isArray(o.services)) opt.services = o.services.filter(x => ['netflix', 'max', 'disney', 'prime'].includes(x));
    for (const k of ['userAgent', 'epgUrl', 'kidsPattern']) {
      if (typeof o[k] !== 'string') continue;
      const v = o[k].trim().slice(0, 500);
      if (k === 'epgUrl' && (v === maskUrl(opt.epgUrl) || (v === '' && vault.isSealed(opt.epgUrl)))) continue;
      if (k === 'epgUrl') { const u = unmaskUrl(v, opt.epgUrl); if (u === null) return refuse('Lösenordet i tv-guide-länken kan inte fyllas i automatiskt – skriv in det igen'); opt[k] = u; } else opt[k] = v;
    }
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

/* Club crests: uploaded one picture per team in /setup (the user's own files; Norrsken ships none). */
route('GET', '/api/setup/crests', (req, res) => {
  if (!checkPin(req, res)) return;
  const ids = new Set(sport.TEAMS.map(t => t.id));
  const nice = (k) => k.replace(/^(nat|comp|club)-/, '').replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase());
  const others = crestKeys().filter(k => !ids.has(k)).sort().map(k => ({ id: k, name: k.startsWith('nat-') ? nice(k).toUpperCase() : nice(k), group: k.startsWith('comp-') ? 'Ligor och turneringar' : k.startsWith('nat-') ? 'Andra länders landslag' : 'Andra klubbar', has: true, mine: !!crestIn(CREST_UP, k), extra: true }));
  ok(res, { teams: sport.TEAMS.map(t => ({ id: t.id, name: t.name, short: t.short, group: t.group, ab: ABBR[t.id] || '', col: t.col, has: !!crestFile(t.id), mine: !!crestIn(CREST_UP, t.id) })).concat(others) });
});
function crestIn(dir, id) { for (const e of Object.keys(CREST_TYPES)) { const f = path.join(dir, id + e); try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* not there */ } } return ''; }
/** What the picture is, by its first bytes (not by what the browser says): PNG, JPEG, WebP or SVG. */
function crestKind(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2000)).replace(/^\uFEFF/, '').trim();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return '.svg';
  return '';
}
/**
 * A picture by its file name: Norrsken works out what it is (a followed team, another club, a national team, a
 * competition) – the folder upload in /setup sends every file here.
 */
route('POST', '/api/setup/crest-auto', async (req, res, q) => {
  if (!checkPin(req, res)) return;
  const k = crests.keyForFile(q.get('name') || '', ABBR);
  if (!k) { req.resume(); return bad(res, 'Filnamnet säger inte vilket lag eller vilken turnering det är', 422); }
  return saveCrest(req, res, k.key, k.label);
});
route('POST', '/api/setup/crest/:id', async (req, res, q, p) => {
  if (!checkPin(req, res)) return;
  if (!sport.TEAMS.some(t => t.id === p.id) && !/^(nat|comp|club)-[a-z0-9-]{2,40}$/.test(p.id)) return bad(res, 'okänt lag', 404);
  return saveCrest(req, res, p.id, '');
});
async function saveCrest(req, res, id, label) {
  const chunks = []; let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => { size += c.length; if (size > 3e6) { reject(new Error('Bilden är för stor (högst 3 MB)')); req.destroy(); } else chunks.push(c); });
      req.on('end', resolve); req.on('error', reject);
    });
  } catch (e) { return bad(res, e.message, 413); }
  const buf = Buffer.concat(chunks);
  const ext = crestKind(buf);
  if (!ext) return bad(res, 'Det där är ingen bild Norrsken kan visa (PNG, JPG, WebP eller SVG)', 415);
  fs.mkdirSync(CREST_UP, { recursive: true });
  for (const e of Object.keys(CREST_TYPES)) { try { fs.unlinkSync(path.join(CREST_UP, id + e)); } catch (_) { /* none */ } }
  fs.writeFileSync(path.join(CREST_UP, id + ext), buf);
  sportCache.clear();
  crestKeyCache.at = 0;
  console.log('[märken] ' + id + ext + ' sparat (' + Math.round(buf.length / 1024) + ' kB)');
  ok(res, { ok: true, id, label });
}
route('DELETE', '/api/setup/crest/:id', (req, res, q, p) => {
  if (!checkPin(req, res)) return;
  if (!CREST_ID.test(p.id)) return bad(res, 'okänt lag', 404);
  for (const e of Object.keys(CREST_TYPES)) { try { fs.unlinkSync(path.join(CREST_UP, p.id + e)); } catch (_) { /* none */ } }
  sportCache.clear();
  crestKeyCache.at = 0;
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

const gzCache = new Map();
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
    // scripts and styles compressed (1.2 MB of them → about a quarter), kept in memory per file version
    if (res._gz && /\.(js|css|html|svg)$/.test(file) && st.size < 5e6) {
      const key = file + '|' + st.mtimeMs;
      let z = gzCache.get(key);
      if (!z) { try { z = require('zlib').gzipSync(fs.readFileSync(file), { level: 6 }); } catch (_) { z = null; } if (z) { if (gzCache.size > 60) gzCache.clear(); gzCache.set(key, z); } }
      if (z) {
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': z.length });
        return res.end(req.method === 'HEAD' ? undefined : z);
      }
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  res._gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  // what a TV fetches over AirPlay (its receiver is hls.js in a web engine): every answer readable by it, errors too –
  // an error it may not read counts as a CORS failure and it gives up instead of trying again (TV log 12 Nov)
  if (/^\/(pause|mrec)\//.test(pathname)) { res.setHeader('Access-Control-Allow-Origin', '*'); airlog.watch(req, res, pathname); }
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, Content-Type, X-Pin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      return res.end();
    }
    const px = /^\/px\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(pathname);
    if (px && (req.method === 'GET' || req.method === 'HEAD')) { if (proxy.isAllowed(proxy.untoken(px[1]))) { lastStreamAt = lastPlayAt = Date.now(); dlYield('ström'); } return await proxy.handle(req, res, px[1], catalog.ua(), ingressBase(req)); }
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
    if (!res.headersSent) bad(res, redactAcct((e && e.message) || 'fel'), 500);
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
// an error nobody caught is written to the log (masked) instead of the add-on silently stopping in the middle of a match
const errSeen = new Map(); // message → when last written (the same error in a loop is written once a minute)
function logUncaught(e) {
  const text = tsbuf._hideLinks(String((e && e.stack) || e)).split('\n').slice(0, 6).join(' | ');
  const key = text.slice(0, 200);
  const seen = errSeen.get(key);
  if (seen && Date.now() - seen.at < 60e3) { seen.n++; return; }
  if (errSeen.size > 200) errSeen.clear();
  errSeen.set(key, { at: Date.now(), n: 0 });
  console.error('[fel]', text + (seen && seen.n ? ' (+' + seen.n + ' likadana sedan förra raden)' : ''));
}
process.on('uncaughtException', logUncaught);
process.on('unhandledRejection', logUncaught);

function start() {
  ff.cleanStart();
  const keptRecs = tsbuf.cleanStart();
  tsbuf.restore(keptRecs);
  // after a restart the memory buffer is empty: the match recordings come back from the Time Capsule
  const onFile = matchRecIdsOnFile();
  tsbuf.protect(onFile);
  matchRecReady = false;
  let loaded = false;
  const finish = (ids) => { if (loaded) return; loaded = true; loadMatchRecs([...new Set([...keptRecs, ...ids])]); matchRecReady = true; };
  tsbuf.recoverTC(onFile.filter(id => !keptRecs.includes(id))).then(ss => finish(ss.map(x => x.id)), () => finish([]));
  // never wait forever: the Time Capsule may be off (then the old ones cannot be played, a running match still records)
  setTimeout(() => finish([]), 120e3).unref();
  server.listen(PORT, HOST, () => {
    const urls = process.env.PUBLIC_URL ? [process.env.PUBLIC_URL.replace(/\/$/, '')] : lanUrls();
    console.log(`\n  ${store.config.options.appName || 'Norrsken'} ${pkg.version} kör på port ${PORT}`);
    console.log('  TV-appen:      ' + (urls[0] || 'http://localhost:' + PORT) + '/');
    console.log('  Inställningar: ' + (urls[0] || 'http://localhost:' + PORT) + '/setup');
    console.log('  ffmpeg:        ' + (ff.has() ? 'ja (MKV, ljudspår och undertexter stöds)' : 'nej (installera för MKV/undertexter)'));
    console.log('  PIN för /setup: ' + (SETUP_PIN_OPTION ? '(den du valt i tilläggets konfiguration)' : setupPin() ? setupPin() + '  (byt den under tilläggets Konfiguration → setup_pin)' : 'av') + '\n');
  });
  if (store.config.configured) catalog.load();
  // background refresh: catalog every 12 h, EPG every 6 h
  setInterval(() => { if (store.config.configured && catalog.ready()) catalog.load(); }, 3600e3).unref();
  setInterval(() => { if (catalog.ready()) catalog.loadEpg().catch(() => {}); }, 30 * 60e3).unref();
  setInterval(matchRecTick, 10e3).unref(); // match recordings (often: a channel without a picture is left within seconds)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

if (require.main === module) start();

module.exports = { server, store, catalog, proxy, start, _pool: pool, _maskUrl: (u) => maskUrl(u), _unmaskUrl: (a, b) => unmaskUrl(a, b), _linkSecrets: (u) => linkSecrets(u), _matchRecTick: matchRecTick, _logUncaught: (e) => logUncaught(e), _matchReset: () => { matchStopped.clear(); matchFailAt.clear(); for (const r of matchRecs.values()) { const x = tsbuf.get(r.sessId); if (x) tsbuf.stop(x, 'test'); } matchRecs.clear(); }, _imageAllowed: (u) => imageAllowed(new URL(u)), _privateHost: privateHost, _streamIdle: () => { lastStreamAt = 0; ff.stopAll(); } };
