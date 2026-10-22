'use strict';
const zlib = require('zlib');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');
const { fetchRaw, decodeEntities, HttpError } = require('./util');

/** "20261020183000 +0200" → epoch ms */
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    const off = (Math.abs(+m[7]) * 60 + +(m[8] || 0)) * 60000;
    t -= sign * off;
  }
  return t;
}

function attr(tag, name) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(tag) || new RegExp('\\s' + name + "\\s*=\\s*'([^']*)'").exec(tag);
  return m ? decodeEntities(m[1]) : '';
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
}

function pickText(block, tag) {
  const re = new RegExp('<' + tag + '(\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
  let m;
  let first = null;
  let sv = null;
  while ((m = re.exec(block))) {
    const txt = decodeEntities(stripCdata(m[2].trim()));
    if (first === null) first = txt;
    if (m[1] && /lang\s*=\s*["'](sv|swe)/i.test(m[1])) { sv = txt; break; }
  }
  return sv !== null ? sv : first || '';
}

class Epg {
  constructor() {
    this.map = new Map(); // channelId → [[start, stop, title, desc], ...]
    this.at = 0;
    this.loading = false;
    this.error = null;
    this.count = 0;
  }

  static fromJSON(obj) {
    const e = new Epg();
    if (obj && obj.ch) {
      for (const k of Object.keys(obj.ch)) e.map.set(k, obj.ch[k]);
      e.at = obj.at || 0;
      e.count = obj.count || 0;
    }
    return e;
  }

  toJSON() {
    const ch = {};
    for (const [k, v] of this.map) ch[k] = v;
    return { at: this.at, count: this.count, ch };
  }

  /** Stream-parse an XMLTV file (plain or gzipped). Keeps a window around now. */
  async load(url, { wanted, ua, timeout = 600000, now = Date.now() } = {}) {
    const from = now - 3 * 86400e3; // three days back, for catch-up
    const to = now + 36 * 3600e3;
    const map = new Map();
    let count = 0;
    const { r, done } = await fetchRaw(url, { ua, timeout });
    try {
      if (!r.ok) throw new HttpError(r.status, 'EPG: servern svarade ' + r.status);
      const src = Readable.fromWeb(r.body);
      const it = src[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done) throw new Error('EPG: tomt svar');
      const gen = (async function* () {
        yield first.value;
        for (;;) { const n = await it.next(); if (n.done) return; yield n.value; }
      })();
      let input = Readable.from(gen);
      const b = first.value;
      if (b[0] === 0x1f && b[1] === 0x8b) input = input.pipe(zlib.createGunzip());

      const dec = new StringDecoder('utf8');
      let buf = '';
      const handle = (block) => {
        const end = block.indexOf('>');
        const open = block.slice(0, end + 1);
        const ch = attr(open, 'channel');
        if (!ch || (wanted && wanted.size && !wanted.has(ch))) return;
        const s = parseXmltvTime(attr(open, 'start'));
        const e = parseXmltvTime(attr(open, 'stop')) || s + 3600e3;
        if (!s || e < from || s > to) return;
        const t = pickText(block, 'title');
        let d = pickText(block, 'desc');
        if (d.length > 280) d = d.slice(0, 277).replace(/\s+\S*$/, '') + '…';
        let list = map.get(ch);
        if (!list) map.set(ch, (list = []));
        list.push([s, e, t, d]);
        count++;
      };
      for await (const chunk of input) {
        buf += dec.write(chunk);
        let pos = 0;
        for (;;) {
          const st = buf.indexOf('<programme', pos);
          if (st < 0) { pos = Math.max(pos, buf.length - 12); break; }
          const en = buf.indexOf('</programme>', st);
          if (en < 0) { pos = st; break; }
          handle(buf.slice(st, en));
          pos = en + 12;
        }
        buf = buf.slice(pos);
      }
    } finally { done(); }
    for (const list of map.values()) {
      list.sort((a, b) => a[0] - b[0]);
      // drop overlaps/duplicates
      for (let i = list.length - 1; i > 0; i--) if (list[i][0] === list[i - 1][0]) list.splice(i, 1);
    }
    this.map = map;
    this.count = count;
    this.at = Date.now();
    return count;
  }

  has(id) { return !!id && this.map.has(id); }

  nowNext(id, now = Date.now()) {
    const list = this.map.get(id);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] <= now) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const cur = idx >= 0 && list[idx][1] > now ? list[idx] : null;
    const nx = list[idx + 1] || null;
    const f = (p) => p && { t: p[2], s: p[0], e: p[1], d: p[3] };
    return { now: f(cur), next: f(nx) };
  }

  range(id, from, to) {
    const list = this.map.get(id) || [];
    return list.filter(p => p[1] > from && p[0] < to).map(p => ({ t: p[2], s: p[0], e: p[1], d: p[3] }));
  }
}

module.exports = { Epg, parseXmltvTime };
