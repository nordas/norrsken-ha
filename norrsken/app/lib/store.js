'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  configured: false,
  source: 'xtream',
  xtream: { server: '', username: '', password: '' },
  m3u: { url: '', epgUrl: '' },
  profiles: [
    { id: 'p1', name: 'Jag', color: '#35d0a0', kids: false },
    { id: 'p2', name: 'Barn', color: '#f5b942', kids: true },
  ],
  options: {
    appName: 'Norrsken',
    hideAdult: true,
    cleanNames: true,
    liveFormat: 'hls', // hls | ts
    audioMode: 'auto', // auto | eac3 | ac3 | aac | copy
    maxRes: 'orig', // orig | 1080 (only when the picture must be converted)
    previews: 'sound', // sound | muted | off
    directPlay: 'auto', // auto: TV fetches from provider directly, falls back to proxy | off: always via server
    userAgent: '',
    epgUrl: '',
    kidsPattern: '',
    pauseMode: 'auto', // auto: archive when the channel has one, else record to disk | archive: archive only | off
    pauseMax: 60, // minutes a paused live channel is recorded at most
    tmdbKey: '', // themoviedb.org key: what is on Netflix, Max, Disney+ and Prime Video
    services: ['netflix', 'max', 'disney', 'prime'],
  },
  hidden: { live: [], movie: [], series: [] },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [] : { ...base };
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, over[k]) : over[k];
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.config = merge(clone(DEFAULT_CONFIG), this.read('config.json') || {});
    this.state = this.read('state.json') || { profiles: {} };
    if (!this.state.profiles) this.state.profiles = {};
    this._stateTimer = null;
  }

  file(name) { return path.join(this.dir, name); }

  read(name) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch (_) { return null; }
  }

  write(name, obj) {
    const f = this.file(name);
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  }

  saveConfig() { this.write('config.json', this.config); }

  saveState() {
    clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => {
      try { this.write('state.json', this.state); } catch (e) { console.error('state save failed', e.message); }
    }, 800);
  }

  flush() {
    clearTimeout(this._stateTimer);
    try { this.write('state.json', this.state); } catch (_) { /* ignore */ }
  }

  profile(id) {
    return this.config.profiles.find(p => p.id === id) || this.config.profiles[0] || { id: 'p1', name: 'Jag', kids: false };
  }

  profileState(id) {
    let s = this.state.profiles[id];
    if (!s) s = this.state.profiles[id] = { myList: [], progress: {}, recent: [] };
    if (!s.myList) s.myList = [];
    if (!s.progress) s.progress = {};
    if (!s.recent) s.recent = [];
    return s;
  }

  readCache(name) { return this.read('cache-' + name + '.json'); }
  writeCache(name, obj) {
    try { this.write('cache-' + name + '.json', obj); } catch (e) { console.error('cache write failed', e.message); }
  }
}

module.exports = { Store, DEFAULT_CONFIG, merge, clone };
