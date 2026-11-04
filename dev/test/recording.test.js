'use strict';
// Match recordings over a whole evening: they survive a restart of the add-on, an interrupted recording plays as
// one from the start, live viewers get an "edge" playlist, and with a Time Capsule the pieces stay local first.
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

test('with a Time Capsule the pieces stay on the local disk while it has room (watching from the start never waits for it)', () => {
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
    NSK_PAUSE_LOCAL_MS: '1', NSK_PAUSE_DIR: '', NSK_STORAGE_DIR: '', TMPDIR: tmp,
  });
  assert.ok(!r.error, r.error);
  assert.ok(r.up >= 5 && r.remote >= 5, 'copied to the Time Capsule: ' + JSON.stringify(r));
  assert.ok(r.local >= r.up, 'and still on the local disk: ' + JSON.stringify(r));
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
