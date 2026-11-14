'use strict';
// Match recordings over a whole evening: they survive a restart of the add-on, an interrupted recording plays as
// one from the start, live viewers get an "edge" playlist, and with a Time Capsule only the newest pieces stay in the buffer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-rec-'));
const clip = path.join(tmp, 'live.ts');
const lib = path.join(__dirname, '..', 'lib');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test.before(() => {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '24',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', clip]);
  assert.equal(r.status, 0, String(r.stderr));
});

/** Run a script in a fresh node (a "restart" of the add-on) and return what it printed as JSON on its last line. */
function run(code, env) {
  const out = execFileSync(process.execPath, ['-e', `
    const http = require('http'); const fs = require('fs'); const path = require('path');
    const tsbuf = require(${JSON.stringify(path.join(lib, 'tsbuf.js'))});
    const serve = () => new Promise(ok => { const s = http.createServer((q, r) => { r.setHeader('Content-Type', 'video/mp2t'); fs.createReadStream(${JSON.stringify(clip)}).pipe(r); }).listen(0, () => ok(s)); });
    const until = async (fn) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };
    (async () => { ${code} })().then(v => { process.stdout.write('\\nRESULT ' + JSON.stringify(v) + '\\n'); process.exit(0); }, e => { process.stdout.write('\\nRESULT ' + JSON.stringify({ error: e.message }) + '\\n'); process.exit(0); });
  `], { env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 90000 });
  const line = out.split('\n').reverse().find(l => l.startsWith('RESULT '));
  return JSON.parse(line.slice(7));
}

test('a match recording survives a restart of the add-on (an update mid-match); a plain pause does not', () => {
  const dir = path.join(tmp, 'rec1');
  const first = run(`
    const srv = await serve();
    const m = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 60, ch: 'Luleå – Frölunda', match: true });
    await until(() => m.done);
    const p = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 60, ch: 'TV10' }); // a pause (ends the match? no: a match is never ended by a pause)
    await until(() => p.done);
    return { match: m.id, pause: p.id, sec: tsbuf.length(m) };
  `, { NSK_PAUSE_DIR: dir });
  assert.ok(first.sec >= 20, JSON.stringify(first));
  // the add-on starts again
  const second = run(`
    const kept = tsbuf.cleanStart();
    const restored = tsbuf.restore(kept);
    const pl = await tsbuf.playlist(restored[0], '/pause');
    return { kept, pauseLeft: fs.existsSync(path.join(${JSON.stringify(dir)}, ${JSON.stringify(first.pause)})), pieces: (pl.match(/#EXTINF/g) || []).length, file: !!tsbuf.file(kept[0], 'p00000.m4s') };
  `, { NSK_PAUSE_DIR: dir });
  assert.deepEqual(second.kept, [first.match], 'the match is kept');
  assert.equal(second.pauseLeft, false, 'the pause is cleaned away');
  assert.ok(second.pieces >= 5, 'its pieces are all there: ' + second.pieces);
  assert.equal(second.file, true);
});

test('an interrupted match plays as one recording from the start (all parts in order), and live viewers start at the end', () => {
  const dir = path.join(tmp, 'rec2');
  const r = run(`
    const srv = await serve();
    const url = 'http://127.0.0.1:' + srv.address().port + '/x.ts';
    const a = tsbuf.start(url, { maxMin: 60, ch: 'match', match: true });
    await until(() => a.done); // the provider dropped it
    const b = tsbuf.start(url, { maxMin: 60, ch: 'match', match: true }); // started again: a second part
    await until(() => b.done);
    const all = await tsbuf.playlistMulti([a, b], '/pause');
    const edge = await tsbuf.playlistMulti([a, b], '/pause', { edge: true });
    const one = await tsbuf.playlist(b, '/pause', { edge: true });
    return { a: a.id, b: b.id, all, edge: edge.split('\\n').slice(0, 4).join('|'), one: one.split('\\n').slice(0, 3).join('|'), len: tsbuf.length(a) + tsbuf.length(b) };
  `, { NSK_PAUSE_DIR: dir });
  assert.ok(!r.error, r.error);
  const lines = r.all.split('\n');
  assert.match(r.all, /#EXT-X-START:TIME-OFFSET=0/, 'from the start');
  assert.equal(lines.filter(l => l === '#EXT-X-DISCONTINUITY').length, 1, 'one break between the two parts');
  assert.deepEqual(lines.filter(l => l.startsWith('#EXT-X-MAP')), ['#EXT-X-MAP:URI="/pause/' + r.a + '/init.mp4"', '#EXT-X-MAP:URI="/pause/' + r.b + '/init.mp4"']);
  const segs = lines.filter(l => l.startsWith('/pause/'));
  assert.ok(segs[0].startsWith('/pause/' + r.a + '/'), 'the first part first');
  assert.ok(segs[segs.length - 1].startsWith('/pause/' + r.b + '/'), 'the second part last');
  const total = lines.filter(l => l.startsWith('#EXTINF')).reduce((n, l) => n + parseFloat(l.slice(8)), 0);
  assert.ok(Math.abs(total - r.len) < 1, 'the whole match: ' + total + ' vs ' + r.len);
  assert.match(r.edge, /#EXT-X-START:TIME-OFFSET=-12/, 'live starts near the end');
  assert.match(r.one, /#EXT-X-START:TIME-OFFSET=-12/);
});

test('with a Time Capsule every piece goes there at once; only the newest few stay in the memory buffer', () => {
  const share = path.join(tmp, 'share');
  fs.mkdirSync(share, { recursive: true });
  const r = run(`
    await require(${JSON.stringify(path.join(lib, 'smb.js'))}).check(true);
    const srv = await serve();
    const s = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 60, ch: 'match', match: true });
    await until(() => s.done);
    await until(() => s.mirror && s.mirror.up.size >= 5);
    await new Promise(r => setTimeout(r, 3500)); // a few more rounds of copying and tidying
    const local = fs.readdirSync(s.dir).filter(n => n.endsWith('.m4s')).length;
    return { up: s.mirror.up.size, local, remote: fs.readdirSync(path.join(${JSON.stringify(share)}, 'Norrsken', 'pause', s.id)).length };
  `, {
    SMBCLIENT_PATH: path.join(__dirname, 'fake-smbclient.js'), FAKE_SMB_ROOT: share, FAKE_SMB_PASS: 'pw', NSK_SMB_SHARE: '//192.168.1.5/Data', NSK_SMB_USER: 'u', NSK_SMB_PASS: 'pw',
    NSK_PAUSE_LOCAL_MS: '1', NSK_PAUSE_DIR: '', NSK_STORAGE_DIR: '', NSK_STAGE_DIR: path.join(tmp, 'stage'), TMPDIR: tmp,
  });
  assert.ok(!r.error, r.error);
  assert.ok(r.up >= 5 && r.remote >= 5, 'copied to the Time Capsule: ' + JSON.stringify(r));
  assert.ok(r.local <= 8, 'only the newest pieces stay in the buffer: ' + JSON.stringify(r));
});

test('a match the provider dropped is not marked finished (the player waits for the next part); a pause that ended is', () => {
  const dir = path.join(tmp, 'rec3');
  const r = run(`
    const srv = await serve();
    const url = 'http://127.0.0.1:' + srv.address().port + '/x.ts';
    const m = tsbuf.start(url, { maxMin: 60, ch: 'match', match: true });
    await until(() => m.done); // the stream ended long before the planned 60 minutes
    const p = tsbuf.start(url, { maxMin: 60, ch: 'TV10' });
    await until(() => p.done);
    return { match: await tsbuf.playlist(m, '/pause'), multi: await tsbuf.playlistMulti([m], '/pause'), pause: await tsbuf.playlist(p, '/pause') };
  `, { NSK_PAUSE_DIR: dir });
  assert.ok(!r.error, r.error);
  assert.doesNotMatch(r.match, /#EXT-X-ENDLIST/, 'the match goes on');
  assert.doesNotMatch(r.multi, /#EXT-X-ENDLIST/);
  assert.match(r.pause, /#EXT-X-ENDLIST/, 'a pause that ended is over');
});

test('a match whose last part the provider dropped is marked finished once its planned end has passed', () => {
  const dir = path.join(tmp, 'rec4');
  const r = run(`
    const srv = await serve();
    const m = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 60, ch: 'match', match: true });
    await until(() => m.done);
    const before = await tsbuf.playlist(m, '/pause');
    m.started = Date.now() - 61 * 60e3; // the match (and its tail) is over by now
    return { before, after: await tsbuf.playlist(m, '/pause'), multi: await tsbuf.playlistMulti([m, m], '/pause') };
  `, { NSK_PAUSE_DIR: dir });
  assert.ok(!r.error, r.error);
  assert.doesNotMatch(r.before, /#EXT-X-ENDLIST/, 'during the match: the player waits for the next part');
  assert.match(r.after, /#EXT-X-ENDLIST/, 'after it: finished');
  assert.match(r.multi, /#EXT-X-ENDLIST/);
});

test('AirPlay of live gets an ordinary sliding live playlist: newest pieces, counted, every part with its own init', () => {
  const tsbuf = require('../lib/tsbuf');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-live-'));
  const part = (id, n, started, extra = {}) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:8', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4"'];
    for (let i = 0; i < n; i++) lines.push('#EXTINF:' + (i % 3 ? '3.840000' : '7.680000') + ',', 'p' + String(i).padStart(5, '0') + '.m4s');
    fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n') + '\n');
    return Object.assign({ id, dir, started, done: false, match: true, maxMin: 170 }, extra);
  };
  const a = part('aaaa1111', 30, Date.now() - 3600e3, { done: true });
  const b = part('bbbb2222', 4, Date.now() - 60e3);
  const pl = tsbuf.livePlaylist([a, b], '/pause', { window: 10 });
  const lines = pl.split('\n');
  const segs = lines.filter(l => l.startsWith('/pause/'));
  assert.equal(segs.length, 10, 'the newest ten pieces');
  assert.ok(!/PLAYLIST-TYPE|EXT-X-START|ENDLIST/.test(pl), 'an ordinary live playlist: no type, no start line, no end while it records');
  assert.match(pl, /#EXT-X-MEDIA-SEQUENCE:24\n/, 'counted from the whole recording (34 pieces, the last 10)');
  assert.match(pl, /#EXT-X-DISCONTINUITY-SEQUENCE:0\n/);
  assert.equal(lines.filter(l => l === '#EXT-X-DISCONTINUITY').length, 1, 'the provider dropped it once: one break');
  assert.ok(pl.indexOf('/pause/aaaa1111/init.mp4') < pl.indexOf('/pause/aaaa1111/p00024.m4s'), 'the first part with its own init');
  assert.ok(pl.indexOf('/pause/bbbb2222/init.mp4') > pl.indexOf('#EXT-X-DISCONTINUITY'), 'after the break the second part with its own init');
  assert.match(pl, /#EXT-X-PROGRAM-DATE-TIME:\d{4}-/);
  assert.match(pl, /#EXT-X-TARGETDURATION:8\n/);
  // further on, the window has left the first part: the break is counted, not shown
  const b2 = part('cccc3333', 12, Date.now() - 60e3);
  const pl2 = tsbuf.livePlaylist([a, b2], '/pause', { window: 10 });
  assert.match(pl2, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
  assert.ok(!/aaaa1111/.test(pl2) && !/^#EXT-X-DISCONTINUITY$/m.test(pl2));
  fs.rmSync(root, { recursive: true, force: true });
});


test('watching live through the server is not a recording: memory only, nothing on the Time Capsule, a sliding list', () => {
  const share = path.join(tmp, 'share-live');
  fs.mkdirSync(share, { recursive: true });
  const r = run(`
    await require(${JSON.stringify(path.join(lib, 'smb.js'))}).check(true);
    const srv = await serve();
    const s = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 360, ch: 'kanal', live: true });
    await until(() => s.done);
    await new Promise(r => setTimeout(r, 3000));
    const remote = fs.existsSync(path.join(${JSON.stringify(share)}, 'Norrsken', 'pause', s.id));
    const text = fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8');
    const pl = await tsbuf.playlist(s, '/pause');
    return { ring: s.ring, mirror: !!s.mirror, remote, event: /PLAYLIST-TYPE:EVENT/.test(text), start: /EXT-X-START/.test(pl) };
  `, {
    SMBCLIENT_PATH: path.join(__dirname, 'fake-smbclient.js'), FAKE_SMB_ROOT: share, FAKE_SMB_PASS: 'pw', NSK_SMB_SHARE: '//192.168.1.5/Data', NSK_SMB_USER: 'u', NSK_SMB_PASS: 'pw',
    NSK_PAUSE_DIR: '', NSK_STORAGE_DIR: '', NSK_STAGE_DIR: path.join(tmp, 'stage-live'), TMPDIR: tmp,
  });
  assert.ok(!r.error, r.error);
  assert.deepEqual(r, { ring: true, mirror: false, remote: false, event: false, start: false });
});

test('AirPlay of live through memory: the sliding list keeps counting its pieces', () => {
  const tsbuf = require('../lib/tsbuf');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-ring-'));
  const dir = path.join(root, 'rrrr1111');
  fs.mkdirSync(dir);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:130', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 130; i < 150; i++) lines.push('#EXTINF:4.000000,', 'p' + String(i).padStart(5, '0') + '.m4s');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n') + '\n');
  const pl = tsbuf.livePlaylist([{ id: 'rrrr1111', dir, started: Date.now() - 600e3, done: false, ring: true, maxMin: 360 }], '/pause');
  assert.match(pl, /#EXT-X-MEDIA-SEQUENCE:130\n/);
  assert.equal(pl.split('\n').filter(l => l.startsWith('/pause/rrrr1111/p')).length, 20);
  assert.ok(!/ENDLIST/.test(pl));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the AirPlay log tells devices apart and counts what each fetched (a TV fetches the recording itself)', () => {
  const airlog = require('../lib/airlog');
  const { EventEmitter } = require('events');
  airlog._reset();
  const hit = (ip, ua, p, status) => { const res = new EventEmitter(); res.statusCode = status; res.getHeader = () => '1000'; airlog.watch({ socket: { remoteAddress: ip }, headers: { 'user-agent': ua } }, res, p); res.emit('finish'); };
  hit('::ffff:192.168.85.30', 'AppleCoreMedia/1.0.0.22A (iPhone; U; CPU OS 18_0 like Mac OS X)', '/pause/abc/index.m3u8', 200);
  hit('192.168.85.40', 'Mozilla/5.0 (Linux; Philips TitanOS) AirPlay', '/pause/abc/live.m3u8', 200);
  hit('192.168.85.40', 'Mozilla/5.0 (Linux; Philips TitanOS) AirPlay', '/pause/abc/p00001.m4s', 200);
  hit('192.168.85.40', 'Mozilla/5.0 (Linux; Philips TitanOS) AirPlay', '/pause/abc/p00002.m4s', 404);
  const s = airlog.summary();
  assert.equal(s.clients.length, 2);
  const tv = s.clients.find(c => c.kind === 'TV');
  assert.deepEqual([tv.ip, tv.lists, tv.pieces, tv.errors, tv.lastErr, tv.playing], ['192.168.85.40', 1, 2, 1, '404 p00002.m4s', true]);
  assert.equal(s.clients.find(c => c.ip === '192.168.85.30').kind, 'iPhone/iPad');
  assert.equal(s.log[0].status, 404);
});

test('a channel that answers 4XX at first is asked again (the provider still counted the old connection), and giving up stops every try', () => {
  const r = run(`
    let hits = 0;
    const srv = await new Promise(ok => { const s = http.createServer((q, res) => { hits++; if (hits <= 2) { res.writeHead(403); return res.end(); } res.setHeader('Content-Type', 'video/mp2t'); fs.createReadStream(${JSON.stringify(clip)}).pipe(res); }).listen(0, () => ok(s)); });
    const p = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/x.ts', { maxMin: 60, ch: 'TV4' });
    await until(() => tsbuf.length(p) > 0 || p.done);
    const okAfter = { hits, tries: p.tries, sec: tsbuf.length(p) };
    tsbuf.stop(p, 'klar');
    // a channel that never answers: the server gives up on it while the recorder waits to ask again
    let dead = 0;
    const srv2 = await new Promise(ok => { const s = http.createServer((q, res) => { dead++; res.writeHead(404); res.end(); }).listen(0, () => ok(s)); });
    const m = tsbuf.start('http://127.0.0.1:' + srv2.address().port + '/y.ts', { maxMin: 60, ch: 'Död kanal', match: true });
    await until(() => m.retrying);
    tsbuf.giveUp(m, 'ingen bild');
    const at = dead;
    await new Promise(r => setTimeout(r, 6000));
    return { okAfter, gaveUpAt: at, deadAfter: dead, done: m.done, session: !!tsbuf.matchSession() };
  `, { NSK_PAUSE_DIR: path.join(tmp, 'retry') });
  assert.ok(r.okAfter.tries >= 1 && r.okAfter.sec > 0, 'it recorded after asking again: ' + JSON.stringify(r));
  assert.equal(r.deadAfter, r.gaveUpAt, 'no new connection after giving up: ' + JSON.stringify(r));
  assert.equal(r.done, true);
  assert.equal(r.session, false, 'the provider connection is free for the next channel');
});
