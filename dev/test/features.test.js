'use strict';
/* 1.10: audio tracks in every playback path, profile choices, favourite-team match, pause for live TV, streaming services. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const MEDIA = path.join(__dirname, 'media');
const mock = require('./mock-provider').create({ mediaDir: MEDIA });
let base = '';
let app;
let prov = '';
let tmdb;
const tmdbHits = [];

const get = async (p, opts) => { const r = await fetch(base + p, opts); const ct = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, json: ct.includes('json') ? await r.json() : null, text: ct.includes('json') ? '' : await r.text() }; };
const post = (p, body) => get(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const sleep = (ms) => new Promise(ok => setTimeout(ok, ms));
async function until(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(150); }
}

/* a small fake themoviedb.org: two titles on Netflix/Max, one on Disney+ only, one nowhere in Sweden */
let localTitle = null; // { n, y } of a film in the mock library, filled in once the catalog has loaded
function fakeTmdb() {
  const titles = {
    'movie:11': { id: 11, title: 'Fjällräddarna', release_date: '2024-03-01', poster_path: '/a.jpg', backdrop_path: '/a-bd.jpg', overview: 'Räddningstjänst i fjällen.', vote_average: 7.4, runtime: 104, genres: [{ name: 'Drama' }] },
    'tv:22': { id: 22, name: 'Malmfältens hemligheter', first_air_date: '2023-09-10', poster_path: '/b.jpg', overview: 'En serie från Kiruna.', vote_average: 8.1, number_of_seasons: 2, genres: [{ name: 'Krim' }] },
    'movie:33': { id: 33, title: 'Bara i USA', release_date: '2022-01-01', poster_path: '/c.jpg', overview: 'Finns inte i Sverige.' },
    'movie:44': { id: 44, title: 'Isprinsessan', release_date: '2021-11-11', poster_path: '/d.jpg', overview: 'Animerat.' },
    'movie:66': { id: 66, title: 'Vinterns ljus', release_date: '2025-02-02', poster_path: '/f.jpg', overview: 'Om polarnatten.' },
  };
  const where = { 'movie:11': [8, 1899], 'tv:22': [1899], 'movie:33': [], 'movie:44': [337], 'movie:66': [119] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    tmdbHits.push(u.pathname + u.search);
    const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.searchParams.get('api_key') !== 'testkey123') return json({ status_message: 'Invalid API key' }, 401);
    const p = u.pathname;
    let m;
    if ((m = /^\/watch\/providers\/(movie|tv)$/.exec(p))) return json({ results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 1899, provider_name: 'HBO Max' }, { provider_id: 337, provider_name: 'Disney Plus' }, { provider_id: 119, provider_name: 'Amazon Prime Video' }, { provider_id: 2, provider_name: 'Apple TV' }] });
    if (p === '/search/multi') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      const all = Object.entries(titles).map(([k, t]) => ({ ...t, media_type: k.split(':')[0] }));
      if (localTitle) all.push({ id: 55, title: localTitle.n, release_date: localTitle.y + '-05-05', poster_path: '/e.jpg', media_type: 'movie' });
      return json({ results: all.filter(t => (t.title || t.name).toLowerCase().includes(q) || q === 'alla') });
    }
    if ((m = /^\/(movie|tv)\/(\d+)\/watch\/providers$/.exec(p))) {
      const ids = m[2] === '55' ? [8] : where[m[1] + ':' + m[2]] || [];
      return json({ results: ids.length ? { SE: { flatrate: ids.map(i => ({ provider_id: i })) }, US: { flatrate: [{ provider_id: 8 }] } } : { US: { flatrate: [{ provider_id: 8 }] } } });
    }
    if ((m = /^\/discover\/(movie|tv)$/.exec(p))) {
      assert.match(u.searchParams.get('with_watch_providers'), /8/);
      return json({ results: Object.entries(titles).filter(([k]) => k.startsWith(m[1])).map(([, t]) => t) });
    }
    if ((m = /^\/(movie|tv)\/(\d+)\/recommendations$/.exec(p))) return json({ results: [titles['movie:44']] });
    if ((m = /^\/search\/(movie|tv)$/.exec(p))) return json({ results: [{ id: 99 }] });
    if ((m = /^\/(movie|tv)\/(\d+)$/.exec(p))) {
      const t = titles[m[1] + ':' + m[2]] || (m[2] === '55' && localTitle ? { id: 55, title: localTitle.n, release_date: localTitle.y + '-05-05' } : null);
      return t ? json({ ...t, credits: { cast: [{ name: 'Alicia Vikander' }] } }) : json({}, 404);
    }
    json({ status_message: 'nope' }, 404);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

before(async () => {
  prov = await mock.listen();
  tmdb = await fakeTmdb();
  process.env.TMDB_BASE = 'http://127.0.0.1:' + tmdb.address().port;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-f-'));
  process.env.NSK_PAUSE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-pause-'));
  process.env.PORT = '0';
  app = require('../server');
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
  await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: mock.PASS }, profiles: [{ id: 'p1', name: 'Oskar' }, { id: 'p2', name: 'Barn', kids: true }] });
  await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s.epg.count > 0 && s; });
});

after(async () => {
  if (app.server.closeAllConnections) app.server.closeAllConnections();
  app.server.close();
  await mock.close();
  tmdb.close();
});

/* ------------------------------------------------------------------ audio tracks */

/** Frequency of the sound in a media file: decode to mono PCM and count zero crossings (440 Hz = Swedish track, 660 Hz = English). */
function toneOf(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 64e6 });
  const pcm = r.stdout;
  const n = Math.floor(pcm.length / 2);
  let zc = 0;
  for (let i = 1; i < n; i++) { const a = pcm.readInt16LE((i - 1) * 2), b = pcm.readInt16LE(i * 2); if ((a < 0) !== (b < 0)) zc++; }
  return zc / 2 / (n / 16000);
}

test('probe lists both sound tracks with language and the default one', async () => {
  const ff = require('../lib/ffmpeg');
  const info = await ff.probe(prov + '/movie/demo/' + encodeURIComponent(mock.PASS) + '/1002.mkv');
  assert.equal(info.audio.length, 2);
  assert.deepEqual(info.audio.map(a => a.label), ['Svenska', 'Engelska']);
  assert.ok(info.audio[0].def, 'first track is the default');
  assert.deepEqual(info.subs.map(s => s.label), ['Svenska', 'Engelska']);
});

test('the converter plays the chosen sound track (a=0 Swedish 440 Hz, a=1 English 660 Hz)', async () => {
  const ff = require('../lib/ffmpeg');
  const url = prov + '/movie/demo/' + encodeURIComponent(mock.PASS) + '/1002.mkv';
  const caps = { vp9: true, opus: true };
  for (const [a, hz] of [[0, 440], [1, 660]]) {
    const s = await ff.hlsSession(url, { group: 'tone' + a, ss: 0, a, caps });
    await ff.hlsPlaylist(s, '/rx');
    await until(() => fs.existsSync(path.join(s.dir, 's00001.m4s')), 30000);
    const out = path.join(os.tmpdir(), 'nsk-tone-' + a + '.mp4');
    fs.writeFileSync(out, Buffer.concat([fs.readFileSync(path.join(s.dir, 'init.mp4')), fs.readFileSync(path.join(s.dir, 's00000.m4s'))]));
    const f = toneOf(out);
    assert.ok(Math.abs(f - hz) < 25, 'track ' + a + ' should be ~' + hz + ' Hz, got ' + f.toFixed(0));
    ff.stopGroup('tone' + a);
  }
});

test('a converted start can ask for track 1 through the HLS address', async () => {
  const st = (await get('/api/stream/movie/1002?profile=p1&ext=mkv&caps=vp9,opus')).json;
  assert.ok(st.t, 'token for the converter');
  assert.equal(st.media.na, 2, 'two sound tracks reported');
  const pr = (await get('/api/probe?t=' + st.t)).json;
  assert.equal(pr.audio.length, 2);
  const rx = st.sources.find(s => s.kind === 'remux');
  const pl = await get(rx.url + '&a=1&caps=vp9,opus');
  assert.equal(pl.status, 200);
  assert.match(pl.text, /#EXTINF/);
  await post('/rx/stop?t=' + encodeURIComponent(st.t));
});

/* ------------------------------------------------------------------ profile choices */

test('profile choices: subtitles default to Swedish (unset), are saved per profile, team is normalised', async () => {
  let s = (await get('/api/state/p1')).json;
  assert.deepEqual(s.prefs, {});
  await post('/api/state/p1/prefs', { sub: 'en', audio: 'sv', team: 'Färjestad BK' });
  s = (await get('/api/state/p1')).json;
  assert.deepEqual(s.prefs, { sub: 'en', audio: 'sv', team: 'farjestad' });
  await post('/api/state/p1/prefs', { sub: '' }); // "Av" is a choice too
  assert.equal((await get('/api/state/p1')).json.prefs.sub, '');
  assert.deepEqual((await get('/api/state/p2')).json.prefs, {}, 'other profile untouched');
  await post('/api/state/p1/prefs', { team: 'lulea', sub: 'sv' });
});

/* ------------------------------------------------------------------ favourite team */

test('sport: matchup and team parsing', () => {
  const sport = require('../lib/sport');
  assert.deepEqual(sport.matchup('SHL: Luleå Hockey - Färjestad BK'), { home: 'Luleå', away: 'Färjestad' });
  assert.deepEqual(sport.matchup('Ishockey: HV 71 – Frölunda HC (direkt)'), { home: 'HV71', away: 'Frölunda' });
  assert.equal(sport.matchup('Rapport'), null);
  assert.equal(sport.teamId('Luleå Hockey'), 'lulea');
  assert.equal(sport.teamId('inget'), 'none');
  assert.ok(sport.channelScore('SE: C More Hockey HD') > sport.channelScore('SE: C More Hockey SD'));
});

test('start page shows the live Luleå match with the best channel and both channels to zap between', async () => {
  const { json } = await get('/api/page/home?profile=p1');
  const m = json.sport;
  assert.ok(m, 'match found');
  assert.equal(m.state, 'live');
  assert.equal(m.title, 'Luleå – Färjestad');
  assert.equal(m.team.id, 'lulea');
  assert.ok(m.s <= Date.now() && m.e > Date.now());
  assert.deepEqual(m.chans.map(c => c.n).sort(), ['TV4 Sport', 'Viasat Sport Premium']);
  assert.ok(!m.chans.some(c => /Eurosport/.test(c.n)), 're-run left out');
  assert.ok(m.ch.id && m.ch.t === 'live');
  // the live page has it too; kids don't (no sport channels in their categories)
  assert.ok((await get('/api/page/live?profile=p1')).json.sport);
  assert.equal((await get('/api/page/home?profile=p2')).json.sport, null);
});

test('another favourite: Brynäs starts within the hour (soon); none: no billboard', async () => {
  await post('/api/state/p1/prefs', { team: 'brynas' });
  let m = (await get('/api/sport?profile=p1')).json.match;
  assert.equal(m.state, 'soon');
  assert.equal(m.title, 'Brynäs – Skellefteå');
  assert.ok(m.s > Date.now() && m.s - Date.now() <= 60 * 60e3);
  await post('/api/state/p1/prefs', { team: 'none' });
  m = (await get('/api/sport?profile=p1')).json.match;
  assert.equal(m, null);
  const teams = (await get('/api/sport?profile=p1')).json.teams;
  assert.ok(teams.length >= 14 && teams[0].id === 'lulea');
  await post('/api/state/p1/prefs', { team: 'lulea' });
});

test('sport: the favourite\'s match counts for the whole calendar day (live, later, already played)', () => {
  const sport = require('../lib/sport');
  const day = sport.stockholmDay(Date.UTC(2026, 9, 24, 10)); // 24 Oct 2026, 12:00 in Stockholm
  assert.equal(new Date(day.start).toISOString(), '2026-10-23T22:00:00.000Z');
  assert.equal(new Date(day.end).toISOString(), '2026-10-24T22:00:00.000Z');
  const H = 3600e3, s0 = day.start;
  const chans = [{ id: 'c1', n: 'TV4 Sport', epg: 'tv4' }];
  const mk = (list) => ({ map: new Map([['tv4', list]]) });
  const now = s0 + 12 * H; // 12:00
  const at = (h, len, title) => [s0 + h * H, s0 + (h + len) * H, title, 'Ishockey, SHL.'];
  // played this morning
  let m = sport.findMatch('lulea', chans, mk([at(8, 2, 'SHL: Luleå Hockey - Färjestad BK')]), { now });
  assert.equal(m.state, 'ended');
  // starts at 19:00 today, four hours away: still shown
  m = sport.findMatch('lulea', chans, mk([at(8, 2, 'SHL: Luleå Hockey - Färjestad BK'), at(19, 2.5, 'SHL: Luleå Hockey - Brynäs')]), { now });
  assert.equal(m.state, 'soon');
  assert.equal(m.title, 'Luleå – Brynäs');
  // live beats both
  m = sport.findMatch('lulea', chans, mk([at(11, 2.5, 'SHL: Luleå Hockey - Brynäs'), at(19, 2.5, 'SHL: Luleå Hockey - Skellefteå')]), { now });
  assert.equal(m.state, 'live');
  // tomorrow's match is not today's
  m = sport.findMatch('lulea', chans, mk([at(26, 2.5, 'SHL: Luleå Hockey - Brynäs')]), { now });
  assert.equal(m, null);
});

/* ------------------------------------------------------------------ pause live TV */

test('pause: records the channel to disk, plays it back as HLS, stops and cleans up', async () => {
  const st = (await get('/api/status')).json;
  assert.deepEqual(st.pause, { mode: 'auto', max: 60, rec: true });
  const r = await post('/api/pause/start?profile=p1', { id: '110' }); // no archive on this channel
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.url, /^\/pause\/\w+\/index\.m3u8$/);
  const pl = await until(async () => { const x = await get(r.json.url); return x.status === 200 && x.text; }, 30000);
  assert.match(pl, /#EXT-X-START:TIME-OFFSET=0/);
  assert.match(pl, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  const seg = pl.split('\n').find(l => l && l[0] !== '#');
  assert.match(seg, /^\/pause\/\w+\/p\d{5}\.m4s$/);
  assert.match(pl, /#EXT-X-MAP:URI="\/pause\/\w+\/init\.mp4"/);
  const sr = await fetch(base + seg);
  assert.equal(sr.status, 200);
  assert.equal(sr.headers.get('content-type'), 'video/iso.segment');
  assert.ok((await sr.arrayBuffer()).byteLength > 1000);
  const alive = (await post('/api/pause/' + r.json.id + '/alive')).json;
  assert.ok(alive.ok && alive.sec > 0);
  // the test clip is 10 s long: the recording ends and the playlist says so
  await until(async () => /#EXT-X-ENDLIST/.test((await get(r.json.url)).text), 30000);
  const dir = path.join(process.env.NSK_PAUSE_DIR, r.json.id);
  assert.ok(fs.existsSync(dir));
  await post('/api/pause/' + r.json.id + '/stop');
  await until(() => !fs.existsSync(dir), 5000);
  assert.equal((await get(r.json.url)).status, 404);
  assert.equal((await post('/api/pause/' + r.json.id + '/alive')).status, 404);
});

test('pause: a new pause ends the previous recording (one provider connection), and "archive only" refuses', async () => {
  const a = (await post('/api/pause/start?profile=p1', { id: '110' })).json;
  const b = (await post('/api/pause/start?profile=p1', { id: '111' })).json;
  assert.notEqual(a.id, b.id);
  assert.equal((await post('/api/pause/' + a.id + '/alive')).status, 404, 'first one stopped');
  await post('/api/pause/' + b.id + '/stop');
  await post('/api/setup', { options: { pauseMode: 'archive', pauseMax: 120 } });
  const st = (await get('/api/status')).json;
  assert.deepEqual(st.pause, { mode: 'archive', max: 120, rec: true });
  assert.equal((await post('/api/pause/start?profile=p1', { id: '110' })).status, 403);
  await post('/api/setup', { options: { pauseMode: 'auto', pauseMax: 60 } });
  // kids can't record a channel outside their categories
  assert.equal((await post('/api/pause/start?profile=p2', { id: '110' })).status, 403);
});

/* ------------------------------------------------------------------ streaming services */

test('services: off without a key; the key is never sent back', async () => {
  assert.equal((await get('/api/services')).json.enabled, false);
  assert.deepEqual((await get('/api/services/search?q=fj&profile=p1')).json, { enabled: false, items: [] });
  await post('/api/setup', { options: { tmdbKey: 'testkey123', services: ['netflix', 'max', 'disney', 'prime'] } });
  const cfg = (await get('/api/setup')).json;
  assert.equal(cfg.options.tmdbKey, '••••');
  await post('/api/setup', { options: { tmdbKey: '••••' } }); // saving the form again keeps it
  assert.equal((await get('/api/services')).json.enabled, true);
});

test('services: search shows titles on the chosen services in Sweden with "Finns på", and the library twin', async () => {
  const lib = (await get('/api/list?type=movie&cat=all&profile=p1&limit=5')).json.items.find(x => x.y);
  localTitle = { n: lib.n, y: lib.y };
  let r = (await get('/api/services/search?q=alla&profile=p1')).json;
  const byId = Object.fromEntries(r.items.map(i => [i.k, i]));
  assert.deepEqual(byId['x:m11'].svc, ['netflix', 'max']);
  assert.deepEqual(byId['x:s22'].svc, ['max']);
  assert.ok(!byId['x:m33'], 'not in Sweden: left out');
  assert.equal(byId['x:m11'].img, 'https://image.tmdb.org/t/p/w342/a.jpg');
  assert.equal(byId['x:m55'].local.id, lib.id, 'library copy found');
  // only some services chosen
  await post('/api/setup', { options: { services: ['disney'] } });
  r = (await get('/api/services/search?q=alla&profile=p1')).json;
  assert.deepEqual(r.items.map(i => i.k).sort(), ['x:m44']);
  await post('/api/setup', { options: { services: ['netflix', 'max', 'disney', 'prime'] } });
  // kids: library only
  assert.deepEqual((await get('/api/services/search?q=alla&profile=p2')).json.items, []);
});

test('services: title details with links that open each app', async () => {
  const d = (await get('/api/services/title/movie/11?profile=p1')).json;
  assert.equal(d.n, 'Fjällräddarna');
  assert.equal(d.dur, 104 * 60);
  assert.equal(d.cast, 'Alicia Vikander');
  assert.deepEqual(d.links.map(l => l.name), ['Netflix', 'HBO Max']);
  assert.equal(d.links[0].url, 'https://www.netflix.com/search?q=Fj%C3%A4llr%C3%A4ddarna');
  assert.deepEqual((await get('/api/services/where/tv/22')).json.svc, ['max']);
});

test('services: suggestions follow what the profile liked, then what is popular; the start page gets a row', async () => {
  const lib = (await get('/api/list?type=movie&cat=all&profile=p1&limit=3')).json.items[1];
  await post('/api/state/p1/like', { k: lib.k, v: 1 });
  const r = (await get('/api/services/suggest?profile=p1')).json;
  assert.ok(r.items.length >= 3, JSON.stringify(r));
  assert.equal(r.items[0].k, 'x:m44', 'recommended from the liked film first');
  assert.match(r.items[0].because, /^Eftersom du gillade /);
  assert.ok(!r.items.some(i => i.k === 'x:m55'), 'what the library has is left out');
  // the start page row is worked out in the background
  await get('/api/page/home?profile=p1');
  const row = await until(async () => (await get('/api/page/home?profile=p1')).json.rows.find(x => x.id === 'svc'));
  assert.equal(row.title, 'Föreslaget på dina tjänster');
  assert.ok(row.items.every(i => i.t === 'ext' && i.svc.length));
  assert.ok(!(await get('/api/page/home?profile=p2')).json.rows.some(x => x.id === 'svc'), 'not for kids');
});

test('services: a wrong key says so instead of failing quietly', async () => {
  await post('/api/setup', { options: { tmdbKey: 'wrong' } });
  const r = (await get('/api/services/search?q=fjallnytt&profile=p1')).json;
  assert.equal(r.error, 'TMDB-nyckeln fungerar inte');
  assert.equal((await get('/api/services')).json.error, 'TMDB-nyckeln fungerar inte');
  await post('/api/setup', { options: { tmdbKey: 'testkey123' } });
});
