'use strict';
/**
 * Favourite team on the start page (like TV4 Play): find the team's match in the TV guide while it is on
 * or about to start, and the channel to watch it on.
 */

// SHL 2026/27 plus a few more Swedish hockey teams. re matches the team in a programme title.
const TEAMS = [
  { id: 'lulea', name: 'Luleå Hockey', short: 'Luleå', re: /lule[åa]/i, col: ['#c8102e', '#111111'] },
  { id: 'bjorkloven', name: 'IF Björklöven', short: 'Björklöven', re: /bj[öo]rkl[öo]ven/i, col: ['#00843d', '#f2c500'] },
  { id: 'brynas', name: 'Brynäs IF', short: 'Brynäs', re: /bryn[äa]s/i, col: ['#f2c500', '#d0102c'] },
  { id: 'djurgarden', name: 'Djurgården', short: 'Djurgården', re: /djurg[åa]rden|\bdif\b/i, col: ['#0a2240', '#d4202a'] },
  { id: 'frolunda', name: 'Frölunda HC', short: 'Frölunda', re: /fr[öo]lunda/i, col: ['#008b4f', '#111111'] },
  { id: 'farjestad', name: 'Färjestad BK', short: 'Färjestad', re: /f[äa]rjestad|\bfbk\b/i, col: ['#008a3e', '#f5c400'] },
  { id: 'hv71', name: 'HV71', short: 'HV71', re: /\bhv\s?71\b/i, col: ['#0d3b8c', '#f2c500'] },
  { id: 'linkoping', name: 'Linköping HC', short: 'Linköping', re: /link[öo]ping|\blhc\b/i, col: ['#0b4fa0', '#e4002b'] },
  { id: 'malmo', name: 'Malmö Redhawks', short: 'Malmö', re: /malm[öo] redhawks|redhawks|malm[öo](?! ff)/i, col: ['#c8102e', '#ffffff'] },
  { id: 'rogle', name: 'Rögle BK', short: 'Rögle', re: /r[öo]gle/i, col: ['#00843d', '#ffffff'] },
  { id: 'skelleftea', name: 'Skellefteå AIK', short: 'Skellefteå', re: /skellefte[åa]/i, col: ['#111111', '#f5c400'] },
  { id: 'timra', name: 'Timrå IK', short: 'Timrå', re: /timr[åa]/i, col: ['#c8102e', '#ffffff'] },
  { id: 'vaxjo', name: 'Växjö Lakers', short: 'Växjö', re: /v[äa]xj[öo]/i, col: ['#f26522', '#0b2d5b'] },
  { id: 'orebro', name: 'Örebro Hockey', short: 'Örebro', re: /[öo]rebro/i, col: ['#111111', '#e4002b'] },
  { id: 'leksand', name: 'Leksands IF', short: 'Leksand', re: /leksand/i, col: ['#0b4fa0', '#ffffff'] },
  { id: 'modo', name: 'Modo Hockey', short: 'Modo', re: /\bmodo\b/i, col: ['#c8102e', '#00843d'] },
  { id: 'aik', name: 'AIK', short: 'AIK', re: /\baik\b(?! fotboll)/i, col: ['#0a2240', '#f5c400'] },
  { id: 'tre-kronor', name: 'Tre Kronor', short: 'Sverige', re: /tre kronor|sverige|sweden/i, col: ['#005293', '#fecb00'] },
];
const BY_ID = new Map(TEAMS.map(t => [t.id, t]));

/** Hockey, not football or news: something hockey-ish in the title, description or channel name. */
const HOCKEY = /hockey|\bshl\b|\bchl\b|hockeyallsvenskan|ishockey|redhawks|lakers|tre kronor/i;
const NOT_LIVE = /\b(repris|i repris|h[öo]jdpunkter|highlights|sammandrag|studio|magasin|efter matchen)\b|\(r\)/i;

function teamId(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === '' || s === 'none' || s === 'inget') return 'none';
  if (BY_ID.has(s)) return s;
  const t = TEAMS.find(x => x.re.test(s) || x.name.toLowerCase() === s);
  return t ? t.id : 'lulea';
}
function team(id) { return BY_ID.get(id) || null; }
function list() { return TEAMS.map(t => ({ id: t.id, name: t.name })); }

/** "SHL: Luleå Hockey - Färjestad BK" → { home: 'Luleå', away: 'Färjestad' } (short names when known). */
function matchup(title, fav) {
  const clean = String(title || '').replace(/^(live|direkt|sport|ishockey|hockey|shl|chl|hockeyallsvenskan)\s*[:|.\-–]\s*/gi, '').replace(/^(live|direkt|sport|ishockey|hockey|shl|chl|hockeyallsvenskan)\s*[:|.\-–]\s*/gi, '');
  const m = /^(.+?)\s+(?:[-–—]|vs\.?|mot)\s+(.+?)(?:\s*[,(|].*)?$/i.exec(clean);
  if (!m) return null;
  const name = (s) => {
    const t = TEAMS.find(x => x.re.test(s));
    return t ? t.short : s.replace(/\s+(hockey|hc|if|bk|ik|aik)$/i, '').trim();
  };
  const home = name(m[1]), away = name(m[2]);
  if (!home || !away || home === away) return null;
  if (fav && !fav.re.test(m[1]) && !fav.re.test(m[2])) return null;
  return { home, away };
}

/** How good a channel is for the match: HD before SD, Swedish before others, not "backup"/"alt". */
function channelScore(name) {
  const n = String(name || '');
  let s = 0;
  if (/\b(fhd|hd|1080)\b/i.test(n)) s += 3;
  if (/\b(4k|uhd)\b/i.test(n)) s += 2;
  if (/\bsd\b/i.test(n)) s -= 3;
  if (/(^|[\s|:[(])(se|swe|sverige)([\s|:\])]|$)/i.test(n)) s += 2;
  if (/backup|alt\b|\braw\b/i.test(n)) s -= 4;
  if (/hockey|sport/i.test(n)) s += 1;
  return s;
}

const SE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** Swedish wall clock of an instant: its date, and the wall time as if it were UTC (ms). */
function wall(ms) {
  const p = {};
  for (const q of SE_FMT.formatToParts(new Date(ms))) p[q.type] = +q.value;
  return { y: p.year, mo: p.month, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
}
/** The instant (ms) of a Swedish wall-clock time; two passes get the summer/winter time change right. */
function stockholmTime(y, mo, d, hh = 0, mm = 0) {
  const g = Date.UTC(y, mo - 1, d, hh, mm);
  let t = g;
  for (let i = 0; i < 2; i++) t = g - (wall(t).ms - Math.floor(t / 1000) * 1000);
  return t;
}

/** Start and end (ms) of the Swedish calendar day that contains `now`. */
function stockholmDay(now) {
  const w = wall(now);
  return { start: stockholmTime(w.y, w.mo, w.d), end: stockholmTime(w.y, w.mo, w.d + 1) };
}

/**
 * Event channels carry the match in their name and have no TV guide, like the provider's TV4 Play ones:
 * "[TV4Play] (25/10) 18:00 Luleå HF - Djurgården IF" → { s, title, label: 'TV4 Play' }. The time is Swedish time.
 */
const EVENT_RE = /^\s*\[([^\]]{2,30})\]\s*\((\d{1,2})\/(\d{1,2})\)\s*(\d{1,2})[:.](\d{2})\s+(.+?)\s*$/;
function eventOf(name, now = Date.now()) {
  const m = EVENT_RE.exec(String(name || ''));
  if (!m) return null;
  const [, label, dd, mo, hh, mm, title] = m;
  const y = wall(now).y;
  // around new year the date can belong to the year before or after
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const t = stockholmTime(yy, +mo, +dd, +hh, +mm);
    if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
  }
  return { s: best, title, label: label.replace(/^\s*tv4\s*play\s*$/i, 'TV4 Play').trim() };
}
const EVENT_LEN = 3 * 3600e3; // the name only says when it starts: a hockey broadcast is about three hours

/** Every match of the favourite's team in the calendar day (Stockholm), best first (see findMatch). */
function matchesToday(teamIdValue, channels, epg, { now = Date.now() } = {}) {
  const fav = team(teamIdValue);
  if (!fav) return [];
  if (!epg || !epg.map) epg = { map: new Map() };
  const day = stockholmDay(now);
  const hits = new Map(); // start + teams → { prog, chans: [] }
  const add = (ch, s, e, t, d, label) => {
    if (s >= day.end || s < day.start) return;
    if (!fav.re.test(t) || NOT_LIVE.test(t)) return;
    // "Luleå HF - Färjestad BK" has no hockey word in it: two known hockey clubs in the title is hockey enough
    const other = TEAMS.some(x => x !== fav && x.re.test(t));
    if (!other && !HOCKEY.test(t + ' ' + (d || '') + ' ' + (ch.n || ''))) return;
    // a programme that already ran for hours is a re-run block, not the match
    if (e - s > 5 * 3600e3) return;
    const mu = matchup(t, fav);
    const key = (mu ? mu.home + '|' + mu.away : t.toLowerCase()) + '|' + Math.round(s / 600e3);
    let h = hits.get(key);
    if (!h) hits.set(key, (h = { s, e, t, d, mu, chans: [], labels: new Map() }));
    if (!h.chans.includes(ch)) h.chans.push(ch);
    h.labels.set(ch.id, label || ch.n);
  };
  for (const ch of channels) {
    const ev = eventOf(ch.n, now);
    if (ev) { add(ch, ev.s, ev.s + EVENT_LEN, ev.title, '', ev.label); continue; }
    if (!ch.epg) continue;
    const list = epg.map.get(ch.epg);
    if (!list) continue;
    for (const p of list) {
      const [s, e, t, d] = p;
      if (s >= day.end) break;
      add(ch, s, e, t, d);
    }
  }
  // on now beats starting soon, then played; then the earliest start; then the one on most channels
  const rank = (h) => (h.s <= now && now < h.e) ? 0 : h.s > now ? 1 : 2;
  return [...hits.values()].sort((a, b) => (rank(a) - rank(b)) || a.s - b.s || b.chans.length - a.chans.length).map((best) => {
    const chans = best.chans.slice().sort((a, b) => channelScore(b.n) - channelScore(a.n));
    return {
      team: { id: fav.id, name: fav.name, short: fav.short, col: fav.col },
      state: best.s > now ? 'soon' : now < best.e ? 'live' : 'ended',
      title: best.mu ? best.mu.home + ' – ' + best.mu.away : best.t,
      raw: best.t,
      home: best.mu ? best.mu.home : '', away: best.mu ? best.mu.away : '',
      s: best.s, e: best.e, d: best.d || '',
      ch: chans[0],
      chName: best.labels.get(chans[0].id) || chans[0].n, // "TV4 Play" instead of the event channel's long name
      chans,
    };
  });
}

/** The favourite's match for the calendar day: the one to show on the start page, or null. */
function findMatch(teamIdValue, channels, epg, opts = {}) {
  return matchesToday(teamIdValue, channels, epg, opts)[0] || null;
}

module.exports = { TEAMS, teamId, team, list, matchup, findMatch, matchesToday, channelScore, stockholmDay, stockholmTime, eventOf };
