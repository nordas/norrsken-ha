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
const ROOT = process.env.NSK_PAUSE_DIR || path.join(os.tmpdir(), 'norrsken-pause');
const IDLE_MS = 3 * 60e3; // the player checks in every 30 s, also while paused
const MIN_FREE = 1.5e9; // leave room on the disk: Home Assistant needs it more than we do
const sessions = new Map();

// whatever an earlier run left behind
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* nothing */ }

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

function stop(s, why) {
  if (!s || s.dead) return;
  s.dead = true;
  sessions.delete(s.id);
  try { if (s.proc) s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  const mb = Math.round(dirBytes(s.dir) / 1e6);
  console.log('[paus] inspelningen slutar (' + (why || 'stopp') + '),', Math.round((Date.now() - s.started) / 60e3) + ' min,', mb + ' MB');
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 1500);
}

function stopAll(why) { for (const s of [...sessions.values()]) stop(s, why); }

/** Start recording `url` (a live channel). maxMin caps the length (and the disk use). */
function start(url, { ua, maxMin = 60, ch = '' } = {}) {
  stopAll('ny paus'); // one connection: a new pause ends the previous one
  fs.mkdirSync(ROOT, { recursive: true });
  const free = freeBytes(ROOT);
  if (free < MIN_FREE) throw new Error('För lite ledigt diskutrymme för att spela in pausen');
  const id = Math.random().toString(36).slice(2, 10);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = { id, url, dir, ch, proc: null, started: Date.now(), last: Date.now(), dead: false, done: false, err: '', maxMin, full: false };
  const hls = /\.m3u8?(\?|$)/i.test(url);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-user_agent', ua || DEFAULT_UA, '-rw_timeout', '20000000'];
  if (!hls) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-fflags', '+genpts+discardcorrupt', '-i', url,
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-t', String(Math.max(1, maxMin) * 60),
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    // fragmented MP4 like the converter: every codec a provider sends (H.264, HEVC, AAC, AC-3…) fits as it is
    '-hls_flags', 'independent_segments+temp_file', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'p%05d.m4s'), path.join(dir, 'index.m3u8'));
  const proc = s.proc = spawn(FF, args);
  proc.stderr.on('data', d => { if (s.err.length < 3000) s.err += d; });
  proc.on('error', (e) => { s.err += e.message; s.done = true; });
  proc.on('close', (code) => {
    s.done = true;
    if (s.dead) return;
    if (Date.now() - s.started >= maxMin * 60e3 - 5000) { s.full = true; console.log('[paus] inspelningen nådde maxlängden', maxMin, 'min'); }
    else if (code) console.error('[paus] ffmpeg fel', code, s.err.split('\n').filter(Boolean).slice(-2).join(' '));
  });
  // keep an eye on the disk while recording
  s.diskT = setInterval(() => {
    if (s.dead) return clearInterval(s.diskT);
    if (freeBytes(ROOT) < MIN_FREE * 0.6) { console.log('[paus] disken börjar bli full: inspelningen stannar här'); try { s.proc.kill('SIGINT'); } catch (_) { /* gone */ } s.full = true; clearInterval(s.diskT); }
  }, 15000);
  if (s.diskT.unref) s.diskT.unref();
  sessions.set(id, s);
  console.log('[paus] spelar in', ch || 'kanalen', 'från nu (högst', maxMin, 'min)');
  return s;
}

function get(id) {
  const s = sessions.get(String(id || ''));
  if (s) s.last = Date.now();
  return s || null;
}

/** The recording as an HLS playlist, waiting for its first piece. Segment URIs point at prefix/<id>/. */
async function playlist(s, prefix, { wait = 30000 } = {}) {
  const f = path.join(s.dir, 'index.m3u8');
  const t0 = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { /* not yet */ }
    if (/#EXTINF/.test(text)) {
      // play from the start of the recording (where you paused), not from its end
      if (text.indexOf('#EXT-X-START') < 0) text = text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
      // finished (time limit or disk): mark the end so the player doesn't wait for more
      if (s.done && text.indexOf('#EXT-X-ENDLIST') < 0) text = text.trimEnd() + '\n#EXT-X-ENDLIST\n';
      return text.split('\n').map((l) => {
        if (l.startsWith('#EXT-X-MAP:URI="')) return l.replace(/URI="([^"]+)"/, (m, u) => 'URI="' + prefix + '/' + s.id + '/' + path.basename(u) + '"');
        return l && l[0] !== '#' ? prefix + '/' + s.id + '/' + path.basename(l.trim()) : l;
      }).join('\n');
    }
    if (s.done || s.dead) throw new Error(s.err.split('\n').filter(Boolean).slice(-1)[0] || 'Inspelningen kom inte igång');
    if (Date.now() - t0 > wait) throw new Error('Inspelningen kom inte igång');
    await new Promise(ok => setTimeout(ok, 300));
  }
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
  for (const s of [...sessions.values()]) if (now - s.last > IDLE_MS) stop(s, 'ingen tittar');
}, 20e3).unref();

function active() { return sessions.size; }

module.exports = { start, get, stop, stopAll, playlist, file, length, active, ROOT };
