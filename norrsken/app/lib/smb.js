'use strict';
/**
 * A network disk Home Assistant cannot mount: an Apple Time Capsule / AirPort Extreme only speaks the old SMB1
 * protocol, which Home Assistant's "Add network storage" and today's Linux kernels refuse. Norrsken then talks to
 * the disk itself with smbclient (Samba's client, which can still do SMB1) and keeps the pause buffer and match
 * recordings there: ffmpeg writes to a small local folder, finished pieces are copied to the disk and the local
 * copy of old ones is removed; a piece that is asked for again is fetched back.
 *
 * Settings (add-on options → env): NSK_SMB_SHARE "//192.168.1.5/Data", NSK_SMB_USER, NSK_SMB_PASS, NSK_SMB_DIR
 * (folder on the share, default "Norrsken"). The password goes to smbclient through its environment, never on
 * the command line, and is never logged.
 */
const { execFile } = require('child_process');

const BIN = process.env.SMBCLIENT_PATH || 'smbclient';
const USER = String(process.env.NSK_SMB_USER || '').trim();
const PASS = String(process.env.NSK_SMB_PASS || '');
const PORT = String(process.env.NSK_SMB_PORT || '').trim(); // for tests; a real disk uses the standard port
const DIR = (() => { const d = String(process.env.NSK_SMB_DIR || 'Norrsken').replace(/[^\w.-]+/g, ''); return !d || /^\.+$/.test(d) ? 'Norrsken' : d; })();

/** "//host/share", "\\\\host\\share", "smb://host/share" or "host/share" → "//host/share" */
function normShare(s) {
  s = String(s || '').trim().replace(/\\/g, '/').replace(/^smb:\/\//i, '').replace(/^\/+/, '');
  const m = /^([^/\s]+)\/([^/\s]+)/.exec(s);
  return m ? '//' + m[1] + '/' + m[2] : '';
}
const SHARE = normShare(process.env.NSK_SMB_SHARE);

const enabled = () => !!SHARE;
// names and folders: letters, digits, _ . -, never "." or ".." (that would leave the Norrsken folder)
const SAFE_NAME = /^(?!\.{1,2}$)[\w.-]+$/;
const SAFE_PATH = /^(?!\.{1,2}(\/|$))[\w.-]+(\/(?!\.{1,2}(\/|$))[\w.-]+)*$/;

const STATUS = [
  [/LOGON_FAILURE|ACCESS_DENIED|WRONG_PASSWORD|ACCOUNT_/i, 'Fel användarnamn eller lösenord till Time Capsule'],
  [/BAD_NETWORK_NAME/i, 'Delningen finns inte på disken (kontrollera namnet i smb_share)'],
  [/CONNECTION_REFUSED|UNREACHABLE|HOST_UNREACHABLE|IO_TIMEOUT|CONNECTION_DISCONNECTED|Connection to .* failed/i, 'Time Capsule svarar inte (är den på och på samma nät?)'],
  [/PROTOCOL|NEGOTIATE|NOT_SUPPORTED/i, 'Disken godtar inte anslutningen (protokollet)'],
  [/DISK_FULL|QUOTA/i, 'Disken är full'],
  [/NO_SUCH_FILE|NOT_FOUND|OBJECT_NAME_NOT_FOUND|PATH_NOT_FOUND/i, 'Filen finns inte på disken'],
];
/** Short Swedish reason; never anything that could carry the account (smbclient does not print the password). */
function friendly(out) {
  const t = String(out || '');
  for (const [re, msg] of STATUS) if (re.test(t)) return msg;
  const m = /NT_STATUS_[A-Z_]+/.exec(t);
  if (m) return 'Time Capsule svarade ' + m[0];
  // only fixed words leave: what kind of trouble, never a line from smbclient (it may name the disk, the share, a user)
  const why = [[/timed? ?out|IO_TIMEOUT/i, 'tidsgräns'], [/refused/i, 'anslutningen nekades'], [/reset|closed|EOF|broken pipe/i, 'anslutningen bröts'],
    [/unreachable|no route|host is down|not known|resolve/i, 'nås inte på nätet'], [/ETIMEDOUT/i, 'tidsgräns']].find(([re]) => re.test(t));
  return 'Kunde inte prata med Time Capsule' + (why ? ' (' + why[1] + ')' : '');
}

/*
 * A Time Capsule only takes the old NTLM login (v1) without SPNEGO; today's Samba sends NTLMv2 by default and the
 * disk answers "wrong password" even when it is right. So: try the modern login first, and when the disk says
 * LOGON_FAILURE, try the old one once; whichever works is kept.
 */
let legacy = process.env.NSK_SMB_LEGACY === '1';
let legacyTried = legacy;
const LEGACY = ['--option=client ntlmv2 auth=no', '--option=client use spnego=no', '--option=client lanman auth=no'];
function baseArgs(old) {
  const a = [SHARE];
  // a disk password (no accounts): the Time Capsule takes any user name, but a password has to be sent
  if (USER) a.push('-U', USER); else if (PASS) a.push('-U', 'Apple'); else a.push('-N');
  if (PORT) a.push('-p', PORT);
  a.push('--option=client min protocol=NT1', '--option=client max protocol=SMB3');
  if (old) a.push(...LEGACY);
  return a;
}

/**
 * Run smbclient commands ("cd x; put a b"). Resolves { ok, out, err }. `ignore` is a regex of statuses that are fine
 * (mkdir of a folder that exists). cwd is the local folder for put/get.
 */
async function exec(cmd, opts = {}) {
  const r = await run(cmd, opts, legacy);
  if (!r.ok && !legacyTried && /Fel användarnamn eller lösenord/.test(r.err)) {
    legacyTried = true;
    const r2 = await run(cmd, opts, true);
    if (r2.ok || !/Fel användarnamn eller lösenord/.test(r2.err)) {
      legacy = true;
      console.log('[time capsule] disken vill ha den äldre inloggningen (NTLMv1) – använder den');
      return r2;
    }
  }
  return r;
}
/*
 * The Time Capsule takes only a few logins at a time and answers the rest with a closed connection: one copy, one
 * check and one fetch at once is the most it is given (each smbclient is its own login).
 */
const MAX_AT_ONCE = 2;
let running = 0;
const waiting = [];
function run(cmd, opts, old) {
  return new Promise((resolve) => {
    const go = () => {
      running++;
      Promise.resolve().then(() => run1(cmd, opts, old))
        .catch(() => ({ ok: false, out: '', err: 'Kunde inte prata med Time Capsule' }))
        .then((r) => { running--; if (waiting.length) waiting.shift()(); resolve(r); });
    };
    if (running < MAX_AT_ONCE) go(); else waiting.push(go);
  });
}
function run1(cmd, { cwd, timeout = 120000, ignore } = {}, old) {
  return new Promise((resolve) => {
    if (!SHARE) return resolve({ ok: false, out: '', err: 'Ingen Time Capsule inställd' });
    const env = Object.assign({}, process.env);
    if (PASS) env.PASSWD = PASS; else delete env.PASSWD;
    const child = execFile(BIN, baseArgs(old).concat(['-c', cmd]), { cwd, env, timeout, maxBuffer: 4e6, encoding: 'utf8' }, (e, stdout, stderr) => {
      const out = String(stdout || '') + '\n' + String(stderr || '');
      let bad = out.split('\n').filter(l => /NT_STATUS_|^do_connect|failed|ERRSRV|ERRDOS/i.test(l));
      if (ignore) bad = bad.filter(l => !ignore.test(l));
      if (e && !bad.length && e.killed) bad = ['IO_TIMEOUT'];
      else if (e && !bad.length && e.code === 'ENOENT') return resolve({ ok: false, out, err: 'smbclient saknas i tillägget' });
      else if (e && !bad.length && e.code && !ignore) bad = [String(e.code)];
      if (bad.length) return resolve({ ok: false, out, err: friendly(bad.join('\n')) });
      resolve({ ok: true, out, err: '' });
    });
    child.on('error', () => { /* handled in the callback */ });
  });
}

const EXISTS = /NAME_COLLISION|OBJECT_NAME_EXISTS|already exists/i;

/** Create a folder and the ones above it ("Norrsken/pause/abc"). */
function ensure(rel) {
  if (!SAFE_PATH.test(rel)) return Promise.resolve({ ok: false, err: 'Ogiltig mapp' });
  const parts = rel.split('/');
  const cmd = parts.map((p, i) => 'mkdir "' + parts.slice(0, i + 1).join('/') + '"').join('; ');
  return exec(cmd, { ignore: EXISTS });
}

/** Copy local files (names in `cwd`) into the remote folder `dir`. */
function put(cwd, names, dir) {
  if (!SAFE_PATH.test(dir) || !names.length || !names.every(n => SAFE_NAME.test(n))) return Promise.resolve({ ok: false, err: 'Ogiltigt namn' });
  const cmd = 'cd "' + dir + '"; ' + names.map(n => 'put "' + n + '" "' + n + '"').join('; ');
  return exec(cmd, { cwd, timeout: 3 * 60e3 });
}

/** Fetch one file into `cwd` under the same name. */
function get(cwd, dir, name) {
  if (!SAFE_PATH.test(dir) || !SAFE_NAME.test(name)) return Promise.resolve({ ok: false, err: 'Ogiltigt namn' });
  return exec('cd "' + dir + '"; get "' + name + '" "' + name + '.fetch"', { cwd, timeout: 3 * 60e3 }).then((r) => {
    if (!r.ok) return r;
    try { require('fs').renameSync(require('path').join(cwd, name + '.fetch'), require('path').join(cwd, name)); } catch (e) { return { ok: false, err: e.message }; }
    return r;
  });
}

/** Remove a remote folder and what is in it (one level: the files, then the folder). */
function rmdirAll(dir) {
  if (!SAFE_PATH.test(dir)) return Promise.resolve({ ok: false, err: 'Ogiltig mapp' });
  return exec('del "' + dir + '/*"; rmdir "' + dir + '"', { ignore: /NO_SUCH_FILE|NOT_FOUND|OBJECT_NAME_NOT_FOUND|PATH_NOT_FOUND|NO_SUCH_FILE/i });
}

/** Fetch several files of one folder into `cwd` in one go (one login: the Time Capsule is slow to log in). */
function getMany(cwd, dir, names) {
  if (!SAFE_PATH.test(dir) || !names.length || !names.every(n => SAFE_NAME.test(n))) return Promise.resolve({ ok: false, err: 'Ogiltigt namn' });
  const fsm = require('fs');
  const pth = require('path');
  return exec('cd "' + dir + '"; ' + names.map(n => 'get "' + n + '" "' + n + '.fetch"').join('; '), { cwd, timeout: 3 * 60e3 }).then((r) => {
    let all = true;
    for (const n of names) {
      try { fsm.renameSync(pth.join(cwd, n + '.fetch'), pth.join(cwd, n)); } catch (_) { all = false; }
    }
    return all ? { ok: true, out: r.out, err: '' } : { ok: false, out: r.out, err: r.err || 'Alla delar kom inte' };
  });
}

/** The file names in a remote folder. */
async function listFiles(dir) {
  if (!SAFE_PATH.test(dir)) return [];
  const l = await exec('ls "' + dir + '/*"');
  if (!l.ok) return [];
  const names = [];
  for (const line of l.out.split('\n')) { const m = /^\s+([\w.-]+)\s+[AHSRN]*\s+\d+\s/.exec(line); if (m && m[1] !== '.' && m[1] !== '..') names.push(m[1]); }
  return names;
}

/** Remove every sub-folder of `dir` (what an earlier run left behind), except those in `keep`. */
async function cleanSubdirs(dir, keep) {
  if (!SAFE_PATH.test(dir)) return { ok: false, err: 'Ogiltig mapp' };
  const l = await exec('ls "' + dir + '/*"');
  if (!l.ok) return l;
  const names = [];
  for (const line of l.out.split('\n')) { const m = /^\s+([\w.-]+)\s+D\s+0\s/.exec(line); if (m && m[1] !== '.' && m[1] !== '..' && !(keep && (typeof keep === 'function' ? keep(m[1]) : keep.has(m[1])))) names.push(m[1]); }
  if (!names.length) return { ok: true, out: '', err: '' };
  return exec(names.map(n => 'del "' + dir + '/' + n + '/*"; rmdir "' + dir + '/' + n + '"').join('; '), { ignore: /NO_SUCH_FILE|NOT_FOUND/i });
}

/** Free and total bytes from the "N blocks of size S. M blocks available" line of a listing. */
function parseDf(out) {
  const m = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(out || '');
  return m ? { total: +m[1] * +m[2], free: +m[3] * +m[2] } : null;
}

let st = { ok: false, err: '', at: 0, free: 0, total: 0 };
let checking = null;
/** Is the disk there, and how much room is left? Cached for a minute; the folder is made on the way. */
function check(force) {
  if (!SHARE) return Promise.resolve(st);
  if (!force && Date.now() - st.at < 60e3) return Promise.resolve(st);
  if (checking) return checking;
  checking = (async () => {
    const r = await ensure(DIR + '/pause');
    let next = { ok: false, err: r.err, at: Date.now(), free: 0, total: 0 };
    if (r.ok) {
      const l = await exec('ls "' + DIR + '"');
      const df = parseDf(l.out);
      next = l.ok ? { ok: true, err: '', at: Date.now(), free: df ? df.free : 0, total: df ? df.total : 0 } : { ok: false, err: l.err, at: Date.now(), free: 0, total: 0 };
    }
    if (next.ok !== st.ok || next.err !== st.err) console.log(next.ok ? '[time capsule] ansluten (' + SHARE + '/' + DIR + ')' : '[time capsule] fungerar inte: ' + next.err);
    st = next;
    checking = null;
    return st;
  })();
  return checking;
}

/** What the status page shows (the last check; never waits). */
function info() {
  if (!SHARE) return { configured: false, ok: false, err: '', freeGb: 0, totalGb: 0, share: '' };
  check().catch(() => {});
  return { configured: true, ok: st.ok, err: st.err, freeGb: Math.round(st.free / 1e8) / 10, totalGb: Math.round(st.total / 1e8) / 10, share: SHARE + '/' + DIR };
}

module.exports = { enabled, exec, ensure, put, get, getMany, listFiles, rmdirAll, cleanSubdirs, check, info, parseDf, friendly, normShare, dir: DIR, free: () => st.free };
