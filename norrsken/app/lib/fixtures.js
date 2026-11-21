'use strict';
/*
 * When a football match kicks off, from ESPN's public scoreboard (the TV guide lists the whole broadcast, studio before
 * and after included – not the kick-off). Only the kick-off time is read, kept in memory, for today and tomorrow.
 * kick(m) → sets m.kick (ms) when the match is found, otherwise leaves it: the guide's end is used then.
 */
const https = require('https');

const LEAGUES = ['eng.1', 'eng.2', 'eng.fa', 'eng.league_cup', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'swe.1'];
const cache = new Map(); // 'YYYYMMDD|league' → { at, events: [{ t, names }] }
let fetcher = null;

function get(url) {
  if (fetcher) return fetcher(url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Norrsken (Home Assistant add-on)', Accept: 'application/json' }, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('svar ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(new Error('för stor')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('tidsgräns')));
    req.on('error', reject);
  });
}

const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
/** Reads one league's day (again after 3 h, 15 min after a failed try). */
async function load(day, league) {
  const key = day + '|' + league;
  const c = cache.get(key);
  if (c && Date.now() - c.at < (c.ok ? 3 * 3600e3 : 15 * 60e3)) return c.events;
  try {
    const j = JSON.parse(await get('https://site.api.espn.com/apis/site/v2/sports/soccer/' + league + '/scoreboard?dates=' + day));
    const events = (j.events || []).map(e => ({ t: Date.parse(e.date), names: ((e.competitions && e.competitions[0] && e.competitions[0].competitors) || []).map(x => String((x.team && (x.team.displayName || x.team.name)) || '')) })).filter(e => e.t && e.names.length === 2);
    cache.set(key, { at: Date.now(), ok: true, events });
    return events;
  } catch (e) {
    cache.set(key, { at: Date.now(), ok: false, events: (c && c.events) || [] });
    return (c && c.events) || [];
  }
}
/** Reads the day of a broadcast (and the one before: a UTC date line) in every league, in the background. */
function warm(t) {
  for (const d of new Set([ymd(t), ymd(t + 86400e3)])) for (const l of LEAGUES) load(d, l);
}

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(fc|afc|cf|sc|if|bk|ff|united|utd|city)\b/g, ' ').replace(/\s+/g, ' ').trim();
const same = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/** The kick-off of this match (m.home, m.away, m.s): within 3 hours after the broadcast starts. */
function kick(m) {
  if (!m || !m.home || !m.away || !m.s) return null;
  warm(m.s);
  for (const d of [ymd(m.s), ymd(m.s + 86400e3)]) for (const l of LEAGUES) {
    const c = cache.get(d + '|' + l);
    const ev = c && c.events.find(e => e.t >= m.s - 30 * 60e3 && e.t <= m.s + 4 * 3600e3 && ((same(e.names[0], m.home) && same(e.names[1], m.away)) || (same(e.names[0], m.away) && same(e.names[1], m.home))));
    if (ev) { m.kick = ev.t; return ev.t; }
  }
  return null;
}

module.exports = { kick, load, warm, _setFetcher: (f) => { fetcher = f; cache.clear(); } };
