'use strict';
/**
 * AirPlay test page (/airtest): the same 20-second test picture in four forms. Opened in Safari on the iPhone and
 * sent to the TV one at a time, it shows which form the TV's AirPlay can play – so Norrsken can hand it that one.
 * The clips are made once with ffmpeg (no provider involved).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const DIR = path.join(os.tmpdir(), 'norrsken-airtest');
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20'];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v', '2500k'];
const VARIANTS = {
  a: { name: 'MP4-fil (H.264 + AAC)', file: 'a/test.mp4', args: (o) => [...SRC, ...H264, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', o] },
  b: { name: 'HLS med TS-bitar (H.264 + AAC)', file: 'b/index.m3u8', args: (o) => [...SRC, ...H264, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(path.dirname(o), 's%03d.ts'), o] },
  c: { name: 'HLS med fMP4-bitar (H.264 + AAC) – som Norrskens inspelningar', file: 'c/index.m3u8', args: (o) => [...SRC, ...H264, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(path.dirname(o), 's%03d.m4s'), o] },
  d: { name: 'HLS med fMP4-bitar (H.264 + Dolby AC-3)', file: 'd/index.m3u8', args: (o) => [...SRC, ...H264, '-c:a', 'ac3', '-b:a', '192k', '-ac', '2', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(path.dirname(o), 's%03d.m4s'), o] },
};

// live (growing) playlists like Norrsken's recordings: the TV may treat these differently from a finished one
const LIVE_SRC = ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '900'];
const LIVE_V = ['-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v', '800k', '-c:a', 'aac', '-b:a', '96k', '-ac', '2'];
const LIVE = {
  e: { name: 'LIVE: växande HLS med fMP4 och startpunkt – exakt som Norrskens inspelningar', fmp4: true },
  f: { name: 'LIVE: växande HLS med fMP4 utan startpunkt', fmp4: true },
  g: { name: 'LIVE: växande HLS med TS-bitar', fmp4: false },
};
const liveProcs = {};
function startLive() {
  for (const [k, v] of Object.entries(LIVE)) {
    const p = liveProcs[k];
    if (p && !p.done) continue;
    const dir = path.join(DIR, k);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const seg = v.fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(dir, 's%03d.m4s')] : ['-hls_segment_filename', path.join(dir, 's%03d.ts')];
    const proc = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...LIVE_SRC, ...LIVE_V, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file', ...seg, path.join(dir, 'index.m3u8')], { stdio: 'ignore' });
    proc.unref(); // a test page must never keep the add-on from stopping
    const rec = liveProcs[k] = { proc, done: false };
    proc.on('error', () => { rec.done = true; });
    proc.on('close', () => { rec.done = true; });
  }
}
/** A live test playlist; "e" gets the start line Norrsken's recordings have. */
function livePlaylist(k) {
  if (!LIVE[k]) return null;
  let t = '';
  try { t = fs.readFileSync(path.join(DIR, k, 'index.m3u8'), 'utf8'); } catch (_) { return null; }
  if (k === 'e' && t.indexOf('#EXT-X-START') < 0) t = t.replace('#EXTM3U', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES');
  return t;
}

let making = null;
/** Make the clips that are missing. */
function ensure() {
  if (making) return making;
  making = (async () => {
    for (const [k, v] of Object.entries(VARIANTS)) {
      const out = path.join(DIR, v.file);
      if (fs.existsSync(out)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await new Promise((ok) => {
        const p = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...v.args(out)]);
        let err = '';
        p.stderr.on('data', d => { err += d; });
        p.on('error', (e) => { err += e.message; ok(); });
        p.on('close', (code) => { if (code) console.error('[airtest]', k, 'gick inte att göra:', err.split('\n').filter(Boolean).slice(-1)[0]); ok(); });
      });
    }
    making = null;
  })();
  return making;
}

/** A file of the test clips (only names ffmpeg made, nothing else on the disk). */
function file(variant, name) {
  if (!(VARIANTS[variant] || LIVE[variant]) || !/^(test\.mp4|index\.m3u8|init\.mp4|s\d{3}\.(ts|m4s))$/.test(name)) return null;
  const f = path.join(DIR, variant, name);
  return fs.existsSync(f) ? f : null;
}

function page(lan, extra = []) {
  const base = (lan || '').replace(/\/$/, '');
  const sec = (k, name, src) => `
  <section><h2>${k.toUpperCase()}. ${name}</h2>
    <video controls playsinline x-webkit-airplay="allow" preload="metadata" src="${src}"></video></section>`;
  const items = Object.entries(VARIANTS).map(([k, v]) => sec(k, v.name, base + '/airtest/' + k + '/' + path.basename(v.file))).join('') +
    Object.entries(LIVE).map(([k, v]) => sec(k, v.name, base + '/airtest/' + k + '/index.m3u8')).join('') +
    extra.map((x, i) => sec(String.fromCharCode(104 + i), x.name, base + x.url)).join('');
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AirPlay-test</title><style>
body{margin:0;padding:16px;background:#0b0b0d;color:#fff;font:16px/1.4 -apple-system,system-ui,sans-serif}
h1{font-size:22px;margin:0 0 6px}p{color:#bbb;margin:0 0 16px}h2{font-size:16px;margin:18px 0 8px}
video{width:100%;aspect-ratio:16/9;background:#222;border-radius:10px}
</style></head><body>
<h1>AirPlay-test</h1>
<p>Spela en video i taget, tryck på AirPlay-symbolen i videons egna kontroller och välj tv:n. Notera för varje bokstav: bild och ljud, bara ljud, eller inget. Klippet är en färgad testbild med en ton.</p>
${items}
</body></html>`;
}

module.exports = { ensure, file, page, startLive, livePlaylist, VARIANTS, LIVE };
