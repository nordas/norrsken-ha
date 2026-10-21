'use strict';
const { Readable } = require('stream');
const { DEFAULT_UA } = require('./util');

/**
 * Stream proxy. The TV never talks to the provider directly:
 *  - adds CORS so hls.js / mpegts.js can fetch
 *  - follows redirects, rewrites HLS playlists so every segment/key also goes through here
 *  - forwards Range so seeking in VOD works
 * Only hosts we have handed out ourselves (or reached via redirect from them) are allowed.
 */
class Proxy {
  constructor() { this.allowed = new Set(); }

  allow(u) {
    try { this.allowed.add(new URL(u).host.toLowerCase()); } catch (_) { /* ignore */ }
  }

  isAllowed(u) {
    try {
      const url = new URL(u);
      return (url.protocol === 'http:' || url.protocol === 'https:') && this.allowed.has(url.host.toLowerCase());
    } catch (_) { return false; }
  }

  token(u) { return Buffer.from(u, 'utf8').toString('base64url'); }

  untoken(t) {
    try { return Buffer.from(String(t), 'base64url').toString('utf8'); } catch (_) { return ''; }
  }

  /** Public path for a provider url; `name` is cosmetic (players sometimes look at extensions). */
  path(u) {
    this.allow(u);
    let name = 'x';
    try { name = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'x').replace(/[^\w.\-]/g, '_').slice(-60) || 'x'; } catch (_) { /* ignore */ }
    return '/px/' + this.token(u) + '/' + name;
  }

  rewritePlaylist(text, base) {
    const abs = (u) => { try { return new URL(u, base).toString(); } catch (_) { return u; } };
    return text.split(/\r?\n/).map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l[0] === '#') {
        return line.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + this.path(abs(u)) + '"');
      }
      return this.path(abs(l));
    }).join('\n');
  }

  async handle(req, res, token, ua) {
    const target = this.untoken(token);
    if (!this.isAllowed(target)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end('forbidden');
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*', Connection: 'keep-alive' };
    if (req.headers.range) headers.Range = req.headers.range;
    let r;
    try {
      r = await fetch(target, { headers, signal: ac.signal, redirect: 'follow' });
    } catch (e) {
      if (ac.signal.aborted) return;
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end('upstream error');
    }
    const final = r.url || target;
    this.allow(final);
    const ct = r.headers.get('content-type') || '';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range' };

    if (!r.ok && r.status !== 206) {
      res.writeHead(r.status, { 'Content-Type': 'text/plain', ...cors });
      res.end('upstream ' + r.status);
      try { await r.body?.cancel(); } catch (_) { /* ignore */ }
      return;
    }

    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(new URL(final).pathname);
    const body = r.body ? Readable.fromWeb(r.body) : null;
    if (!body) { res.writeHead(r.status, cors); return res.end(); }
    body.on('error', () => { /* client went away */ });

    // Sniff the first chunk: some panels serve playlists as text/plain without extension.
    const it = body[Symbol.asyncIterator]();
    let first;
    try { first = await it.next(); } catch (_) { if (!res.headersSent) { res.writeHead(502, cors); } return res.end(); }
    const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
    const isPlaylist = looksPlaylist || head.slice(0, 7).toString('latin1') === '#EXTM3U';

    if (isPlaylist && !/^video\//i.test(ct)) {
      const chunks = [head];
      let total = head.length;
      try {
        for (;;) {
          const n = await it.next();
          if (n.done) break;
          chunks.push(Buffer.from(n.value));
          total += n.value.length;
          if (total > 8 * 1024 * 1024) break;
        }
      } catch (_) { /* partial */ }
      const text = Buffer.concat(chunks).toString('utf8');
      const out = this.rewritePlaylist(text, final);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', ...cors });
      return res.end(out);
    }

    const out = { ...cors, 'Cache-Control': 'no-store' };
    out['Content-Type'] = ct && !/text\/html/i.test(ct) ? ct : guessType(final);
    for (const h of ['content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) out[h.replace(/(^|-)\w/g, s => s.toUpperCase())] = v;
    }
    if (!out['Accept-Ranges'] && r.status === 206) out['Accept-Ranges'] = 'bytes';
    res.writeHead(r.status, out);
    if (head.length) res.write(head);
    (async () => {
      try {
        for (;;) {
          const n = await it.next();
          if (n.done) break;
          if (res.destroyed) { ac.abort(); break; }
          if (!res.write(n.value)) await waitDrain(res);
        }
        if (!res.destroyed) res.end();
      } catch (_) {
        res.destroy();
      }
    })();
  }
}

function waitDrain(res) {
  return new Promise((ok) => {
    const done = () => { res.off('drain', done); res.off('close', done); ok(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

function guessType(u) {
  const p = (() => { try { return new URL(u).pathname.toLowerCase(); } catch (_) { return ''; } })();
  if (p.endsWith('.ts')) return 'video/mp2t';
  if (p.endsWith('.mp4') || p.endsWith('.m4v') || p.endsWith('.m4s')) return 'video/mp4';
  if (p.endsWith('.mkv')) return 'video/x-matroska';
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.aac')) return 'audio/aac';
  if (p.endsWith('.vtt')) return 'text/vtt';
  return 'application/octet-stream';
}

module.exports = { Proxy };
