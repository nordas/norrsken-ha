'use strict';
const crypto = require('crypto');

const DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';

/** Lowercase and strip diacritics so "malmo" matches "Malmö". */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function hashId(s) {
  return crypto.createHash('sha1').update(String(s)).digest('base64url').slice(0, 11);
}

// "SE| SVT1", "|SE| SVT1", "[SE] SVT1", "SE: SVT1", "SE - SVT1", "NORDIC| Viaplay"
const PREFIX_RE = /^\s*(?:\[[A-Z0-9+]{2,7}\]|\|[A-Z0-9+]{2,7}\||[A-Z0-9+]{2,7}\s*[|:]|[A-Z]{2,3}\s+-\s+|[A-Z]{2,3}\s*»)\s*(?:[-|:»]\s*)?/;

function cleanName(name, on) {
  const n = String(name || '').trim();
  if (!on) return n;
  const c = n.replace(PREFIX_RE, '').trim();
  return c || n;
}

const KEEP_UPPER = new Set(['TV', 'HD', 'UHD', 'FHD', 'SD', '4K', '8K', 'SVT', 'NRK', 'DR', 'YLE', 'VOD', 'PPV', 'USA', 'UK', 'EU', 'BBC', 'CNN', 'HBO', 'NHL', 'NFL', 'NBA', 'UFC', 'F1', 'MMA', 'XXX', 'VIP', '3D', 'DK', 'NO', 'SE', 'FI', 'TV4', 'AMC', 'MTV', 'ESPN', 'SHL', 'PL', 'CL', 'WWE', 'C More', 'IPTV', 'EPG', 'LGBTQ']);

/** "BARN & FAMILJ" → "Barn & familj" (only for names written entirely in capitals). */
function tameCaps(name) {
  const s = String(name || '');
  if (!/[A-ZÅÄÖ]/.test(s) || /[a-zåäöéü]/.test(s)) return s;
  let first = true;
  return s.replace(/[\p{L}\p{N}+]+/gu, (w) => {
    let out;
    if (KEEP_UPPER.has(w) || /\d/.test(w)) out = w;
    else out = w.toLowerCase();
    if (first) { out = out.charAt(0).toUpperCase() + out.slice(1); first = false; }
    return out;
  });
}

/** Pull a trailing release year out of a movie name: "Dune (2021)" → { n: "Dune", y: 2021 } */
function splitYear(name) {
  const max = new Date().getFullYear() + 1;
  const m = /\s*(?:[([](\d{4})[)\]]|\s[-–]\s(\d{4}))\s*$/.exec(name);
  if (m) {
    const y = +(m[1] || m[2]);
    if (y >= 1900 && y <= max) return { n: name.slice(0, m.index).trim() || name, y };
  }
  return { n: name, y: 0 };
}

function yearOf(v) {
  const m = /(\d{4})/.exec(String(v || ''));
  return m ? +m[1] : 0;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg || 'HTTP ' + status); this.status = status; }
}

async function fetchRaw(url, { ua, timeout = 30000, headers = {}, signal } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('timeout')), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*', ...headers },
      signal: ac.signal,
      redirect: 'follow',
    });
    return { r, done: () => clearTimeout(t) };
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function fetchText(url, opts = {}) {
  const { r, done } = await fetchRaw(url, opts);
  try {
    if (!r.ok) throw new HttpError(r.status, 'Servern svarade ' + r.status);
    return await r.text();
  } finally { done(); }
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {
    throw new Error('Ogiltigt svar från servern (inte JSON)');
  }
}

function redact(msg, secrets) {
  let s = String(msg || '');
  for (const sec of secrets || []) {
    if (sec && sec.length > 2) s = s.split(sec).join('***');
    if (sec && sec.length > 2) s = s.split(encodeURIComponent(sec)).join('***');
  }
  return s.replace(/(username|password)=[^&\s]+/gi, '$1=***');
}

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch (_) { return m; }
  });
}

function b64decode(s) {
  if (!s) return '';
  try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch (_) { return String(s); }
}

/** Run async fn over items with limited concurrency. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = undefined; }
    }
  });
  await Promise.all(workers);
  return out;
}

class LRU {
  constructor(max = 500, ttl = 6 * 3600e3) { this.max = max; this.ttl = ttl; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (Date.now() - e.t > this.ttl) { this.m.delete(k); return undefined; }
    this.m.delete(k); this.m.set(k, e);
    return e.v;
  }
  set(k, v) {
    this.m.delete(k);
    this.m.set(k, { v, t: Date.now() });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  clear() { this.m.clear(); }
}

module.exports = {
  DEFAULT_UA, fold, hashId, cleanName, tameCaps, splitYear, yearOf, HttpError,
  fetchRaw, fetchText, fetchJson, redact, decodeEntities, b64decode, pool, LRU,
};
