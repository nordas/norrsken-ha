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

function probe(url, ua) {
  const c = probes.get(url);
  if (c) return Promise.resolve(c);
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-user_agent', ua || DEFAULT_UA, '-rw_timeout', '15000000', url];
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
        const res = {
          dur: parseFloat(j.format && j.format.duration) || 0,
          video: (streams.find(s => s.codec_type === 'video') || {}).codec_name || '',
          height: (streams.find(s => s.codec_type === 'video') || {}).height || 0,
          pix: (streams.find(s => s.codec_type === 'video') || {}).pix_fmt || '',
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
        probes.set(url, res);
        resolve(res);
      } catch (e) { reject(new Error('Kunde inte läsa filen')); }
    });
  });
}

function killOnClose(res, p) {
  const kill = () => { try { p.kill('SIGKILL'); } catch (_) { /* gone */ } };
  res.on('close', kill);
  p.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
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
  let aout;
  if (!audio || audioMode === 'copy') aout = { copy: true };
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

/** Remux to fragmented MP4 starting at `ss` seconds, picking audio track `a`; converts only what the screen can't play. */
async function remux(req, res, url, { ss = 0, a = 0, ua, audioMode = 'auto', maxRes = 'orig', caps = {} } = {}) {
  let info = null;
  try { info = await probe(url, ua); } catch (_) { /* go blind */ }
  const p = plan(info, caps, { a, audioMode, maxRes });
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', ua || DEFAULT_UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', url, '-map', '0:v:0', '-map', '0:a:' + (a | 0) + '?');
  if (p.videoCopy) {
    args.push('-c:v', 'copy');
    if (/hevc|h265/.test(p.vcodec)) args.push('-tag:v', 'hvc1');
  } else {
    // picture in a format the screen can't decode: H.264, in 4K unless "max 1080p" is chosen
    const vf = p.scale ? "scale='min(1920,iw)':-2" : "scale='min(3840,iw)':-2";
    args.push('-c:v', 'libx264', '-preset', p.big ? 'superfast' : 'veryfast', '-crf', p.big ? '22' : '20',
      '-maxrate', p.big && !p.scale ? '40M' : '12M', '-bufsize', p.big && !p.scale ? '80M' : '24M',
      '-pix_fmt', 'yuv420p', '-threads', '0', '-vf', vf);
  }
  if (p.audio.copy) args.push('-c:a', 'copy');
  else args.push('-c:a', p.audio.codec, '-b:a', p.audio.br, '-ac', String(p.audio.ch));
  args.push('-sn', '-dn', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-frag_duration', '3000000', 'pipe:1');
  const proc = spawn(FF, args);
  killOnClose(res, proc);
  let err = '';
  proc.stderr.on('data', d => { if (err.length < 2000) err += d; });
  proc.on('close', (code) => { if (code && code !== 255) console.error('[remux] ffmpeg exit', code, err.split('\n').slice(-3).join(' ')); });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  proc.stdout.pipe(res);
}

/** Extract embedded text subtitle `s` as WebVTT, with absolute timestamps, starting near `ss`. */
function subs(req, res, url, { s = 0, ss = 0, ua } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', ua || DEFAULT_UA, '-reconnect', '1', '-reconnect_streamed', '1'];
  if (ss > 0) args.push('-ss', String(Math.max(0, ss - 5)), '-copyts');
  args.push('-i', url, '-map', '0:s:' + (s | 0), '-vn', '-an', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1');
  const p = spawn(FF, args);
  killOnClose(res, p);
  p.stderr.on('data', () => {});
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  p.stdout.pipe(res);
}

module.exports = { has, probe, remux, subs, langName, plan, playsAsIs };
