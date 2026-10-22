'use strict';
/*
 * A fake IPTV provider (Xtream Codes API + M3U + XMLTV + media) for tests and local demos.
 *   node test/mock-provider.js [port] [mediaDir]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const USER = 'demo';
const PASS = 'p@ss word';

const LIVE_CATS = [
  { category_id: '1', category_name: 'SE| ALLMÄNT' },
  { category_id: '2', category_name: 'SE| SPORT' },
  { category_id: '3', category_name: 'SE| BARN' },
  { category_id: '4', category_name: 'NORDIC| NYHETER' },
  { category_id: '9', category_name: 'XXX | ADULTS' },
];
const CH = [
  ['SE: SVT1 HD', '1', 'svt1.se'], ['SE: SVT2 HD', '1', 'svt2.se'], ['SE: TV4 HD', '1', 'tv4.se'], ['SE: Kanal 5', '1', 'k5.se'],
  ['SE: TV6', '1', 'tv6.se'], ['SE: Sjuan', '1', 'sjuan.se'], ['SE: TV8', '1', 'tv8.se'], ['SE: Kanal 9', '1', 'k9.se'],
  ['SE: TV10', '1', 'tv10.se'], ['SE: TV12', '1', 'tv12.se'], ['SE: Viasat Sport Premium', '2', 'vsp.se'],
  ['SE: TV4 Sport', '2', 'tv4sport.se'], ['SE: Eurosport 1', '2', 'es1.se'], ['SE: V Sport Fotboll', '2', 'vfb.se'],
  ['SE: Barnkanalen', '3', 'barn.se'], ['SE: Disney Junior', '3', 'dj.se'], ['SE: Nickelodeon', '3', 'nick.se'], ['SE: Cartoon Network', '3', 'cn.se'],
  ['NO: NRK1', '4', 'nrk1.no'], ['DK: DR1', '4', 'dr1.dk'], ['FI: Yle TV1', '4', 'yle1.fi'], ['SE: SVT24', '4', 'svt24.se'],
  ['XXX: Hot', '9', 'x.x'],
];
const MOVIE_CATS = [
  { category_id: '10', category_name: 'SE| NYA FILMER' },
  { category_id: '11', category_name: 'SE| ACTION' },
  { category_id: '12', category_name: 'SE| BARN & FAMILJ' },
  { category_id: '13', category_name: 'SE| DRAMA' },
  { category_id: '19', category_name: 'ADULT 18+' },
  { category_id: '14', category_name: 'SE| 4K UHD' },
];
const WORDS = ['Norrsken', 'Midnattssol', 'Fjällen', 'Isvägen', 'Kalla spår', 'Sista tåget', 'Gruvan', 'Vargtimmen', 'Snöstorm', 'Polarnatt',
  'Malmfälten', 'Älvdalen', 'Tystnaden', 'Gränsen', 'Renvaktaren', 'Kebnekaise', 'Den långa vintern', 'Järnmalm', 'Blåljus', 'Stormvarning',
  'Ishotellet', 'Skuggan', 'Ödemarken', 'Torne älv', 'Kåtan', 'Vinterväg', 'Frostnatt', 'Lappland', 'Myren', 'Stjärnhimlen'];
const MOVIES = [];
for (let i = 0; i < 64; i++) {
  const cat = ['10', '11', '12', '13'][i % 4];
  const year = 1998 + (i * 7) % 28;
  MOVIES.push({
    num: i + 1, name: `SE| ${WORDS[i % WORDS.length]}${i >= WORDS.length ? ' ' + (Math.floor(i / WORDS.length) + 1) : ''} (${year})`,
    stream_id: 1000 + i, stream_icon: `/img/poster/m${i}.svg?t=${encodeURIComponent(WORDS[i % WORDS.length])}`,
    rating: ((i * 37) % 50 / 10 + 5).toFixed(1), added: String(1760000000 + i * 86400), category_id: cat,
    container_extension: i % 3 === 0 ? 'mkv' : 'mp4',
  });
}
// the same titles again in 4K, as providers often do
MOVIES.push({ num: 97, name: 'SE| Norrsken 4K (1998)', stream_id: 1097, stream_icon: '/img/poster/m0.svg?t=Norrsken', rating: '5.0', added: '1760000000', category_id: '14', container_extension: 'mkv' });
MOVIES.push({ num: 98, name: 'SE| Midnattssol (2005) [UHD]', stream_id: 1098, stream_icon: '/img/poster/m1.svg?t=Midnattssol', rating: '8.7', added: '1760000000', category_id: '14', container_extension: 'mkv' });
MOVIES.push({ num: 99, name: 'XXX Film', stream_id: 1999, stream_icon: '', rating: '0', added: '1760000000', category_id: '19', container_extension: 'mp4' });
const SERIES_CATS = [
  { category_id: '20', category_name: 'SE| SVENSKA SERIER' },
  { category_id: '21', category_name: 'SE| KRIM' },
  { category_id: '22', category_name: 'SE| BARNSERIER' },
];
const SERIES = [];
for (let i = 0; i < 18; i++) {
  SERIES.push({
    num: i + 1, name: `${WORDS[(i * 3) % WORDS.length]} – serien`, series_id: 5000 + i,
    cover: `/img/poster/s${i}.svg?t=${encodeURIComponent(WORDS[(i * 3) % WORDS.length])}`,
    plot: 'En nordisk berättelse om mörker, ljus och hemligheter i en liten gruvstad.', genre: 'Drama, Krim', cast: i === 4 ? 'Greta Gruvström, Erik Eriksson' : 'Anna Andersson', director: 'Lisa Lund',
    releaseDate: `${2010 + i}-01-01`, rating: (6 + (i % 4) * 0.7).toFixed(1), last_modified: String(1760000000 + i * 3600),
    category_id: ['20', '21', '22'][i % 3], backdrop_path: [`/img/bd/s${i}.svg?t=${encodeURIComponent(WORDS[(i * 3) % WORDS.length])}`],
  });
}

function seriesInfo(id) {
  const s = SERIES.find(x => x.series_id === +id);
  if (!s) return [];
  const seasons = 1 + (+id % 3);
  const episodes = {};
  let eid = (+id - 5000) * 100 + 7000;
  for (let sn = 1; sn <= seasons; sn++) {
    episodes[sn] = [];
    for (let e = 1; e <= 6; e++) {
      episodes[sn].push({
        id: String(eid++), episode_num: e, title: `${s.name} - S${String(sn).padStart(2, '0')}E${String(e).padStart(2, '0')} - Kapitel ${e}`,
        container_extension: 'mp4', season: sn,
        info: { movie_image: `/img/bd/e${eid}.svg?t=${encodeURIComponent('Avsnitt ' + e)}`, plot: `Avsnitt ${e}: saker ställs på sin spets.`, duration_secs: 20, duration: '00:00:20' },
      });
    }
  }
  return {
    seasons: Array.from({ length: seasons }, (_, i) => ({ season_number: i + 1, name: 'Säsong ' + (i + 1) })),
    info: { name: s.name, cover: s.cover, plot: s.plot + ' Den här beskrivningen kommer från detaljanropet.', cast: 'Anna Andersson, Erik Eriksson', director: 'Lisa Lund', genre: s.genre, releaseDate: s.releaseDate, rating: s.rating, backdrop_path: s.backdrop_path },
    episodes,
  };
}

function xmltv(now) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`; };
  const start = Math.floor(now / 1800e3) * 1800e3 - 3600e3;
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  const titles = ['Rapport', 'Morgonstudion', 'Antikrundan', 'Sportnytt', 'Bolibompa', 'Fotboll: Allsvenskan', 'Dokument inifrån', 'Kvällsöppet', 'Nyheter', 'Väder'];
  for (const [, , epg] of CH) {
    x += `  <channel id="${epg}"><display-name>${epg}</display-name></channel>\n`;
  }
  CH.forEach(([, , epg], ci) => {
    for (let i = 0; i < 24; i++) {
      const s = start + i * 1800e3;
      const t = titles[(i + ci) % titles.length];
      x += `  <programme start="${fmt(s)}" stop="${fmt(s + 1800e3)}" channel="${epg}"><title lang="en">${t} (en)</title><title lang="sv">${t}</title><desc lang="sv">Beskrivning av ${t} &amp; mer.</desc></programme>\n`;
    }
  });
  return x + '</tv>\n';
}

function posterSvg(text, w, h, seed, withText = true) {
  // a small landscape "still": sky, sun, layered mountains – enough to look like artwork in screenshots
  const hue = (seed * 47) % 360;
  const esc = (s) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const r = (n) => ((seed * 9301 + n * 49297) % 233280) / 233280;
  const ridge = (base, amp, n) => {
    let d = `M0 ${h}`;
    for (let i = 0; i <= 8; i++) d += ` L${(w * i) / 8} ${base - amp * r(n + i)}`;
    return d + ` L${w} ${h} Z`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,22%)"/><stop offset=".65" stop-color="hsl(${(hue + 25) % 360},65%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},70%,70%)"/></linearGradient>
<radialGradient id="s"><stop offset="0" stop-color="hsl(${(hue + 50) % 360},90%,85%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},90%,85%)" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * (0.25 + r(1) * 0.5)}" cy="${h * 0.48}" r="${Math.min(w, h) * 0.35}" fill="url(#s)"/>
<path d="${ridge(h * 0.68, h * 0.22, 2)}" fill="hsl(${(hue + 200) % 360},30%,30%)" opacity=".85"/>
<path d="${ridge(h * 0.8, h * 0.2, 11)}" fill="hsl(${(hue + 210) % 360},35%,18%)"/>
<path d="${ridge(h * 0.94, h * 0.12, 21)}" fill="hsl(${(hue + 220) % 360},40%,8%)"/>
${withText ? `<text x="50%" y="${h * 0.86}" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="${Math.round(w / 8)}" fill="#fff">${esc(text)}</text>` : ''}</svg>`;
}

function logoSvg(text, seed) {
  const hue = (seed * 67) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160" viewBox="0 0 300 160"><rect x="20" y="30" width="260" height="100" rx="18" fill="hsl(${hue},60%,45%)"/><text x="150" y="98" text-anchor="middle" font-family="sans-serif" font-weight="800" font-size="38" fill="#fff">${text.replace(/[<>&]/g, '')}</text></svg>`;
}

function create({ mediaDir, gzipEpg = true } = {}) {
  let host = '';
  const stats = { requests: [] };
  const server = http.createServer((req, res) => {
    if (process.env.MOCK_CORS) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Range'); res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range'); if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); } }
    const u = new URL(req.url, 'http://x');
    stats.requests.push(u.pathname + (u.search ? '?…' : ''));
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const q = u.searchParams;
    const authed = q.get('username') === USER && q.get('password') === PASS;
    const p = u.pathname;

    if (p === '/player_api.php') {
      if (!authed) return json({ user_info: { auth: 0 } });
      const a = q.get('action') || '';
      const abs = (o) => JSON.parse(JSON.stringify(o).replace(/"\/img\//g, '"' + host + '/img/'));
      switch (a) {
        case '': return json({ user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 200), max_connections: '2', active_cons: '0', is_trial: '0' }, server_info: { url: 'x' } });
        case 'get_live_categories': return json(LIVE_CATS);
        case 'get_live_streams': return json(abs(CH.map(([name, cat, epg], i) => ({ num: i + 1, name, stream_type: 'live', stream_id: 100 + i, stream_icon: `/img/logo/${i}.svg?t=${encodeURIComponent(name.replace(/^\w\w: /, ''))}`, epg_channel_id: epg, category_id: cat, tv_archive: i < 3 ? 1 : 0, tv_archive_duration: i < 3 ? 3 : 0 }))));
        case 'get_vod_categories': return json(MOVIE_CATS);
        case 'get_vod_streams': return json(abs(MOVIES));
        case 'get_series_categories': return json(SERIES_CATS);
        case 'get_series': return json(abs(SERIES));
        case 'get_vod_info': {
          const m = MOVIES.find(x => x.stream_id === +q.get('vod_id'));
          if (!m) return json({ info: [], movie_data: {} });
          const i = MOVIES.indexOf(m);
          return json(abs({ info: { plot: 'En film om ljus och mörker långt norr om polcirkeln. Beskrivning från detaljanropet.', genre: 'Drama, Thriller', cast: 'Maja Holm, Johan Berg', director: 'Sara Ek', duration: '00:00:40', duration_secs: 40, releasedate: '2021-03-01', backdrop_path: [`/img/bd/m${i}.svg?t=${encodeURIComponent(WORDS[i % WORDS.length])}`], youtube_trailer: '' }, movie_data: { stream_id: m.stream_id, name: m.name, container_extension: m.container_extension } }));
        }
        case 'get_series_info': return json(abs(seriesInfo(q.get('series_id'))));
        case 'get_short_epg': {
          const now = Date.now();
          const b = (s) => Buffer.from(s).toString('base64');
          return json({ epg_listings: [0, 1].map(i => ({ title: b('Kortprogram ' + i), description: b('Från short EPG'), start_timestamp: String(Math.floor((now - 600e3 + i * 1800e3) / 1000)), stop_timestamp: String(Math.floor((now + 1200e3 + i * 1800e3) / 1000)) })) });
        }
        default: return json([]);
      }
    }
    if (p === '/xmltv.php') {
      if (!authed) { res.writeHead(401); return res.end(); }
      const x = xmltv(Date.now());
      if (gzipEpg) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(zlib.gzipSync(x)); }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(x);
    }
    if (p === '/get.php') {
      if (!authed) { res.writeHead(401); return res.end(); }
      const enc = (s) => encodeURIComponent(s);
      let m = `#EXTM3U url-tvg="${host}/xmltv.php?username=${enc(USER)}&password=${enc(PASS)}"\n`;
      CH.forEach(([name, cat, epg], i) => {
        const g = LIVE_CATS.find(c => c.category_id === cat).category_name;
        m += `#EXTINF:-1 tvg-id="${epg}" tvg-name="${name}" tvg-logo="${host}/img/logo/${i}.svg?t=${enc(name)}" group-title="${g}",${name}\n${host}/live/${enc(USER)}/${enc(PASS)}/${100 + i}.m3u8\n`;
      });
      MOVIES.slice(0, 10).forEach((mv) => {
        m += `#EXTINF:-1 tvg-logo="${host}${mv.stream_icon}" group-title="Filmer, nya",${mv.name}\n${host}/movie/${enc(USER)}/${enc(PASS)}/${mv.stream_id}.${mv.container_extension}\n`;
      });
      for (let e = 1; e <= 3; e++) m += `#EXTINF:-1 tvg-logo="" group-title="Serier",Isvägen S01 E0${e}\n${host}/series/${enc(USER)}/${enc(PASS)}/${9000 + e}.mp4\n`;
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return res.end(m);
    }
    let mm;
    if ((mm = /^\/img\/(poster|bd|logo)\/(\w+)\.svg$/.exec(p))) {
      const t = q.get('t') || mm[2];
      const seed = [...mm[2]].reduce((a, c) => a + c.charCodeAt(0), 0);
      const svg = mm[1] === 'logo' ? logoSvg(t, seed) : mm[1] === 'poster' ? posterSvg(t, 400, 600, seed) : posterSvg(t, 1280, 720, seed, false);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
      return res.end(svg);
    }
    // media: /live/u/p/ID.m3u8 → redirect to /hls/token/index.m3u8 (like real panels)
    if ((mm = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.(m3u8|ts)$/.exec(p))) {
      if (decodeURIComponent(mm[1]) !== USER || decodeURIComponent(mm[2]) !== PASS) { res.writeHead(403); return res.end(); }
      if (mm[4] === 'm3u8') { res.writeHead(302, { Location: `/hls/tok${mm[3]}/index.m3u8` }); return res.end(); }
      return serveFile(res, req, path.join(mediaDir || '', 'clip.ts'), 'video/mp2t');
    }
    // catch-up: /timeshift/u/p/minutes/YYYY-MM-DD:HH-MM/ID.(ts|m3u8)
    if ((mm = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/(\d{4}-\d\d-\d\d:\d\d-\d\d)\/(\d+)\.(m3u8|ts)$/.exec(p))) {
      if (decodeURIComponent(mm[1]) !== USER || decodeURIComponent(mm[2]) !== PASS) { res.writeHead(403); return res.end(); }
      if (mm[6] === 'm3u8') { res.writeHead(302, { Location: `/hls/ts${mm[5]}/index.m3u8` }); return res.end(); }
      return serveFile(res, req, path.join(mediaDir || '', 'clip.ts'), 'video/mp2t');
    }
    if ((mm = /^\/hls\/(\w+)\/(.+)$/.exec(p))) {
      const f = path.join(mediaDir || '', 'hls', path.basename(mm[2]));
      if (mm[2].endsWith('.m3u8')) {
        // serve playlist as text/plain to exercise sniffing, with relative segment URIs
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(fs.readFileSync(f));
      }
      return serveFile(res, req, f, 'video/mp4');
    }
    if ((mm = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/.exec(p))) {
      if (decodeURIComponent(mm[2]) !== USER || decodeURIComponent(mm[3]) !== PASS) { res.writeHead(403); return res.end(); }
      const ext = mm[5];
      const id = +mm[4];
      const f = ext === 'mkv' ? (id === 1003 ? 'vp9dts.mkv' : 'movie.mkv') : id === 1001 ? 'ac3.mp4' : 'movie.mp4';
      return serveFile(res, req, path.join(mediaDir || '', f), ext === 'mkv' ? 'video/x-matroska' : 'video/mp4');
    }
    res.writeHead(404);
    res.end('nope');
  });
  return {
    server, stats, USER, PASS,
    listen(port = 0) {
      return new Promise(ok => server.listen(port, '127.0.0.1', () => { host = 'http://127.0.0.1:' + server.address().port; ok(host); }));
    },
    get host() { return host; },
    close() { return new Promise(ok => { server.close(ok); if (server.closeAllConnections) server.closeAllConnections(); }); },
  };
}

function serveFile(res, req, file, type) {
  let st;
  try { st = fs.statSync(file); } catch (_) { res.writeHead(404); return res.end(); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

module.exports = { create, USER, PASS };

if (require.main === module) {
  const port = +process.argv[2] || 9911;
  const m = create({ mediaDir: process.argv[3] || path.join(__dirname, 'media') });
  m.listen(port).then(h => console.log('mock provider on ' + h + '  user=' + USER + ' pass=' + PASS));
}
