'use strict';
/**
 * Downloads: a film or an episode is read from the provider and written as an MP4 on the storage disk (the
 * AirPort's, if set up). Picture is copied as it is; sound the iPhone/TV can't play (DTS, TrueHD…) becomes E-AC-3.
 * Finished files can be played from the server (no provider connection) or saved to the phone/Mac from the browser.
 *
 * The provider gives few connections: a download only runs while nothing else plays (see deps.busy), and a new
 * stream stops it (deps.yield) – it starts over from the beginning when it is the downloads' turn again.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const { DEFAULT_UA } = require('./util');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const MIN_FREE = 1.5e9;
const COPY_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);
const COPY_VIDEO = new Set(['h264', 'hevc']);
const items = new Map(); // id → item (the saved fields) – runtime state lives in `run`
const run = new Map(); // id → { proc, started }
let deps = { busy: () => false, maxConn: () => 1, probe: null, url: () => null, ua: () => DEFAULT_UA };
let loaded = false;

const dir = () => storage.downloadDir();
const indexFile = () => path.join(dir(), 'index.json');
const safeId = (type, id) => type + '-' + String(id).replace(/[^\w.-]/g, '_').slice(0, 80);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function load() {
  if (loaded) return;
  loaded = true;
  try {
    for (const it of JSON.parse(fs.readFileSync(indexFile(), 'utf8')).items || []) {
      if (it.status === 'downloading') it.status = 'queued'; // the server stopped in the middle of it
      items.set(it.id, it);
    }
  } catch (_) { /* first run */ }
  // partial files from a stopped run are useless
  try { for (const f of fs.readdirSync(dir())) if (f.endsWith('.part.mp4')) fs.rmSync(path.join(dir(), f), { force: true }); } catch (_) { /* none */ }
}
function save() {
  try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(indexFile(), JSON.stringify({ items: [...items.values()] })); } catch (e) { console.error('[nedladdning] kunde inte spara listan:', e.message); }
}

function configure(d) { deps = Object.assign(deps, d); load(); }

/** What the app shows. */
function view(it) {
  const r = run.get(it.id);
  return { id: it.id, type: it.type, mid: it.mid, ext: it.ext, title: it.title, sub: it.sub, img: it.img, status: it.status, pct: Math.round((it.pct || 0) * 1000) / 10, bytes: it.bytes || 0, dur: it.dur || 0, err: it.err || '', created: it.created, done: it.done || 0, active: !!r, file: it.status === 'done' ? it.id + '/' + encodeURIComponent((it.title || 'film').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'film') + '.mp4' : '' };
}
// newest batch first; inside a batch (a season) in the order it was queued
function list() { load(); return [...items.values()].sort((a, b) => (b.created - a.created) || (a.ord || 0) - (b.ord || 0)).map(view); }
function get(id) { load(); return items.get(id) || null; }
/** A finished download of this film/episode, if there is one and its file is still there. */
function doneFor(type, id) {
  load();
  const it = items.get(safeId(type, id));
  return it && it.status === 'done' && fs.existsSync(fileOf(it)) ? view(it) : null;
}
function fileOf(it) { return path.join(dir(), it.id + '.mp4'); }

/** Queue a film or episode. Returns the item (already existing ones are left alone, a failed one is retried). */
let seq = 0;
function add({ type, id, ext, title, sub, img, at }) {
  load();
  if (type !== 'movie' && type !== 'episode') throw new Error('Bara filmer och avsnitt kan laddas ner');
  const key = safeId(type, id);
  const old = items.get(key);
  if (old && old.status !== 'error') return view(old);
  const it = { id: key, type, mid: String(id), ext: clean(ext, 8), title: clean(title, 120) || 'Namnlös', sub: clean(sub, 120), img: clean(img, 600), status: 'queued', pct: 0, bytes: 0, dur: 0, err: '', created: at || Date.now(), ord: ++seq, done: 0 };
  items.set(key, it);
  save();
  setTimeout(pump, 50);
  return view(it);
}

function killRun(id) {
  const r = run.get(id);
  if (!r) return;
  r.stopped = true;
  try { r.proc.kill('SIGINT'); } catch (_) { /* gone */ }
  setTimeout(() => { try { r.proc.kill('SIGKILL'); } catch (_) { /* gone */ } }, 4000).unref();
}

function remove(id) {
  const it = items.get(id);
  if (!it) return false;
  killRun(id);
  items.delete(id);
  for (const f of [fileOf(it), path.join(dir(), id + '.part.mp4')]) setTimeout(() => fs.rm(f, { force: true }, () => {}), 800);
  save();
  return true;
}

function cancel(id) {
  const it = items.get(id);
  if (!it || it.status === 'done') return false;
  return remove(id);
}

/** Something else wants the provider's connection. */
function yieldTo(why) {
  let n = 0;
  for (const [id, r] of run) {
    const it = items.get(id);
    if (it && !r.stopped) { n++; killRun(id); it.status = 'queued'; it.pct = 0; it.err = ''; console.log('[nedladdning] pausar ' + it.title + ' (' + why + ')'); }
  }
  if (n) save();
  return n;
}

function active() { return run.size; }

async function start(it) {
  const src = deps.url(it.type, it.mid, it.ext);
  if (!src || !src.primary) { it.status = 'error'; it.err = 'Kunde inte hitta filen hos leverantören'; save(); return; }
  fs.mkdirSync(dir(), { recursive: true });
  it.status = 'downloading'; it.err = ''; it.pct = 0;
  const r = { started: Date.now(), stopped: false, proc: null };
  run.set(it.id, r);
  save();
  let info = null;
  try { info = deps.probe ? await deps.probe(src.primary, deps.ua()) : null; } catch (e) { /* download anyway, copy everything */ }
  if (r.stopped) { run.delete(it.id); return; }
  if (info && info.video && !COPY_VIDEO.has(info.video)) { run.delete(it.id); it.status = 'error'; it.err = 'Bildformatet (' + info.video + ') går inte att spara utan omkodning'; save(); return; }
  it.dur = (info && info.dur) || 0;
  const estimate = info && info.br && info.dur ? info.br / 8 * info.dur : 0;
  const free = storage.freeBytes(dir()).free;
  if (free && free - estimate < MIN_FREE) { run.delete(it.id); it.status = 'error'; it.err = 'För lite ledigt utrymme på lagringsdisken'; save(); return; }
  const out = path.join(dir(), it.id + '.part.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-user_agent', deps.ua(), '-rw_timeout', '30000000'];
  if (!/\.m3u8?(\?|$)/i.test(src.primary)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  args.push('-fflags', '+genpts+discardcorrupt', '-i', src.primary, '-map', '0:v:0', '-sn', '-dn', '-c:v', 'copy');
  if (info && info.video === 'hevc') args.push('-tag:v', 'hvc1'); // Apple needs this tag to play H.265 from MP4
  const audio = ((info && info.audio) || []).slice(0, 4);
  if (audio.length) {
    audio.forEach((a, n) => {
      args.push('-map', '0:a:' + a.i);
      if (COPY_AUDIO.has(a.codec)) args.push('-c:a:' + n, 'copy');
      else args.push('-c:a:' + n, 'eac3', '-b:a:' + n, '640k', '-ac:a:' + n, String(Math.min(6, a.ch || 2)));
    });
  } else args.push('-map', '0:a:0?', '-c:a', 'copy');
  args.push('-movflags', '+faststart', '-f', 'mp4', '-y', out);
  const proc = r.proc = spawn(FF, args);
  let err = '';
  let buf = '';
  proc.stderr.on('data', (d) => { if (err.length < 3000) err += d; });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && it.dur) it.pct = Math.min(0.99, +m[1] / 1e6 / it.dur);
      const s = /^total_size=(\d+)/.exec(line);
      if (s) it.bytes = +s[1];
    }
  });
  proc.on('error', (e) => { err += e.message; });
  proc.on('close', (code) => {
    run.delete(it.id);
    if (r.stopped || !items.has(it.id)) { fs.rm(out, { force: true }, () => {}); return pumpSoon(); }
    if (code === 0 && fs.existsSync(out) && fs.statSync(out).size < 20000) {
      // ffmpeg can end "fine" on a stream that gave nothing: an almost empty file is not a film
      fs.rmSync(out, { force: true });
      it.status = 'error'; it.err = 'Leverantören skickade ingen film (tom fil)';
      console.error('[nedladdning] tom fil:', it.title);
    } else if (code === 0 && fs.existsSync(out)) {
      try {
        fs.renameSync(out, fileOf(it));
        it.status = 'done'; it.pct = 1; it.done = Date.now(); it.bytes = fs.statSync(fileOf(it)).size; it.err = '';
        console.log('[nedladdning] klar:', it.title, Math.round(it.bytes / 1e6) + ' MB');
      } catch (e) { it.status = 'error'; it.err = e.message; }
    } else {
      fs.rm(out, { force: true }, () => {});
      it.status = 'error';
      it.err = (err.split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg avslutades med fel ' + code).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<länk>').slice(0, 200);
      console.error('[nedladdning] fel:', it.title, it.err);
    }
    save();
    pumpSoon();
  });
}

let pumpT = null;
function pumpSoon() { if (!pumpT) pumpT = setTimeout(() => { pumpT = null; pump(); }, 500); }

/** Start the next queued download when the provider has a free connection. */
function pump() {
  load();
  const maxConn = deps.maxConn() || 1;
  const limit = maxConn >= 4 ? 2 : 1;
  if (run.size >= limit) return;
  if (deps.busy()) return;
  const next = [...items.values()].filter(x => x.status === 'queued').sort((a, b) => (a.created - b.created) || (a.ord || 0) - (b.ord || 0))[0];
  if (next && !run.has(next.id)) start(next).catch((e) => { run.delete(next.id); next.status = 'error'; next.err = e.message; save(); });
}
setInterval(pump, 8000).unref();

module.exports = { configure, doneFor, add, list, get, fileOf, remove, cancel, yieldTo, active, pump, view };
