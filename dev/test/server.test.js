'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mock = require('./mock-provider').create({ mediaDir: path.join(__dirname, 'media') });
let base = '';
let app;
let prov = '';

const get = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, headers: r.headers, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null, r }; };
const post = (p, body) => get(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise(ok => setTimeout(ok, ms));
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(100); }
}

before(async () => {
  prov = await mock.listen();
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-'));
  process.env.PORT = '0';
  app = require('../server');
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
});

after(async () => { if (app.server.closeAllConnections) app.server.closeAllConnections(); app.server.close(); await mock.close(); });

test('unconfigured status', async () => {
  const { json } = await get('/api/status');
  assert.equal(json.configured, false);
  assert.equal(json.ready, false);
  assert.ok(Array.isArray(json.profiles));
});

test('connection test rejects bad password and accepts good one', async () => {
  const badr = await post('/api/setup/test', { source: 'xtream', xtream: { server: prov, username: 'demo', password: 'wrong' } });
  assert.match(badr.json.error, /Fel användarnamn/);
  assert.ok(!badr.json.error.includes('wrong'));
  const good = await post('/api/setup/test', { source: 'xtream', xtream: { server: prov + '/player_api.php', username: 'demo', password: mock.PASS } });
  assert.equal(good.json.ok, true);
  assert.equal(good.json.maxConnections, 2);
});

test('save xtream config and load catalog', async () => {
  const r = await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: mock.PASS }, profiles: [{ id: 'p1', name: 'Oskar', kids: false }, { id: 'p2', name: 'Barn', kids: true }] });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.config.xtream.hasPassword, true);
  assert.equal(r.json.config.xtream.password, undefined);
  const st = await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s; });
  assert.deepEqual(st.counts, { live: 23, movie: 67, series: 18 });
});

test('home page hides adult, cleans names, splits years', async () => {
  const { json } = await get('/api/page/home?profile=p1');
  assert.ok(json.rows.length >= 4);
  const all = json.rows.flatMap(r => r.items);
  assert.ok(!all.some(i => /xxx/i.test(i.n)), 'adult hidden');
  const live = json.rows.find(r => r.kind === 'live');
  assert.ok(live, 'has a live row');
  assert.ok(live.items.some(i => i.n === 'SVT1 HD'), 'prefix stripped');
  const mv = all.find(i => i.t === 'movie');
  assert.ok(mv.y > 1990 && !/\(\d{4}\)/.test(mv.n), 'year split from title');
  assert.ok(!all.some(i => i._u || i._f), 'private fields stripped');
});

test('kids profile sees only kids categories', async () => {
  const { json } = await get('/api/page/live?profile=p2');
  assert.ok(json.rows.length >= 1);
  assert.ok(json.rows.every(r => /barn/i.test(r.title)), json.rows.map(r => r.title).join(','));
  const s = (await get('/api/search?q=svt&profile=p2')).json;
  assert.equal(s.live.length, 0);
});

test('list pagination and categories', async () => {
  const cats = (await get('/api/cats/movie?profile=p1')).json;
  assert.ok(cats.length === 5);
  const page = (await get('/api/list?type=movie&cat=all&offset=10&limit=5&profile=p1')).json;
  assert.equal(page.items.length, 5);
  assert.equal(page.total, 64); // the two 4K copies are grouped with their titles
});

test('search folds diacritics', async () => {
  const s = (await get('/api/search?q=malmfalt&profile=p1')).json;
  assert.ok(s.movie.some(i => i.n.startsWith('Malmfälten')));
  const t = (await get('/api/search?q=svt&profile=p1')).json;
  assert.ok(t.live.length >= 3);
});

test('movie and series details', async () => {
  const m = (await get('/api/info/movie/1001')).json;
  assert.match(m.p, /detaljanropet/);
  assert.equal(m.dur, 40);
  assert.ok(m.bd.startsWith('http'));
  const s = (await get('/api/info/series/5003')).json;
  assert.equal(s.seasons.length, 3);
  assert.equal(s.seasons[0].eps[0].n, 'Kapitel 1');
  assert.equal(s.seasons[0].eps[0].sid, '5003');
});

test('EPG from gzipped XMLTV prefers Swedish titles', async () => {
  await until(async () => (await get('/api/status')).json.epg.count > 0);
  const e = (await get('/api/epg/now?ids=100,101')).json;
  assert.ok(e['100'].now.t, 'has now');
  assert.ok(!/\(en\)/.test(e['100'].now.t), 'sv title preferred');
  assert.ok(e['100'].next.s > e['100'].now.s);
  const g = (await get('/api/epg/channel/100?hours=4')).json;
  assert.ok(g.length >= 8);
});

test('live stream through proxy: redirect + playlist rewrite + segments', async () => {
  const all = (await get('/api/stream/live/100')).json;
  assert.equal(all.live, true);
  assert.ok(all.sources[0].direct && /^http:\/\/127\.0\.0\.1/.test(all.sources[0].url), 'direct source first');
  const s = { sources: all.sources.filter(x => !x.direct) };
  assert.equal(s.sources[0].kind, 'hls');
  assert.equal(s.sources[1].kind, 'ts');
  const pl = await fetch(base + s.sources[0].url);
  assert.equal(pl.headers.get('access-control-allow-origin'), '*');
  const text = await pl.text();
  assert.match(text, /#EXT-X-MAP:URI="\/px\//);
  const seg = text.split('\n').find(l => l.startsWith('/px/'));
  const sr = await fetch(base + seg);
  assert.equal(sr.status, 200);
  assert.ok((await sr.arrayBuffer()).byteLength > 1000);
  const ts = await fetch(base + s.sources[1].url);
  const buf = Buffer.from(await ts.arrayBuffer());
  assert.equal(buf[0], 0x47, 'mpeg-ts sync byte');
});

test('proxy refuses unknown hosts', async () => {
  const tok = Buffer.from('http://example.com/x').toString('base64url');
  const r = await fetch(base + '/px/' + tok);
  assert.equal(r.status, 403);
});

test('vod: range through proxy, probe, remux, subtitles', async () => {
  const conv = (await get('/api/stream/movie/1001')).json; // MPEG-4 + AC3: this screen can't play it
  assert.equal(conv.sources[0].kind, 'remux', 'unplayable file starts with the converter');
  assert.equal(conv.media.a, 'ac3');
  const mp4all = (await get('/api/stream/movie/1002?caps=vp9,opus')).json;
  assert.equal(mp4all.sources[0].kind, 'file');
  assert.equal(mp4all.sources[0].direct, true);
  const mp4 = { sources: mp4all.sources.filter(x => !x.direct) };
  const rr = await fetch(base + mp4.sources[0].url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(rr.status, 206);
  assert.match(rr.headers.get('content-range'), /^bytes 100-199\//);
  assert.equal((await rr.arrayBuffer()).byteLength, 100);

  const mkv = (await get('/api/stream/movie/1000?caps=vp9,opus')).json; // i=0 → mkv
  assert.equal(mkv.ext, 'mkv');
  assert.equal(mkv.sources[0].needs, 'video/x-matroska', 'direct MKV only if the TV can play it');
  assert.equal(mkv.sources[1].kind, 'remux');
  mkv.sources = mkv.sources.filter(x => x.kind === 'remux');
  const pr = (await get('/api/probe?t=' + mkv.t)).json;
  assert.equal(pr.audio.length, 2);
  assert.equal(pr.audio[0].label, 'Svenska');
  assert.equal(pr.subs.length, 2);
  assert.ok(pr.subs[0].text);
  assert.ok(pr.dur > 35);
  const pl = await (await fetch(base + mkv.sources[0].url + '&ss=5&a=1&caps=vp9,opus')).text();
  assert.match(pl, /#EXT-X-MAP:URI="\/rx\/\w+\/init\.mp4"/, 'converted HLS playlist');
  const seg = pl.split('\n').find(l => l.startsWith('/rx/'));
  const sr = await fetch(base + seg);
  assert.equal(sr.status, 200);
  assert.ok((await sr.arrayBuffer()).byteLength > 1000);
  const sv = await (await fetch(base + '/subs?t=' + mkv.t + '&s=0')).text();
  assert.match(sv, /WEBVTT/);
  assert.match(sv, /svensk undertext/);
  const late = await (await fetch(base + '/subs?t=' + mkv.t + '&s=1&ss=15')).text();
  assert.match(late, /(00:)?00:20\.000 --> (00:)?00:25\.000/, 'absolute timestamps kept when seeking');
});

test('progress, continue watching and next episode', async () => {
  const s = (await get('/api/info/series/5000')).json;
  const ep = s.seasons[0].eps[0];
  await post('/api/state/p1/progress', { item: { ...ep, sn: s.n }, pos: 300, dur: 1200 });
  let home = (await get('/api/page/home?profile=p1')).json;
  let cw = home.rows.find(r => r.id === 'cw');
  assert.equal(cw.items[0].k, ep.k);
  assert.equal(cw.items[0].sn, s.n);
  await post('/api/state/p1/progress', { item: { ...ep, sn: s.n }, pos: 1190, dur: 1200 });
  home = (await get('/api/page/home?profile=p1')).json;
  cw = home.rows.find(r => r.id === 'cw');
  assert.equal(cw.items.length, 1);
  assert.equal(cw.items[0].k, s.seasons[0].eps[1].k, 'up next is episode 2');
  assert.equal(cw.items[0].upnext, true);
  const st = (await get('/api/state/p1')).json;
  assert.ok(st.progress[s.seasons[0].eps[1].k]);
  // other profile unaffected
  const other = (await get('/api/page/home?profile=p2')).json;
  assert.ok(!other.rows.some(r => r.id === 'cw'));
});

test('my list and recent channels', async () => {
  const m = (await get('/api/item/movie/1003')).json;
  await post('/api/state/p1/mylist', { item: m, on: true });
  await post('/api/state/p1/recent', { item: (await get('/api/item/live/101')).json });
  const home = (await get('/api/page/home?profile=p1')).json;
  assert.equal(home.rows.find(r => r.id === 'ml').items[0].k, 'm:1003');
  assert.equal(home.rows.find(r => r.id === 'rc').items[0].k, 'l:101');
  const ml = (await get('/api/page/mylist?profile=p1')).json;
  assert.equal(ml.rows[0].items[0].k, 'm:1003');
  await post('/api/state/p1/mylist', { item: m, on: false });
  const st = (await get('/api/state/p1')).json;
  assert.equal(st.myList.length, 0);
});

test('hidden categories', async () => {
  const cats = (await get('/api/setup/categories')).json;
  const sport = cats.live.find(c => /SPORT/.test(c.name));
  await post('/api/setup/categories', { live: [sport.id] });
  const page = (await get('/api/page/live?profile=p1')).json;
  assert.ok(!page.rows.some(r => /sport/i.test(r.title)));
  await post('/api/setup/categories', { live: [] });
});

test('pin-locked profile: unlock gives a token, playback needs it, kids need a parent pin to leave', async () => {
  const cfg = (await get('/api/setup')).json;
  const profiles = cfg.profiles.map(p => ({ id: p.id, name: p.name, color: p.color, kids: p.kids }));
  profiles[0].pin = '1234';
  await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: '' }, profiles });
  await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s; });
  const st = (await get('/api/status')).json;
  assert.equal(st.parentPin, true);
  assert.equal(st.profiles[0].hasPin, true);
  assert.equal(JSON.stringify(st).includes('1234'), false);
  const live = (await get('/api/list?type=live&cat=all&limit=1&profile=p1')).json.items[0];
  assert.equal((await get('/api/stream/live/' + live.id + '?profile=p1')).status, 401);
  assert.equal((await post('/api/profile/p1/unlock', { pin: '0000' })).status, 403);
  const u = await post('/api/profile/p1/unlock', { pin: '1234' });
  assert.ok(u.json.token);
  assert.equal((await get('/api/stream/live/' + live.id + '?profile=p1&pt=' + u.json.token)).status, 200);
  // leaving the kids profile for an unlocked adult profile still needs a parent's PIN
  profiles.push({ id: 'p3', name: 'Gäst', kids: false });
  await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: '' }, profiles });
  assert.equal((await post('/api/profile/p3/unlock', { pin: '', from: 'p2' })).status, 403);
  assert.equal((await post('/api/profile/p3/unlock', { pin: '1234', from: 'p2' })).status, 200);
  assert.equal((await post('/api/profile/p3/unlock', { pin: '' })).status, 200);
  // back to no PIN for the remaining tests
  await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: '' }, profiles: profiles.slice(0, 2).map((p, i) => i ? p : Object.assign({}, p, { pin: '' })) });
  await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s; });
});

test('catch-up timestamps use the provider time zone', () => {
  const { tsStamp } = require('../lib/provider');
  const t = Date.UTC(2026, 0, 15, 22, 30);
  assert.equal(tsStamp(t, 'UTC'), '2026-01-15:22-30');
  assert.equal(tsStamp(t, 'Europe/Stockholm'), '2026-01-15:23-30');
  assert.equal(tsStamp(t, 'America/New_York'), '2026-01-15:17-30');
});

test('same title in 4K: grouped as versions, shown once', async () => {
  const r = (await get('/api/search?q=norrsken&profile=p1')).json;
  const hits = r.movie.filter(m => m.n === 'Norrsken');
  assert.equal(hits.length, 1);
  const info = (await get('/api/info/movie/' + hits[0].id + '?profile=p1')).json;
  assert.ok(info.versions && info.versions.length === 2);
  assert.equal(info.versions[0].q, '4K');
  assert.equal(info.versions[0].id, '1097');
});

test('search: actors from the series list, and one typo is forgiven', async () => {
  const r = (await get('/api/search?q=gruvstr%C3%B6m&profile=p1')).json;
  assert.equal(r.series.length, 1);
  const t = (await get('/api/search?q=kebnekase&profile=p1')).json;
  assert.ok(t.movie.some(m => m.n.startsWith('Kebnekaise')));
});

test('refresh works again after a load that came from the cache', async () => {
  const before = (await get('/api/status')).json.at;
  await sleep(20);
  await post('/api/refresh', {});
  await until(async () => { const s = (await get('/api/status')).json; return !s.loading && s.at > before && s; });
});

test('catch-up: archive stream as TS and HLS, played through the proxy', async () => {
  const start = Math.floor(Date.now() / 1000) - 3600;
  const r = (await get('/api/stream/live/100?profile=p1&start=' + start + '&dur=30')).json;
  assert.equal(r.catchup, true);
  const kinds = r.sources.map(x => x.kind);
  assert.ok(kinds.includes('ts') && kinds.includes('hls'));
  assert.ok(r.sources.every(x => !x.url.includes(mock.PASS)) || r.sources.some(x => x.direct));
  const prox = r.sources.find(x => x.kind === 'ts' && !x.direct);
  assert.equal((await get(prox.url)).status, 200);
  // a channel without an archive just plays live
  const noArc = (await get('/api/stream/live/110?profile=p1&start=' + start + '&dur=30')).json;
  assert.ok(!noArc.catchup);
});

test('recommendations learn from likes and what was watched', async () => {
  const none = (await get('/api/recommend?profile=p2')).json.items;
  assert.equal(none.length, 0);
  const s = (await get('/api/list?type=series&cat=all&limit=1&profile=p1')).json.items[0];
  await post('/api/state/p1/like', { k: s.k, v: 1 });
  const rec = (await get('/api/recommend?profile=p1')).json.items;
  assert.ok(rec.length > 0);
  assert.ok(!rec.some(x => x.k === s.k), 'the liked title itself is not suggested');
  assert.ok(rec.some(x => /Eftersom du sett/.test(x.because || '')));
  const st = (await get('/api/state/p1')).json;
  assert.equal(st.likes[s.k], 1);
  await post('/api/state/p1/like', { k: s.k, v: 0 });
});

test('qr code svg', async () => {
  const r = await fetch(base + '/api/qr.svg?text=' + encodeURIComponent('http://192.168.1.2:8787/setup'));
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(await r.text(), /^<svg/);
});

test('static files and setup page', async () => {
  const r = await fetch(base + '/setup');
  assert.equal(r.status, 200);
  const t = await fetch(base + '/../server.js');
  assert.notEqual(t.status, 200);
});

test('m3u source with series grouping and url-tvg epg', async () => {
  const url = prov + '/get.php?username=demo&password=' + encodeURIComponent(mock.PASS) + '&type=m3u_plus';
  await post('/api/setup', { source: 'm3u', m3u: { url, epgUrl: '' } });
  const st = await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s.counts.movie === 10 && s; });
  assert.equal(st.counts.live, 23);
  assert.equal(st.counts.series, 1);
  const series = (await get('/api/list?type=series&cat=all&profile=p1')).json.items[0];
  assert.equal(series.n, 'Isvägen');
  const info = (await get('/api/info/series/' + series.id)).json;
  assert.equal(info.seasons[0].eps.length, 3);
  const epStream = (await get('/api/stream/episode/' + info.seasons[0].eps[0].id)).json;
  assert.ok(epStream.sources.length);
  const live = (await get('/api/stream/live/' + (await get('/api/list?type=live&cat=all&profile=p1')).json.items[0].id)).json;
  assert.equal(live.sources[0].kind, 'hls');
  await until(async () => { const s = (await get('/api/status')).json; return !s.epg.loading && s.epg.count > 0; });
});

test('pasting an xtream get.php link switches to xtream when asked', async () => {
  const url = prov + '/get.php?username=demo&password=' + encodeURIComponent(mock.PASS) + '&type=m3u_plus';
  const r = await post('/api/setup', { source: 'm3u', m3u: { url }, preferXtream: true });
  assert.equal(r.json.config.source, 'xtream');
  assert.equal(r.json.config.xtream.username, 'demo');
  await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s.counts.movie === 67; });
});
