'use strict';
const { spawn, spawnSync } = require('child_process');
const { DEFAULT_UA, LRU } = require('./util');

/**
 * Optional ffmpeg helpers. With ffmpeg installed on the server the app can:
 *  - remux MKV/AVI to fragmented MP4 on the fly (no re-encoding of video)
 *  - switch audio language
 *  - pull embedded text subtitles out as WebVTT
 */
const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const FP = process.env.FFPROBE_PATH || 'ffprobe';
let available = null;
const probes = new LRU(300, 3600e3);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'stl', 'vplayer']);

function has() {
  if (available === null) {
    try {
      available = spawnSync(FF, ['-version'], { timeout: 5000 }).status === 0 && spawnSync(FP, ['-version'], { timeout: 5000 }).status === 0;
    } catch (_) { available = false; }
  }
  return available;
}

const LANGS = {
  swe: 'Svenska', sv: 'Svenska', eng: 'Engelska', en: 'Engelska', nor: 'Norska', nob: 'Norska', no: 'Norska', dan: 'Danska', da: 'Danska',
  fin: 'Finska', fi: 'Finska', ger: 'Tyska', deu: 'Tyska', de: 'Tyska', fre: 'Franska', fra: 'Franska', fr: 'Franska', spa: 'Spanska',
  es: 'Spanska', ita: 'Italienska', it: 'Italienska', jpn: 'Japanska', ja: 'Japanska', kor: 'Koreanska', ara: 'Arabiska', tur: 'Turkiska',
  pol: 'Polska', rus: 'Ryska', dut: 'Nederländska', nld: 'Nederländska', por: 'Portugisiska', ice: 'Isländska', isl: 'Isländska',
  chi: 'Kinesiska', zho: 'Kinesiska', hin: 'Hindi', und: '',
};
function langName(code) { return LANGS[String(code || '').toLowerCase()] ?? String(code || '').toUpperCase(); }

const probing = new Map();
/** Read a file's streams. Concurrent calls for the same file share one ffprobe (providers often allow one connection). */
function probe(url, ua) {
  const c = probes.get(url);
  if (c) return Promise.resolve(c);
  if (probing.has(url)) return probing.get(url);
  const pr = probeOnce(url, ua).finally(() => probing.delete(url));
  probing.set(url, pr);
  return pr;
}

/** HDR kind of a video stream from ffprobe: 'Dolby Vision', 'HDR10', 'HLG' or ''. */
function hdrOf(vs) {
  const sd = (vs.side_data_list || []).map(x => String(x.side_data_type || '')).join(' ');
  if (/dovi|dolby vision/i.test(sd) || /^dv(h1|he|a1|av)$/i.test(vs.codec_tag_string || '')) return 'Dolby Vision';
  const tr = String(vs.color_transfer || '');
  if (tr === 'smpte2084') return /hdr10\+|dynamic hdr/i.test(sd) ? 'HDR10+' : 'HDR10';
  if (tr === 'arib-std-b67') return 'HLG';
  return '';
}

/** Bitstream filters this ffmpeg has (to write the picture's shape into the video itself). */
let bsfs = null;
function hasBsf(name) {
  if (bsfs === null) {
    try { bsfs = new Set(String(spawnSync(FF, ['-hide_banner', '-bsfs'], { timeout: 5000 }).stdout || '').split(/\s+/)); } catch (_) { bsfs = new Set(); }
  }
  return bsfs.has(name);
}
/**
 * Non-square pixels (anamorphic TV/DVD pictures, MKVs that only state the shape in the container): written into the
 * copied video itself too, or a TV or AirPlay receiver shows the picture squeezed with black sides.
 */
function aspectArgs(info, p) {
  const sar = info && info.sar;
  if (!sar || sar === '1:1' || sar === '0:1') return [];
  const out = [];
  const bsf = /hevc|h265/.test(p.vcodec) ? 'hevc_metadata' : p.vcodec === 'h264' ? 'h264_metadata' : '';
  if (bsf && hasBsf(bsf)) out.push('-bsf:v', bsf + '=sample_aspect_ratio=' + sar.replace(':', '/'));
  if (info.dar) out.push('-aspect', info.dar);
  return out;
}

function probeOnce(url, ua) {
  return new Promise((resolve, reject) => {
    // only the start of the file: enough for codecs and tracks, and seconds faster on big MKVs over the internet
    const args = ['-v', 'error', '-probesize', '8M', '-analyzeduration', '4M', '-print_format', 'json', '-show_streams', '-show_format', '-user_agent', ua || DEFAULT_UA, '-rw_timeout', '15000000', url];
    const p = spawn(FP, args);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', () => {});
    const t = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        const streams = j.streams || [];
        let ai = 0;
        let si = 0;
        const vs = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || {};
        const res = {
          dur: parseFloat(j.format && j.format.duration) || 0,
          br: parseInt(j.format && j.format.bit_rate, 10) || 0,
          video: vs.codec_name || '',
          height: vs.height || 0,
          width: vs.width || 0,
          pix: vs.pix_fmt || '',
          sar: /^\d+:\d+$/.test(vs.sample_aspect_ratio || '') ? vs.sample_aspect_ratio : '',
          dar: /^\d+:\d+$/.test(vs.display_aspect_ratio || '') ? vs.display_aspect_ratio : '',
          hdr: hdrOf(vs),
          audio: [],
          subs: [],
        };
        for (const s of streams) {
          const tags = s.tags || {};
          if (s.codec_type === 'audio') {
            res.audio.push({ i: ai++, codec: s.codec_name, lang: tags.language || '', label: langName(tags.language) || 'Ljud ' + ai, title: tags.title || '', ch: s.channels || 0, def: !!(s.disposition && s.disposition.default) });
          } else if (s.codec_type === 'subtitle') {
            const text = TEXT_SUBS.has(s.codec_name);
            res.subs.push({ i: si++, codec: s.codec_name, lang: tags.language || '', label: langName(tags.language) || 'Undertext ' + si, title: tags.title || '', text, forced: !!(s.disposition && s.disposition.forced) });
          }
        }
        if (!res.video && !res.audio.length) return reject(new Error('Kunde inte läsa filen'));
        probes.set(url, res);
        resolve(res);
      } catch (e) { reject(new Error('Kunde inte läsa filen')); }
    });
  });
}

/**
 * Decide what has to be converted for this screen.
 * caps: what the viewing device decodes, e.g. { ac3: true, eac3: true, hevc: true, hevc10: true }.
 * opts.audioMode:
 *   auto  – keep the original sound when the screen can play it; DTS / TrueHD / FLAC / PCM become
 *           Dolby Digital Plus 5.1 (or Dolby Digital 5.1, or AAC) depending on what the screen supports
 *   eac3  – always Dolby Digital Plus 5.1      ac3 – always Dolby Digital 5.1
 *   aac   – always AAC stereo                  copy – never touch the sound
 * opts.maxRes: 'orig' keeps 4K when the picture has to be converted, '1080' scales down (lighter on the server).
 */
function plan(info, caps = {}, { a = 0, audioMode = 'auto', maxRes = 'orig' } = {}) {
  const audio = info && info.audio[a];
  const ac = audio ? audio.codec : '';
  const ch = audio ? audio.ch || 2 : 2;
  const plays = (c) => c === 'aac' || c === 'mp3' || (c === 'ac3' && caps.ac3) || (c === 'eac3' && caps.eac3) || (c === 'opus' && caps.opus) || (c === 'flac' && caps.flac);
  // lossless multichannel: FLAC keeps every channel (up to 7.1) and every bit of TrueHD / DTS-HD MA / PCM
  const lossless = { codec: 'flac', ch: Math.min(ch, 8), br: '' };
  const hiRes = /truehd|mlp|dts|pcm|flac|alac/.test(ac);
  let aout;
  if (!audio || audioMode === 'copy') aout = { copy: true };
  else if (audioMode === 'lossless') aout = plays(ac) && !hiRes ? { copy: true } : (ac === 'flac' && caps.flac ? { copy: true } : lossless);
  else if (audioMode === 'auto' && hiRes && caps.flac && !plays(ac)) aout = lossless;
  else if (audioMode === 'aac') aout = ac === 'aac' && ch <= 2 ? { copy: true } : { codec: 'aac', ch: 2, br: '192k' };
  else if (audioMode === 'eac3') aout = ac === 'eac3' ? { copy: true } : { codec: 'eac3', ch: Math.min(ch, 6), br: ch > 2 ? '768k' : '256k' };
  else if (audioMode === 'ac3') aout = ac === 'ac3' ? { copy: true } : { codec: 'ac3', ch: Math.min(ch, 6), br: ch > 2 ? '640k' : '256k' };
  else if (plays(ac)) aout = { copy: true };
  else if (caps.eac3) aout = { codec: 'eac3', ch: Math.min(ch, 6), br: ch > 2 ? '768k' : '256k' };
  else if (caps.ac3) aout = { codec: 'ac3', ch: Math.min(ch, 6), br: ch > 2 ? '640k' : '256k' };
  else aout = { codec: 'aac', ch: 2, br: '192k' };

  const vc = info ? info.video : '';
  const tenBit = info && /10/.test(info.pix || '');
  const hevcOk = caps.hevc && (!tenBit || caps.hevc10);
  const vcopy = !info || vc === 'h264' || ((vc === 'hevc' || vc === 'h265') && hevcOk) || (vc === 'vp9' && caps.vp9) || (vc === 'av1' && caps.av1);
  const big = info && info.height > 1100;
  return { audio: aout, videoCopy: vcopy, scale: !vcopy && big && maxRes === '1080', big, vcodec: vc };
}

/** True when the file can be played as it is (no conversion at all). */
function playsAsIs(info, caps, opts) {
  const p = plan(info, caps, opts);
  return p.videoCopy && p.audio.copy;
}


/* ------------------------------------------------------------------ HLS conversion
   Works everywhere, including Safari and iPhone (which can't play a streamed MP4 without byte ranges).
   One session per film; seeking far away restarts it at the new position. */
const fs = require('fs');
const os = require('os');
const path = require('path');
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
const HLS_ROOT = process.env.NSK_HLS_DIR || path.join(os.tmpdir(), 'norrsken-hls');
const sessions = new Map(); // key -> session
const starting = new Map(); // key -> promise of the session being set up (two requests at once get one ffmpeg)
const HLS_MIN_FREE = 1.5e9; // leave room on the disk, like the pause recordings
/** Whatever an earlier run left behind (called when the server starts, not when the module is loaded). */
function cleanStart() { try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch (_) { /* nothing */ } }
function freeBytes(dir) {
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch (_) { return Infinity; }
}

function argsFor(info, p, url, ss, a, ua, dir) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-user_agent', ua || DEFAULT_UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  args.push('-probesize', '8M', '-analyzeduration', '3M', '-fflags', '+genpts+discardcorrupt');
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', url, '-map', '0:v:0', '-map', '0:a:' + (a | 0) + '?');
  if (p.videoCopy) {
    args.push('-c:v', 'copy');
    if (/hevc|h265/.test(p.vcodec)) args.push('-tag:v', 'hvc1');
    args.push(...aspectArgs(info, p));
  } else {
    const vf = p.scale ? "scale='min(1920,iw)':-2" : "scale='min(3840,iw)':-2";
    args.push('-c:v', 'libx264', '-preset', p.big ? 'ultrafast' : 'veryfast', '-tune', 'zerolatency', '-crf', p.big ? '23' : '21',
      '-g', '96', '-keyint_min', '48', '-sc_threshold', '0', '-maxrate', p.scale ? '10M' : '30M', '-bufsize', p.scale ? '20M' : '60M',
      '-pix_fmt', 'yuv420p', '-threads', '0', '-vf', vf);
  }
  if (p.audio.copy) args.push('-c:a', 'copy');
  else if (p.audio.codec === 'flac') args.push('-c:a', 'flac', '-compression_level', '2', '-ac', String(p.audio.ch), '-strict', '-2');
  else args.push('-c:a', p.audio.codec, '-b:a', p.audio.br, '-ac', String(p.audio.ch));
  args.push('-sn', '-dn', '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '2048',
    '-f', 'hls', '-hls_init_time', '1', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 's%05d.m4s'), path.join(dir, 'index.m3u8'));
  // the film's text subtitles from the same read of the file (no second connection to the provider): sub<i>.vtt
  for (const sb of textSubs(info)) {
    args.push('-map', '0:s:' + sb.i, '-c:s', 'webvtt', '-flush_packets', '1', '-max_muxing_queue_size', '2048', '-f', 'webvtt', path.join(dir, 'sub' + sb.i + '.vtt'));
  }
  return args;
}
const BITMAP_SUBS = /^(hdmv_pgs_subtitle|pgssub|dvd_subtitle|dvdsub|dvb_subtitle|dvbsub|xsub)$/;
function textSubs(info) { return ((info && info.subs) || []).filter(sb => sb.text && !BITMAP_SUBS.test(sb.codec || '')); }

/** The conversion of this film (its token) and the subtitle file it writes, if any. */
function subSession(group, i) {
  for (const s of sessions.values()) {
    if (s.group !== group || s.dead) continue;
    const f = path.join(s.dir, 'sub' + (i | 0) + '.vtt');
    return { s, file: f, has: s.subs && s.subs.includes(i | 0) };
  }
  return null;
}

function stopSession(s) {
  if (!s || s.dead) return;
  s.dead = true;
  sessions.delete(s.key);
  try { s.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  setTimeout(() => fs.rm(s.dir, { recursive: true, force: true }, () => {}), 2000);
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.last > 90e3) stopSession(s);
}, 15e3).unref();

const KEEP_BEHIND = 150; // segments (about 10 min) kept behind the viewer when the disk runs low
/**
 * The disk while converting (a long 4K film is tens of GB): when it runs low, free what the viewer has already
 * watched (except the last 10 min); if that isn't enough, end the conversion where it is rather than fill the disk.
 */
function guardDisk(free = freeBytes) {
  if (!sessions.size || free(HLS_ROOT) >= HLS_MIN_FREE * 0.6) return;
  for (const s of sessions.values()) {
    const upTo = (s.seen || 0) - KEEP_BEHIND;
    if (upTo > 0) {
      let n = 0;
      for (let i = s.freed || 0; i < upTo; i++) { try { fs.unlinkSync(path.join(s.dir, 's' + String(i).padStart(5, '0') + '.m4s')); n++; } catch (_) { /* gone */ } }
      s.freed = Math.max(s.freed || 0, upTo);
      if (n) console.log('[remux] disken börjar bli full: tog bort', n, 'redan sedda delar');
    }
  }
  if (free(HLS_ROOT) >= HLS_MIN_FREE * 0.3) return;
  for (const s of sessions.values()) {
    if (s.done || s.full) continue;
    s.full = true;
    console.log('[remux] disken är full: konverteringen stannar här');
    try { s.proc.kill('SIGINT'); } catch (_) { /* gone */ }
  }
}
setInterval(() => guardDisk(), 15e3).unref();

/**
 * Get (or start) a conversion session. opts: { group, ss, a, ua, audioMode, maxRes, caps, safe }
 * group identifies the film: starting a new position stops the old one, so the provider only sees one connection.
 */
function hlsSession(url, opts) {
  const { group, ss = 0, a = 0, safe = false, caps = {} } = opts;
  const key = group + '|' + Math.floor(ss) + '|' + a + '|' + (safe ? 's' : Object.keys(caps).sort().join(','));
  const s = sessions.get(key);
  if (s && !s.dead) { s.last = Date.now(); return Promise.resolve(s); }
  // a second request for the same thing while the first is still being set up (hls.js retries, double taps)
  if (starting.has(key)) return starting.get(key);
  const pr = startSession(url, key, opts).finally(() => starting.delete(key));
  starting.set(key, pr);
  return pr;
}

async function startSession(url, key, opts) {
  const { group, ss = 0, a = 0, ua, audioMode = 'auto', maxRes = 'orig', caps = {}, safe = false } = opts;
  let s;
  // the disk first: a film that can't start doesn't stop the one that plays
  fs.mkdirSync(HLS_ROOT, { recursive: true });
  if (freeBytes(HLS_ROOT) < HLS_MIN_FREE) throw new Error('För lite ledigt diskutrymme för att konvertera filmen');
  // the provider gives one connection: a new conversion ends every other one (another film, another device)
  for (const o of sessions.values()) stopSession(o);
  let info = null;
  try { info = await probe(url, ua); } catch (_) { /* go blind */ }
  const p = plan(info, safe ? {} : caps, { a, audioMode, maxRes: safe ? '1080' : maxRes });
  if (safe && !p.videoCopy) p.scale = true;
  for (const o of sessions.values()) stopSession(o); // started meanwhile (the probe takes a moment)
  const id = Math.random().toString(36).slice(2, 10);
  const dir = path.join(HLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  console.log('[remux]', info ? info.video + ' ' + info.height + 'p ' + (info.audio[a] || {}).codec : 'okänd fil', '→ bild', p.videoCopy ? 'orörd' : 'H.264' + (p.scale ? ' 1080p' : ''), '· ljud', p.audio.copy ? 'orört' : p.audio.codec + ' ' + p.audio.ch + 'ch', '· från', Math.floor(ss) + 's', '(HLS)');
  s = { key, group, id, dir, proc: null, last: Date.now(), dead: false, err: '', done: false, tries: 0, ss: Math.max(0, +ss || 0), subs: textSubs(info).map(sb => sb.i) };
  const start = () => {
    const proc = s.proc = spawn(FF, argsFor(info, p, url, ss, a, ua, dir));
    proc.stderr.on('data', d => { if (s.err.length < 3000) s.err += d; });
    // speed log: how fast the film arrives from the provider compared with playing it (under 1.0× = it will buffer)
    const t0 = Date.now();
    let lastLog = 0, firstSeen = false, buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      const kv = {};
      for (const l of lines) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
      const outS = (+kv.out_time_us || +kv.out_time_ms || 0) / 1e6;
      if (!firstSeen && fs.existsSync(path.join(dir, 's00000.m4s'))) {
        firstSeen = true;
        console.log('[remux] första bilden klar efter', ((Date.now() - t0) / 1000).toFixed(1), 's');
      }
      const now = Date.now();
      if (outS > 0) { s.speed = outS / Math.max(0.5, (now - t0) / 1000); s.out = outS; }
      if (outS > 0 && now - lastLog > 20000) {
        lastLog = now;
        const el = (now - t0) / 1000;
        const x = outS / el;
        console.log('[remux] hastighet', x.toFixed(2) + '×', '·', Math.round(outS) + ' s film på', Math.round(el) + ' s', '·', kv.bitrate || '', x < 1.05 ? '· FÖR LÅNGSAMT: leverantören/nätet hinner inte' : '');
      }
    });
    proc.on('close', (code) => {
      if (s.dead) return;
      // the provider answered with an error page (often: the previous stream's connection hadn't closed yet): try once more
      const nothing = !fs.existsSync(path.join(dir, 'init.mp4'));
      if (code && code !== 255 && nothing && s.tries < 1) {
        s.tries++;
        console.log('[remux] leverantören svarade inte med video – försöker igen');
        s.err = '';
        setTimeout(() => { if (!s.dead) start(); }, 1500);
        return;
      }
      s.done = true;
      if (code && code !== 255) console.error('[remux] ffmpeg fel', code, hideLinks(s.err.split('\n').slice(-4).join(' ')));
    });
  };
  start();
  sessions.set(key, s);
  return s;
}

/** Playlist for a session, waiting for the first segment. Segment URIs point at prefix/<id>/. */
async function hlsPlaylist(s, prefix) {
  const f = path.join(s.dir, 'index.m3u8');
  const t0 = Date.now();
  for (;;) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { /* not yet */ }
    if (/#EXTINF/.test(text)) {
      // the playlist grows while converting: tell players to start at the beginning, not at the "live" end
      // (Safari/iPhone otherwise jump forward and keep buffering)
      if (text.indexOf('#EXT-X-START') < 0) text = text.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
      return text.split('\n').map((l) => {
        if (l.startsWith('#EXT-X-MAP:URI="')) return l.replace(/URI="([^"]+)"/, (m, u) => 'URI="' + prefix + '/' + s.id + '/' + path.basename(u) + '"');
        if (l && l[0] !== '#') return prefix + '/' + s.id + '/' + path.basename(l.trim());
        return l;
      }).join('\n');
    }
    if (s.done || s.dead) throw new Error(hideLinks(s.err.split('\n').filter(Boolean).slice(-1)[0]) || 'Konverteringen avbröts');
    if (Date.now() - t0 > 45000) throw new Error('Konverteringen kom inte igång');
    await new Promise(ok => setTimeout(ok, 300));
  }
}

function hlsFile(id, name) {
  for (const s of sessions.values()) {
    if (s.id === id) {
      s.last = Date.now();
      if (!/^(init\.mp4|s\d{5}\.m4s)$/.test(name)) return null;
      const n = /^s(\d{5})/.exec(name);
      if (n) s.seen = Math.max(s.seen || 0, +n[1]); // how far the viewer has got (for freeing the disk behind them)
      return path.join(s.dir, name);
    }
  }
  return null;
}

function activeSessions() { return sessions.size + starting.size; }
function stopAll() { for (const o of sessions.values()) stopSession(o); }
/** The player was closed: free the provider connection at once instead of after 90 s. */
function stopGroup(group) { for (const o of sessions.values()) if (o.group === group) stopSession(o); }

/** How a conversion keeps up: { speed: film seconds per second, out: seconds made } (newest session of the film). */
function sessionStat(group) {
  let best = null;
  for (const s of sessions.values()) if (s.group === group && !s.dead && (!best || s.last > best.last)) best = s;
  return best ? { speed: best.speed || 0, out: best.out || 0, done: !!best.done } : null;
}

module.exports = { _hideLinks: hideLinks, subSession, textSubs, _guardDisk: guardDisk, _sessions: sessions, cleanStart, stopGroup, stopAll, activeSessions, has, probe, langName, plan, playsAsIs, hlsSession, hlsPlaylist, hlsFile, sessionStat, aspectArgs };
