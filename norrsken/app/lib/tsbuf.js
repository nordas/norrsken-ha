'use strict';
/**
 * Pause for live TV on channels without an archive: from the moment you pause, the server records the channel
 * (the stream as it is, nothing converted) to the Time Capsule, never to Home Assistant's disk (see below).
 * Resuming plays the recording, which keeps growing, so you carry on exactly where you were, behind live;
 * "Gå till live" ends it.
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
/*
 * NOTHING is ever kept on Home Assistant's own disk (it lives on a small SSD that filled up once and froze it).
 * Without a mounted network folder (storage_dir) the recording goes to the Time Capsule: ffmpeg writes into a small
 * buffer in memory (/dev/shm), every finished piece is copied to the Time Capsule at once and leaves the buffer; only
 * the newest few stay for live and AirPlay. No Time Capsule, no recording. Everything is gone after 24 h.
 */
const IN_HA = !!process.env.SUPERVISOR_TOKEN;
/*
 * Docker gives a container 64 MB of /dev/shm unless told otherwise, and an add-on cannot ask for more. Nothing goes
 * to Home Assistant's disk instead: the buffer's limits follow the size of /dev/shm (a piece leaves for the Time
 * Capsule as soon as it is whole, so even a small buffer is enough while the Time Capsule keeps up).
 */
let shmSize = null;
function shmTotal() {
  if (shmSize === null) {
    try { const st = fs.statfsSync('/dev/shm'); shmSize = st.blocks * st.bsize; } catch (_) { shmSize = 0; }
    if (IN_HA) console.log('[paus] minnesbuffert (/dev/shm):', Math.round(shmSize / 1e6), 'MB – allt sparas på Time Capsule, inget på Home Assistants disk');
  }
  return shmSize;
}
function stageRoot() {
  if (process.env.NSK_STAGE_DIR) return process.env.NSK_STAGE_DIR;
  if (fs.existsSync('/dev/shm')) return '/dev/shm/norrsken-pause';
  return IN_HA ? '' : path.join(os.tmpdir(), 'norrsken-pause'); // tests on a Mac; never in Home Assistant
}
// a share of the memory buffer, never more than the full-size figure (an unknown size: the full-size figure)
const ofShm = (share, full) => { const t = process.env.NSK_STAGE_DIR ? 0 : shmTotal(); return t ? Math.min(full, t * share) : full; };
const tcMode = () => !process.env.NSK_PAUSE_DIR && !storage.mounted();
// a mounted network folder, or the memory buffer in front of the Time Capsule; looked up each time (shares come and go)
const rootDir = () => process.env.NSK_PAUSE_DIR || (tcMode() ? stageRoot() : storage.pauseDir());
const mirrorOn = () => tcMode() && smb.enabled();
const KEEP_LOCAL = () => Math.max(3, Math.min(8, Math.floor(ofShm(0.5, 64e6) / 8e6))); // at least the newest pieces stay in the buffer (live, AirPlay)
// and as many more of the newest as fit in this much memory: a player a minute or two behind live (an iPhone after a
// few stalls, a short pause) then never waits for the Time Capsule, which is slow to fetch from (one SMB1 login a go)
const LOCAL_BUDGET = () => ofShm(0.25, (+process.env.NSK_LOCAL_MB || 150) * 1e6);
const LOCAL_FOR_MS = +process.env.NSK_PAUSE_LOCAL_MS || 60e3; // a piece fetched back stays this long, then leaves again
const RING = () => Math.max(6, Math.min(20, Math.floor(ofShm(0.5, 80e6) / 4e6))); // live without the Time Capsule: this many pieces (up to 80 s) in memory, no more
const STAGE_MAX = () => ofShm(0.8, (+process.env.NSK_STAGE_MAX_MB || 300) * 1e6); // the buffer of one recording never grows past this
const TC_GRACE_MS = +process.env.NSK_TC_GRACE_MS || 120e3; // the Time Capsule may be away this long, then the recording stops
const KEEP_MS = 24 * 3600e3; // hard: nothing is kept longer, here or on the Time Capsule
const KEEP_MATCH_DIR_MS = KEEP_MS;
const IDLE_MS = 3 * 60e3; // the player checks in every 30 s, also while paused
const MIN_FREE = 1.5e9; // leave room on the disk: Home Assistant needs it more than we do
const stageMin = () => ofShm(0.4, 200e6); // and in memory
const sessions = new Map();

/** '' when the Time Capsule can take a recording now, otherwise why not (nothing is then recorded at all). */
function tcProblem() {
  if (!tcMode()) return '';
  if (!smb.enabled()) return 'Ingen Time Capsule inställd (smb_share) – paus och matchinspelning sparas bara där';
  if (!stageRoot()) return 'Inget minnesutrymme för inspelningen (/dev/shm saknas)';
  const i = smb.info();
  if (!i.ok) { smb.check(true).catch(() => {}); return 'Time Capsule svarar inte' + (i.err ? ' (' + i.err + ')' : '') + ' – ingen inspelning, inget sparas på Home Assistants disk'; }
  if (smb.free() && smb.free() < MIN_FREE) return 'För lite ledigt utrymme på Time Capsule';
  return '';
}

/**
 * The Time Capsule's disk sleeps: just after it wakes it answers "no such share" for a minute or so. Before a
 * recording starts, ask it again (never trust an old answer) and give it a little time to wake up.
 */
async function wakeTC(tries = 4, gap = 5000) {
  // it answered last time (that answer is renewed whenever it is asked for): go at once; a disk that dozed off
  // since gets TC_GRACE_MS to wake up while the first pieces wait in memory
  if (!mirrorOn() || smb.info().ok) return;
  for (let i = 0; i < tries; i++) {
    const r = await smb.check(true).catch(() => ({ ok: false }));
    if (r.ok) return;
    if (i < tries - 1) await new Promise(ok => setTimeout(ok, gap));
  }
}

/*
 * Match recordings outlive a restart (an update in the middle of a match): their playlist, first piece (init.mp4)
 * and meta.json are copied to the Time Capsule with the pieces, and the folders of the match recordings the server
 * still lists (/data/matchrecs.json) are never removed by tidying; recoverTC() brings them back after a restart.
 */
const protectedIds = new Set();
function protect(ids) { for (const id of ids || []) if (/^[a-z0-9]{4,12}$/.test(id)) protectedIds.add(id); }
let recovering = false;

/** Remove every folder on the Time Capsule that no recording owns (left behind, or older than 24 h). */
function sweepRemote() {
  if (!mirrorOn() || recovering) return Promise.resolve();
  return smb.check(true).then((r) => { if (r.ok) return smb.cleanSubdirs(smb.dir + '/pause', (n) => sessions.has(n) || protectedIds.has(n)); }).catch(() => {});
}

/** Whatever an earlier run left behind (called when the server starts, not when the module is loaded). */
function cleanStart() {
  // a match recording survives a restart (an update in the middle of the match must not lose its start); pauses do not
  const keep = new Set();
  const root = rootDir();
  // what 1.14.4 and older left on the add-on's own disk: never kept
  if (tcMode()) try { fs.rmSync(path.join(os.tmpdir(), 'norrsken-pause'), { recursive: true, force: true }); } catch (_) { /* nothing there */ }
  try {
    for (const id of fs.readdirSync(root)) {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8')); } catch (_) { /* a pause or junk */ }
      if (meta && meta.match && Date.now() - meta.started < KEEP_MATCH_DIR_MS && /^[a-z0-9]{4,12}$/.test(id)) { keep.add(id); continue; }
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
    }
  } catch (_) { /* nothing there */ }
  // nothing on the Time Capsule is removed at start: a match recording there may be brought back (recoverTC); what is
  // really left behind goes with the hourly tidying, which keeps the recordings the server still lists
  return [...keep];
}

/** A finished match recording from before a restart, played from its folder (and the Time Capsule). */
function restoredSession(id, dir, meta, have) {
  const over = !!meta.maxMin && Date.now() > meta.started + meta.maxMin * 60e3;
  const s = { id, url: '', dir, ch: meta.ch || '', proc: null, started: meta.started || Date.now(), last: Date.now(), dead: false, done: true, err: '', maxMin: meta.maxMin || 0, full: over, match: true, restored: true };
  if (mirrorOn()) {
    let idxM = 0;
    try { idxM = fs.statSync(path.join(dir, 'index.m3u8')).mtimeMs; } catch (_) { /* none */ }
    s.mirror = { dir: smb.dir + '/pause/' + id, ready: true, up: new Set(have || []), upx: new Set(['meta.json', 'init.mp4']), idxM, busy: false, err: '', fetching: new Map(), fetchedAt: new Map(), bytes: 0 };
    if (!have) smb.listFiles(s.mirror.dir).then((names) => { for (const n of names) if (/^p\d{5}\.m4s$/.test(n)) s.mirror.up.add(n); }).catch(() => {});
    s.mirrorT = setInterval(() => mirrorTick(s), 5000);
    if (s.mirrorT.unref) s.mirrorT.unref();
  }
  sessions.set(id, s);
  return s;
}

/** Keep only the pieces that are there; a gap (a piece that never reached the Time Capsule) is marked as one. */
function trimIndex(dir, have) {
  const f = path.join(dir, 'index.m3u8');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const out = [];
  let pend = null; let gap = false; let any = false;
  for (const l of lines) {
    if (l.startsWith('#EXTINF')) { pend = l; continue; }
    if (pend && l && l[0] !== '#') {
      if (have.has(path.basename(l.trim()))) { if (gap && any) out.push('#EXT-X-DISCONTINUITY'); out.push(pend, l); any = true; gap = false; } else gap = true;
      pend = null; continue;
    }
    if (l === '#EXT-X-ENDLIST') continue;
    out.push(l);
  }
  fs.writeFileSync(f, out.join('\n'));
  return any;
}

/**
 * After a restart: bring back the match recordings the server still lists, from the Time Capsule (the memory buffer
 * is empty after a restart). Their playlist, init.mp4 and meta.json are fetched; the pieces stay on the disk and are
 * fetched when played, as always.
 */
async function recoverTC(ids) {
  const out = [];
  ids = [...new Set(ids || [])].filter(id => /^[a-z0-9]{4,12}$/.test(id) && !sessions.has(id));
  if (!mirrorOn() || !ids.length) return out;
  protect(ids);
  recovering = true;
  try {
    await wakeTC(6, 10000);
    if (!smb.info().ok) { console.log('[match] Time Capsule svarar inte – inspelningarna kan inte hämtas tillbaka nu'); return out; }
    for (const id of ids) {
      const rdir = smb.dir + '/pause/' + id;
      const names = await smb.listFiles(rdir);
      const have = new Set(names.filter(n => /^p\d{5}\.m4s$/.test(n)));
      if (!names.includes('index.m3u8') || !names.includes('init.mp4') || !have.size) {
        if (names.length) console.log('[match] inspelningen ' + id + ' saknar spellista på Time Capsule (gjord före 1.14.9) – kan inte spelas igen');
        continue;
      }
      const dir = path.join(rootDir(), id);
      fs.mkdirSync(dir, { recursive: true });
      const want = ['index.m3u8', 'init.mp4'].concat(names.includes('meta.json') ? ['meta.json'] : []);
      const g = await smb.getMany(dir, rdir, want);
      if (!g.ok) { console.log('[match] kunde inte hämta inspelningen ' + id + ':', g.err); continue; }
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) { /* older: no meta */ }
      if (meta.started && Date.now() - meta.started > KEEP_MATCH_DIR_MS) continue;
      if (!trimIndex(dir, have)) continue;
      out.push(restoredSession(id, dir, meta, have));
    }
    if (out.length) console.log('[match]', out.length, 'matchinspelning(ar) hämtade tillbaka från Time Capsule efter omstarten');
  } catch (e) { console.error('[match] återställning:', e.message); } finally { recovering = false; }
  return out;
}

/** Bring back the match recordings cleanStart kept: finished (nothing records into them now), playable, 24 h. */
function restore(ids) {
  const out = [];
  for (const id of ids || []) {
    const dir = path.join(rootDir(), id);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) { continue; }
    // over by now (its planned length has passed): finished; otherwise it goes on in a new part after the restart.
    // ffmpeg stopped in the middle: the playlist has no end mark yet, the pieces it lists are whole
    out.push(restoredSession(id, dir, meta, null));
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
  if (s.retryT) clearTimeout(s.retryT);
  try { if (s.proc) s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  if (s.mirrorT) clearInterval(s.mirrorT);
  if (s.mirror) smb.rmdirAll(s.mirror.dir).catch(() => {});
  const mb = Math.round(dirBytes(s.dir) / 1e6);
  console.log('[paus] inspelningen slutar (' + (why || 'stopp') + '),', Math.round((Date.now() - s.started) / 60e3) + ' min,', mb + ' MB');
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 1500);
}

/**
 * Stop recording here (what is recorded stays playable). full: as far as it goes (a disk is full); otherwise the
 * Time Capsule was away and a match recording may start again in a new part once it is back.
 */
function halt(s, why, full = true) {
  if (s.halted || s.dead) return;
  s.halted = true;
  console.log('[paus] inspelningen stannar här:', why);
  try { if (s.proc) s.proc.kill('SIGINT'); } catch (_) { /* gone */ }
  if (full) s.full = true;
  if (s.diskT) clearInterval(s.diskT);
}

/**
 * The server gives up on this connection (a match channel that shows no picture): ffmpeg and any try it was waiting
 * to make go at once, so the next channel is the only connection to the provider. What it recorded stays.
 */
function giveUp(s, why) {
  if (!s || s.dead || s.done) return;
  s.done = true;
  s.retrying = false;
  if (s.retryT) { clearTimeout(s.retryT); s.retryT = null; }
  if (s.diskT) { clearInterval(s.diskT); s.diskT = null; } // nothing more is written (the copies to the Time Capsule go on)
  try { if (s.proc) s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  console.log('[paus] slutar försöka med kanalen:', why);
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
function start(url, { ua, maxMin = 60, ch = '', match = false, live = false } = {}) {
  if (match) { for (const s of [...sessions.values()]) if (!s.match) stop(s, 'matchinspelning'); }
  else {
    if (matchSession()) throw new Error('Matchinspelningen pågår på en annan kanal');
    stopPauses('ny paus'); // one connection: a new pause ends the previous one (a finished match recording stays)
  }
  const why = tcProblem();
  // plain live viewing (an iPhone watches live through this) still works without the Time Capsule: only the newest
  // pieces, in memory, ffmpeg removes the older ones itself; no pausing back, nothing kept anywhere
  // (since 1.16 always so: watching a channel is not recording it. Only a pause and a match recording are kept.)
  const ring = live && !match;
  if (why && !ring) { console.log('[paus] ingen inspelning:', why); throw new Error(why); }
  const useMirror = tcMode() && !ring;
  const ROOT = rootDir();
  fs.mkdirSync(ROOT, { recursive: true });
  const free = freeBytes(ROOT);
  // live through memory keeps at most STAGE_MAX: it needs that much free, not the disk margin a pause needs
  if (free < (!tcMode() ? MIN_FREE : ring ? stageMin() / 2 : stageMin())) throw new Error(tcMode() ? 'För lite ledigt minne för att spela in pausen' : 'För lite ledigt diskutrymme för att spela in pausen');
  const id = Math.random().toString(36).slice(2, 10);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = { id, url, dir, ch, proc: null, started: Date.now(), last: Date.now(), dead: false, done: false, err: '', maxMin, full: false, match: !!match, ring };
  try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ch, match: !!match, started: s.started, maxMin })); } catch (_) { /* the recording works without it */ }
  if (useMirror) s.mirror = { dir: smb.dir + '/pause/' + id, ready: false, up: new Set(), busy: false, err: '', fetching: new Map(), fetchedAt: new Map(), bytes: 0 };
  const hls = /\.m3u8?(\?|$)/i.test(url);
  /*
   * AAC in a transport stream is ADTS, and ffmpeg's HLS muxer stops at the first piece ("Malformed AAC bitstream")
   * unless it is told to convert it. That filter refuses other audio (AC-3…), so: try it first, and when ffmpeg says
   * it cannot use the filter, start again without it (it fails at once, before anything is recorded).
   */
  const launch = (bsf) => {
    s.lastLaunch = Date.now();
    s.retrying = false;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-user_agent', ua || DEFAULT_UA, '-rw_timeout', '20000000'];
    if (!hls) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    args.push('-fflags', '+genpts+discardcorrupt', '-i', url,
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy');
    if (bsf) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-t', String(Math.max(1, maxMin) * 60), '-f', 'hls', '-hls_time', '4');
    // ring (live only, no Time Capsule): a sliding list of the newest pieces, ffmpeg removes the older ones
    if (ring) args.push('-hls_list_size', String(RING()), '-hls_flags', 'independent_segments+temp_file+delete_segments');
    else args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file');
    // fragmented MP4 like the converter: every codec a provider sends (H.264, HEVC, AAC, AC-3…) fits as it is
    args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'p%05d.m4s'), path.join(dir, 'index.m3u8'));
    const proc = s.proc = spawn(FF, args);
    proc.stderr.on('data', d => { if (s.err.length < 3000) s.err += d; });
    proc.on('error', (e) => { s.err += e.message; s.done = true; });
    proc.on('close', (code) => {
      if (s.dead || s.done) { s.done = true; return; }
      if (bsf && code && /bitstream filter/i.test(s.err) && Date.now() - s.started < 20000) { s.err = ''; launch(false); return; }
      /*
       * The provider allows one connection: the player's own stream was closed a moment ago and the provider may still
       * count it, so it answers 4XX (or closes at once). Nothing recorded yet: wait and ask again, a few times.
       */
      let pieces = 0;
      try { pieces = fs.readdirSync(s.dir).filter(n => /^p\d{5}\.m4s$/.test(n)).length; } catch (_) { /* gone */ }
      const most = s.match ? 2 : 4; // a match has other channels to try: the server moves on sooner
      if (code && !pieces && (s.tries || 0) < most && Date.now() - s.started < 90e3) {
        s.tries = (s.tries || 0) + 1;
        console.log('[paus] kanalen svarade inte (' + hideLinks(s.err.split('\n').filter(Boolean).slice(-1).join(' ')) + '), försöker igen', s.tries + '/' + most);
        s.err = '';
        s.retrying = true;
        s.retryT = setTimeout(() => { s.retryT = null; if (!s.dead && !s.done && !s.halted) launch(bsf); }, 2500 * s.tries);
        if (s.retryT.unref) s.retryT.unref();
        return;
      }
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
    if (s.ring && dirBytes(s.dir) > STAGE_MAX()) return halt(s, 'bufferten i minnet är full', false);
    if (freeBytes(path.dirname(s.dir)) < (s.mirror ? stageMin() * 0.25 : MIN_FREE * 0.6) || (s.mirror && smb.free() && smb.free() < MIN_FREE * 0.6)) halt(s, s.mirror ? 'minnet eller Time Capsule börjar bli fullt' : 'disken börjar bli full');
  }, 5000);
  if (s.diskT.unref) s.diskT.unref();
  sessions.set(id, s);
  console.log(match ? '[match] spelar in' : ring ? '[live] via minnet, spelas inte in:' : '[paus] spelar in', ch || 'kanalen', ring ? '' : 'från nu (högst ' + maxMin + ' min)');
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

/** Copy finished pieces to the Time Capsule at once; a piece that is there leaves the buffer (the newest few stay). */
async function mirrorTick(s) {
  const m = s.mirror;
  if (!m || m.busy || s.dead) return;
  m.busy = true;
  try {
    if (!m.ready) { const r = await smb.ensure(m.dir); if (!r.ok) throw new Error(r.err); m.ready = true; }
    // ffmpeg writes a piece under a temporary name and renames it when it is whole, so every p*.m4s is complete
    const segs = fs.readdirSync(s.dir).filter(n => /^p\d{5}\.m4s$/.test(n)).sort();
    const todo = segs.filter(n => !m.up.has(n)).slice(0, 6);
    // a match recording also keeps its playlist, first piece and meta on the Time Capsule: after a restart it is
    // brought back from there (the buffer in memory is empty then). In the same go as the pieces: one login.
    const extra = [];
    if (s.match) {
      m.upx = m.upx || new Set();
      for (const n of ['meta.json', 'init.mp4']) if (!m.upx.has(n) && fs.existsSync(path.join(s.dir, n))) extra.push(n);
      let idxM = 0;
      try { idxM = fs.statSync(path.join(s.dir, 'index.m3u8')).mtimeMs; } catch (_) { /* not yet */ }
      if (idxM && idxM !== m.idxM && (todo.length || s.done || Date.now() - (m.idxAt || 0) > 20000)) extra.push('index.m3u8');
    }
    if (todo.length || extra.length) {
      let idxNow = 0;
      try { idxNow = fs.statSync(path.join(s.dir, 'index.m3u8')).mtimeMs; } catch (_) { /* none */ }
      const r = await smb.put(s.dir, todo.concat(extra), m.dir);
      if (!r.ok) throw new Error(r.err);
      for (const n of todo) { m.up.add(n); try { m.bytes += fs.statSync(path.join(s.dir, n)).size; } catch (_) { /* gone */ } }
      for (const n of extra) { if (n === 'index.m3u8') { m.idxM = idxNow; m.idxAt = Date.now(); } else m.upx.add(n); }
    }
    evict(s);
    if (m.err) console.log('[paus] Time Capsule är tillbaka');
    m.err = '';
    m.errSince = 0;
  } catch (e) {
    if (e.message !== m.err) console.error('[paus] kunde inte kopiera till Time Capsule:', e.message);
    m.err = e.message;
    if (!m.errSince) m.errSince = Date.now();
    // nothing is kept on Home Assistant's disk, and the memory buffer is small: when the Time Capsule stays away, stop
    if (!s.done && Date.now() - m.errSince > TC_GRACE_MS) halt(s, 'Time Capsule svarar inte (' + e.message + ')', false);
  } finally {
    m.busy = false;
    if (!s.done && !s.dead && dirBytes(s.dir) > STAGE_MAX()) halt(s, 'Time Capsule hinner inte med (bufferten i minnet är full)', false);
  }
}

/**
 * Pieces that are on the Time Capsule leave the buffer, except the newest (at least KEEP_LOCAL, more while they fit in
 * LOCAL_BUDGET) and those just fetched back.
 */
function evict(s) {
  const m = s.mirror;
  const now = Date.now();
  let segs = [];
  try { segs = fs.readdirSync(s.dir).filter(n => /^p\d{5}\.m4s$/.test(n)).sort(); } catch (_) { return; }
  let keep = 0;
  let bytes = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    try { bytes += fs.statSync(path.join(s.dir, segs[i])).size; } catch (_) { /* gone */ }
    if (keep >= KEEP_LOCAL() && bytes > LOCAL_BUDGET()) break;
    keep++;
  }
  for (const n of segs.slice(0, Math.max(0, segs.length - keep))) {
    const f = path.join(s.dir, n);
    const back = m.fetchedAt.get(n);
    if (!m.up.has(n) || m.fetching.has(n) || (back && now - back < LOCAL_FOR_MS)) continue;
    m.fetchedAt.delete(n);
    try { fs.rmSync(f, { force: true }); } catch (_) { /* gone */ }
  }
}

/** A piece to play: in the buffer, or fetched back from the Time Capsule (with the next 7, half a minute, in the same go). */
async function fileReady(id, name) {
  const f = file(id, name);
  if (!f) return null;
  if (fs.existsSync(f)) return f;
  const s = get(id);
  const m = s && s.mirror;
  if (!m || !m.up.has(name)) return null;
  const num = /^p(\d{5})\.m4s$/.exec(name);
  const want = [name];
  if (num) for (let k = 1; k <= 7; k++) { const nx = 'p' + String(+num[1] + k).padStart(5, '0') + '.m4s'; if (m.up.has(nx) && !fs.existsSync(path.join(s.dir, nx)) && !m.fetching.has(nx)) want.push(nx); }
  let p = m.fetching.get(name);
  if (!p) {
    p = (async () => {
      let r = await smb.getMany(s.dir, m.dir, want);
      if (!r.ok && !fs.existsSync(f)) r = await smb.getMany(s.dir, m.dir, [name]); // once more, the piece itself
      // fetched back: it stays LOCAL_FOR_MS for the player, then leaves the buffer again (evict)
      for (const n of want) m.fetchedAt.set(n, Date.now());
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
      if (text.indexOf('#EXT-X-START') < 0 && !s.ring) text = text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=' + (edge ? '-12' : '0') + ',PRECISE=YES');
      // finished (time limit or disk): mark the end so the player doesn't wait for more
      // finished: mark the end so the player doesn't wait for more. A match recording the provider dropped is not
      // finished (the server starts it again and the playlist goes on): only when it ran its full length
      if (s.match && !s.full && !pastEnd(s)) text = text.replace(/^#EXT-X-ENDLIST\s*$/m, ''); // ffmpeg writes it when the stream ends
      else if (s.done && text.indexOf('#EXT-X-ENDLIST') < 0) text = text.trimEnd() + '\n#EXT-X-ENDLIST\n';
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
 * Live for a TV over AirPlay: an ordinary sliding live playlist of the newest pieces (as TV4 Play and every live
 * service send), not the growing recording with a "start 12 s before the end" line. A Philips TV (Titan OS) spun on
 * that and gave up; Apple's rules for AirPlay TVs: at least six pieces, MEDIA-SEQUENCE and DISCONTINUITY-SEQUENCE
 * counted, the first piece of each part with its own init (EXT-X-MAP), the clock time of the pieces. With a long
 * window the TV's own remote can pause and rewind while it plays over AirPlay.
 * list: the parts of the recording in order (one for a pause, several for a match the provider dropped).
 */
// window: how many pieces back the TV's own remote can rewind. The whole recording: the Philips TV (Titan OS) played
// every live form on /airtest (40 s, 15 min, all), but not the growing recording from its start – so a TV always gets
// this one, the whole match in it, and "from the start" is a jump the phone makes once the TV plays
const AIR_WINDOW = +process.env.NSK_AIR_WINDOW || 100000;
function livePlaylist(list, prefix, { window = AIR_WINDOW } = {}) {
  const parts = (list || []).filter(Boolean);
  const all = [];
  let seq0 = 0;
  parts.forEach((s, pi) => {
    let text = '';
    try { text = fs.readFileSync(path.join(s.dir, 'index.m3u8'), 'utf8'); } catch (_) { return; }
    let dur = 0; let t = s.started || Date.now(); let first = true;
    // live through memory only: the list slides, its first piece is not the recording's first
    const sq = s.ring ? +((/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text) || [])[1] || 0) : 0;
    if (sq) { seq0 = sq; t += sq * 4000; }
    for (const l of text.split('\n')) {
      if (l.startsWith('#EXTINF:')) { dur = parseFloat(l.slice(8)) || 0; continue; }
      if (!l || l[0] === '#' || !dur) continue;
      all.push({ s, uri: prefix + '/' + s.id + '/' + path.basename(l.trim()), dur, at: t, disc: first && pi > 0 && all.length > 0 });
      t += dur * 1000; dur = 0; first = false;
    }
  });
  if (!all.length) return null;
  const from = Math.max(0, all.length - window);
  const win = all.slice(from);
  const target = Math.max(4, Math.ceil(Math.max(...win.map(e => e.dur))));
  const discBefore = all.slice(0, from + 1).filter(e => e.disc).length - (win[0].disc ? 1 : 0);
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + target, '#EXT-X-MEDIA-SEQUENCE:' + (seq0 + from), '#EXT-X-DISCONTINUITY-SEQUENCE:' + discBefore, '#EXT-X-INDEPENDENT-SEGMENTS'];
  let map = '';
  win.forEach((e, i) => {
    if (e.disc && i > 0) out.push('#EXT-X-DISCONTINUITY');
    const m = prefix + '/' + e.s.id + '/init.mp4';
    if (m !== map) { out.push('#EXT-X-MAP:URI="' + m + '"'); map = m; }
    if (i === 0 || e.disc) out.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(e.at).toISOString());
    out.push('#EXTINF:' + e.dur.toFixed(6) + ',', e.uri);
  });
  const last = parts[parts.length - 1];
  if (last.done && (last.full || pastEnd(last) || !last.match)) out.push('#EXT-X-ENDLIST');
  return out.join('\n') + '\n';
}

/** The planned end of the recording has passed (a match: its end plus the tail): nothing more will come. */
function pastEnd(s) { return !!s.maxMin && Date.now() > s.started + s.maxMin * 60e3; }

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
  if (last.done && (last.full || pastEnd(last))) out.push('#EXT-X-ENDLIST');
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

setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.started > KEEP_MS) { stop(s, 'ett dygn gånget'); continue; } // hard: never longer, match or pause
    if (!s.match && now - s.last > IDLE_MS) stop(s, 'ingen tittar');
  }
}, 20e3).unref();
// and on the Time Capsule: every hour, whatever no running recording owns goes (a crash or a reboot left it behind)
setInterval(() => { sweepRemote(); }, 3600e3).unref();
// an answer "it is away" is never left standing: asked again every minute until it is back (it wakes up by itself)
setInterval(() => { if (mirrorOn() && !smb.info().ok) smb.check(true).catch(() => {}); }, 60e3).unref();

function active() { return sessions.size; }
/** Recordings that still read from the provider (a finished match recording kept for a day does not). */
function recording() { let n = 0; for (const s of sessions.values()) if (!s.dead && !s.done) n++; return n; }
/** '' when a recording can start (disks have room), otherwise why not. */
function preflight() {
  const why = tcProblem();
  if (why) return why;
  try { fs.mkdirSync(rootDir(), { recursive: true }); } catch (e) { return 'mappen för inspelningar går inte att skapa'; }
  if (freeBytes(rootDir()) < (tcMode() ? stageMin() : MIN_FREE)) return tcMode() ? 'för lite ledigt minne' : 'för lite ledigt diskutrymme';
  return '';
}
/** Pause recordings someone is using (a paused channel), not match recordings. */
function pauseActive() { let n = 0; for (const s of sessions.values()) if (!s.match && !s.dead) n++; return n; }

/** Every recording that runs (for the AirPlay test page). */
function list() { return [...sessions.values()].filter(s => !s.dead).map(s => ({ id: s.id, ch: s.ch, match: s.match })); }

/** For tests: what a restart does to a recording – the process is gone and so is the memory buffer, nothing else. */
function _forget(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.dead = true;
  sessions.delete(id);
  try { if (s.proc) s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  if (s.mirrorT) clearInterval(s.mirrorT);
  if (s.diskT) clearInterval(s.diskT);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

module.exports = { giveUp, stageInfo: () => ({ dir: tcMode() ? stageRoot() : rootDir(), mem: tcMode(), shmMb: Math.round(shmTotal() / 1e6), freeMb: (f => isFinite(f) ? Math.round(f / 1e6) : null)(freeBytes(fs.existsSync(rootDir()) ? rootDir() : path.dirname(rootDir()))) }), livePlaylist, _forget, wakeTC, sweepRemote, recoverTC, protect, recording, preflight, list, restore, playlistMulti, _hideLinks: hideLinks, start, get, stop, stopAll, stopPauses, matchSession, playlist, file, fileReady, length, active, pauseActive, cleanStart, rootDir };
