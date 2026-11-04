'use strict';
// A disk Home Assistant cannot mount (Time Capsule, SMB1): Norrsken talks to it with smbclient. Tested against a
// stand-in smbclient whose "share" is a folder (fake-smbclient.js); the real protocol was tried against Samba
// limited to SMB1 by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-smb-'));
const share = path.join(tmp, 'share');
const log = path.join(tmp, 'calls.log');
fs.mkdirSync(share);
Object.assign(process.env, {
  SMBCLIENT_PATH: path.join(__dirname, 'fake-smbclient.js'), FAKE_SMB_ROOT: share, FAKE_SMB_PASS: 'hemligt ord', FAKE_SMB_LOG: log,
  NSK_SMB_SHARE: 'smb://192.168.1.5/Data', NSK_SMB_USER: 'oskar', NSK_SMB_PASS: 'hemligt ord', NSK_PAUSE_LOCAL_MS: '1', NSK_SMB_DIR: 'Norrsken', NSK_LOCAL_KEEP_FREE_GB: '100000000', // a full local disk: old pieces leave it (local first otherwise)
});
delete process.env.NSK_STORAGE_DIR;
delete process.env.NSK_PAUSE_DIR;
const smb = require('../lib/smb');
const tsbuf = require('../lib/tsbuf');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise(r => setTimeout(r, 200)); } };

// 40 s of live-like TV: a keyframe every second, so every piece is 4 s
function makeClip(file, audio) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', audio, '-b:a', '96k', '-f', 'mpegts', file]);
  assert.equal(r.status, 0, String(r.stderr));
}
function serve(file) {
  const srv = http.createServer((q, r) => { r.setHeader('Content-Type', 'video/mp2t'); fs.createReadStream(file).pipe(r); }).listen(0);
  return srv;
}
const secs = (s) => tsbuf.length(s);
const remoteDir = (s) => path.join(share, 'Norrsken', 'pause', s.id);

test.after(() => { tsbuf.stopAll('test'); fs.rmSync(tmp, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

test('the Time Capsule is found, its folders are made, and a wrong password or a disk that is off say so in plain words', async () => {
  const ok = await smb.check(true);
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(path.join(share, 'Norrsken', 'pause')), true, 'the Norrsken folder is made on the disk');
  assert.ok(ok.free > 0 && ok.total >= ok.free, 'free room is read from the disk');
  assert.equal(smb.info().configured, true);
  assert.equal(smb.normShare('\\\\192.168.1.5\\Data'), '//192.168.1.5/Data');
  assert.equal(smb.normShare('smb://tc.local/Disk/'), '//tc.local/Disk');
  // the password is only given to smbclient through its environment, never on its command line
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.equal(calls.some(c => c.hasPassOnArgv), false);
  process.env.FAKE_SMB_DOWN = '1';
  const down = await smb.exec('ls');
  delete process.env.FAKE_SMB_DOWN;
  assert.equal(down.ok, false);
  assert.match(down.err, /Time Capsule svarar inte/);
  process.env.FAKE_SMB_PASS = 'annat';
  const bad = await smb.exec('ls');
  process.env.FAKE_SMB_PASS = 'hemligt ord';
  assert.equal(bad.ok, false);
  assert.match(bad.err, /Fel användarnamn eller lösenord/);
  assert.equal(JSON.stringify(bad).includes('hemligt'), false, 'the password never ends up in an answer');
  // a name that could smuggle in another command is refused before smbclient sees it
  assert.equal((await smb.put(tmp, ['a"; del "x'], 'Norrsken/pause')).ok, false);
});

for (const audio of ['aac', 'ac3']) {
  test(`pause with ${audio} sound: the whole recording is kept (not 0.2 s), copied to the Time Capsule, old pieces leave the local disk and come back when asked for`, async () => {
    const file = path.join(tmp, 'live-' + audio + '.ts');
    makeClip(file, audio);
    const srv = serve(file);
    let s;
    try {
      s = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/live.ts', { maxMin: 5, ch: 'Test' });
      assert.ok(s.mirror, 'the recording is mirrored to the disk');
      await waitFor(() => s.done, 30000);
      assert.ok(secs(s) >= 36, 'about 40 s recorded, got ' + secs(s)); // ADTS AAC used to stop it after 0.2 s
      await waitFor(() => fs.existsSync(remoteDir(s)) && fs.readdirSync(remoteDir(s)).filter(n => n.endsWith('.m4s')).length >= 10, 30000);
      await waitFor(() => s.mirror.up.size >= 10, 30000);
      const names = [...s.mirror.up].sort();
      // only the newest pieces stay on the local disk
      await waitFor(() => fs.readdirSync(s.dir).filter(n => n.endsWith('.m4s')).length <= 9, 30000);
      const local = fs.readdirSync(s.dir).filter(n => n.endsWith('.m4s'));
      assert.ok(local.length <= 9 && !local.includes(names[0]), 'the first piece is only on the disk now');
      const f = await tsbuf.fileReady(s.id, names[0]);
      assert.ok(f && fs.existsSync(f), 'asked for again, it is fetched back');
      assert.equal(fs.statSync(f).size, fs.statSync(path.join(remoteDir(s), names[0])).size);
      assert.equal(await tsbuf.fileReady(s.id, 'p99999.m4s'), null);
      const pl = await tsbuf.playlist(s, '/pause');
      assert.equal(pl.split('\n').filter(l => l.startsWith('/pause/')).length >= 10, true);
      // ending the recording removes it from the disk too
      tsbuf.stop(s, 'test');
      await waitFor(() => !fs.existsSync(remoteDir(s)), 15000);
      assert.equal(fs.existsSync(remoteDir(s)), false);
    } finally { srv.close(); if (s) tsbuf.stop(s, 'test'); }
  });
}

test('when the Time Capsule drops out the recording goes on locally and is copied when it is back', async () => {
  const file = path.join(tmp, 'live-aac.ts');
  const srv = serve(file);
  let s;
  try {
    process.env.FAKE_SMB_DOWN = '1';
    s = tsbuf.start('http://127.0.0.1:' + srv.address().port + '/live.ts', { maxMin: 5, ch: 'Test' });
    await waitFor(() => s.done, 30000);
    await waitFor(() => s.mirror.err, 15000);
    assert.match(s.mirror.err, /Time Capsule svarar inte/);
    assert.equal(s.mirror.up.size, 0);
    assert.ok(fs.readdirSync(s.dir).filter(n => n.endsWith('.m4s')).length >= 10, 'nothing is lost locally');
    delete process.env.FAKE_SMB_DOWN;
    await waitFor(() => s.mirror.up.size >= 10, 30000);
    assert.equal(s.mirror.err, '');
  } finally { delete process.env.FAKE_SMB_DOWN; srv.close(); if (s) tsbuf.stop(s, 'test'); }
});

test('a Time Capsule that only takes the old login (NTLMv1) is reached anyway, and a wrong password still says so', () => {
  const run = (env) => require('child_process').execFileSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'smb.js'))}).check(true).then(r => { process.stdout.write(JSON.stringify(r)); });
  `], { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  const ok = JSON.parse(run({ FAKE_SMB_LEGACY_ONLY: '1' }).split('\n').pop());
  assert.equal(ok.ok, true, 'falls back to NTLMv1 and connects');
  const bad = JSON.parse(run({ FAKE_SMB_LEGACY_ONLY: '1', NSK_SMB_PASS: 'fel' }).split('\n').pop());
  assert.equal(bad.ok, false);
  assert.match(bad.err, /Fel användarnamn eller lösenord/);
});

test('a Time Capsule folder setting of "." or ".." never leaves the Norrsken folder', async () => {
  assert.equal((await smb.ensure('../x')).ok, false);
  assert.equal((await smb.ensure('Norrsken/../../x')).ok, false);
  assert.equal((await smb.put(tmp, ['..'], 'Norrsken/pause')).ok, false);
  assert.equal((await smb.rmdirAll('..')).ok, false);
});

test('tidying the Time Capsule asks per folder at the moment of deleting (a recording started since is kept)', async () => {
  const base = path.join(share, 'Norrsken', 'pause');
  for (const n of ['gammal1', 'ny2']) { fs.mkdirSync(path.join(base, n), { recursive: true }); fs.writeFileSync(path.join(base, n, 'p00000.m4s'), 'x'); }
  const asked = [];
  const r = await smb.cleanSubdirs('Norrsken/pause', (n) => { asked.push(n); return n === 'ny2'; });
  assert.equal(r.ok, true);
  assert.ok(asked.includes('gammal1') && asked.includes('ny2'));
  assert.equal(fs.existsSync(path.join(base, 'gammal1')), false, 'left over from before: removed');
  assert.equal(fs.existsSync(path.join(base, 'ny2')), true, 'started since: kept');
});
