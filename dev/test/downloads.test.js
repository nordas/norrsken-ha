'use strict';
/* Downloads to the storage disk (the AirPort's): the file, the connection rules, playing it back, the fallback. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-dl-'));
const MEDIA = path.join(TMP, 'media');
const AIRPORT = path.join(TMP, 'airport'); // stands for /media/airport (network disk mounted by Home Assistant)
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(AIRPORT, { recursive: true });
const mock = require('./mock-provider').create({ mediaDir: MEDIA });
let base = '';
let app;
let prov = '';

const get = async (p, opts) => { const r = await fetch(base + p, opts); const ct = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, json: ct.includes('json') ? await r.json() : null, buf: ct.includes('json') ? null : Buffer.from(await r.arrayBuffer()) }; };
const post = (p, body) => get(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const sleep = (ms) => new Promise(ok => setTimeout(ok, ms));
async function until(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(150); }
}
const probe = (f) => String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv=p=0', f]).stdout).trim().split('\n').map(x => x.split(',').filter(Boolean).join(':'));
const dlDir = () => path.join(AIRPORT, 'norrsken', 'downloads');
const list = async () => (await get('/api/downloads?profile=p1')).json.items;
const find = async (id) => (await list()).find(x => x.id === id);

before(async () => {
  const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: MEDIA }); assert.equal(r.status, 0, String(r.stderr)); };
  const V = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25'];
  const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
  ff([...V, ...A, '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'movie.mp4']); // plays as it is (index first, like films made for streaming)
  ff([...V, ...A, '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'dca', '-strict', '-2', 'movie.mkv']); // DTS: has to become E-AC-3
  ff([...V, ...A, '-t', '4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'ac3', 'vp9dts.mkv']); // VP9: can't be copied into MP4 for Apple
  prov = await mock.listen();
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-dl-data-'));
  process.env.NSK_STORAGE_DIR = AIRPORT;
  delete process.env.NSK_PAUSE_DIR;
  process.env.PORT = '0';
  process.env.NSK_SETUP_OPEN = '1';
  app = require('../server');
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
  await post('/api/setup', { source: 'xtream', xtream: { server: prov, username: 'demo', password: mock.PASS }, profiles: [{ id: 'p1', name: 'Oskar' }, { id: 'p2', name: 'Barn', kids: true }] });
  await until(async () => { const s = (await get('/api/status')).json; return s.ready && !s.loading && s; });
});

after(async () => { if (app.server.closeAllConnections) app.server.closeAllConnections(); app.server.close(); await mock.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('status says where the big files go and that downloads work', async () => {
  const { json } = await get('/api/status');
  assert.equal(json.downloads, true);
  assert.equal(json.storage.configured, true);
  assert.equal(json.storage.ok, true);
  assert.equal(json.storage.onNetwork, true);
  assert.ok(json.storage.freeGb > 0);
});

test('a film is saved as an MP4 on the storage disk, picture and sound copied', async () => {
  const r = await post('/api/downloads?profile=p1', { type: 'movie', id: '1002', ext: 'mp4', title: 'Fjällräddarna', sub: '2024', img: '' });
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].id, 'movie-1002');
  const x = await until(async () => { const i = await find('movie-1002'); return i && (i.status === 'done' || i.status === 'error') && i; });
  assert.equal(x.status, 'done', x.err);
  const f = path.join(dlDir(), 'movie-1002.mp4');
  assert.ok(fs.existsSync(f), 'the file is on the storage disk');
  assert.deepEqual(probe(f).sort(), ['aac:audio', 'h264:video']);
  assert.ok(x.bytes > 1000);
  assert.deepEqual(fs.readdirSync(dlDir()).filter(n => n.includes('.part')), [], 'no half-written file is left');
});

test('sound a phone cannot play (DTS) becomes E-AC-3, picture is still copied', async () => {
  await post('/api/downloads?profile=p1', { type: 'movie', id: '1004', ext: 'mkv', title: 'DTS-film' });
  const x = await until(async () => { const i = await find('movie-1004'); return i && (i.status === 'done' || i.status === 'error') && i; });
  assert.equal(x.status, 'done', x.err);
  assert.deepEqual(probe(path.join(dlDir(), 'movie-1004.mp4')).sort(), ['eac3:audio', 'h264:video']);
});

test('a picture format that cannot go into an MP4 is refused with a reason, nothing is kept', async () => {
  await post('/api/downloads?profile=p1', { type: 'movie', id: '1003', ext: 'mkv', title: 'VP9-film' });
  const x = await until(async () => { const i = await find('movie-1003'); return i && (i.status === 'done' || i.status === 'error') && i; });
  assert.equal(x.status, 'error');
  assert.match(x.err, /vp9/i);
  assert.ok(!fs.existsSync(path.join(dlDir(), 'movie-1003.mp4')));
});

test('the finished file is served with Range (seeking) and can be saved with a name', async () => {
  const x = await find('movie-1002');
  const url = '/dl/' + x.file;
  const whole = await get(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.buf.length, x.bytes);
  const part = await get(url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/' + x.bytes);
  assert.equal(part.buf.length, 100);
  assert.deepEqual(part.buf, whole.buf.subarray(0, 100));
  const tail = await get(url, { headers: { Range: 'bytes=-50' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.buf, whole.buf.subarray(whole.buf.length - 50));
  const bad = await get(url, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(bad.status, 416);
  const save = await get(url + '?dl=1');
  assert.match(save.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Fj%C3%A4llr%C3%A4ddarna\.mp4/);
  assert.equal((await get('/dl/movie-9999/x.mp4')).status, 404);
});

test('playing a downloaded film uses the file on the server and no provider connection', async () => {
  const s = (await get('/api/stream/movie/1002?profile=p1&caps=h264,aac')).json;
  assert.equal(s.downloaded, true);
  assert.equal(s.sources.length, 1);
  assert.match(s.sources[0].url, /\/dl\/movie-1002\//);
  assert.equal(s.sources[0].kind, 'file');
  // one that is not downloaded still goes to the provider
  const n = (await get('/api/stream/movie/1005?profile=p1&caps=h264,aac')).json;
  assert.ok(!n.downloaded);
});

test('a kids profile cannot queue what its library does not show; bad requests are refused', async () => {
  const ids = async (p) => new Set((await get('/api/list?type=movie&cat=all&offset=0&limit=500&profile=' + p)).json.items.map(i => i.id));
  const adult = await ids('p1');
  const kids = await ids('p2');
  const hidden = [...adult].find(id => !kids.has(id));
  assert.ok(hidden, 'the mock library has films the kids profile does not see');
  assert.equal((await post('/api/downloads?profile=p2', { type: 'movie', id: hidden, title: 'x' })).status, 400);
  assert.equal(await find('movie-' + hidden), undefined);
  assert.equal((await post('/api/downloads?profile=p1', { type: 'live', id: '1' })).status, 400);
  assert.equal((await post('/api/downloads?profile=p1', { items: [] })).status, 400);
  assert.equal((await post('/api/downloads?profile=p1', { type: 'movie' })).status, 400);
});

test('deleting removes the file from the storage disk and the list', async () => {
  const r = await post('/api/downloads/movie-1002/delete');
  assert.equal(r.json.ok, true);
  await until(async () => !fs.existsSync(path.join(dlDir(), 'movie-1002.mp4')));
  assert.equal(await find('movie-1002'), undefined);
  assert.equal((await get('/api/stream/movie/1002?profile=p1&caps=h264,aac')).json.downloaded, undefined);
});

/* ---- the module on its own: a download steps aside for a new stream and starts over later ---- */
test('every way into the provider gives way to or is refused by a running download', async () => {
  const dl = require('../lib/downloads');
  const file = fs.readFileSync(path.join(MEDIA, 'movie.mp4'));
  const slow = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'video/mp4' });
    let o = 0;
    const t = setInterval(() => { if (o >= file.length) { clearInterval(t); return r.end(); } r.write(file.subarray(o, o + 3000)); o += 3000; }, 200);
    r.on('close', () => clearInterval(t));
  });
  await new Promise(ok => slow.listen(0, '127.0.0.1', ok));
  const slowUrl = 'http://127.0.0.1:' + slow.address().port + '/slow.mp4';
  let busy = false;
  dl.configure({ busy: () => busy, maxConn: () => 1, probe: async () => ({ video: 'h264', dur: 8, br: 100000, audio: [{ i: 0, codec: 'aac', ch: 2 }] }), url: () => ({ primary: slowUrl, ext: 'mp4' }), ua: () => 't' });
  try {
    dl.add({ type: 'movie', id: 'slow1', title: 'Långsam' });
    await until(async () => (await find('movie-slow1')).status === 'downloading');
    assert.equal(dl.active(), 1);
    // things that only look at the provider are refused while it is busy (the mock account has 2 connections)
    app.proxy.allow(slowUrl);
    const t = app.proxy.token(slowUrl);
    const st = await get('/api/speedtest?t=' + t);
    assert.equal(st.status, 409);
    assert.match(st.json.error, /nedladdning/i);
    const pr = await get('/api/probe?t=' + t);
    assert.equal(pr.status, 409);
    const pv = await get('/api/stream/movie/1005?profile=p1&caps=h264,aac&pv=1');
    assert.equal(pv.status, 409);
    assert.equal(dl.active(), 1, 'a refused preview leaves the download alone');
    // a real stream takes the connection: the download steps aside, its half file goes, it starts over later
    busy = true;
    const s = await get('/api/stream/movie/1005?profile=p1&caps=h264,aac');
    assert.equal(s.status, 200);
    await until(async () => dl.active() === 0);
    const q = await find('movie-slow1');
    assert.equal(q.status, 'queued');
    assert.equal(q.pct, 0);
    await sleep(1500);
    assert.equal(dl.active(), 0, 'it waits while something plays');
    assert.deepEqual(fs.readdirSync(dlDir()).filter(n => n.includes('slow1')), [], 'the half file is gone');
    busy = false;
    dl.pump();
    const done = await until(async () => { const i = await find('movie-slow1'); return i.status === 'done' && i; }, 40000);
    assert.ok(done.bytes > 1000);
  } finally { slow.close(); dl.remove('movie-slow1'); }
});

test('without the network disk everything falls back to the add-on disk and says so', () => {
  const run = (dir) => JSON.parse(spawnSync(process.execPath, ['-e', "const s=require('../lib/storage');console.log(JSON.stringify({i:s.info(),p:s.pauseDir(),d:s.downloadDir()}))"], { cwd: __dirname, env: { ...process.env, NSK_STORAGE_DIR: dir, DATA_DIR: TMP } }).stdout.toString().trim().split('\n').pop());
  const gone = run(path.join(TMP, 'not-mounted'));
  assert.equal(gone.i.configured, true);
  assert.equal(gone.i.ok, false);
  assert.match(gone.i.err, /monterad/);
  assert.ok(!gone.d.startsWith(TMP + path.sep + 'not-mounted'));
  assert.ok(gone.d.startsWith(TMP));
  const here = run(AIRPORT);
  assert.equal(here.i.ok, true);
  assert.equal(here.d, path.join(AIRPORT, 'norrsken', 'downloads'));
  assert.equal(here.p, path.join(AIRPORT, 'norrsken', 'pause'));
  const none = run('');
  assert.equal(none.i.configured, false);
  assert.equal(none.i.ok, true);
});

test('downloads need the profile: a kids profile neither sees nor deletes what its library does not show; a bad address is 400', async () => {
  const ids = async (p) => new Set((await get('/api/list?type=movie&cat=all&offset=0&limit=500&profile=' + p)).json.items.map(i => i.id));
  const adult = await ids('p1');
  const kidsLib = await ids('p2');
  const hidden = [...adult].find(id => !kidsLib.has(id));
  assert.ok(hidden);
  // an adult profile queues a film the kids library does not have
  const q = await post('/api/downloads?profile=p1', { type: 'movie', id: hidden, title: 'Vuxenfilm' });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.ok((await get('/api/downloads?profile=p1')).json.items.some(x => x.id === 'movie-' + hidden), 'the adult sees it');
  assert.ok(!(await get('/api/downloads?profile=p2')).json.items.some(x => x.id === 'movie-' + hidden), 'the kids profile does not');
  assert.equal((await post('/api/downloads/movie-' + hidden + '/delete?profile=p2', {})).status, 403, 'nor can it delete it');
  assert.equal((await post('/api/downloads/movie-' + hidden + '/delete?profile=p1', {})).status, 200);
  assert.equal((await post('/api/downloads/%E0%A4%A/delete?profile=p1', {})).status, 400);
  assert.equal((await fetch(base + '/dl/%E0%A4%A/x.mp4')).status, 400);
});
