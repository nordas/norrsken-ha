'use strict';
/**
 * Pause for live TV on channels without an archive: from the moment you pause, the server records the channel
 * to disk (the stream as it is, nothing converted). Resuming plays the recording, which keeps growing, so you
 * carry on exactly where you were, behind live; "Gå till live" ends it.
 *
 * One recording at a time: the player stops its own stream first, so the provider only ever sees one connection.
 * A recording is removed when the player says stop, when nobody has asked about it for a while, or on restart.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_UA } = require('./util');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const storage = require('./storage');
const smb = require('./smb');
// the storage disk (the AirPort's, when set up) or the add-on's own; looked up each time since the share may come and go
const rootDir = () => process.env.NSK_PAUSE_DIR || storage.pauseDir();
// A Time Capsule Home Assistant cannot mount (SMB1): pieces are copied there as they are finished, see mirrorTick
const mirrorOn = () => smb.enabled() && !process.env.NSK_PAUSE_DIR && !storage.mounted();
const KEEP_LOCAL = 8; // the newest pieces always stay on the local disk
const LOCAL_FOR_MS = +process.env.NSK_PAUSE_LOCAL_MS || 60e3; // and a piece that was copied stays at least this long
// Local first: the pieces stay on the add-on's disk as long as it has room (watching from the start, live and AirPlay
// then never wait for the Time Capsule); the copies on the Time Capsule are what is left when the disk runs low.
const LOCAL_KEEP_FREE = (+process.env.NSK_LOCAL_KEEP_FREE_GB || 4) * 1e9;
const KEEP_MATCH_DIR_MS = 24 * 3600e3;
const IDLE_MS = 3 * 60e3; // the player checks in every 30 s, also while paused
const MIN_FREE = 1.5e9; // leave room on the disk: Home Assistant needs it more than we do
const sessions = new Map();

/** Whatever an earlier run left behind (called when the server starts, not when the module is loaded). */
function cleanStart() {
  // a match recording survives a restart (an update in the middle of the match must not lose its start); pauses do not
  const keep = new Set();
  const root = rootDir();
  try {
    for (const id of fs.readdirSync(root)) {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8')); } catch (_) { /* a pause or junk */ }
      if (meta && meta.match && Date.now() - meta.started < KEEP_MATCH_DIR_MS && /^[a-z0-9]{4,12}$/.test(id)) { keep.add(id); continue; }
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
    }
  } catch (_) { /* nothing there */ }
  if (mirrorOn()) smb.check(true).then((r) => { if (r.ok) return smb.cleanSubdirs(smb.dir + '/pause', keep); }).catch(() => {});
  return [...keep];
}

/** Bring back the match recordings cleanStart kept: finished (nothing records into them now), playable, 24 h. */
function restore(ids) {
  const out = [];
  for (const id of ids || []) {
    const dir = path.join(rootDir(), id);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) { continue; }
    const s = { id, url: '', dir, ch: meta.ch || '', proc: null, started: meta.started, last: Date.now(), dead: false, done: true, err: '', maxMin: meta.maxMin || 0, full: false, match: true, restored: true };
    // ffmpeg stopped in the middle: the playlist has no end mark yet, the pieces it lists are whole
    if (mirrorOn()) {
      s.mirror = { dir: smb.dir + '/pause/' + id, ready: true, up: new Set(), busy: false, err: '', fetching: new Map(), bytes: 0 };
      smb.listFiles(s.mirror.dir).then((names) => { for (const n of names) if (/^p\d{5}\.m4s$/.test(n)) s.mirror.up.add(n); }).catch(() => {});
      s.mirrorT = setInterval(() => mirrorTick(s), 5000);
      if (s.mirrorT.unref) s.mirrorT.unref();
    }
    sessions.set(id, s);
    out.push(s);
  }
  if (out.length) console.log('[match]', out.length, 'matchinspelning(ar) finns kvar efter omstarten');
  return out;
}
cleanStart.done = false;

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (_) { return Infinity; }
}

function dirBytes(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { try { n += fs.statSync(path.join(dir, f)).size; } catch (_) { /* gone */ } } } catch (_) { /* gone */ }
  return n;
}

/** ffmpeg names its input link in its errors, and the link carries the account: never pass it on (log or answer). */
// to the end of the link, also when the password has a space or ": " in it: through the last "@" of the line, then
// up to ": Reason" or the end of the line
const hideLinks = (t) => String(t || '').split('\n').map((line) => {
  const m = /[a-z][a-z0-9+.-]*:\/\//i.exec(line);
  if (!m) return line;
  const at = line.lastIndexOf('@');
  const from = at > m.index ? at : m.index + m[0].length;
  const rest = line.slice(from);
  const cut = /: [A-Za-z]/.exec(rest);
  const tail = cut ? rest.slice(cut.index) : (/\.$/.test(rest.trimEnd()) ? '.' : '');
  return line.slice(0, m.index) + '<länk>' + tail;
}).join('\n');
function stop(s, why) {
  if (!s || s.dead) return;
  s.dead = true;
  sessions.delete(s.id);
  try { if (s.proc) s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  if (s.mirrorT) clearInterval(s.mirrorT);
  if (s.mirror) smb.rmdirAll(s.mirror.dir).catch(() => {});
  const mb = Math.round(dirBytes(s.dir) / 1e6);
  console.log('[paus] inspelningen slutar (' + (why || 'stopp') + '),', Math.round((Date.now() - s.started) / 60e3) + ' min,', mb + ' MB');
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 1500);
}

function stopAll(why) { for (const s of [...sessions.values()]) stop(s, why); }
/** The pause recordings only: a finished match recording stays (it is kept a day). */
function stopPauses(why) { let n = 0; for (const s of [...sessions.values()]) if (!s.match) { stop(s, why); n++; } return n; }

/** The match recording that is still running, if any (it keeps the provider connection). */
function matchSession() {
  for (const s of sessions.values()) if (s.match && !s.dead && !s.done) return s;
  return null;
}

/**
 * Start recording `url` (a live channel). maxMin caps the length (and the disk use).
 * match: a match recording (keeps 24 h, not stopped when nobody asks). It takes over from a pause, but a pause
 * never takes over from a match recording.
 */
function start(url, { ua, maxMin = 60, ch = '', match = false } = {}) {
  if (match) { for (const s of [...sessions.values()]) if (!s.match) stop(s, 'matchinspelning'); }
  else {
    if (matchSession()) throw new Error('Matchinspelningen pågår på en annan kanal');
    stopPauses('ny paus'); // one connection: a new pause ends the previous one (a finished match recording stays)
  }
  const ROOT = rootDir();
  fs.mkdirSync(ROOT, { recursive: true });
  const useMirror = mirrorOn() && smb.info().ok;
  if (mirrorOn() && !useMirror) { smb.check(true).catch(() => {}); console.log('[paus] Time Capsule svarar inte – spelar in på tilläggets egen disk'); }
  const free = freeBytes(ROOT);
  if (free < (useMirror ? MIN_FREE * 0.4 : MIN_FREE)) throw new Error('För lite ledigt diskutrymme för att spela in pausen');
  if (useMirror && smb.free() && smb.free() < MIN_FREE) throw new Error('För lite ledigt utrymme på Time Capsule');
  const id = Math.random().toString(36).slice(2, 10);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = { id, url, dir, ch, proc: null, started: Date.now(), last: Date.now(), dead: false, done: false, err: '', maxMin, full: false, match: !!match };
  try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ch, match: !!match, started: s.started, maxMin })); } catch (_) { /* the recording works without it */ }
  if (useMirror) s.mirror = { dir: smb.dir + '/pause/' + id, ready: false, up: new Set(), busy: false, err: '', fetching: new Map(), bytes: 0 };
  const hls = /\.m3u8?(\?|$)/i.test(url);
  /*
   * AAC in a transport stream is ADTS, and ffmpeg's HLS muxer stops at the first piece ("Malformed AAC bitstream")
   * unless it is told to convert it. That filter refuses other audio (AC-3…), so: try it first, and when ffmpeg says
   * it cannot use the filter, start again without it (it fails at once, before anything is recorded).
   */
  const launch = (bsf) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-user_agent', ua || DEFAULT_UA, '-rw_timeout', '20000000'];
    if (!hls) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    args.push('-fflags', '+genpts+discardcorrupt', '-i', url,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy');
    if (bsf) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-t', String(Math.max(1, maxMin) * 60),
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      // fragmented MP4 like the converter: every codec a provider sends (H.264, HEVC, AAC, AC-3…) fits as it is
      '-hls_flags', 'independent_segments+temp_file', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'p%05d.m4s'), path.join(dir, 'index.m3u8'));
    const proc = s.proc = spawn(FF, args);
    proc.stderr.on('data', d => { if (s.err.length < 3000) s.err += d; });
    proc.on('error', (e) => { s.err += e.message; s.done = true; });
    proc.on('close', (code) => {
      if (s.dead) { s.done = true; return; }
      if (bsf && code && /bitstream filter/i.test(s.err) && Date.now() - s.started < 20000) { s.err = ''; launch(false); return; }
      s.done = true;
      if (Date.now() - s.started >= maxMin * 60e3 - 5000) { s.full = true; console.log('[paus] inspelningen nådde maxlängden', maxMin, 'min'); }
      else if (code) console.error('[paus] ffmpeg fel', code, hideLinks(s.err.split('\n').filter(Boolean).slice(-2).join(' ')));
    });
  };
  launch(true);
  if (s.mirror) { s.mirrorT = setInterval(() => mirrorTick(s), 2500); if (s.mirrorT.unref) s.mirrorT.unref(); }
  // keep an eye on the disk while recording
  s.diskT = setInterval(() => {
    if (s.dead) return clearInterval(s.diskT);
    if (s.mirror) smb.check().catch(() => {});
    if (freeBytes(path.dirname(s.dir)) < (s.mirror ? MIN_FREE * 0.25 : MIN_FREE * 0.6) || (s.mirror && smb.free() && smb.free() < MIN_FREE * 0.6)) { console.log('[paus] disken börjar bli full: inspelningen stannar här'); try { s.proc.kill('SIGINT'); } catch (_) { /* gone */ } s.full = true; clearInterval(s.diskT); }
  }, 15000);
  if (s.diskT.unref) s.diskT.unref();
  sessions.set(id, s);
  console.log(match ? '[match] spelar in' : '[paus] spelar in', ch || 'kanalen', 'från nu (högst', maxMin, 'min)');
  return s;
}

/** What the channel sends (read from the first local piece, no provider connection): for AirPlay and other questions. */
function logFormat(s) {
  const FP = process.env.FFPROBE_PATH || 'ffprobe';
  const f = path.join(s.dir, 'index.m3u8');
  const p = spawn(FP, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,level,width,height,avg_frame_rate,channels,pix_fmt,field_order', '-of', 'json', f]);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => {});
  p.on('close', () => {
    try {
      const st = JSON.parse(out).streams || [];
      const v = st.find(x => x.codec_type === 'video');
      const a = st.find(x => x.codec_type === 'audio');
      const fr = v && /^(\d+)\/(\d+)$/.exec(v.avg_frame_rate || '');
      const fps = fr && +fr[2] ? Math.round(+fr[1] / +fr[2]) : 0; // "50/1"
      console.log('[paus] format:', v ? v.codec_name + ' ' + (v.profile || '') + ' ' + (v.level ? 'L' + v.level : '') + ' ' + v.width + 'x' + v.height + ' ' + fps + 'fps ' + (v.pix_fmt || '') + (v.field_order && v.field_order !== 'progressive' && v.field_order !== 'unknown' ? ' SPRÅNGVIS (' + v.field_order + ')' : '') : 'ingen bild', '·', a ? a.codec_name + ' ' + (a.profile || '') + ' ' + (a.channels || '') + 'ch' : 'inget ljud');
    } catch (_) { /* not readable */ }
  });
}

/** Copy finished pieces to the Time Capsule, and free the local disk of the old ones. */
async function mirrorTick(s) {
  const m = s.mirror;
  if (!m || m.busy || s.dead) return;
  m.busy = true;
  try {
    if (!m.ready) { const r = await smb.ensure(m.dir); if (!r.ok) throw new Error(r.err); m.ready = true; }
    // ffmpeg writes a piece under a temporary name and renames it when it is whole, so every p*.m4s is complete
    const segs = fs.readdirSync(s.dir).filter(n => /^p\d{5}\.m4s$/.test(n)).sort();
    const todo = segs.filter(n => !m.up.has(n)).slice(0, 6);
    if (todo.length) {
      const r = await smb.put(s.dir, todo, m.dir);
      if (!r.ok) throw new Error(r.err);
      for (const n of todo) { m.up.add(n); try { m.bytes += fs.statSync(path.join(s.dir, n)).size; } catch (_) { /* gone */ } }
    }
    // only when the local disk runs low: the oldest pieces that are safe on the Time Capsule leave it first
    const now = Date.now();
    if (freeBytes(s.dir) < LOCAL_KEEP_FREE) {
      let freed = 0;
      for (const n of segs.slice(0, Math.max(0, segs.length - KEEP_LOCAL))) {
        if (freeBytes(s.dir) >= LOCAL_KEEP_FREE) break;
        const f = path.join(s.dir, n);
        try { if (m.up.has(n) && now - fs.statSync(f).mtimeMs > LOCAL_FOR_MS) { fs.rmSync(f, { force: true }); freed++; } } catch (_) { /* gone */ }
      }
      if (freed && !m.lowLogged) { m.lowLogged = true; console.log('[paus] lite plats på tilläggets disk: äldre delar finns nu bara på Time Capsule'); }
    }
    if (m.err) console.log('[paus] Time Capsule är tillbaka');
    m.err = '';
  } catch (e) {
    if (e.message !== m.err) console.error('[paus] kunde inte kopiera till Time Capsule:', e.message, '(sparar lokalt tills vidare)');
    m.err = e.message;
  } finally { m.busy = false; }
}

/** A piece to play: on the local disk, or fetched back from the Time Capsule (with the next few in the same go). */
async function fileReady(id, name) {
  const f = file(id, name);
  if (!f) return null;
  if (fs.existsSync(f)) return f;
  const s = get(id);
  const m = s && s.mirror;
  if (!m || !m.up.has(name)) return null;
  const num = /^p(\d{5})\.m4s$/.exec(name);
  const want = [name];
  if (num) for (let k = 1; k <= 3; k++) { const nx = 'p' + String(+num[1] + k).padStart(5, '0') + '.m4s'; if (m.up.has(nx) && !fs.existsSync(path.join(s.dir, nx)) && !m.fetching.has(nx)) want.push(nx); }
  let p = m.fetching.get(name);
  if (!p) {
    p = (async () => {
      let r = await smb.getMany(s.dir, m.dir, want);
      if (!r.ok && !fs.existsSync(f)) r = await smb.getMany(s.dir, m.dir, [name]); // once more, the piece itself
      return r;
    })().finally(() => { for (const n of want) m.fetching.delete(n); });
    for (const n of want) m.fetching.set(n, p);
  }
  await p;
  return fs.existsSync(f) ? f : null;
}

function get(id) {
  const s = sessions.get(String(id || ''));
  if (s) s.last = Date.now();
  return s || null;
}

/** The recording as an HLS playlist, waiting for its first piece. Segment URIs point at prefix/<id>/. */
async function playlist(s, prefix, { wait = 30000, edge = false } = {}) {
  const f = path.join(s.dir, 'index.m3u8');
  const t0 = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { /* not yet */ }
    if (/#EXTINF/.test(text)) {
      if (!s.fmtLogged) { s.fmtLogged = true; logFormat(s); }
      // play from the start of the recording (where you paused), not from its end
      // live (edge): a little before its end, so a TV or Safari never starts by reading the oldest pieces
      if (text.indexOf('#EXT-X-START') < 0) text = text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=' + (edge ? '-12' : '0') + ',PRECISE=YES');
      // finished (time limit or disk): mark the end so the player doesn't wait for more
      if (s.done && text.indexOf('#EXT-X-ENDLIST') < 0) text = text.trimEnd() + '\n#EXT-X-ENDLIST\n';
      return text.split('\n').map((l) => {
        if (l.startsWith('#EXT-X-MAP:URI="')) return l.replace(/URI="([^"]+)"/, (m, u) => 'URI="' + prefix + '/' + s.id + '/' + path.basename(u) + '"');
        return l && l[0] !== '#' ? prefix + '/' + s.id + '/' + path.basename(l.trim()) : l;
      }).join('\n');
    }
    if (s.done || s.dead) throw new Error(hideLinks(s.err.split('\n').filter(Boolean).slice(-1)[0]) || 'Inspelningen kom inte igång');
    if (Date.now() - t0 > wait) throw new Error('Inspelningen kom inte igång');
    await new Promise(ok => setTimeout(ok, 300));
  }
}

/**
 * A match recording that was interrupted (the provider dropped it, the add-on restarted) is several recordings: one
 * playlist of all of them in order, so "from the start" really is the start of the match.
 */
async function playlistMulti(list, prefix, { edge = false } = {}) {
  const parts = list.filter(Boolean);
  if (!parts.length) throw new Error('Inspelningen finns inte längre');
  if (parts.length === 1) return playlist(parts[0], prefix, { edge });
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-START:TIME-OFFSET=' + (edge ? '-12' : '0') + ',PRECISE=YES', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS'];
  let target = 4;
  const body = [];
  let first = true;
  for (const s of parts) {
    let text = '';
    try { text = fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8'); } catch (_) { continue; }
    if (!/#EXTINF/.test(text)) continue;
    const td = /#EXT-X-TARGETDURATION:(\d+)/.exec(text);
    if (td) target = Math.max(target, +td[1]);
    if (!first) body.push('#EXT-X-DISCONTINUITY');
    first = false;
    body.push('#EXT-X-MAP:URI="' + prefix + '/' + s.id + '/init.mp4"');
    for (const l of text.split('\n')) {
      if (l.startsWith('#EXTINF')) body.push(l);
      else if (l && l[0] !== '#') body.push(prefix + '/' + s.id + '/' + path.basename(l.trim()));
    }
  }
  if (!body.length) throw new Error('Inspelningen kom inte igång');
  const last = parts[parts.length - 1];
  out.push('#EXT-X-TARGETDURATION:' + target, '#EXT-X-MEDIA-SEQUENCE:0', ...body);
  if (last.done && last.full) out.push('#EXT-X-ENDLIST');
  return out.join('\n') + '\n';
}

function file(id, name) {
  const s = get(id);
  if (!s || !/^(init\.mp4|p\d{5}\.m4s)$/.test(name)) return null;
  return path.join(s.dir, name);
}

/** How far the recording has got, in seconds. */
function length(s) {
  try {
    const text = fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8');
    let n = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) n += +m[1];
    return n;
  } catch (_) { return 0; }
}

const KEEP_MATCH_MS = 24 * 3600e3;
setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.match) { if (now - s.started > KEEP_MATCH_MS) stop(s, 'ett dygn gånget'); continue; } // a match stays a day
    if (now - s.last > IDLE_MS) stop(s, 'ingen tittar');
  }
}, 20e3).unref();

function active() { return sessions.size; }
/** Pause recordings someone is using (a paused channel), not match recordings. */
function pauseActive() { let n = 0; for (const s of sessions.values()) if (!s.match && !s.dead) n++; return n; }

/** Every recording that runs (for the AirPlay test page). */
function list() { return [...sessions.values()].filter(s => !s.dead).map(s => ({ id: s.id, ch: s.ch, match: s.match })); }

module.exports = { list, restore, playlistMulti, _hideLinks: hideLinks, start, get, stop, stopAll, stopPauses, matchSession, playlist, file, fileReady, length, active, pauseActive, cleanStart, rootDir };
