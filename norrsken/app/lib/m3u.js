'use strict';

function parseAttrs(s) {
  const o = {};
  const re = /([\w-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] || '';
    o[m[1].toLowerCase()] = v.trim();
  }
  return o;
}

function parseExtinf(line) {
  // #EXTINF:-1 tvg-id="x" group-title="a,b",Title, with comma
  let i = line.indexOf(':') + 1;
  let inQ = false;
  let commaAt = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { commaAt = i; break; }
  }
  const head = commaAt >= 0 ? line.slice(0, commaAt) : line;
  const title = commaAt >= 0 ? line.slice(commaAt + 1).trim() : '';
  return { attrs: parseAttrs(head), title };
}

function parseM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let header = {};
  let cur = null;
  let grp = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) { header = parseAttrs(line.slice(7)); continue; }
    if (line.startsWith('#EXTINF')) { cur = parseExtinf(line); continue; }
    if (line.startsWith('#EXTGRP:')) { grp = line.slice(8).trim(); continue; }
    if (line[0] === '#') continue;
    if (cur) {
      entries.push({
        url: line,
        title: cur.title || cur.attrs['tvg-name'] || '',
        attrs: cur.attrs,
        group: cur.attrs['group-title'] || grp || '',
      });
    }
    cur = null;
    grp = null;
  }
  return { header, entries };
}

const EP_RE = /^(.*?)[\s._\-|]*\bS(\d{1,2})\s*[._ ]?\s*E(\d{1,4})\b\s*[-–:._]*\s*(.*)$/i;
const VOD_EXT_RE = /\.(mp4|mkv|avi|m4v|mov|wmv|flv|webm|mpg|mpeg)(\?|$)/i;

/** Decide what an M3U entry is: live channel, movie or series episode. */
function classify(e) {
  const url = e.url;
  const ep = EP_RE.exec(e.title);
  if (/\/series\//i.test(url)) return { type: 'episode', ep };
  if (/\/movie\//i.test(url)) return { type: 'movie' };
  if (VOD_EXT_RE.test(url)) return ep ? { type: 'episode', ep } : { type: 'movie' };
  return { type: 'live' };
}

module.exports = { parseM3U, parseAttrs, parseExtinf, classify, EP_RE };
