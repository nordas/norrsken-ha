'use strict';
/**
 * Who fetches the recordings (/pause, /mrec), and how it goes: a TV playing over AirPlay fetches them itself, so this
 * is the only place its side of AirPlay can be seen. Kept in memory (the newest requests), summed up per device, and
 * said in the add-on log when a device starts, stops or gets an error – so a failed AirPlay can be read afterwards
 * instead of photographed off the TV.
 */
const MAX = 600;
const GAP_MS = 25e3; // no request for this long: the device has stopped playing
const log = [];
const clients = new Map(); // ip|ua → { ip, ua, kind, first, last, n, bytes, errors, lists, pieces, id, said }

function kindOf(ua) {
  const u = String(ua || '');
  if (/AppleCoreMedia/i.test(u) && /iPhone|iPad|iPod/i.test(u)) return 'iPhone/iPad';
  if (/AppleCoreMedia/i.test(u) && /Apple ?TV/i.test(u)) return 'Apple TV';
  if (/AppleCoreMedia/i.test(u)) return 'Apples spelare';
  if (/iPhone|iPad/i.test(u)) return 'iPhone/iPad (Safari)';
  if (/Philips|TitanOS|Titan|NETTV|SmartTV|Novatek|AirPlay|WhaleTV/i.test(u)) return 'TV';
  if (/Macintosh/i.test(u)) return 'Mac';
  if (/Chrome|Firefox|Safari/i.test(u)) return 'webbläsare';
  return u ? 'okänd enhet' : 'enhet utan namn';
}

/** Call for every request to a recording; `res` is watched until it is sent. */
function watch(req, res, pathname) {
  const t0 = Date.now();
  const ip = String((req.socket && req.socket.remoteAddress) || '?').replace(/^::ffff:/, '');
  const ua = String(req.headers['user-agent'] || '').slice(0, 160);
  res.on('finish', () => {
    const now = Date.now();
    const m = /^\/(pause|mrec)\/([^/]+)\/([^/?]+)/.exec(pathname) || [];
    const e = { t: now, ip, kind: kindOf(ua), id: m[2] || '', file: m[3] || pathname, status: res.statusCode, ms: now - t0, bytes: +res.getHeader('content-length') || 0 };
    log.push(e);
    if (log.length > MAX) log.splice(0, log.length - MAX);
    const key = ip + '|' + ua;
    let c = clients.get(key);
    if (!c || now - c.last > GAP_MS) {
      c = { ip, ua, kind: e.kind, first: now, last: now, n: 0, bytes: 0, errors: 0, lists: 0, pieces: 0, id: e.id, lastErr: '' };
      clients.set(key, c);
      console.log('[airplay] ' + c.kind + ' (' + ip + ') börjar hämta ' + e.file + (ua ? ' – ' + ua.slice(0, 80) : ''));
    }
    c.last = now; c.n++; c.bytes += e.bytes; c.id = e.id || c.id;
    if (/\.m3u8$/.test(e.file)) c.lists++; else if (/\.m4s$/.test(e.file)) c.pieces++;
    if (e.status >= 400) {
      c.errors++; c.lastErr = e.status + ' ' + e.file;
      if (c.errors <= 5) console.log('[airplay] ' + c.kind + ' (' + ip + ') fick fel ' + e.status + ' på ' + e.file);
    }
    if (clients.size > 40) for (const [k, v] of clients) if (now - v.last > 3600e3) clients.delete(k);
  });
}

/** Said once when a device has gone quiet: how long it played and what it got. */
function tick(now = Date.now()) {
  for (const c of clients.values()) {
    if (c.said || now - c.last < GAP_MS) continue;
    c.said = true;
    console.log('[airplay] ' + c.kind + ' (' + c.ip + ') slutade hämta efter ' + Math.round((c.last - c.first) / 1000) + ' s: ' + c.lists + ' spellistor, ' + c.pieces + ' bitar, ' + c.errors + ' fel' + (c.lastErr ? ' (senast ' + c.lastErr + ')' : ''));
  }
}
const timer = setInterval(tick, 10e3);
if (timer.unref) timer.unref();

function summary(now = Date.now()) {
  return {
    now,
    clients: [...clients.values()].sort((a, b) => b.last - a.last).slice(0, 12).map(c => ({
      kind: c.kind, ip: c.ip, ua: c.ua, playing: now - c.last < GAP_MS, first: c.first, last: c.last, secs: Math.round((c.last - c.first) / 1000),
      lists: c.lists, pieces: c.pieces, mb: +(c.bytes / 1048576).toFixed(1), errors: c.errors, lastErr: c.lastErr, id: c.id,
    })),
    log: log.slice(-120).reverse().map(e => ({ t: e.t, ip: e.ip, kind: e.kind, file: e.file, status: e.status, ms: e.ms })),
  };
}
function _reset() { log.length = 0; clients.clear(); }

module.exports = { watch, summary, tick, kindOf, _reset };
