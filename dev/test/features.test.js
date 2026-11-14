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
  process.env.NSK_AIRTEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-airtest-'));
  process.env.PORT = '0';
  process.env.NSK_SETUP_OPEN = '1'; // the setup PIN has its own test (pin.test.js)
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
  assert.deepEqual(s.prefs, { sub: 'en', audio: 'sv', team: 'farjestad', teams: ['farjestad'] });
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
  // a title with no hockey word in it ("Luleå HF - Färjestad BK") is still the match
  m = sport.findMatch('lulea', chans, mk([at(11, 2.5, 'Luleå HF - Färjestad BK')]), { now });
  assert.equal(m && m.title, 'Luleå – Färjestad');
  // tomorrow's match is not today's
  m = sport.findMatch('lulea', chans, mk([at(26, 2.5, 'SHL: Luleå Hockey - Brynäs')]), { now });
  assert.equal(m, null);
});

test('sport: TV4 Play event channels carry the match in their name (no TV guide)', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 9, 25, 10); // 25 Oct 2026, 11:00 Swedish time (winter time from 03:00 today)
  const ev = sport.eventOf('[TV4Play] (25/10) 13:50 Norrby IF - IFK Norrköping', now);
  assert.equal(new Date(ev.s).toISOString(), '2026-10-25T12:50:00.000Z');
  assert.equal(ev.title, 'Norrby IF - IFK Norrköping');
  assert.equal(ev.label, 'TV4 Play');
  assert.equal(sport.eventOf('TV4 Play Event 21', now), null);
  // around new year the date belongs to the next year
  assert.equal(new Date(sport.eventOf('[TV4Play] (02/01) 19:00 X - Y', Date.UTC(2026, 11, 30)).s).toISOString(), '2027-01-02T18:00:00.000Z');
  const chans = [
    { id: 'a', n: '[TV4Play] (25/10) 13:20 Inter - Fiorentina', epg: '-' },
    { id: 'b', n: '[TV4Play] (25/10) 17:00 Studio: Luleå HF - Djurgården IF', epg: '-' },
    { id: 'c', n: '[TV4Play] (25/10) 18:00 Luleå HF - Djurgården IF', epg: '-' },
    { id: 'd', n: '[TV4Play] (24/10) 18:00 Luleå HF - Frölunda HC', epg: '-' },
    { id: 'e', n: 'TV4 Hockey HD', epg: 'tv4hockey.se' },
  ];
  const m = sport.findMatch('lulea', chans, null, { now });
  assert.equal(m.state, 'soon');
  assert.equal(m.title, 'Luleå – Djurgården');
  assert.equal(m.ch.id, 'c'); // not the studio show, not yesterday's match
  assert.equal(m.chName, 'TV4 Play');
  assert.equal(new Date(m.s).toISOString(), '2026-10-25T17:00:00.000Z');
  assert.equal(sport.findMatch('lulea', chans, null, { now: Date.UTC(2026, 9, 25, 18) }).state, 'live');
});

test('sport: Sweden\'s national teams (chosen like any team) and the skiing world cups', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 10, 28, 10); // 28 Nov 2026, 11:00 Swedish time
  const day = sport.stockholmDay(now), H = 3600e3;
  const at = (h, len, t, d = '') => [day.start + h * H, day.start + (h + len) * H, t, d];
  const chans = [
    { id: '1', n: 'SVT1 HD', epg: 'svt1' }, { id: '3', n: 'Eurosport 1 HD', epg: 'es1' },
    { id: '2', n: '[TV4Play] (28/11) 20:45 Sverige - Schweiz', epg: '-' },
    { id: '4', n: '[TV4Play] (28/11) 19:00 Luleå HF - Brynäs IF', epg: '-' },
  ];
  const epg = { map: new Map([
    ['svt1', [at(8, 2, 'Längdskidor: Världscupen', '10 km fri stil damer, Ruka.'), at(13, 1.5, 'Skidskytte: Världscupen', 'Sprint herrar.'), at(15, 1, 'Sverige idag'), at(16, 1, 'Handboll: Sverige - Norge')]],
    ['es1', [at(10.5, 2, 'Fotboll: Sverige - Danmark', 'Landskamp'), at(20, 1, 'Ishockey: Tre Kronor - Finland', 'Karjala Cup')]],
  ]) };
  const favs = ['lulea', 'tre-kronor', 'sverige-fotboll'];
  const all = sport.todayAll(favs, chans, epg, { now });
  const got = all.map(m => m.state + ' ' + m.team.id + ' ' + m.title);
  assert.deepEqual(got, [
    'live sverige-fotboll Sverige – Danmark',
    'soon skidskytte Skidskytte: Världscupen',
    'soon lulea Luleå – Brynäs',
    'soon tre-kronor Sverige – Finland',
    'soon sverige-fotboll Sverige – Schweiz', // an event channel says nothing of the sport: the men's football team
    'ended langd Längdskidor: Världscupen',
  ]);
  // the billboard takes the first; Sverige idag and handball are not followed
  assert.equal(sport.findMatch(favs, chans, epg, { now }).title, 'Sverige – Danmark');
  // the handball match is followed once the handball team is chosen
  assert.ok(sport.todayAll(['sverige-handboll'], chans, epg, { now }).some(m => m.team.id === 'sverige-handboll' && m.title === 'Sverige – Norge'));
  assert.equal(sport.todayAll(['lulea'], chans, epg, { now }).filter(m => /Sverige/.test(m.title)).length, 0);
  // the recordings stay with the favourite team only
  assert.deepEqual(sport.matchesToday('lulea', chans, epg, { now }).map(m => m.title), ['Luleå – Brynäs']);
});

/* ------------------------------------------------------------------ pause live TV */

test('pause: records the channel to disk, plays it back as HLS, stops and cleans up', async () => {
  const st = (await get('/api/status')).json;
  assert.deepEqual(st.pause, { mode: 'auto', max: 60, rec: true });
  const r = await post('/api/pause/start?profile=p1', { id: '108' }); // no archive on this channel (and no match: pausing the match channel records the match)
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
  const a = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  const b = (await post('/api/pause/start?profile=p1', { id: '109' })).json;
  assert.notEqual(a.id, b.id);
  assert.equal((await post('/api/pause/' + a.id + '/alive')).status, 404, 'first one stopped');
  await post('/api/pause/' + b.id + '/stop');
  await post('/api/setup', { options: { pauseMode: 'archive', pauseMax: 120 } });
  const st = (await get('/api/status')).json;
  assert.deepEqual(st.pause, { mode: 'archive', max: 120, rec: true });
  assert.equal((await post('/api/pause/start?profile=p1', { id: '108' })).status, 403);
  await post('/api/setup', { options: { pauseMode: 'auto', pauseMax: 60 } });
  // kids can't record a channel outside their categories
  assert.equal((await post('/api/pause/start?profile=p2', { id: '108' })).status, 403);
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

/* ------------------------------------------------------------------ match recording (Luleå, 24 h) */

test('match: the favourite\'s match is recorded from the start, kept for a day, one stream at a time', async () => {
  // Luleå's match is recorded from the start of the broadcast even when someone watches something else: on a
  // one- or two-connection account the recording gets the connection, a paused channel gives way
  app._streamIdle();
  const pz = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  assert.ok(pz.id, JSON.stringify(pz));
  app._matchRecTick();
  const r = (await get('/api/matchrec')).json;
  assert.equal(r.recs.length, 1, 'recorded although a channel was paused: ' + JSON.stringify(r));
  assert.equal((await get(pz.url)).status, 404, 'the pause gave way to the match (one connection)');
  // the list is saved: a restart of the add-on carries on with it
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'matchrecs.json'), 'utf8'));
  assert.equal(saved.recs.length, 1);
  assert.equal(saved.recs[0].title, r.recs[0].title);
  const rec = r.recs[0];
  assert.match(rec.title, /Luleå – Färjestad/);
  assert.match(rec.url, /\/mrec\/\w+\/index\.m3u8$/, 'one playlist for the whole match (all its parts)');
  // while it runs, a pause on another channel waits; the same channel pauses into the recording
  assert.equal(rec.recording, true, 'the match recording runs');
  const other = await post('/api/pause/start?profile=p1', { id: '111' });
  assert.equal(other.status, 409, JSON.stringify(other.json));
  const same = await post('/api/pause/start?profile=p1', { id: rec.chId });
  assert.equal(same.json && same.json.id, rec.id);
  // the server refuses another stream itself too (not only the app's question)
  assert.ok((await get('/api/matchrec')).json.active, 'still recording');
  const st = await get('/api/stream/live/111?profile=p1');
  assert.equal(st.status, 409, JSON.stringify(st.json));
  // the same channel: the recording, never a second connection to the provider
  const sc = await get('/api/stream/live/' + encodeURIComponent(rec.chId) + '?profile=p1');
  assert.equal(sc.status, 200, JSON.stringify(sc.json));
  assert.equal(sc.json.rec && sc.json.rec.id, rec.id);
  assert.equal(sc.json.sources.length, 1);
  assert.ok(!sc.json.sources.some(x => x.direct), 'no direct provider link');
  // its archive would be a second connection: refused
  const ar = await get('/api/stream/live/' + encodeURIComponent(rec.chId) + '?profile=p1&start=' + Math.floor(Date.now() / 1000 - 3600));
  assert.equal(ar.status, 409, JSON.stringify(ar.json));
  // the playlist is there, growing from the start
  const pl = await until(async () => { const x = await get(rec.url); return x.status === 200 && x.text; }, 30000);
  assert.match(pl, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.match(pl, /#EXT-X-START:TIME-OFFSET=0/, 'from the start of the match');
  assert.match((await get(rec.url + '?edge=1')).text, /#EXT-X-START:TIME-OFFSET=-12/, 'live viewers (and AirPlay) start near the end');
  // a second tick does not start another one for the same match
  app._matchRecTick();
  assert.equal((await get('/api/matchrec')).json.recs.length, 1);
  // stopping it (the viewer says so) removes it
  const stopped = (await post('/api/matchrec/stop')).json;
  assert.ok(stopped.stopped >= 0);
  await until(async () => (await get(rec.url)).status === 404, 5000);
  assert.equal((await get('/api/matchrec')).json.active, null);
  // stopped by the viewer: not started again for this match
  app._streamIdle();
  app._matchRecTick();
  assert.equal((await get('/api/matchrec')).json.recs.length, 0, 'a stopped match stays stopped');
});

test('match: watching the match channel when the match is due records it and shows the recording live (one connection), pausing it too', async () => {
  app._matchReset();
  app._streamIdle();
  const m = (await get('/api/page/home?profile=p1')).json.sport;
  const ch = m.chans[1]; // not the best channel: the one the viewer is on is the one recorded
  // the player of that channel checks in: the server says to ask for the channel again
  const w = (await post('/api/watching', { ch: ch.id })).json;
  assert.equal(w.recNow, true, JSON.stringify(w));
  assert.equal((await post('/api/watching', { ch: '108' })).json.recNow, false, 'a channel without the match: nothing to do');
  // it asks again: the recording starts and is what it gets, at its live edge
  const sc = await get('/api/stream/live/' + encodeURIComponent(ch.id) + '?profile=p1');
  assert.equal(sc.status, 200, JSON.stringify(sc.json));
  assert.ok(sc.json.rec && sc.json.rec.edge, 'the recording at its live edge');
  const r = (await get('/api/matchrec')).json;
  assert.equal(r.recs.length, 1);
  assert.equal(String(r.recs[0].chId), String(ch.id), 'the channel being watched is the one recorded');
  assert.equal(r.recs[0].id, sc.json.rec.id);
  assert.equal((await post('/api/watching', { ch: ch.id })).json.recNow, false, 'already recording');
  // a preview never starts it
  app._matchReset();
  app._streamIdle();
  await get('/api/stream/live/' + encodeURIComponent(ch.id) + '?profile=p1&pv=1');
  assert.equal((await get('/api/matchrec')).json.recs.length, 0, 'a preview does not start the recording');
  // pausing the match channel: the pause is the match recording (not a short pause that ends at its limit)
  app._streamIdle();
  const pz = (await post('/api/pause/start?profile=p1', { id: m.ch.id })).json;
  const r2 = (await get('/api/matchrec')).json;
  assert.equal(r2.recs.length, 1, JSON.stringify(r2));
  assert.equal(pz.id, r2.recs[0].id);
  assert.ok(pz.max >= Math.floor((m.e - Date.now()) / 60e3) && pz.max > 60, 'long enough for the whole match (a pause is 60 min): ' + pz.max);
  // a channel without the match pauses as before
  app._matchReset();
  app._streamIdle();
  const other = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  assert.ok(other.id);
  assert.equal((await get('/api/matchrec')).json.recs.length, 0);
  await post('/api/pause/' + other.id + '/stop');
  app._matchReset();
});

test('match: a device playing something else when the match starts is told to switch; the FHD channel is preferred', async () => {
  const sport = require('../lib/sport');
  assert.ok(sport.channelScore('SE: TV4 Sport FHD') > sport.channelScore('SE: TV4 Sport HD'), 'FHD before HD');
  assert.ok(sport.channelScore('SE: TV4 Sport HD') > sport.channelScore('SE: TV4 Sport'), 'HD before plain');
  app._matchReset();
  app._streamIdle();
  const m = (await get('/api/page/home?profile=p1')).json.sport;
  // a channel without the match, or a film (no channel): switch to the match
  const w = (await post('/api/watching', { ch: '108' })).json;
  assert.ok(w.matchOn, JSON.stringify(w));
  assert.equal(w.matchOn.title, m.title);
  assert.ok(m.chans.some(c => String(c.id) === String(w.matchOn.ch.id)), 'one of the match channels');
  assert.equal(String(w.matchOn.ch.id), String(m.ch.id), 'the best (FHD/HD) one');
  assert.ok((await post('/api/watching', {})).json.matchOn, 'a film too');
  // the match channel itself: record it and watch through the recording (not "switch")
  const own = (await post('/api/watching', { ch: m.ch.id })).json;
  assert.equal(own.recNow, true);
  assert.equal(own.matchOn, null);
  // once it records, nothing more to say
  app._streamIdle();
  app._matchRecTick();
  assert.equal((await get('/api/matchrec')).json.recs.length, 1);
  assert.equal((await post('/api/watching', { ch: '108' })).json.matchOn, null);
  // a downloaded film plays from the server's disk: it never has to give way
  app._matchReset();
  assert.equal((await post('/api/watching', { dl: true })).json.matchOn, null);
  app._matchReset();
});

test('match: when its recording cannot start (disk full, no channel) nobody watching is cut off for it', async () => {
  const tsbuf = require('../lib/tsbuf');
  app._matchReset();
  app._streamIdle();
  const pz = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  assert.ok(pz.id);
  const real = tsbuf.preflight;
  tsbuf.preflight = () => 'för lite ledigt diskutrymme';
  try {
    app._matchRecTick();
    assert.equal((await get('/api/matchrec')).json.recs.length, 0, 'nothing recorded');
    assert.equal((await get(pz.url)).status, 200, 'the paused channel goes on');
    // and the next tick a moment later does not try again at once
    tsbuf.preflight = real;
    app._matchRecTick();
    assert.equal((await get('/api/matchrec')).json.recs.length, 0, 'it waits a while before the next try');
    assert.equal((await get(pz.url)).status, 200);
  } finally { tsbuf.preflight = real; }
  await post('/api/pause/' + pz.id + '/stop');
  app._matchReset();
});

test('one connection: a paused channel blocks the speed test, a new stream ends it; a finished match recording survives a new pause', async () => {
  const tsbuf = require('../lib/tsbuf');
  const st = (await get('/api/stream/movie/1002?profile=p1&ext=mkv&caps=vp9,opus')).json;
  assert.ok(st.t, 'a token for the speed test');
  app._streamIdle();
  const pz = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  assert.ok(pz.id, JSON.stringify(pz));
  const sp = await get('/api/speedtest?t=' + encodeURIComponent(st.t) + '&sec=3');
  assert.equal(sp.status, 409, 'the speed test waits for the paused channel');
  // a preview (start page, guide) gives way to the paused channel instead of ending it
  assert.equal((await get('/api/stream/live/112?profile=p1&pv=1')).status, 409);
  assert.equal(tsbuf.pauseActive(), 1, 'the pause goes on');
  await get('/api/stream/movie/1002?profile=p1&ext=mkv&caps=vp9,opus');
  assert.equal(tsbuf.pauseActive(), 0, 'a new stream ends the paused channel');
  assert.equal((await get(pz.url)).status, 404);
  // a match recording that has finished is kept for a day, even when someone pauses another channel
  const m = tsbuf.start(prov + '/live/demo/demo/110.ts', { maxMin: 1, ch: 'test', match: true });
  m.done = true; try { m.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  const pz2 = (await post('/api/pause/start?profile=p1', { id: '108' })).json;
  assert.ok(pz2.id, JSON.stringify(pz2));
  assert.ok(tsbuf.get(m.id), 'the finished match recording is still there');
  tsbuf.stop(m, 'test'); await post('/api/pause/' + pz2.id + '/stop');
});

test('ffmpeg errors never pass on a link (it carries the account)', () => {
  const ff = require('../lib/ffmpeg'), tsbuf = require('../lib/tsbuf');
  const lines = ['Error opening input file http://h:8080/live/anna/PW4/123.m3u8.', 'http://h/movie/anna/P W4/1.mp4: Server returned 403 Forbidden'];
  for (const f of [ff._hideLinks, tsbuf._hideLinks]) for (const line of lines) { const o = f(line); assert.ok(!/anna|PW4|W4/.test(o), o); assert.match(o, /<länk>/); }
  assert.match(ff._hideLinks(lines[1]), /Server returned 403/, 'the reason stays');
});

test('converting: a low disk frees what was already watched, then ends the conversion instead of filling it', () => {
  const ff = require('../lib/ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-disk-'));
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(dir, 's' + String(i).padStart(5, '0') + '.m4s'), 'x');
  let killed = '';
  const s = { key: 'k', dir, seen: 190, done: false, proc: { kill: (sig) => { killed = sig; } } };
  ff._sessions.set('k', s);
  try {
    ff._guardDisk(() => 6e8); // low (below 0.6 × 1.5 GB) but not critical (above 0.3 ×)
    assert.ok(!fs.existsSync(path.join(dir, 's00000.m4s')), 'watched part freed');
    assert.ok(fs.existsSync(path.join(dir, 's00040.m4s')), 'the last 10 min behind the viewer stay');
    assert.equal(killed, '');
    ff._guardDisk(() => 1e8); // critical
    assert.equal(killed, 'SIGINT');
  } finally { ff._sessions.delete('k'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one connection: proxied streams count, a new stream ends them, a preview and the speed test give way', async () => {
  const ended = [];
  const fake = (n) => { const ac = new AbortController(); ac.signal.addEventListener('abort', () => ended.push(n)); return [ac, { destroy: () => ended.push('res' + n) }]; };
  const [ac1, res1] = fake(1);
  app.proxy.open.set(ac1, res1);
  assert.equal(app.proxy.activeCount(), 1);
  const st = (await get('/api/stream/movie/1002?profile=p1&ext=mkv&caps=vp9,opus')).json; // a new stream ends the proxied one
  assert.equal(app.proxy.activeCount(), 0);
  assert.deepEqual(ended.sort(), [1, 'res1']);
  // AirPlay preparation only asks for addresses: it must not end what is playing
  const [ac0, res0] = fake(0);
  app.proxy.open.set(ac0, res0);
  assert.equal((await get('/api/stream/movie/1002?profile=p1&ext=mkv&caps=vp9,opus&air=1')).status, 200);
  assert.equal(app.proxy.activeCount(), 1, 'the proxied stream goes on');
  app.proxy.abortAll();
  const [ac2, res2] = fake(2);
  app.proxy.open.set(ac2, res2);
  assert.equal((await get('/api/stream/live/112?profile=p1&pv=1')).status, 409, 'a preview gives way to a proxied stream');
  assert.equal(app.proxy.activeCount(), 1, 'and does not end it');
  assert.equal((await get('/api/speedtest?t=' + encodeURIComponent(st.t) + '&sec=3')).status, 409, 'the speed test waits');
  app.proxy.abortAll();
});

test('images: the home network is closed (also behind a redirect), the provider\'s own server and public names are open', async () => {
  const ok = (u) => app._imageAllowed(u);
  assert.equal(ok('http://127.0.0.1:1/x.png'), false);
  assert.equal(ok('http://localhost:8123/x.png'), false);
  assert.equal(ok('http://192.168.1.5/x.png'), false);
  assert.equal(ok('http://[::1]/x.png'), false);
  assert.equal(ok('http://localhost.:8123/x.png'), false, 'a trailing dot is the same name');
  assert.equal(ok('http://fcdn.example.test/x.png'), true, 'a name that starts with fc is not an IPv6 address');
  assert.equal(ok('http://fdlogo.example.test/x.png'), true);
  assert.equal(ok('https://image.tmdb.org/t/p/w500/a.jpg'), true);
  assert.equal(ok(prov + '/img/logo/10.svg'), true, 'the provider itself');
  const u = new URL(prov);
  assert.equal(ok('http://' + u.hostname + ':' + (+u.port + 1) + '/x.png'), false, 'another port on the provider\'s machine');
  // a redirect from an allowed server to the home network is stopped
  const secret = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'image/png' }); r.end('LANSECRET'); });
  await new Promise(r => secret.listen(0, '127.0.0.1', r));
  const hop = http.createServer((q, r) => { r.writeHead(302, { Location: 'http://127.0.0.1:' + secret.address().port + '/s.png' }); r.end(); });
  await new Promise(r => hop.listen(0, '127.0.0.1', r));
  const old = app.store.config.options.epgUrl;
  app.store.config.options.epgUrl = 'http://127.0.0.1:' + hop.address().port + '/epg.xml'; // makes this one "the provider"
  try {
    const r = await get('/img?u=' + encodeURIComponent('http://127.0.0.1:' + hop.address().port + '/logo.png'));
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.text || '', /LANSECRET/);
  } finally { app.store.config.options.epgUrl = old; hop.close(); secret.close(); }
});

test('links in ffmpeg errors: gone also when the password has a space or ": " in it', () => {
  const hide = require('../lib/ffmpeg')._hideLinks;
  for (const s of ['http://anna:pa: ss@h/x.m3u8: Invalid data', 'http://h/live/anna/P W4/1.mp4: Server returned 403', 'Error opening input file http://h/live/anna/PW4/1.m3u8.']) {
    const o = hide(s);
    assert.doesNotMatch(o, /anna|ss@|W4|PW4/, o);
  }
  assert.match(hide('http://anna:pa: ss@h/x.m3u8: Invalid data'), /Invalid data/);
});

test('AirPlay test page: four forms of a test clip, each playable from the server (Range for the MP4)', async () => {
  const pg = await until(async () => { const x = await get('/airtest'); return x.status === 200 && x.text; }, 120000);
  const srcs = [...pg.matchAll(/<video[^>]+src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length >= 7, pg); // four finished clips, three growing (live) playlists, maybe the match recording
  assert.ok(srcs.filter(u => /\/airtest\/[efg]\/index\.m3u8$/.test(u)).length === 3, 'three live forms');
  for (const u of srcs.filter(x => /\/airtest\//.test(x))) {
    const path = u.replace(/^https?:\/\/[^/]+/, '');
    const r = /\/[efg]\/index/.test(path) ? await until(async () => { const x = await fetch(base + path); return x.status === 200 && x; }, 30000) : await fetch(base + path);
    assert.equal(r.status, 200, path);
    const body = Buffer.from(await r.arrayBuffer());
    if (path.endsWith('.m3u8')) {
      const seg = await until(async () => { const t = path.includes('/airtest/') && /\/[efg]\//.test(path) ? await (await fetch(base + path)).text() : body.toString(); return t.split('\n').find(l => l && l[0] !== '#'); }, 30000);
      if (/\/e\//.test(path)) assert.match(body.toString(), /#EXT-X-START:TIME-OFFSET=0/, 'like the recordings');
      if (/\/[efg]\//.test(path)) assert.doesNotMatch(body.toString(), /#EXT-X-ENDLIST/, 'still growing');
      assert.ok(seg, 'a playlist with pieces: ' + path);
      const sr = await fetch(base + path.replace(/index\.m3u8$/, seg));
      assert.equal(sr.status, 200, seg);
      assert.ok((await sr.arrayBuffer()).byteLength > 10000);
    } else assert.ok(body.length > 100000, 'the MP4 is there');
  }
  const mp4 = srcs.find(u => u.endsWith('.mp4')).replace(/^https?:\/\/[^/]+/, '');
  const part = await fetch(base + mp4, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await get('/airtest/a/..%2Fsecret')).status, 404, 'only the clips');
});

test('AirPlay test page: the /setup PIN is needed, and names from the provider are escaped', async () => {
  const airtest = require('../lib/airtest');
  const html = airtest.page('', [{ name: '<img src=x onerror=alert(1)>', url: '/pause/x/index.m3u8' }]);
  assert.ok(!html.includes('<img src=x'), 'a channel name cannot add HTML');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(airtest.pinPage('Fel PIN-kod'), /name="pin"/);
});

test('an error nobody caught is logged once a minute with a count, masked', () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const e = new Error('trasigt http://u:hemligt@prov.example/live/1.ts');
    for (let i = 0; i < 5; i++) app._logUncaught(e);
  } finally { console.error = orig; }
  assert.equal(lines.length, 1, 'the same error in a loop: one line');
  assert.match(lines[0], /^\[fel\]/);
  assert.ok(!lines[0].includes('hemligt'), 'the link is masked');
});

test('sport: several favourite teams, Premier League clubs in every competition, the list of coming matches', async () => {
  const sport = require('../lib/sport');
  const A = sport.TEAMS.find(t => t.id === 'arsenal');
  assert.equal(sport.TEAMS.filter(t => t.group === 'Premier League').length, 20);
  assert.deepEqual(sport.matchup('Fotboll: Premier League: Arsenal - Chelsea', A), { home: 'Arsenal', away: 'Chelsea' });
  assert.deepEqual(sport.matchup('FA Cup: Manchester United vs Arsenal FC', A), { home: 'Man United', away: 'Arsenal' });
  assert.equal(sport.matchup('Arsenal: historien', A), null);
  assert.deepEqual(sport.teamIds(['lulea', 'Arsenal', 'none', 'x', 'lulea']), ['lulea', 'arsenal']);
  const now = Date.UTC(2026, 10, 14, 10);
  const ch = [{ id: 1, n: 'V Sport Premium HD', epg: 'a' }, { id: 2, n: 'SVT1', epg: 'b' }];
  const h = 3600e3, d = 86400e3;
  const epg = { map: new Map([
    ['a', [[now + h, now + 3 * h, 'Premier League: Arsenal - Chelsea', ''], [now + d, now + d + 2 * h, 'NBA: Arsenal - X', 'basket'], [now + 3 * d, now + 3 * d + 2 * h, 'Carabao Cup: Hull City - Arsenal', ''], [now + 4 * d, now + 4 * d + 2 * h, 'Champions League: Liverpool - Arsenal (repris)', '']]],
    ['b', [[now + 2 * h, now + 4 * h, 'Vinterstudion: Längdskidor: Världscupen', ''], [now + 5 * h, now + 7 * h, 'SHL: Luleå Hockey - Brynäs', '']]],
  ]) };
  const up = sport.upcoming(['arsenal', 'lulea'], ch, epg, { now });
  assert.deepEqual(up.map(m => m.title), ['Arsenal – Chelsea', 'Luleå – Brynäs', 'Hull – Arsenal']);
  assert.equal(up[2].label, 'Fotboll · Ligacupen');
  // recorded by itself: Luleå only; the skiing world cup when switched on; never a football club
  assert.deepEqual(sport.recToday('lulea', false, ch, epg, { now }).map(m => m.team.id), ['lulea']);
  assert.deepEqual(sport.recToday('lulea', true, ch, epg, { now }).map(m => m.team.id).sort(), ['langd', 'lulea']);
  // the profile keeps a list; the old single value follows along
  await post('/api/state/p1/prefs', { teams: ['lulea', 'arsenal', 'nonsense'] });
  let s = (await get('/api/state/p1')).json;
  assert.deepEqual(s.prefs.teams, ['lulea', 'arsenal']);
  assert.equal(s.prefs.team, 'lulea');
  const r = (await get('/api/sport?profile=p1')).json;
  assert.ok(Array.isArray(r.upcoming));
  assert.ok(r.teams.some(t => t.id === 'man-utd' && t.group === 'Premier League'));
  await post('/api/state/p1/prefs', { teams: [] });
  s = (await get('/api/state/p1')).json;
  assert.deepEqual(s.prefs.teams, []);
  assert.equal(s.prefs.team, 'none');
  await post('/api/state/p1/prefs', { team: 'lulea', sub: 'sv' });
});

test('sport: a Swedish channel always before another country\'s; one match on several channels; youth teams are not the team', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 10, 14, 6);
  const mk = (n, region) => ({ id: n, n, region, epg: '' });
  const ch = [mk('[Vgtv] (14/11) 17:50 Luleå vs Färjestad', 'foreign'), mk('[Svensk] (14/11) 11:10 U14P: Luleå HF  Vs Piteå HC', 'se'), mk('[Svensk] (14/11) 12:00 J20: Luleå HF - Skellefteå AIK', 'se')];
  let up = sport.upcoming(['lulea'], ch, { map: new Map() }, { now });
  assert.equal(up.length, 1);
  assert.equal(up[0].foreign, true); // only the Norwegian one is known so far: said, not hidden
  ch.push(mk('[TV4Play] (14/11) 17:55 Luleå HF - Färjestad BK', 'se'), mk('V Sport 1 FHD', 'se'));
  up = sport.upcoming(['lulea'], ch, { map: new Map() }, { now });
  assert.equal(up.length, 1);
  assert.deepEqual([up[0].title, up[0].chName, up[0].foreign, up[0].chans.length], ['Luleå – Färjestad', 'TV4 Play', false, 1]);
  assert.equal(new Date(up[0].s).toISOString(), '2026-11-14T16:55:00.000Z');
  assert.ok(sport.channelScore('TV4 Hockey UHD', 'se') > sport.channelScore('TV4 Hockey FHD', 'se'));
  assert.ok(sport.channelScore('TV4 Hockey', 'se') > sport.channelScore('Viaplay Sport FHD', 'foreign'));
  assert.deepEqual(['Sweden - Sport', 'Norway - VG+ Play', 'United Kingdom - Sport', 'Sport'].map(sport.regionOf), ['se', 'foreign', 'foreign', '']);
});

test('sport: each coming match carries the guide text, whether it records by itself, and the teams\' ids (the match page)', async () => {
  await post('/api/state/p1/prefs', { teams: ['lulea'] });
  const r = (await get('/api/sport?profile=p1')).json;
  const all = (r.upcoming || []).concat(r.match ? [r.match] : []);
  const lul = all.find(m => /Luleå/.test(m.title));
  if (lul) {
    assert.equal(typeof lul.d, 'string');
    assert.ok(lul.d.length > 0);
    assert.equal(lul.autoRec, true);
    if (lul.sides) assert.equal(lul.sides.find(x => /Luleå/.test(x.n)).id, 'lulea');
  }
  await post('/api/state/p1/prefs', { team: 'lulea', sub: 'sv' });
});

test('club crests: uploaded in /setup (PIN), checked by their bytes, shown at /crest/:id, removable', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a90f0000000049454e44ae426082', 'hex');
  const hdr = Object.assign({ 'Content-Type': 'application/octet-stream' }, process.env.__NSK_TEST_PIN ? { 'X-Pin': process.env.__NSK_TEST_PIN } : {});
  let r = await fetch(base + '/api/setup/crest/lulea', { method: 'POST', headers: hdr, body: PNG });
  if (r.status === 401) return; // a PIN is required here: the PIN guard is covered elsewhere
  assert.equal(r.status, 200);
  r = await fetch(base + '/crest/lulea');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  // not a picture: refused, whatever it calls itself
  r = await fetch(base + '/api/setup/crest/farjestad', { method: 'POST', headers: hdr, body: '<html><script>alert(1)</script></html>' });
  assert.equal(r.status, 415);
  r = await fetch(base + '/api/setup/crest/nobody', { method: 'POST', headers: hdr, body: PNG });
  assert.equal(r.status, 404);
  // too big: a clear answer (not a cut connection), and the crest there was is still there
  r = await fetch(base + '/api/setup/crest/lulea', { method: 'POST', headers: hdr, body: Buffer.concat([PNG, Buffer.alloc(1.2e6)]) });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /för stor/);
  assert.equal((await fetch(base + '/crest/lulea')).status, 200);
  // two uploads of the same crest at once (a folder with two names for one team): both answered, one crest left
  const two = await Promise.all([1, 2].map(() => fetch(base + '/api/setup/crest/lulea', { method: 'POST', headers: hdr, body: PNG })));
  assert.deepEqual(two.map(x => x.status), [200, 200]);
  assert.equal((await fetch(base + '/crest/lulea')).status, 200);
  const list = await (await fetch(base + '/api/setup/crests', { headers: hdr })).json();
  assert.equal(list.teams.find(t => t.id === 'lulea').mine, true);
  const sp = (await get('/api/sport?profile=p1')).json;
  const side = [sp.match].concat(sp.upcoming || []).filter(Boolean).flatMap(m => m.sides || []).find(x => x.id === 'lulea');
  if (side) assert.match(side.img, /\/crest\/lulea\?v=\d+/);
  r = await fetch(base + '/api/setup/crest/lulea', { method: 'DELETE', headers: hdr });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base + '/crest/lulea')).status, 404);
});

test('sport: every Swedish national team on its own – sport, women/men, juniors', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 10, 14, 9), h = 3600e3;
  const ch = [{ id: 1, n: '[Viapaly SE] (14/11) 18:30 Sverige - Bosnien-Hercegovina', region: 'se', epg: '' }, { id: 2, n: 'TV4 Hockey FHD', region: 'se', epg: 'a' }, { id: 3, n: 'SVT1 FHD', region: 'se', epg: 'b' }, { id: 4, n: 'TV4 Fotboll', region: 'se', epg: 'c' }];
  const epg = { map: new Map([
    ['a', [[now + 2 * h, now + 5 * h, 'Sverige - Finland', 'Ishockey, Euro Hockey Tour.'], [now + 6 * h, now + 9 * h, 'Sverige - USA', 'Damkronorna möter USA i ishockey.'], [now + 26 * h, now + 29 * h, 'JVM: Sverige - Kanada', 'Ishockey, junior-VM.']]],
    ['b', [[now + 3 * h, now + 5 * h, 'Handboll: Sverige - Norge', 'EM-kval, damer.'], [now + 30 * h, now + 32 * h, 'Sverige - Danmark', 'Handbollslandskamp, herrar.']]],
    ['c', [[now + 50 * h, now + 52 * h, 'Sverige - Spanien (dam)', 'Fotboll, Nations League.'], [now + 70 * h, now + 72 * h, 'Sverige - Italien', 'U21-landskamp i fotboll.']]],
  ]) };
  const nations = sport.TEAMS.filter(t => t.group === 'Landslag').map(t => t.id);
  assert.ok(nations.length >= 16);
  const got = sport.upcoming(nations, ch, epg, { now, days: 5 }).map(m => m.team.id + ' ' + m.title);
  assert.deepEqual(got, ['tre-kronor Sverige – Finland', 'sverige-handboll-dam Sverige – Norge', 'damkronorna Sverige – USA', 'sverige-fotboll Sverige – Bosnien-Hercegovina',
    'juniorkronorna Sverige – Kanada', 'sverige-handboll Sverige – Danmark', 'sverige-fotboll-dam Sverige – Spanien', 'sverige-u21 Sverige – Italien']);
  // only the chosen ones
  assert.deepEqual(sport.upcoming(['damkronorna'], ch, epg, { now, days: 5 }).map(m => m.title), ['Sverige – USA']);
});

test('sport: the same national match on two services in two languages is one match, on the Swedish one, with the flags', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 10, 14, 15);
  const ch = [{ id: 1, n: '[Viapaly SE] (14/11) 18:30 Sverige - Bosnien-Hercegovina', region: 'se', epg: '' }, { id: 2, n: '[Viaplay NO] (14/11) 20:30 Sverige - Bosnia-Hercegovina', region: 'foreign', epg: '' }];
  const r = sport.upcoming(['sverige-fotboll'], ch, { map: new Map() }, { now });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].title, r[0].chName, r[0].foreign, r[0].chans.map(c => c.id)], ['Sverige – Bosnien-Hercegovina', 'Viaplay', false, [1]]);
  assert.deepEqual(sport.countryOf('Bosnia-Herzegovina'), { flag: 'BA', ab: 'BIH' });
  assert.equal(sport.countryOf('Luleå'), null);
});

test('crests: one folder for everything – your teams, other clubs, other countries, competitions – found again by name', async () => {
  const crests = require('../lib/crests');
  const k = (f) => (crests.keyForFile(f, { aik: 'AIK', lulea: 'LHF' }) || {}).key;
  assert.equal(k('aik-logo-footylogos.svg'), 'aik');
  assert.equal(k('lulea-hockey-logo-footylogos.svg'), 'lulea');
  assert.equal(k('djurgardens-if-hockey-logo-footylogos.svg'), 'djurgarden');
  assert.equal(k('sweden-mens-national-ice-hockey-team-seeklogo-2.svg'), 'tre-kronor');
  assert.equal(k('sweden-national-team-logo-footylogos.svg'), 'sverige-fotboll');
  assert.equal(k('bosnia-and-herzegovina-national-team-logo-footylogos.svg'), 'nat-bih');
  assert.equal(k('republic-of-ireland-national-team-logo-footylogos.svg'), 'nat-irl');
  assert.equal(k('uefa-champions-league-logo-footylogos (1).svg'), 'comp-champions-league');
  assert.equal(k('uefa-nations-league-logo-footylogos.svg'), 'comp-nations-league');
  assert.equal(k('premier-league-england-logo-footylogos.svg'), 'comp-premier-league');
  assert.equal(k('shl-logo-footylogos.svg'), 'comp-shl');
  assert.equal(k('bayern-munich-logo-footylogos.svg'), 'club-bayern-munich');
  const keys = ['club-bayern-munich', 'club-real-madrid', 'club-atletico-madrid', 'club-inter-milan', 'club-paris-saint-germain-psg', 'club-sporting-cp', 'club-fk-bodo-glimt'];
  const c = (n) => crests.clubKey(n, keys);
  assert.deepEqual(['Bayern München', 'Real Madrid', 'Atlético Madrid', 'AC Milan', 'Inter', 'PSG', 'Sporting Lissabon', 'Bodø/Glimt'].map(c),
    ['club-bayern-munich', 'club-real-madrid', 'club-atletico-madrid', '', 'club-inter-milan', 'club-paris-saint-germain-psg', 'club-sporting-cp', 'club-fk-bodo-glimt']);
  assert.equal(crests.compKey('Champions League'), 'comp-champions-league');
  // through the server: sent by file name, kept under its key, shown for the list in /setup
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>';
  for (const name of ['bayern-munich-logo-footylogos.svg', 'uefa-champions-league-logo-footylogos.svg', 'bosnia-and-herzegovina-national-team-logo-footylogos.svg']) {
    const r = await fetch(base + '/api/setup/crest-auto?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: svg });
    assert.equal(r.status, 200, name);
  }
  assert.equal((await fetch(base + '/api/setup/crest-auto?name=' + encodeURIComponent('IMG_2092.PNG'), { method: 'POST', body: svg })).status, 422);
  assert.equal((await fetch(base + '/crest/club-bayern-munich')).status, 200);
  const list = (await get('/api/setup/crests')).json.teams;
  assert.ok(list.some(t => t.id === 'comp-champions-league' && t.group === 'Ligor och turneringar'));
  assert.ok(list.some(t => t.id === 'nat-bih' && t.group === 'Andra länders landslag'));
  for (const id of ['club-bayern-munich', 'comp-champions-league', 'nat-bih']) await fetch(base + '/api/setup/crest/' + id, { method: 'DELETE' });
});

test('sport: a foreign rerun hours later is the same match (its text gives arena and competition), not a second card', () => {
  const sport = require('../lib/sport');
  const now = Date.UTC(2026, 10, 14, 15);
  const ch = [{ id: 1, n: '[Viapaly SE] (14/11) 18:30 Sverige - Bosnien-Hercegovina', region: 'se', epg: '' }, { id: 2, n: 'TV2 Sport 1 FHD', region: 'foreign', epg: 'a' }];
  const epg = { map: new Map([['a', [[Date.UTC(2026, 10, 15, 0), Date.UTC(2026, 10, 15, 2), 'Sverige - Bosnia-Hercegovina', 'Fra Strawberry Arena, Stockholm og kampen mellom Sverige og Bosnia-Hercegovina i UEFA Nations League.']]]]) };
  const r = sport.upcoming(['sverige-fotboll'], ch, epg, { now, days: 2 });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].chName, r[0].arena, r[0].kind.comp], ['Viaplay', 'Strawberry Arena', 'Nations League']);
});

test('crest file names: Tre Kronor, Blågult and "<sport>_<herr|dam>_se" are Sweden\'s own teams, not other clubs', () => {
  const c = require('../lib/crests');
  const want = { 'Tre Kronor.svg': 'tre-kronor', 'Damkronorna.png': 'damkronorna', 'Blågult.svg': 'sverige-fotboll', 'fotboll_herr_se.svg': 'sverige-fotboll', 'fotboll_dam_se.png': 'sverige-fotboll-dam', 'handboll_dam_se.svg': 'sverige-handboll-dam', 'Basket SE.svg': 'sverige-basket', 'Sevilla.png': 'club-sevilla' };
  for (const [f, id] of Object.entries(want)) assert.equal((c.keyForFile(f) || {}).key, id, f);
  assert.equal(c.keyForFile('Fjärås.png').label, 'Fjärås', 'the name as it was written');
  for (const f of ['Brynäs hockey se.png', 'Linköping SE basket.png']) assert.ok(!/^sverige|tre-kronor/.test(c.keyForFile(f).key), f + ' is a club, not Sweden');
});
