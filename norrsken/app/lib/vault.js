'use strict';
/**
 * The provider's user name and password, encrypted in config.json with a key that lives somewhere else:
 * Home Assistant's own secrets.yaml (the add-on may only read it). A copy of the add-on's data folder alone
 * can't be read; a full Home Assistant backup has both files, so it doesn't protect against that.
 *
 *   secrets.yaml:   norrsken_nyckel: <long random string>
 *
 * Without the line, nothing is encrypted (as before) and the setup page shows the line to add.
 */
const crypto = require('crypto');
const fs = require('fs');

const KEY_NAME = 'norrsken_nyckel';
const PREFIX = 'enc:v1:';
// the fields that carry the account (an M3U link or guide link often has the user name and password in it)
const FIELDS = [['xtream', 'username'], ['xtream', 'password'], ['m3u', 'url'], ['m3u', 'epgUrl'], ['options', 'epgUrl']];

function secretsFile() {
  if (process.env.NSK_SECRETS_FILE) return process.env.NSK_SECRETS_FILE;
  for (const f of ['/homeassistant/secrets.yaml', '/config/secrets.yaml']) { try { if (fs.existsSync(f)) return f; } catch (_) { /* no */ } }
  return '';
}

let cache = { at: 0, key: null, file: '' };
/** The key from secrets.yaml (read again at most every 10 s, so adding the line works without a restart). */
function key() {
  if (Date.now() - cache.at < 10000) return cache.key;
  const file = secretsFile();
  let k = null;
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = new RegExp('^\\s*' + KEY_NAME + '\\s*:\\s*["\']?([^"\'#\\s]{16,})', 'm').exec(text);
      if (m) k = crypto.createHash('sha256').update('norrsken-vault:' + m[1]).digest();
    } catch (_) { /* unreadable */ }
  }
  cache = { at: Date.now(), key: k, file };
  return k;
}

function seal(text, k = key()) {
  if (!k || typeof text !== 'string' || !text || text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

/** Decrypted text, or null when it is encrypted and the key is missing or wrong. */
function open(text, k = key()) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return text;
  if (!k) return null;
  try {
    const b = Buffer.from(text.slice(PREFIX.length), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

const get = (o, p) => p.reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const set = (o, p, v) => { const last = p[p.length - 1]; const parent = get(o, p.slice(0, -1)); if (parent && typeof parent === 'object') parent[last] = v; };

/** A copy of the config with the account fields encrypted (when there is a key). */
function sealConfig(cfg) {
  const k = key();
  const out = JSON.parse(JSON.stringify(cfg));
  if (!k) return out;
  for (const p of FIELDS) { const v = get(out, p); if (typeof v === 'string' && v) set(out, p, seal(v, k)); }
  return out;
}

/**
 * The config as read from disk, decrypted in place. Returns { locked, plain }: locked = some field could not be
 * opened (key missing or changed; those fields keep their encrypted text and saving keeps them as they were),
 * plain = some field is still unencrypted while a key exists (encrypt it on the next save).
 */
function openConfig(cfg) {
  const k = key();
  let locked = false, plain = false;
  for (const p of FIELDS) {
    const v = get(cfg, p);
    if (typeof v !== 'string' || !v) continue;
    if (v.startsWith(PREFIX)) { const o = open(v, k); if (o === null) locked = true; else set(cfg, p, o); }
    else if (k) plain = true;
  }
  return { locked, plain };
}

function isSealed(v) { return typeof v === 'string' && v.startsWith(PREFIX); }

let suggestion = '';
/** For the setup page: is the key there, and the line to add when it isn't. */
function status() {
  const k = key();
  if (!suggestion) suggestion = KEY_NAME + ': ' + crypto.randomBytes(24).toString('base64url');
  return { on: !!k, file: cache.file || '', line: k ? '' : suggestion, name: KEY_NAME };
}

module.exports = { key, seal, open, sealConfig, openConfig, isSealed, status, FIELDS, KEY_NAME, _reset: () => { cache = { at: 0, key: null, file: '' }; } };
