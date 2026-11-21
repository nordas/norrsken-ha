'use strict';
/*
 * Which league a hockey game belongs to, from the Swedish Ice Hockey Association's own list of the day's games
 * (stats.swehockey.se, "Games by date": a heading per league – SHL, SDHL, HockeyAllsvenskan, J20 … – and the games
 * under it). The TV guide often names a game only "Djurgårdens IF - Luleå HF", the same for the men in SHL and the
 * women in SDHL; this list tells them apart. Read a few times a day for today and tomorrow, kept in memory only.
 *
 * verdict(m, team, other) → 'shl'  : the game is in SHL (or SHL's playoffs) – the team followed
 *                           'other' : the clubs meet that day only in another league (SDHL, J20 …) – not the team
 *                           null    : not in the list (CHL, a friendly, the list not read): decided from the text
 */
const https = require('https');

const DAY_MS = 86400e3;
const cache = new Map(); // 'YYYY-MM-DD' → { at, games: [{ group, time, home, away }] }
let fetcher = null; // tests put their own

function stockholmDate(t) {
  return new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }); // YYYY-MM-DD
}

const strip = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (x, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();

/** The page's table: a row with only a league's name opens a league, a row with a time and "A - B" is a game in it. */
function parse(html) {
  const games = [];
  let group = '';
  const rows = String(html).split(/<tr\b/i).slice(1);
  for (const row of rows) {
    const cells = row.split(/<t[dh]\b/i).slice(1).map(c => strip(c.replace(/^[^>]*>/, '')));
    const text = cells.filter(Boolean);
    if (!text.length) continue;
    const timeAt = text.findIndex(c => /^\d{1,2}:\d{2}$/.test(c));
    const gameCell = text.find(c => / - /.test(c) && !/^\d+\s*-\s*\d+$/.test(c));
    if (timeAt >= 0 && gameCell) {
      const [home, away] = gameCell.split(/\s+-\s+/);
      if (home && away) games.push({ group, time: text[timeAt], home: home.trim(), away: away.trim() });
    } else if (text.length === 1 || /ScheduleAndResults/i.test(row)) {
      if (!/^group\s*\/\s*time$/i.test(text[0])) group = text[0];
    }
  }
  return games;
}

function get(url) {
  if (fetcher) return fetcher(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Norrsken (Home Assistant add-on)', Accept: 'text/html' }, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString())); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('svar ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 3e6) req.destroy(new Error('för stor')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('tidsgräns')));
    req.on('error', reject);
  });
}

/** Reads the day's list (again after 3 hours, or 15 min after a failed try). */
async function load(date) {
  const c = cache.get(date);
  if (c && Date.now() - c.at < (c.games ? 3 * 3600e3 : 15 * 60e3)) return c.games;
  try {
    const games = parse(await get('https://stats.swehockey.se/GamesByDate/' + date + '/ByTime/90'));
    cache.set(date, { at: Date.now(), games });
    if (!c || !c.games) console.log('[swehockey]', date + ':', games.length, 'matcher (' + [...new Set(games.map(g => g.group))].slice(0, 8).join(', ') + ')');
    return games;
  } catch (e) {
    cache.set(date, { at: Date.now(), games: (c && c.games) || null });
    console.log('[swehockey] kunde inte läsa', date + ':', e.message);
    return (c && c.games) || null;
  }
}

/** Today and tomorrow, now and every hour. */
function start() {
  const tick = () => { const now = Date.now(); load(stockholmDate(now)); load(stockholmDate(now + DAY_MS)); };
  tick();
  const t = setInterval(tick, 3600e3);
  if (t.unref) t.unref();
}

const SHL_GROUP = /(^|[^a-z])shl([^a-z]|$)/i; // "SHL", "SM-slutspel SHL", "SHL Kvalserie" – not "SDHL"
/** The game in the day's list that this broadcast shows: { group, time, home, away } or null. */
function find(m, re1, re2) {
  const c = cache.get(stockholmDate(m.s));
  if (!c || !c.games) return null;
  let meet = c.games.filter(g => (re1.test(g.home) && re2.test(g.away)) || (re2.test(g.home) && re1.test(g.away)));
  if (!meet.length) return null;
  // the men and the women of the same two clubs can meet the same day: the game nearest the broadcast's start counts
  const hm = new Date(m.s).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).split(':');
  const at = +hm[0] * 60 + +hm[1];
  const near = meet.filter(g => { const t = g.time.split(':'); return Math.abs(+t[0] * 60 + +t[1] - at) <= 75; });
  if (near.length) meet = near;
  return meet.find(g => SHL_GROUP.test(g.group) && !/sdhl/i.test(g.group)) || meet[0];
}
function verdict(m, re1, re2) {
  const g = find(m, re1, re2);
  if (!g) return null;
  // when the puck drops (the broadcast's start is a guess from the guide): the recording ends a set time after it
  const [hh, mm] = g.time.split(':').map(Number);
  const day = Date.parse(stockholmDate(m.s) + 'T00:00:00Z');
  const off = new Date(m.s).getTime() - Date.parse(new Date(m.s).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(' ', 'T') + 'Z');
  m.puck = day + (hh * 60 + mm) * 60e3 + off;
  return SHL_GROUP.test(g.group) && !/sdhl/i.test(g.group) ? 'shl' : 'other';
}

module.exports = { parse, load, start, verdict, find, stockholmDate, _setFetcher: (f) => { fetcher = f; cache.clear(); } };
