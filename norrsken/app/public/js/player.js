/* Norrsken player: live TV with zapping/channel list, VOD with scrubbing, tracks, subtitles and next episode. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;

  var SNAP = ['k', 't', 'id', 'n', 'img', 'bd', 'num', 'cat', 'epg', 'y', 'r', 'sid', 'sn', 'se', 'ep', 'ext', 'dur', 'g'];
  function snap(it) { var o = {}; SNAP.forEach(function (k) { if (it[k] !== undefined && it[k] !== null && it[k] !== '') o[k] = it[k]; }); return o; }

  function parseVttTime(s) {
    var m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/.exec(s);
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }

  NS.introCache = NS.introCache || {};

  function Player(opts) {
    var self = this;
    this.o = opts;
    this.item = opts.item;
    this.live = this.item.t === 'live';
    this.list = opts.list && opts.list.length ? opts.list.slice() : [this.item];
    this.cat = opts.cat || this.item.cat || null;
    this.series = opts.series || null;
    this.start = opts.start || 0;
    this.offset = 0;
    this.audioIdx = 0;
    this.sub = null; // { kind:'hls'|'ff', i }
    this.zone = 'bar';
    this.panel = null;
    this.timers = [];

    var el = this.el = h('div', { class: 'screen player' });
    var v = this.video = h('video', { playsinline: true, preload: 'auto' });
    v.autoplay = true;
    el.appendChild(v);
    this.spin = h('div', { class: 'spinner spin' });
    this.bigIcon = h('div', { class: 'big-icon' }, NS.icon('pause'));
    el.appendChild(h('div', { class: 'center' }, [this.spin, this.bigIcon]));
    el.classList.add('buffering');

    // OSD
    this.osd = h('div', { class: 'osd' });
    this.osd.appendChild(h('div', { class: 'top' }));
    this.osd.appendChild(h('div', { class: 'bottom' }));
    this.ttl = h('div', { class: 'ttl' });
    this.osd.appendChild(this.ttl);
    this.clockEl = h('div', { class: 'clock', style: 'top:7.4rem;right:12rem' });
    this.osd.appendChild(this.clockEl);
    if (this.live) {
      this.chan = h('div', { class: 'chan' });
      this.osd.appendChild(this.chan);
      this.osd.appendChild(h('div', { class: 'hint', style: 'top:auto;bottom:3rem' }, [
        h('span', {}, [h('kbd', { text: 'OK' }), 'Kanallista']), h('span', {}, [h('kbd', { text: '▲▼' }), 'Byt kanal']), h('span', {}, [h('kbd', { text: '0–9' }), 'Kanalnummer']), h('span', {}, [h('kbd', { text: 'Info' }), 'Tv-guide']), h('span', {}, [h('kbd', { text: '▶' }), 'Ljud/text']), h('span', {}, [h('kbd', { style: 'color:#f5d33c', text: '●' }), 'Förra kanalen']),
        h('span', {}, [h('kbd', { style: 'color:#3ccf4e', text: '●' }), 'Favorit']), this.item.arc ? h('span', {}, [h('kbd', { style: 'color:#e5242b', text: '●' }), 'Starta om']) : null,
        h('span', {}, [h('kbd', { text: '⏯' }), 'Pausa'])]));
      // paused live TV / watching behind live: how far behind, and how to get back
      this.tsEl = h('div', { class: 'tshift' });
      this.osd.appendChild(this.tsEl);
      // a seek bar for the recording (TV4 Play style): drag to go back or forward inside what has been recorded
      this.lPlayed = h('div', { class: 'played' });
      this.lKnob = h('div', { class: 'knob' });
      this.lBubble = h('div', { class: 'bubble' });
      this.lbar = h('div', { class: 'bar tsbar' }, [h('div', { class: 'rail2' }, [this.lPlayed]), this.lKnob, this.lBubble]);
      this.ltA = h('span'); this.ltB = h('span');
      this.ltimes = h('div', { class: 'times tsbar' }, [this.ltA, this.ltB]);
      this.lLive = h('button', { class: 'btn golive', onclick: function (e) { e.stopPropagation(); self.goLive(); } }, [NS.icon('live'), 'Titta live']);
      this.lrow = h('div', { class: 'tsrow' }, [this.lbar, this.lLive]);
      this.osd.appendChild(this.lrow);
      this.osd.appendChild(this.ltimes);
      this.lDrag = false;
      this.freezeEl = h('canvas', { class: 'freeze' });
      el.insertBefore(this.freezeEl, el.firstChild.nextSibling);
    } else {
      this.bar = h('div', { class: 'bar' });
      this.bufEl = h('div', { class: 'buf' });
      this.playedEl = h('div', { class: 'played' });
      this.bar.appendChild(h('div', { class: 'rail2' }, [this.bufEl, this.playedEl]));
      this.knob = h('div', { class: 'knob' });
      this.bubble = h('div', { class: 'bubble' });
      this.bar.appendChild(this.knob);
      this.bar.appendChild(this.bubble);
      this.osd.appendChild(this.bar);
      this.timesL = h('span');
      this.timesR = h('span');
      this.osd.appendChild(h('div', { class: 'times' }, [this.timesL, this.timesR]));
      this.obtns = h('div', { class: 'obtns' });
      this.osd.appendChild(this.obtns);
    }
    el.appendChild(this.osd);

    this.zapEl = h('div', { class: 'zap' });
    el.appendChild(this.zapEl);
    this.numEl = h('div', { class: 'numentry' });
    el.appendChild(this.numEl);
    this.nextEl = h('div', { class: 'nextup' });
    el.appendChild(this.nextEl);
    this.skipEl = h('div', { class: 'btn focus skip-intro', onclick: function (e) { e.stopPropagation(); self.skipIntro(); } }, [NS.icon('ff'), 'Hoppa över intro']);
    el.appendChild(this.skipEl);
    this.errEl = h('div', { class: 'perror' });
    el.appendChild(this.errEl);
    this.side = h('div', { class: 'panel-side' });
    el.appendChild(this.side);
    this.sideR = h('div', { class: 'panel-side right' });
    el.appendChild(this.sideR);

    if (NS.touch) this.touchUi();
    else if (window.matchMedia && matchMedia('(pointer: fine)').matches) this.mouseUi();

    // media events
    var on = function (ev, fn) { v.addEventListener(ev, fn); };
    on('playing', function () { self.buffering(false); self.errShown = false; self.played = true; self.lastMove = Date.now(); });
    on('waiting', function () {
      self.buffering(true);
      var b = 0;
      try { var bb = v.buffered; for (var i = 0; i < bb.length; i++) if (v.currentTime >= bb.start(i) - 0.5 && v.currentTime <= bb.end(i)) b = bb.end(i) - v.currentTime; } catch (e) { /* ignore */ }
      NS.diag('buffrar vid ' + Math.round(self.cur()) + ' s, buffert framåt ' + b.toFixed(1) + ' s, motor ' + (self.hls ? (window.ManagedMediaSource && !window.MediaSource ? 'hls.js/MMS' : 'hls.js') : self.mp ? 'mpegts' : self.kind));
    });
    on('stalled', function () { self.buffering(true); });
    on('canplay', function () { self.buffering(false); });
    on('pause', function () { self.renderButtons(); });
    on('play', function () { self.renderButtons(); });
    on('pause', function () { self.bigIcon.innerHTML = ''; self.bigIcon.appendChild(NS.icon('pause')); self.bigIcon.classList.add('on'); self.showOsd(true); });
    on('play', function () { self.bigIcon.classList.remove('on'); self.showOsd(); });
    on('timeupdate', function () {
      self.lastMove = Date.now();
      // some browsers never send "playing" after a short stall: if the picture moves, it isn't buffering
      if (v.currentTime !== self._lastCT && !v.paused) { self._lastCT = v.currentTime; self.buffering(false); }
      self.tick();
    });
    on('loadedmetadata', function () {
      if (self.kind === 'file' && self.pendingSeek > 0) { try { v.currentTime = self.pendingSeek; } catch (e) { /* ignore */ } self.pendingSeek = 0; }
      // the screen's own player may list the file's sound tracks (Safari, many TVs): offer them right away
      if (self.nativeAudio()) { self.autoTracks(); self.renderButtons(); }
    });
    try { if (v.audioTracks && v.audioTracks.addEventListener) v.audioTracks.addEventListener('addtrack', function () { if (self.nativeAudio()) self.autoTracks(); }); } catch (e) { /* ignore */ }
    on('ended', function () { self.onEnded(); });
    on('error', function () {
      if (self.kind === 'hls' && self.hls) return; // hls.js reports its own errors
      var cs = self.sources && self.sources[self.si];
      var err = v.error;
      if (cs && cs.direct && !self.played && cs.kind === 'file' && err && err.code === 2) NS.directBad.file = true;
      // the file itself can't be decoded here (code 4): skip the other copies of the same file and go to the converter
      // the converter's output still can't be decoded (e.g. HEVC the hardware can't handle): convert everything to H.264/AAC
      if (cs && cs.kind === 'remux' && !self.safeMode && err && (err.code === 3 || err.code === 4)) {
        self.safeMode = true; console.log('[norrsken] retry with full conversion');
        if (self.media && /hevc|h265/i.test(self.media.v || '')) NS.store.set('hevcBad', true);
        self.startSource(self.played ? self.cur() : self.start); return;
      }
      if (cs && cs.kind === 'file' && err && err.code === 4 && self.sources) {
        var ri = -1;
        for (var k = self.si + 1; k < self.sources.length; k++) if (self.sources[k].kind === 'remux') { ri = k; break; }
        if (ri > 0) { var at = self.played ? self.cur() : self.start; self.si = ri; self.startSource(at); return; }
      }
      self.fail(err ? (err.code === 4 ? 'Formatet stöds inte av den här skärmen' : 'Mediafel ' + err.code) : 'Mediafel');
    });

    if (this.live) {
      this.lbar.addEventListener('pointerdown', function (e) {
        if (!self.tshift || self.tshift.mode !== 'rec') return;
        self.lDrag = true; self.lbar.classList.add('scrub'); self.showOsd(true);
        self.lPreview = self.lFrac(e) * self.recLen();
        self.lShow(self.lPreview);
        e.preventDefault();
      });
      this._lMove = function (e) { if (!self.lDrag) return; self.lPreview = self.lFrac(e) * self.recLen(); self.lShow(self.lPreview); };
      this._lUp = function () {
        if (!self.lDrag) return;
        self.lDrag = false; self.lbar.classList.remove('scrub');
        self.seekRec(self.lPreview);
        self.showOsd();
      };
      window.addEventListener('pointermove', this._lMove);
      window.addEventListener('pointerup', this._lUp);
    }
    this._epg = function () { if (self.live) { self.renderChan(); if (self.panel === 'channels') self.paintChannels(); } };
    document.addEventListener('nsk-epg', this._epg);
  }

  /* ------------------------------------------------------------ lifecycle */
  Player.prototype.activate = function (first) {
    var self = this;
    this.clk = NS.clock(this.clockEl);
    if (!first) {
      // paused live TV (recording or archive spot): come back still paused, with the frozen picture, and go on from there
      if (this.suspended && !this.skipResume && this.live && this.tshift) { this.suspended = false; if (this.freezeEl && this.freezeEl.width) this.freezeEl.classList.add('on'); this.buffering(false); this.paintTshift(); this.showOsd(true); }
      else if (this.suspended && !this.skipResume) { this.suspended = false; this.play(this.item, this.resumeAt || 0); }
      this.skipResume = false;
      return;
    }
    this.play(this.item, this.start);
    this.every(3000, function () { self.watchdog(); });
    this.every(500, function () { if (self.cuSeek) self.cuCatch(); });
    this.every(15000, function () { self.saveProgress(); });
    if (this.live) this.every(30000, function () { NS.needEpg([self.item.id]); });
    if (this.live) this.every(1000, function () { if (self.tshift || self.livePausedAt) self.paintTshift(); });
  };
  Player.prototype.every = function (ms, fn) { this.timers.push(setInterval(fn, ms)); };
  Player.prototype.deactivate = function () {
    clearInterval(this.clk);
    // something opened on top (guide, another player): stop streaming so we don't hold a second provider connection.
    // Always cancel a request still in flight too, or it would start playing behind whatever is now on top.
    this.reqId = {};
    this.waitStart = false;
    clearTimeout(this.airT);
    this.airNative = false;
    if (!this.suspended) this.resumeAt = this.live ? 0 : this.sources ? this.cur() : this.start;
    if (this.sources) this.saveProgress();
    if (this.live && this.tshift) {
      // the recording goes on while the guide is open; remember where we were in it and keep the picture
      clearTimeout(this.lpT);
      var ts = this.tshift, v = this.video;
      if (ts.playing) { ts.pos = v.currentTime || 0; ts.playing = false; this.snapFrame(); }
    }
    this.teardown();
    this.suspended = true;
  };
  Player.prototype.destroy = function () {
    this.saveProgress(true);
    // let the server stop converting right away (frees the provider connection for the next title)
    if (this.tok) { try { var u = 'rx/stop?t=' + encodeURIComponent(this.tok); if (navigator.sendBeacon) navigator.sendBeacon(u); else NS.api.post(u, {}); } catch (e) { /* ignore */ } }
    this.timers.forEach(clearInterval);
    clearInterval(this.clk);
    clearTimeout(this.osdT); clearTimeout(this.scrubT); clearTimeout(this.numT); clearInterval(this.nextT); clearTimeout(this.zapT); clearTimeout(this.airT);
    document.removeEventListener('nsk-epg', this._epg);
    if (this._winOff) this._winOff();
    if (this._lMove) { window.removeEventListener('pointermove', this._lMove); window.removeEventListener('pointerup', this._lUp); }
    if (this.tshift) this.endTshift();
    this.stopSubs();
    this.teardown();
    if (this.chanRows) this.chanRows = null;
  };
  Player.prototype.exit = function () { NS.router.pop(); };

  /* ------------------------------------------------------------ loading */
  Player.prototype.play = function (item, start) {
    var self = this;
    if (this.tshift) this.endTshift();
    this.item = item;
    this.start = start || 0;
    this.offset = 0;
    this.cuOff = 0;
    this.probe = null;
    this.tok = '';
    this.audioIdx = 0;
    this.nextDismissed = false;
    this.introDone = false;
    this.hideNext();
    this.stopSubs();
    this.sub = null;
    this.hideError();
    this.buffering(true);
    this.dur = item.dur || 0;
    this.renderTitle();
    if (this.live) {
      this.renderChan();
      this.showOsd();
      NS.needEpg([item.id]);
      NS.api.recent(snap(item)).catch(function () {});
      NS.state.dirty = true;
      // zap through the whole category, not just the cards a row had loaded
      if (!this.fullList && item.cat) {
        this.fullList = true;
        NS.api.list('live', item.cat, 0, 3000).then(function (r) { if (r.items && r.items.length > self.list.length) { self.list = r.items; self.cat = item.cat; } }).catch(function () {});
      }
    } else {
      if (item.t === 'episode' && !this.series && item.sid) {
        NS.infoFor({ t: 'series', id: item.sid }).then(function (s) { self.series = s; self.renderButtons(); }).catch(function () {});
      }
      this.renderButtons();
      this.showOsd();
    }
    var req = this.reqId = {};
    var cu = item.t === 'catchup' ? item.cu : null;
    if (cu) {
      // timeshift works in whole minutes: start the archive at the minute we want and count from there
      var cap = this.cuMax();
      if (this.start > cap) this.start = cap;
      this.cuOff = Math.max(0, Math.floor(this.start / 60) * 60);
      this.cuSeek = this.start - this.cuOff; // the rest of the way, once enough has loaded
      this.start = 0;
      this._cuFresh = true;
    }
    // a film that exists in several qualities: play the best one this device can show (unless one was picked)
    var pick = item.t === 'movie' && !item.vid && NS.infoFor ? NS.infoFor(item).then(function (info) {
      var v = NS.bestVersion(info && info.versions);
      if (v && v.id !== item.id) { item.vid = v.id; item.ext = v.ext || item.ext; }
    }).catch(function () {}) : Promise.resolve();
    NS.preview.settle().then(function () { return pick; }).then(function () {
      if (cu) return NS.api.get('api/stream/live/' + encodeURIComponent(item.id) + '?caps=' + NS.caps + '&start=' + (cu.start + self.cuOff) + '&dur=' + Math.max(1, Math.ceil(cu.dur - self.cuOff / 60)), 20000);
      return NS.api.stream(item.t, item.vid || item.id, item.ext);
    }).then(function (res) {
      if (req !== self.reqId) return;
      self.sources = NS.usableSources(res.sources || []);
      self.media = res.media || null;
      self.safeMode = false;
      self.tok = res.t || '';
      self.si = 0;
      if (!self.sources.length) return self.fail('Ingen ström hittades');
      var go = function () { if (req !== self.reqId) return; self.waitStart = false; self.startSource(self.start); };
      // converted playback: read the tracks first (the server already did, so it's instant), so the chosen
      // audio language goes into the first request instead of restarting the conversion a moment later
      self.waitStart = !!self.tok && self.sources[0].kind === 'remux';
      if (self.tok) {
        NS.api.probe(self.tok).then(function (p) {
          if (req !== self.reqId) return;
          self.probe = p;
          if (p.dur) self.dur = p.dur;
          // the file's default sound track (not always the first): what plays directly, and what the converter starts with
          var di = (p.audio || []).findIndex(function (a) { return a.def; });
          if (di > 0 && (self.waitStart || self.kind !== 'remux')) self.audioIdx = p.audio[di].i;
          self.autoTracks();
          self.renderButtons();
          if (self.waitStart) go();
        }).catch(function () { if (self.waitStart) go(); });
      }
      if (self.waitStart) setTimeout(function () { if (self.waitStart) go(); }, 4000);
      else go();
    }).catch(function (e) { if (req === self.reqId) self.fail(e.message); });
  };

  Player.prototype.teardown = function () {
    var v = this.video;
    if (this.hls) { try { this.hls.destroy(); } catch (e) { /* ignore */ } this.hls = null; }
    if (this.mp) { try { this.mp.pause(); this.mp.unload(); this.mp.detachMediaElement(); this.mp.destroy(); } catch (e) { /* ignore */ } this.mp = null; }
    try { v.pause(); } catch (e) { /* ignore */ }
    v.removeAttribute('src');
    // a left-over AirPlay <source> would otherwise be loaded by load() below: a second stream nobody watches
    [].slice.call(v.querySelectorAll('source')).forEach(function (s) { s.remove(); });
    try { v.load(); } catch (e) { /* ignore */ }
  };

  Player.prototype.startSource = function (at) {
    var self = this;
    if (this.suspended) return;
    if (this.live && this.tshift && this.tshift.url) { this.startRec(this.tshift.playing ? this.video.currentTime || 0 : 0); return; }
    if (this.item.t === 'catchup') {
      // the archive URL is fixed to its start time: a retry/reload asks for a new one at the current position
      // (moving on to the next source of the same request is fine; reloading the same one is not)
      if (!this._cuFresh && this.si === this._cuSi) {
        var pos = this.cur();
        if (this.cuMax() - pos < 60 && this.cuLiveNow()) { this.toLive(); return; }
        this.play(this.item, pos);
        return;
      }
      this._cuFresh = false;
      this._cuSi = this.si;
    }
    var src = this.sources[this.si];
    var v = this.video;
    this.airNative = false;
    clearTimeout(this.airT);
    this.teardown();
    this.kind = src.kind;
    this.netRetry = 0;
    this.mediaRetry = 0;
    this.played = false;
    this.srcStart = Date.now();
    this.lastMove = Date.now();
    this.pendingSeek = 0;
    at = at || 0;
    if (src.kind === 'hls') {
      if (window.Hls && window.Hls.isSupported()) {
        var hls = this.hls = new window.Hls({
          enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 40, maxMaxBufferLength: 120,
          maxBufferHole: 1, liveSyncDurationCount: 4, liveMaxLatencyDurationCount: 12, startFragPrefetch: true,
          manifestLoadingTimeOut: 15000, fragLoadingTimeOut: 30000, abrEwmaDefaultEstimate: 4000000,
          manifestLoadingMaxRetry: src.direct ? 0 : 3, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6,
          startPosition: !this.live && at > 0 ? at : -1, capLevelToPlayerSize: true
        });
        hls.on(window.Hls.Events.ERROR, function (ev, d) { self.onHlsError(d); });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () { self.playPromise(); });
        hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, function () { self.autoTracks(); });
        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, function () { self.autoTracks(); });
        hls.loadSource(src.url);
        hls.attachMedia(v);
        return;
      }
      if (v.canPlayType('application/vnd.apple.mpegurl')) { this.kind = 'native'; this.pendingSeek = at; v.src = src.url; this.playPromise(); return; }
      return this.next('HLS stöds inte');
    }
    if (src.kind === 'ts') {
      if (window.mpegts && window.mpegts.isSupported()) {
        var mp = this.mp = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src.url }, {
          enableWorker: true, lazyLoad: false, enableStashBuffer: true, stashInitialSize: 1024 * 1024,
          liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 60, autoCleanupMinBackwardDuration: 30
        });
        mp.on(window.mpegts.Events.ERROR, function (t, d) { if (src.direct && !self.played) NS.directBad.ts = true; self.next('Strömfel: ' + (d || t)); });
        mp.attachMediaElement(v);
        mp.load();
        this.playPromise();
        return;
      }
      return this.next('MPEG-TS stöds inte');
    }
    if (src.kind === 'remux') {
      this.startRemux(at);
      if (this.sub && this.sub.kind === 'ff') this.startSubs(this.sub.i, at);
      return;
    }
    // plain file
    this.pendingSeek = at;
    v.src = src.url;
    this.playPromise();
    if (this.sub && this.sub.kind === 'ff') this.startSubs(this.sub.i, at);
  };

  /** Converted playback: an HLS stream from the server, starting at `at` seconds into the film. */
  Player.prototype.startRemux = function (at) {
    var self = this, v = this.video;
    var src = this.sources[this.si];
    this.offset = at || 0;
    var url = NS.remuxUrl(src.url, this.offset, this.audioIdx, this.safeMode);
    // during AirPlay Safari's own player keeps going (a new sound track or position too): hls.js would send only sound
    if (window.Hls && window.Hls.isSupported() && !this.airNative) {
      var hls = this.hls = new window.Hls({
        enableWorker: true, startPosition: 0, maxBufferLength: 60, maxMaxBufferLength: 180, backBufferLength: 60,
        manifestLoadingTimeOut: 60000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 30000, fragLoadingTimeOut: 60000,
        liveSyncDurationCount: 9999, liveDurationInfinity: false
      });
      hls.on(window.Hls.Events.ERROR, function (ev, d) { self.onHlsError(d); });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { self.playPromise(); });
      // how fast segments reach this device (the server side is measured in the add-on log)
      var fl = { n: 0, bytes: 0, ms: 0, slow: 0 };
      hls.on(window.Hls.Events.FRAG_LOADED, function (ev, d) {
        try {
          var st = d.frag.stats || d.stats || {};
          var ms = (st.loading && st.loading.end - st.loading.start) || (st.tload - st.trequest) || 0;
          var by = st.total || st.loaded || 0;
          fl.n++; fl.bytes += by; fl.ms += ms;
          if (ms > (d.frag.duration || 4) * 1000) fl.slow++;
          if (fl.n === 3 || fl.n % 20 === 0) NS.diag('bitar ' + fl.n + ': ' + (fl.bytes * 8 / Math.max(1, fl.ms) / 1000).toFixed(1) + ' Mbit/s till enheten, ' + fl.slow + ' långsammare än realtid, buffert ' + Math.round((function () { try { return v.buffered.end(v.buffered.length - 1) - v.currentTime; } catch (e) { return 0; } })()) + ' s');
        } catch (e) { /* ignore */ }
      });
      this.airUrl = url;
      // iPhone/iPad (ManagedMediaSource): hls.js clears all <source> children and turns remote playback off when it
      // attaches, so the plain HLS source for AirPlay has to be added after that, next to hls.js's own source
      hls.on(window.Hls.Events.MEDIA_ATTACHED, function () { if (self.hls === hls) self.addAirSource(); });
      hls.loadSource(url);
      hls.attachMedia(v);
      return;
    }
    v.src = this.airNative ? new URL(url, location.href).href : url;
    this.airUrl = url;
    this.playPromise();
  };

  /** With hls.js in Safari: a plain HLS <source> after hls.js's own, which is what AirPlay hands to the Apple TV. */
  Player.prototype.addAirSource = function () {
    var v = this.video;
    if (!window.WebKitPlaybackTargetAvailabilityEvent || !this.hls) return;
    var src = this.airUrl || (this.sources && this.sources[this.si] && this.sources[this.si].url) || '';
    if (!src) return;
    try {
      v.disableRemotePlayback = false;
      v.setAttribute('x-webkit-airplay', 'allow');
      var el = v.querySelector('source.air') || document.createElement('source');
      el.className = 'air'; el.type = 'application/x-mpegURL'; el.src = new URL(src, location.href).href;
      if (!el.parentNode) v.appendChild(el);
    } catch (e) { /* ignore */ }
  };

  /**
   * AirPlay (iPhone/iPad/Mac Safari). Through hls.js (ManagedMediaSource) Safari only sends the sound, so switch
   * to Safari's own HLS player first: it hands the stream's address to the Apple TV, which then fetches the picture
   * itself. Back to hls.js when AirPlay ends (or if no Apple TV was picked).
   */
  Player.prototype.airplay = function () {
    var self = this, v = this.video;
    if (!v.webkitShowPlaybackTargetPicker) { NS.toast('AirPlay finns i Safari på iPhone, iPad och Mac', 'info'); return; }
    try {
      var src = this.airUrl || (this.sources && this.sources[this.si] && this.sources[this.si].url) || '';
      if (this.hls && src && !this.airNative) {
        var rel = v.currentTime || 0;
        try { this.hls.destroy(); } catch (e) { /* ignore */ }
        this.hls = null;
        this.airNative = true;
        [].slice.call(v.querySelectorAll('source')).forEach(function (s) { s.remove(); });
        v.disableRemotePlayback = false;
        v.setAttribute('x-webkit-airplay', 'allow');
        v.src = new URL(src, location.href).href;
        var seek = function () { v.removeEventListener('loadedmetadata', seek); if (rel > 1 && !self.live) { try { v.currentTime = rel; } catch (e) { /* ignore */ } } };
        v.addEventListener('loadedmetadata', seek);
        this.playPromise();
        clearTimeout(this.airT);
        this.airT = setTimeout(function () { if (self.airNative && !v.webkitCurrentPlaybackTargetIsWireless) self.airBack(); }, 30000);
      }
      v.webkitShowPlaybackTargetPicker();
    } catch (e) { NS.toast('AirPlay gick inte att starta', 'info'); }
  };
  /** AirPlay ended: back to hls.js on the phone, where it was. */
  Player.prototype.airBack = function () {
    if (!this.airNative || this.suspended) return;
    this.airNative = false;
    clearTimeout(this.airT);
    this.startSource(this.live ? 0 : this.cur());
  };

  Player.prototype.playPromise = function () {
    var self = this, v = this.video;
    var p = v.play();
    if (!p || !p.catch) return;
    p.catch(function (e) {
      if (!e || e.name !== 'NotAllowedError') return;
      // phones and some browsers refuse to start with sound unless you tapped right before: start muted instead
      v.muted = true;
      var p2 = v.play();
      if (p2 && p2.catch) p2.catch(function () { self.tapToPlay(); });
      self.unmuteHint();
    });
  };

  /** Shown when playback started muted: one tap turns the sound on. */
  Player.prototype.unmuteHint = function () {
    var self = this;
    if (this.unmuteEl) return;
    var b = this.unmuteEl = h('button', { class: 'btn focus unmute' }, [NS.icon('sub'), 'Tryck för ljud']);
    b.addEventListener('click', function (e) { e.stopPropagation(); self.video.muted = false; self.video.play(); b.remove(); self.unmuteEl = null; });
    this.el.appendChild(b);
  };

  /** The browser wouldn't start the video at all: show a big play button. */
  Player.prototype.tapToPlay = function () {
    var self = this;
    this.buffering(false);
    if (this.tapEl) return;
    var b = this.tapEl = h('button', { class: 'tap-play' }, NS.icon('play'));
    b.addEventListener('click', function (e) { e.stopPropagation(); self.video.muted = false; self.video.play(); b.remove(); self.tapEl = null; });
    this.el.appendChild(b);
  };

  Player.prototype.onHlsError = function (d) {
    NS.diag('hls-fel ' + d.type + '/' + d.details + (d.fatal ? ' (avbröt)' : '') + (d.response && d.response.code ? ' http ' + d.response.code : ''));
    if (!d || !d.fatal) return;
    var self = this;
    var H = window.Hls;
    var src = this.sources && this.sources[this.si];
    if (src && src.direct && !this.played) { NS.directBad.hls = true; this.next('Direktuppspelning blockerad'); return; }
    if (src && src.kind === 'remux' && !this.safeMode && (d.type === H.ErrorTypes.MEDIA_ERROR || /manifest|buffer/i.test(d.details || ''))) {
      this.safeMode = true; console.log('[norrsken] conversion output not playable, retry fully converted');
      if (this.media && /hevc|h265/i.test(this.media.v || '')) NS.store.set('hevcBad', true);
      var at = this.played ? this.cur() : this.start;
      this.teardown(); this.kind = 'remux'; this.startRemux(at); return;
    }
    if (d.type === H.ErrorTypes.NETWORK_ERROR && this.netRetry < 3) {
      this.netRetry++;
      setTimeout(function () { if (self.hls) self.hls.startLoad(); }, 1000 * this.netRetry);
      return;
    }
    if (d.type === H.ErrorTypes.MEDIA_ERROR && this.mediaRetry < 2) {
      this.mediaRetry++;
      if (this.mediaRetry === 2) this.hls.swapAudioCodec();
      this.hls.recoverMediaError();
      return;
    }
    this.next('Strömmen gick inte att spela (' + d.details + ')');
  };

  /** Try the next source, or give up. */
  Player.prototype.next = function (why) {
    this.lastErr = why;
    if (this.sources && this.si < this.sources.length - 1) {
      var at = this.live ? 0 : this.cur();
      this.si++;
      this.startSource(at);
      return;
    }
    this.fail(why);
  };
  Player.prototype.fail = function (why) {
    if (this.sources && this.si < this.sources.length - 1) return this.next(why);
    this.buffering(false);
    this.showError(why);
  };

  Player.prototype.watchdog = function () {
    var v = this.video;
    if (this.suspended || this.errShown || !this.sources || this.tapEl) return;
    // never got going on this source: try the next one instead of spinning forever
    if (!this.played && Date.now() - (this.srcStart || 0) > (this.kind === 'remux' ? 30000 : 15000)) {
      console.log('[norrsken] source', this.si, this.kind, 'did not start, trying next');
      this.srcStart = Date.now();
      this.next('Strömmen startade inte');
      return;
    }
    if (v.paused) return;
    if (Date.now() - (this.lastMove || 0) > 25000) {
      // stuck: reload the current source once, then fall back
      if (!this.reloaded) { this.reloaded = true; this.startSource(this.live ? 0 : this.cur()); }
      else { this.reloaded = false; this.next('Strömmen har slutat svara'); }
    } else this.reloaded = false;
  };

  /* ------------------------------------------------------------ time */
  Player.prototype.cur = function () { return (this.kind === 'remux' ? this.offset : 0) + (this.cuOff || 0) + (this.video.currentTime || 0); };
  Player.prototype.duration = function () {
    if (this.item.t === 'catchup') return this.dur || 0;
    if (this.kind !== 'remux') { var d = this.video.duration; if (d && isFinite(d)) return d; }
    return this.dur || 0;
  };
  Player.prototype.seekTo = function (t) {
    var d = this.duration();
    t = Math.max(0, d ? Math.min(t, d - 2) : t);
    if (this.item.t === 'catchup') {
      // the archive can't be seeked inside one request: ask the provider for a new start time
      t = Math.min(t, this.cuMax());
      var rel0 = t - this.cuOff;
      var v0 = this.video, inB = false;
      try { for (var j = 0; j < v0.buffered.length; j++) if (rel0 >= v0.buffered.start(j) && rel0 <= v0.buffered.end(j) - 1) inB = true; } catch (e) { /* ignore */ }
      if (inB) { try { v0.currentTime = rel0; } catch (e) { /* ignore */ } } else this.play(this.item, t);
      this.tick();
      return;
    }
    if (this.kind === 'remux') {
      // inside what has already been converted: just move; further away: restart the conversion there
      var rel = t - this.offset;
      var v = this.video, inBuf = false;
      try { for (var i = 0; i < v.seekable.length; i++) if (rel >= v.seekable.start(i) && rel <= v.seekable.end(i) - 1) inBuf = true; } catch (e) { /* ignore */ }
      // also anywhere the server has already converted (it runs far ahead): no restart, no waiting
      if (!inBuf && this.hls && rel >= 0) {
        try {
          var lv = this.hls.levels[Math.max(0, this.hls.currentLevel)];
          if (lv && lv.details && rel < lv.details.totalduration - 2) inBuf = true;
        } catch (e) { /* ignore */ }
      }
      if (inBuf && rel >= 0) { try { v.currentTime = rel; } catch (e) { /* ignore */ } }
      else {
        this.buffering(true);
        this.teardown();
        this.kind = 'remux';
        this.startRemux(t);
        if (this.sub && this.sub.kind === 'ff') this.rebaseSubs(t);
      }
    } else {
      try { this.video.currentTime = t; } catch (e) { /* ignore */ }
      if (this.sub && this.sub.kind === 'ff' && (t < this.subFrom - 1 || t > this.subLast + 90)) this.startSubs(this.sub.i, t);
    }
    this.tick();
  };

  Player.prototype.tick = function () {
    if (this.live) return;
    if (this.cuSeek) this.cuCatch();
    var d = this.duration();
    var c = this.scrubbing !== null && this.scrubbing !== undefined ? this.scrubbing : this.cur();
    var pct = d ? Math.min(100, c / d * 100) : 0;
    if (this.osdOn) {
      this.playedEl.style.width = pct + '%';
      this.knob.style.left = pct + '%';
      this.bubble.style.left = pct + '%';
      this.bubble.textContent = NS.fmtTime(c);
      this.timesL.textContent = NS.fmtTime(c);
      this.timesR.textContent = d ? '−' + NS.fmtTime(d - c) : '';
      var v = this.video;
      try {
        if (v.buffered.length && d) {
          var end = (this.kind === 'remux' ? this.offset : 0) + v.buffered.end(v.buffered.length - 1);
          this.bufEl.style.width = Math.min(100, end / d * 100) + '%';
        }
      } catch (e) { /* ignore */ }
    }
    // next episode prompt
    if (d > 60 && this.nextEp() && !this.nextDismissed && !this.nextOn && d - this.cur() <= Math.max(25, Math.min(d * 0.04, 90)) && !this.video.paused) this.showNext();
    this.introTick();
  };

  Player.prototype.saveProgress = function (final) {
    if (this.live || !this.sources || this.item.t === 'catchup') return;
    var d = this.duration();
    var c = this.cur();
    if (!d || c < 5) return;
    var it = this.item;
    NS.state.progress[it.k] = { pos: c, dur: d, ts: Date.now() };
    NS.state.dirty = true;
    var s = snap(Object.assign({}, it, { dur: Math.round(d) }));
    NS.api.progress(s, c, d).catch(function () {});
    if (final && d && c / d >= 0.95) delete NS.state.progress[it.k];
  };

  Player.prototype.onEnded = function () {
    if (this.live && this.tshift) { this.goLive(); return; }
    if (this.live) { this.startSource(0); return; }
    if (this.item.t === 'catchup') { this.cuEnded(); return; }
    this.saveProgress(true);
    if (this.nextEp()) this.playNext();
    else this.exit();
  };

  /* ------------------------------------------------------------ episodes */
  Player.prototype.allEps = function () {
    var s = this.series;
    if (!s || !s.seasons) return [];
    var out = [];
    s.seasons.forEach(function (x) { out.push.apply(out, x.eps); });
    return out;
  };
  Player.prototype.nextEp = function () {
    if (this.item.t !== 'episode') return null;
    var all = this.allEps();
    var id = this.item.id;
    var i = all.findIndex(function (e) { return e.id === id; });
    return i >= 0 ? all[i + 1] || null : null;
  };
  Player.prototype.playNext = function (byUser) {
    var self = this;
    var nx = this.nextEp();
    if (!nx) return;
    this.autoCount = byUser ? 0 : (this.autoCount || 0) + 1;
    if (this.autoCount >= 3) {
      // three episodes in a row without touching anything: check that someone is still watching
      this.autoCount = 0;
      this.video.pause();
      this.hideNext();
      NS.confirm({ title: 'Tittar du fortfarande?', text: 'Nästa: ' + NS.epCode(nx) + ' ' + nx.n, buttons: [{ label: 'Fortsätt titta', icon: 'play', value: true }, { label: 'Avsluta', value: false }], cancel: false })
        .then(function (yes) { if (yes) self.playNext(true); else self.exit(); });
      return;
    }
    var c = this.cur(), d = this.duration();
    if (d) NS.api.progress(snap(Object.assign({}, this.item, { dur: Math.round(d) })), Math.max(c, d), d).catch(function () {});
    delete NS.state.progress[this.item.k];
    NS.state.dirty = true;
    var s = this.series;
    this.play(Object.assign({}, nx, { sn: s.n, bd: s.bd }), 0);
  };
  Player.prototype.showNext = function () {
    var self = this;
    var nx = this.nextEp();
    if (!nx) return;
    this.nextOn = true;
    var left = 10;
    var bar = h('i', { style: 'width:0%' });
    var btn = h('div', { class: 'btn focus cd', onclick: function () { self.playNext(true); } }, [NS.icon('play'), 'Spela nu', bar]);
    var credits = h('div', { class: 'btn', onclick: function () { self.nextDismissed = true; self.hideNext(); } }, 'Titta på eftertexterna');
    this.nextBtns = [btn, credits];
    this.nextI = 0;
    this.nextEl.innerHTML = '';
    this.nextEl.appendChild(h('div', { class: 'nl', text: 'Nästa avsnitt' }));
    this.nextEl.appendChild(h('div', { class: 'nt', text: NS.epCode(nx) + '  ' + nx.n }));
    this.nextEl.appendChild(h('div', { class: 'btns' }, [btn, credits]));
    this.nextEl.classList.add('on');
    clearInterval(this.nextT);
    this.nextT = setInterval(function () {
      if (self.video.paused) return; // the countdown waits while paused
      left -= 0.25;
      bar.style.width = Math.min(100, (10 - left) * 10) + '%';
      if (left <= 0) { clearInterval(self.nextT); self.playNext(false); }
    }, 250);
  };
  Player.prototype.hideNext = function () {
    clearInterval(this.nextT);
    this.nextOn = false;
    if (this.nextEl) this.nextEl.classList.remove('on');
  };

  /* ------------------------------------------------------------ OSD */
  Player.prototype.buffering = function (on) {
    var self = this;
    clearTimeout(this.bufT);
    if (on) this.bufT = setTimeout(function () { self.el.classList.add('buffering'); }, 250);
    else this.el.classList.remove('buffering');
  };

  /** Subtitles move up while the controls are showing, so the buttons never cover them. */
  Player.prototype.liftCues = function () {
    var tr = this.track, line = this.osdOn && !this.live ? -7 : -3;
    if (!tr || !tr.cues) return;
    for (var i = 0; i < tr.cues.length; i++) if (tr.cues[i].line !== line) { try { tr.cues[i].line = line; } catch (e) { /* ignore */ } }
  };
  Player.prototype.showOsd = function (sticky) {
    var self = this;
    var was = this.osdOn;
    this.osdOn = true;
    if (!was) this.liftCues();
    this.osd.classList.add('on');
    this.tick();
    clearTimeout(this.osdT);
    if (sticky) return;
    this.osdT = setTimeout(function () {
      if (self.video.paused && !self.live) return;
      if (self.scrubbing !== null && self.scrubbing !== undefined) return;
      if (self.zone !== 'bar' && !self.live) return;
      self.hideOsd();
    }, this.live ? 5000 : 4500);
  };
  Player.prototype.hideOsd = function () {
    this.osdOn = false;
    this.liftCues();
    this.osd.classList.remove('on');
    if (!this.live) { this.zone = 'bar'; this.paintZone(); }
  };

  Player.prototype.renderTitle = function () {
    var it = this.item;
    this.ttl.innerHTML = '';
    if (this.live) return;
    if (it.t === 'catchup') {
      this.ttl.appendChild(h('b', { text: it.n }));
      this.ttl.appendChild(h('span', { text: it.sn + '  ·  ' + NS.fmtClock(it.cu.start * 1000) + '–' + NS.fmtClock((it.cu.start + it.cu.dur * 60) * 1000) }));
    } else if (it.t === 'episode') {
      this.ttl.appendChild(h('b', { text: it.sn || it.n }));
      this.ttl.appendChild(h('span', { text: NS.epCode(it) + '  ' + it.n }));
    } else {
      this.ttl.appendChild(h('b', { text: it.n }));
      if (it.y) this.ttl.appendChild(h('span', { text: String(it.y) }));
    }
  };

  Player.prototype.renderChan = function () {
    if (!this.live) return;
    var it = this.item;
    var e = NS.epgFor(it.id);
    var c = this.chan;
    c.innerHTML = '';
    var logo = h('div', { class: 'clogo' });
    if (it.img) logo.appendChild(NS.img(it.img, '', function () { logo.appendChild(h('span', { text: it.n })); }));
    else logo.appendChild(h('span', { text: it.n }));
    c.appendChild(logo);
    var info = h('div', { class: 'cinfo' });
    info.appendChild(h('div', { class: 'cname' }, [it.num ? h('span', { class: 'n', text: String(it.num) }) : null, h('span', { text: it.n }), h('span', { class: 'live-dot', text: 'Live' })]));
    var now = e && e.now;
    info.appendChild(h('div', { class: 'cnow', text: now ? now.t : it.n }));
    if (now) {
      var pct = Math.min(100, Math.max(0, (Date.now() - now.s) / (now.e - now.s) * 100));
      info.appendChild(h('div', { class: 'ctime' }, [NS.fmtClock(now.s) + '–' + NS.fmtClock(now.e), NS.progEl(pct)]));
    }
    if (e && e.next) info.appendChild(h('div', { class: 'cnext' }, ['Härnäst ' + NS.fmtClock(e.next.s) + '  ', h('b', { text: e.next.t })]));
    c.appendChild(info);
  };

  Player.prototype.trackOptions = function () {
    var o = { audio: [], subs: [] };
    var hls = this.hls;
    var self = this;
    var pa = this.probe && this.probe.audio || [];
    var chNote = function (n) { return n > 2 ? n === 6 ? '5.1' : n === 8 ? '7.1' : n + ' kanaler' : ''; };
    var nat = this.nativeAudio();
    if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
      o.audio = hls.audioTracks.map(function (t, i) { return { kind: 'hls', i: i, label: t.name || NS.langName(NS.langCode(t.lang)) || 'Ljud ' + (i + 1), code: NS.langCode(t.lang || t.name), on: hls.audioTrack === i }; });
    } else if (nat) {
      // the screen plays the file itself and can switch its sound tracks: instant, no conversion
      var same = pa.length === nat.length;
      o.audio = Array.prototype.map.call(nat, function (t, i) {
        var p = same ? pa[i] : null;
        var code = NS.langCode(p ? p.lang : t.language || t.label);
        var label = p ? p.label + (p.title && p.title !== p.label ? ' – ' + p.title : '') : (NS.langName(code) || t.label || 'Ljud ' + (i + 1));
        return { kind: 'native', i: i, label: label, code: code, note: p ? chNote(p.ch) : '', on: !!t.enabled };
      });
    } else if (pa.length > 1) {
      o.audio = pa.map(function (t) { return { kind: 'ff', i: t.i, label: t.label + (t.title && t.title !== t.label ? ' – ' + t.title : ''), code: NS.langCode(t.lang || t.label), note: chNote(t.ch), on: self.audioIdx === t.i }; });
    }
    var sub = this.sub;
    o.subs.push({ kind: 'off', i: -1, label: 'Av', on: !sub });
    if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
      hls.subtitleTracks.forEach(function (t, i) { o.subs.push({ kind: 'hls', i: i, label: t.name || NS.langName(NS.langCode(t.lang)) || 'Undertext ' + (i + 1), code: NS.langCode(t.lang || t.name), forced: !!t.forced, on: !!sub && sub.kind === 'hls' && sub.i === i }); });
    }
    if (this.probe && this.tok) {
      this.probe.subs.filter(function (s) { return s.text; }).forEach(function (s) {
        o.subs.push({ kind: 'ff', i: s.i, label: s.label + (s.forced ? ' (tvingad)' : '') + (s.title && s.title !== s.label ? ' – ' + s.title : ''), code: NS.langCode(s.lang || s.label), forced: !!s.forced, on: !!sub && sub.kind === 'ff' && sub.i === s.i });
      });
    }
    return o;
  };

  /** The screen's own list of sound tracks, when it has one and it is in charge (a file or HLS played without hls.js). */
  Player.prototype.nativeAudio = function () {
    var at = this.video.audioTracks;
    if (this.hls || !at || at.length < 2 || this.kind === 'remux') return null;
    return at;
  };
  /** Language of the sound that plays now. */
  Player.prototype.curAudioCode = function () {
    var on = this.trackOptions().audio.find(function (t) { return t.on; });
    if (on) return on.code;
    var pa = this.probe && this.probe.audio || [];
    var a = pa.find(function (t) { return t.i === this.audioIdx; }, this) || pa[0];
    return a ? NS.langCode(a.lang || a.label) : '';
  };
  /**
   * The profile's languages: sound as picked last time (kids: Swedish), subtitles in Swedish unless the profile chose
   * something else. Swedish speech needs no Swedish text, except the "forced" kind that only covers foreign lines.
   */
  Player.prototype.autoTracks = function () {
    if (this.autoDone === this.item.k) return;
    var o = this.trackOptions();
    var apref = NS.langCode(NS.pref('audio') || NS.store.get(NS.pkey('audioLang'), '')) || (NS.profile && NS.profile.kids ? 'sv' : '');
    var spref = NS.pref('sub');
    var applied = false;
    if (apref) {
      var a = o.audio.find(function (t) { return t.code === apref; });
      if (a && !a.on) { this.setAudio(a, true); applied = true; }
    }
    if (spref) {
      var speech = (a && a.code) || this.curAudioCode();
      var cands = o.subs.filter(function (t) { return t.kind !== 'off' && t.code === spref; });
      var s = speech === spref ? cands.find(function (t) { return t.forced; }) : (cands.find(function (t) { return !t.forced; }) || cands[0]);
      if (s && !s.on) { this.setSub(s, true); applied = true; }
    }
    if (applied || o.subs.length > 1 || o.audio.length) this.autoDone = this.item.k;
  };

  Player.prototype.renderButtons = function () {
    if (this.live) return;
    var self = this;
    var b = [];
    var opts = this.trackOptions();
    b.push({ id: 'pp', icon: this.video.paused ? 'play' : 'pause', label: this.video.paused ? 'Spela' : 'Pausa' });
    b.push({ id: 'rw', icon: 'rw', label: '10 s' });
    b.push({ id: 'ff', icon: 'ff', label: '10 s' });
    b.push({ id: 'tracks', icon: 'sub', label: 'Ljud och undertexter' });
    if (this.nextEp()) b.push({ id: 'next', icon: 'next', label: 'Nästa avsnitt' });
    b.push({ id: 'restart', icon: 'restart', label: 'Från början' });
    if (this.item.t === 'catchup') b.push({ id: 'live', icon: 'live', label: 'Gå till live' });
    this.btns = b;
    this.obtns.innerHTML = '';
    this.btnEls = b.map(function (x, i) {
      var e = h('div', { class: 'btn', onclick: function () { self.bi = i; self.pressBtn(); } }, [NS.icon(x.icon), x.label]);
      self.obtns.appendChild(e);
      return e;
    });
    if (this.bi === undefined || this.bi >= b.length) this.bi = 0;
    this.paintZone();
  };
  Player.prototype.paintZone = function () {
    if (this.live) return;
    var self = this;
    this.bar.classList.toggle('focus', this.zone === 'bar');
    (this.btnEls || []).forEach(function (e, i) { e.classList.toggle('focus', self.zone === 'btns' && i === self.bi); });
  };
  Player.prototype.pressBtn = function () {
    var b = this.btns[this.bi];
    if (!b) return;
    if (b.id === 'pp') { if (this.video.paused) this.playPromise(); else this.video.pause(); var self = this; setTimeout(function () { self.renderButtons(); }, 50); }
    else if (b.id === 'rw') this.seekTo(this.cur() - 10);
    else if (b.id === 'ff') this.seekTo(this.cur() + 10);
    else if (b.id === 'tracks') this.openTracks();
    else if (b.id === 'next') this.playNext();
    else if (b.id === 'live') this.toLive();
    else if (b.id === 'restart') { this.seekTo(0); this.zone = 'bar'; this.paintZone(); this.playPromise(); }
  };

  /* ------------------------------------------------------------ scrubbing */
  Player.prototype.scrub = function (dir, repeat) {
    if (this.live) return;
    var d = this.duration();
    if (!d) return;
    this.scrubN = repeat ? (this.scrubN || 0) + 1 : 0;
    var step = this.scrubN > 24 ? 120 : this.scrubN > 12 ? 60 : this.scrubN > 4 ? 30 : 10;
    var base = this.scrubbing !== null && this.scrubbing !== undefined ? this.scrubbing : this.cur();
    this.scrubbing = Math.max(0, Math.min(d - 1, base + dir * step));
    this.bar.classList.add('scrub');
    this.showOsd(true);
    this.tick();
    var self = this;
    clearTimeout(this.scrubT);
    this.scrubT = setTimeout(function () { self.commitScrub(); }, 750);
  };
  Player.prototype.commitScrub = function () {
    clearTimeout(this.scrubT);
    if (this.scrubbing === null || this.scrubbing === undefined) return;
    var t = this.scrubbing;
    this.learnIntro(this.cur(), t);
    this.scrubbing = null;
    this.bar.classList.remove('scrub');
    if (this.nextOn && this.duration() - t > 25) this.hideNext();
    this.seekTo(t);
    this.showOsd();
  };

  /* ------------------------------------------------------------ tracks & subtitles */
  Player.prototype.openTracks = function () {
    var self = this;
    var o = this.trackOptions();
    this.panel = 'tracks';
    this.trItems = [];
    var box = h('div', { class: 'tracks' });
    var add = function (title, list) {
      if (!list.length) return;
      box.appendChild(h('h3', { text: title }));
      list.forEach(function (t) {
        var e = h('div', { class: 'ti', onclick: function () { self.ti = self.trItems.indexOf(t); self.pickTrack(); } }, [h('span', { class: 'chk' }, t.on ? NS.icon('check') : null), t.label, t.note ? h('span', { class: 'note', text: t.note }) : null]);
        t.el = e;
        t.group = title;
        self.trItems.push(t);
        box.appendChild(e);
      });
    };
    add('Ljud', o.audio);
    add('Undertexter', o.subs.length > 1 ? o.subs : []);
    if (!this.trItems.length) box.appendChild(h('p', { class: 'note', style: 'padding:2rem 0;color:var(--text-2)', text: 'Den här strömmen har inga fler ljudspår eller undertexter.' }));
    this.sideR.innerHTML = '';
    this.sideR.appendChild(h('div', { class: 'ph', text: 'Ljud och undertexter' }));
    this.sideR.appendChild(box);
    this.ti = Math.max(0, this.trItems.findIndex(function (t) { return t.on; }));
    this.paintTracks();
    this.sideR.classList.add('on');
    this.hideOsd();
  };
  Player.prototype.paintTracks = function () {
    var self = this;
    this.trItems.forEach(function (t, i) { t.el.classList.toggle('focus', i === self.ti); });
  };
  Player.prototype.pickTrack = function () {
    var t = this.trItems[this.ti];
    if (!t) return;
    if (t.group === 'Ljud') {
      this.setAudio(t);
      if (t.code) NS.setPref('audio', t.code);
      // foreign speech and no subtitles on: the profile's subtitle language comes on, as it does at the start
      var spref = NS.pref('sub');
      if (spref && t.code && t.code !== spref && (!this.sub || this.sub.forced)) {
        var s = this.trackOptions().subs.find(function (x) { return x.kind !== 'off' && x.code === spref && !x.forced; });
        if (s) { this.setSub(s, true); this.sub.auto = true; }
      } else if (spref && t.code === spref && this.sub && this.sub.auto) this.setSub({ kind: 'off' }, true); // back to own language: off again
    }
    else { this.setSub(t); NS.setPref('sub', t.kind === 'off' ? '' : t.code || ''); }
    this.closePanel();
  };
  Player.prototype.setAudio = function (t, silent) {
    var self = this;
    if (t.kind === 'hls' && this.hls) { this.hls.audioTrack = t.i; if (!silent) NS.toast('Ljud: ' + t.label, 'sub'); return; }
    if (t.kind === 'native') {
      var at = this.nativeAudio();
      if (at) {
        for (var j = 0; j < at.length; j++) at[j].enabled = j === t.i;
        this.audioIdx = (this.probe && this.probe.audio[t.i]) ? this.probe.audio[t.i].i : t.i;
        if (!silent) NS.toast('Ljud: ' + t.label, 'sub');
        // some TVs list the tracks but keep playing the first one: then let the server pick the track instead
        setTimeout(function () {
          var at2 = self.nativeAudio();
          if (at2 && at2[t.i] && !at2[t.i].enabled && self.probe && self.probe.audio.length > 1) self.setAudio({ kind: 'ff', i: self.audioIdx, label: t.label }, true);
        }, 1500);
        return;
      }
      if (!this.probe || !this.probe.audio[t.i]) return;
      t = { kind: 'ff', i: this.probe.audio[t.i].i, label: t.label };
    }
    if (t.kind !== 'ff') return;
    this.audioIdx = t.i;
    // switching audio in a container the browser plays natively needs the remuxer
    var ri = this.sources.findIndex(function (s) { return s.kind === 'remux'; });
    if (ri < 0) { if (!silent) NS.toast('Ljudspåret kan inte bytas här: servern saknar ffmpeg', 'info'); return; }
    if (this.waitStart) { this.si = ri; return; } // not started yet: the first start uses this track
    var at = this.cur();
    this.si = ri;
    this.startSource(at);
    if (!silent) NS.toast('Ljud: ' + t.label, 'sub');
  };
  Player.prototype.setSub = function (t, silent) {
    this.stopSubs();
    if (this.hls) this.hls.subtitleTrack = -1;
    if (t.kind === 'off') { this.sub = null; if (!silent) NS.toast('Undertexter av', 'sub'); return; }
    this.sub = { kind: t.kind, i: t.i, label: t.label, forced: !!t.forced };
    if (t.kind === 'hls' && this.hls) { this.hls.subtitleTrack = t.i; this.hls.subtitleDisplay = true; }
    else if (t.kind === 'ff') this.startSubs(t.i, this.cur());
    if (!silent) NS.toast('Undertexter: ' + t.label, 'sub');
  };

  Player.prototype.newTrack = function () {
    var v = this.video;
    for (var i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
    var tr = v.addTextTrack('subtitles', 'sub', 'sv');
    tr.mode = 'showing';
    this.track = tr;
    return tr;
  };
  Player.prototype.addCue = function (c) {
    var shift = this.kind === 'remux' ? this.offset : 0;
    var s = c.s - shift, e = c.e - shift;
    if (e <= 0) return;
    try {
      var Cue = window.VTTCue || window.TextTrackCue;
      var cue = new Cue(Math.max(0, s), e, c.text);
      cue.line = this.osdOn && !this.live ? -7 : -3;
      this.track.addCue(cue);
    } catch (err) { /* ignore bad cue */ }
  };
  Player.prototype.rebaseSubs = function (t) {
    if (!this.sub) return;
    var self = this;
    this.newTrack();
    (this.cues || []).forEach(function (c) { self.addCue(c); });
    if (t < this.subFrom - 1 || t > this.subLast + 90) this.startSubs(this.sub.i, t, true);
  };
  Player.prototype.stopSubs = function () {
    if (this.subCtl) { try { this.subCtl.abort(); } catch (e) { /* ignore */ } this.subCtl = null; }
    if (this.track) this.track.mode = 'disabled';
    this.track = null;
  };
  /** Stream embedded subtitles as WebVTT and add cues as they arrive. */
  Player.prototype.startSubs = function (si, from, keepCues) {
    var self = this;
    if (this.subCtl) { try { this.subCtl.abort(); } catch (e) { /* ignore */ } }
    if (!keepCues || !this.track) { this.cues = []; this.cueSeen = {}; this.newTrack(); }
    from = Math.max(0, Math.floor(from || 0));
    this.subFrom = from;
    this.subLast = from;
    if (!this.tok || !window.fetch || !window.ReadableStream) return;
    var ctl = this.subCtl = new AbortController();
    var buf = '';
    var dec = new TextDecoder();
    var handle = function (block) {
      var lines = block.split('\n');
      var ti = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
      if (ti < 0) return;
      var parts = lines[ti].split('-->');
      var s = parseVttTime(parts[0]), e = parseVttTime(parts[1]);
      if (isNaN(s) || isNaN(e)) return;
      var text = lines.slice(ti + 1).join('\n').trim();
      if (!text) return;
      var key = s + '|' + text;
      if (self.cueSeen[key]) return;
      self.cueSeen[key] = 1;
      var c = { s: s, e: e, text: text };
      self.cues.push(c);
      if (e > self.subLast) self.subLast = e;
      self.addCue(c);
    };
    fetch('subs?t=' + this.tok + '&s=' + si + '&ss=' + from, { signal: ctl.signal }).then(function (r) {
      var rd = r.body.getReader();
      var pump = function () {
        return rd.read().then(function (x) {
          if (x.done) { if (buf.trim()) handle(buf.trim()); return; }
          buf += dec.decode(x.value, { stream: true }).replace(/\r/g, '');
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, idx).trim()); buf = buf.slice(idx + 2); }
          return pump();
        });
      };
      return pump();
    }).catch(function () { /* aborted or failed */ });
  };

  /* ------------------------------------------------------------ live: zapping & channel list */
  /** Catch-up: start the programme that is on now from its beginning (when the channel has an archive). */
  Player.prototype.restartProgramme = function () {
    var e = NS.epgFor(this.item.id);
    if (!this.item.arc || !e || !e.now) { NS.toast('Kanalen har inget arkiv att spola tillbaka i', 'info'); return; }
    NS.router.replace(new Player({ item: NS.catchupItem(this.item, e.now, this.list) }));
  };
  /** Catch-up: how far one may go (a programme still on air can't go past "now"). */
  Player.prototype.cuMax = function () {
    var cu = this.item.cu;
    if (!cu) return 0;
    var aired = Date.now() / 1000 - cu.start - 30;
    return Math.max(0, Math.min(cu.dur * 60 - 5, aired));
  };
  Player.prototype.cuLiveNow = function () { var cu = this.item.cu; return cu && Date.now() / 1000 < cu.start + cu.dur * 60; };
  /** Catch-up: after a new start, wait until the exact second is loaded, then jump there. */
  Player.prototype.cuCatch = function () {
    if (!this.cuSeek || this.suspended) return;
    var v = this.video;
    var end = 0;
    try { if (v.buffered.length) end = v.buffered.end(v.buffered.length - 1); } catch (e) { /* ignore */ }
    if (end >= this.cuSeek + 1) {
      try { v.currentTime = this.cuSeek; } catch (e) { /* ignore */ }
      this.cuSeek = 0;
      this.buffering(false);
      if (v.paused && this._cuHeld) { this._cuHeld = false; this.playPromise(); }
    } else if (this.played && !v.paused) { v.pause(); this._cuHeld = true; this.buffering(true); }
  };

  /**
   * Catch-up: the archive stream ran out. The provider cuts an archive request at the length it knew about
   * when it was asked, so in a programme still on air (or one cut short) ask again from where we are;
   * go to the live broadcast only when we are close to "now" or the programme is over.
   */
  Player.prototype.cuEnded = function () {
    var cu = this.item.cu, pos = this.cur();
    var left = this.cuLiveNow() ? this.cuMax() - pos : cu.dur * 60 - 30 - pos;
    // the same end again right away: the archive has nothing more for us, don't loop
    var again = this._cuEnd !== undefined && Math.abs(pos - this._cuEnd) < 10;
    this._cuEnd = pos;
    if (left >= 60 && !again) { this.play(this.item, pos); return; }
    if (this.cuLiveNow()) { this.toLive(); return; }
    if (this.item.fromPause) { this.pauseNextProg(); return; }
    this.exit();
  };

  /* ------------------------------------------------------------ pause live TV */
  /**
   * Pause on a live channel. A short pause just holds the picture. After a few seconds the stream is stopped
   * (so it doesn't hold the provider connection) and, when you go on, you continue where you paused:
   *  - from the channel's archive when it has one (catch-up, with its own timeline), or
   *  - from the server's recording: it starts recording the channel when you pause and plays that back.
   * Without either, going on after a while starts live again and says so.
   */
  Player.prototype.livePlayPause = function (play) {
    var v = this.video;
    var paused = this.tshift ? !this.tshift.playing || v.paused : v.paused;
    if (play === null || play === undefined) play = paused;
    if (play) this.liveResume(); else this.livePause();
  };
  Player.prototype.livePause = function () {
    var self = this, v = this.video;
    if (this.tshift && this.tshift.playing) { v.pause(); this.showOsd(true); this.paintTshift(); return; } // pausing the recording: it keeps recording
    if (this.livePausedAt) return;
    v.pause();
    this.livePausedAt = Date.now();
    this.showOsd(true);
    this.paintTshift();
    clearTimeout(this.lpT);
    this.lpT = setTimeout(function () { self.freezeLive(); }, 4000);
  };
  Player.prototype.liveResume = function () {
    var self = this, v = this.video;
    clearTimeout(this.lpT);
    var ts = this.tshift;
    if (ts && ts.playing) { this.playPromise(); this.showOsd(); this.paintTshift(); return; }
    if (ts && ts.mode === 'arc') {
      // on with the archive from the paused second (a few seconds back: what the screen showed was behind live)
      var prog = ts.prog;
      var it = NS.catchupItem(this.item, prog, this.list);
      it.fromPause = true;
      var from = Math.max(0, (ts.at - prog.s) / 1000 - 8);
      this.tshift = null;
      this.livePausedAt = 0;
      NS.router.replace(new Player({ item: it, start: from }));
      return;
    }
    if (ts && ts.mode === 'rec') {
      if (!ts.url) { this.buffering(true); ts.resume = true; return; } // the recording hasn't answered yet: go on when it does
      ts.playing = true;
      this.livePausedAt = 0;
      this.startRec(ts.pos || 0);
      ts.pos = 0;
      this.paintTshift();
      return;
    }
    var long = this.livePausedAt && Date.now() - this.livePausedAt > 20000;
    this.livePausedAt = 0;
    this.paintTshift();
    if (long || !this.sources || !v.src && !this.hls && !this.mp) { this.startSource(0); NS.toast('Tillbaka till live', 'live'); }
    else this.playPromise();
    this.showOsd();
  };
  /** Still paused after a few seconds: keep the picture on screen, stop the stream, get ready to continue. */
  Player.prototype.freezeLive = function () {
    var self = this, v = this.video;
    if (!this.live || !this.livePausedAt || !this.video.paused || this.tshift) return;
    var st = (NS.status && NS.status.pause) || { mode: 'auto', rec: true, max: 60 };
    if (st.mode === 'off') return;
    var e = NS.epgFor(this.item.id);
    var at = this.livePausedAt;
    var arc = this.item.arc && e && e.now && e.now.s <= at;
    if (!arc && !(st.mode === 'auto' && st.rec)) return;
    this.snapFrame();
    this.teardown();
    if (arc) { this.tshift = { mode: 'arc', at: at, prog: e.now }; this.paintTshift(); return; }
    var ts = this.tshift = { mode: 'rec', at: at, max: st.max };
    this.paintTshift();
    NS.api.post('api/pause/start' + NS.pq(), { id: this.item.id }).then(function (r) {
      if (self.tshift !== ts) { NS.api.post('api/pause/' + r.id + '/stop', {}).catch(function () {}); return; }
      ts.id = r.id; ts.url = r.url; ts.max = r.max || ts.max;
      ts.aliveT = setInterval(function () {
        NS.api.post('api/pause/' + ts.id + '/alive', {}).then(function (a) { ts.sec = a.sec; ts.full = a.full; self.paintTshift(); }).catch(function () { /* gone: the next play goes live */ ts.lost = true; });
      }, 30000);
      if (ts.resume) { ts.resume = false; self.liveResume(); }
    }).catch(function (err) {
      if (self.tshift !== ts) return;
      self.tshift = null;
      NS.toast((err && err.message) || 'Pausen kunde inte spelas in', 'info');
      self.paintTshift();
      if (ts.resume) self.liveResume();
    });
  };
  /** Keep the current frame on screen (a canvas) while nothing streams. */
  Player.prototype.snapFrame = function () {
    var v = this.video, c = this.freezeEl;
    if (!c) return;
    try {
      var w = v.videoWidth, hh = v.videoHeight;
      if (w && hh) { c.width = w; c.height = hh; c.getContext('2d').drawImage(v, 0, 0, w, hh); c.classList.add('on'); }
    } catch (err) { /* a picture from another site can't always be drawn: black then */ }
  };
  /** Play the server's recording of the paused channel (it keeps growing while we watch). */
  Player.prototype.startRec = function (at) {
    var self = this, v = this.video, ts = this.tshift;
    if (ts.lost) { this.goLive(); return; }
    this.teardown();
    this.kind = 'hls';
    this.played = false;
    this.srcStart = Date.now();
    this.lastMove = Date.now();
    this.buffering(true);
    var url = ts.url;
    if (window.Hls && window.Hls.isSupported()) {
      // an EVENT playlist: start where the recording starts and never jump ahead to its end
      var hls = this.hls = new window.Hls({ enableWorker: true, startPosition: at || 0, liveSyncDurationCount: 99999, liveMaxLatencyDurationCount: Infinity,
        maxBufferLength: 40, backBufferLength: 60, manifestLoadingTimeOut: 40000, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 });
      hls.on(window.Hls.Events.ERROR, function (ev, d) { if (d && d.fatal) { NS.diag('pausinspelning: ' + d.details); self.goLive(); } });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { self.playPromise(); });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      this.kind = 'native';
      if (at) this.pendingSeek = at;
      v.src = url;
      this.playPromise();
    }
    var off = function () { v.removeEventListener('playing', off); self.freezeEl.classList.remove('on'); };
    v.addEventListener('playing', off);
  };
  /** Leave the paused/behind state: stop the recording (or forget the archive spot). */
  Player.prototype.endTshift = function () {
    var ts = this.tshift;
    clearTimeout(this.lpT);
    this.livePausedAt = 0;
    if (this.freezeEl) this.freezeEl.classList.remove('on');
    if (!ts) return;
    this.tshift = null;
    clearInterval(ts.aliveT);
    if (ts.id) NS.api.post('api/pause/' + ts.id + '/stop', {}).catch(function () {});
    this.paintTshift();
  };
  /** ▶▶ / "Gå till live": back to the live broadcast. */
  Player.prototype.goLive = function () {
    if (!this.live) { if (this.item.t === 'catchup') this.toLive(); return; }
    this.endTshift();
    this.startSource(0);
    this.showOsd();
    NS.toast('Live', 'live');
  };
  /** Where we are in the recording, and how much has been recorded (seconds). */
  Player.prototype.recPos = function () {
    var ts = this.tshift;
    if (!ts || ts.mode !== 'rec') return 0;
    return ts.playing ? this.video.currentTime || 0 : ts.pos || 0;
  };
  Player.prototype.recLen = function () {
    var ts = this.tshift;
    if (!ts || ts.mode !== 'rec') return 0;
    return Math.max(ts.sec || 0, this.recPos() + 1);
  };
  /** Paint the seek bar of the recording (hidden unless we are behind live or paused on a recording). */
  Player.prototype.paintLBar = function () {
    var ts = this.tshift;
    var rec = !!(ts && ts.mode === 'rec' && ts.url);
    this.el.classList.toggle('lshift', rec);
    if (!rec || this.lDrag) return;
    var pos = this.recPos(), len = this.recLen();
    this.lShow(pos, len);
  };
  /** Show a point on the seek bar: knob, bubble and both times. */
  Player.prototype.lShow = function (t, len) {
    len = len || this.recLen() || 1;
    var pct = Math.min(100, Math.max(0, t / len * 100));
    this.lPlayed.style.width = pct + '%'; this.lKnob.style.left = pct + '%'; this.lBubble.style.left = pct + '%';
    this.lBubble.textContent = NS.fmtTime(t);
    this.ltA.textContent = NS.fmtTime(t);
    this.ltB.textContent = '−' + NS.fmtTime(Math.max(0, len - t));
  };
  /** Go to a point in the recording: while playing the picture jumps there, while paused the next play starts there. */
  Player.prototype.seekRec = function (t) {
    var ts = this.tshift;
    if (!ts || ts.mode !== 'rec' || !ts.url) return;
    t = Math.max(0, Math.min(t, this.recLen() - 2));
    if (!ts.playing) { ts.pos = t; this.paintLBar(); this.paintTshift(); return; }
    try { this.video.currentTime = t; } catch (e) { /* ignore: the picture stays where it was */ }
    this.buffering(true);
    this.paintLBar();
  };
  /** Pointer position on the seek bar as a share of the recording. */
  Player.prototype.lFrac = function (e) {
    var r = this.lbar.getBoundingClientRect();
    return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  };

  /** The paused / behind-live line in the live OSD. */
  Player.prototype.paintTshift = function () {
    var el = this.tsEl;
    if (!el) return;
    var ts = this.tshift, v = this.video;
    el.innerHTML = '';
    var on = !!(ts || this.livePausedAt);
    el.classList.toggle('on', on);
    this.el.classList.toggle('behind', !!(ts && ts.playing));
    if (this.liveBtn) this.liveBtn.style.display = ts ? '' : 'none';
    this.paintLBar();
    if (!on) return;
    var self = this;
    var behind = 0;
    if (ts && (ts.playing || ts.pos)) behind = Math.max(0, (Date.now() - ts.at) / 1000 - (ts.playing ? v.currentTime || 0 : ts.pos) - 4);
    else behind = (Date.now() - (ts ? ts.at : this.livePausedAt)) / 1000;
    var paused = !ts || !ts.playing || v.paused;
    el.appendChild(h('span', { class: 'ts-state' }, [NS.icon(paused ? 'pause' : 'play'), paused ? 'Pausad' : 'Efter live']));
    el.appendChild(h('b', { text: '−' + NS.fmtTime(behind) }));
    var note = '';
    if (ts && ts.mode === 'arc') note = 'Fortsätter från arkivet där du pausade';
    else if (ts && ts.mode === 'rec') note = ts.full ? 'Inspelningen är full (' + ts.max + ' min)' : ts.url ? (paused ? 'Spelar in medan du pausar · högst ' + ts.max + ' min' : 'Spelas in · högst ' + ts.max + ' min') : 'Startar inspelningen…';
    else if (this.livePausedAt) note = 'Bilden står still';
    if (note) el.appendChild(h('span', { class: 'ts-note', text: note }));
    el.onclick = function (e) { e.stopPropagation(); self.livePlayPause(); };
    this.paintLBar();
  };

  /** Watching a paused channel from its archive and the programme ended: go on with the next one, still behind live. */
  Player.prototype.pauseNextProg = function () {
    var self = this, it = this.item, end = (it.cu.start + it.cu.dur * 60) * 1000;
    NS.api.guide(it.ch.id, 1, 6).then(function (list) {
      var nx = (list || []).find(function (p) { return p.s >= end - 60e3 && p.s < Date.now() - 90e3; });
      if (!nx) { self.toLive(); return; }
      var n = NS.catchupItem(it.ch, nx, it.chList);
      n.fromPause = true;
      NS.router.replace(new Player({ item: n, start: 0 }));
    }).catch(function () { self.toLive(); });
  };

  /** Yellow (or 0): jump back to the channel you watched before. */
  Player.prototype.lastChannel = function () {
    if (!this.prevCh) { NS.toast('Ingen tidigare kanal ännu', 'info'); return; }
    this.tune(this.prevCh);
  };
  /** From an archived programme back to the channel's live broadcast. */
  Player.prototype.toLive = function () {
    var it = this.item;
    NS.router.replace(new Player({ item: it.ch, list: it.chList || [it.ch], cat: it.ch.cat }));
  };

  Player.prototype.zap = function (dir) {
    if (this.list.length < 2) return;
    var id = this.item.id;
    var i = this.list.findIndex(function (x) { return x.id === id; });
    i = (i + dir + this.list.length) % this.list.length;
    this.tune(this.list[i]);
  };
  Player.prototype.tune = function (it, list) {
    if (list) this.list = list;
    if (this.item && this.item.id !== it.id) this.prevCh = this.item;
    this.play(it, 0);
    var self = this;
    this.zapEl.innerHTML = '';
    if (it.num) this.zapEl.appendChild(h('span', { class: 'n', text: String(it.num) }));
    this.zapEl.appendChild(document.createTextNode(it.n));
    this.zapEl.classList.add('on');
    clearTimeout(this.zapT);
    this.zapT = setTimeout(function () { self.zapEl.classList.remove('on'); }, 2500);
  };

  Player.prototype.numKey = function (d) {
    var self = this;
    this.numBuf = ((this.numBuf || '') + d).slice(-4);
    this.numEl.textContent = this.numBuf;
    this.numEl.classList.add('on');
    clearTimeout(this.numT);
    this.numT = setTimeout(function () {
      var n = +self.numBuf;
      self.numBuf = '';
      self.numEl.classList.remove('on');
      var hit = self.list.find(function (x) { return x.num === n; });
      if (hit) return self.tune(hit);
      var go = function (all) {
        var h2 = all.find(function (x) { return x.num === n; });
        if (h2) self.tune(h2, all); else NS.toast('Kanal ' + n + ' finns inte', 'info');
      };
      if (NS.allLive) return go(NS.allLive);
      NS.api.list('live', 'all', 0, 3000).then(function (r) { NS.allLive = r.items || []; go(NS.allLive); }).catch(function () {});
    }, 1500);
  };

  Player.prototype.openChannels = function () {
    var self = this;
    this.panel = 'channels';
    this.hideOsd();
    this.side.innerHTML = '';
    this.chHead = h('div', { class: 'ph' });
    this.side.appendChild(this.chHead);
    this.chList = h('div', { class: 'chlist' });
    this.side.appendChild(this.chList);
    this.side.classList.add('on');
    this.chItems = this.list;
    var id = this.item.id;
    this.chI = Math.max(0, this.chItems.findIndex(function (x) { return x.id === id; }));
    var ready = function () {
      self.catI = Math.max(0, self.cats.findIndex(function (c) { return c.id === self.cat; }));
      if (self.cats.length && self.catI < 0) self.catI = 0;
      self.paintHead();
      self.paintChannels();
    };
    if (NS.liveCats) { this.cats = NS.liveCats; ready(); }
    else {
      this.cats = [];
      this.paintHead();
      this.paintChannels();
      NS.api.cats('live').then(function (c) { NS.liveCats = c; self.cats = c; ready(); }).catch(function () {});
    }
  };
  Player.prototype.paintHead = function () {
    var c = this.cats && this.cats.find(function (x) { return x.id === this.cat; }, this);
    this.chHead.innerHTML = '';
    var many = this.cats && this.cats.length > 1;
    this.chHead.appendChild(h('span', { text: c ? c.name : 'Kanaler' }));
    if (many) this.chHead.appendChild(h('span', { class: 'arr on' }, [NS.icon('left'), NS.icon('right')]));
  };
  Player.prototype.switchCat = function (dir) {
    var self = this;
    if (!this.cats || this.cats.length < 2) return;
    this.catI = (this.catI + dir + this.cats.length) % this.cats.length;
    var cat = this.cats[this.catI];
    this.cat = cat.id;
    this.paintHead();
    this.chItems = [];
    this.chI = 0;
    this.paintChannels();
    var tok = this._catTok = {};
    NS.api.list('live', cat.id, 0, 3000).then(function (r) {
      if (tok !== self._catTok) return;
      self.chItems = r.items || [];
      self.chI = 0;
      self.paintChannels();
    }).catch(function () {});
  };
  Player.prototype.paintChannels = function () {
    var self = this;
    var L = this.chList;
    if (!L) return;
    L.innerHTML = '';
    var VIS = 8;
    var items = this.chItems || [];
    var first = Math.max(0, Math.min(this.chI - 3, items.length - VIS));
    var ids = [];
    for (var i = first; i < Math.min(items.length, first + VIS); i++) {
      var it = items[i];
      ids.push(it.id);
      var e = NS.epgFor(it.id);
      var lg = h('div', { class: 'cl' });
      if (it.img) lg.appendChild(NS.img(it.img));
      var t = h('div', { class: 'ct' }, [h('div', { class: 'cname', text: it.n }), h('div', { class: 'cs', text: e && e.now ? NS.fmtClock(e.now.s) + '  ' + e.now.t : '' })]);
      if (e && e.now) {
        var pct = Math.min(100, Math.max(0, (Date.now() - e.now.s) / (e.now.e - e.now.s) * 100));
        t.appendChild(NS.progEl(pct));
      }
      var row = h('div', { class: 'ci' + (i === this.chI ? ' focus' : '') + (it.id === this.item.id ? ' cur' : ''), style: 'top:' + ((i - first) * 11) + 'rem' },
        [h('div', { class: 'cn', text: it.num ? String(it.num) : '' }), lg, t]);
      (function (idx) { row.addEventListener('click', function () { self.chI = idx; self.pickChannel(); }); })(i);
      L.appendChild(row);
    }
    if (!items.length) L.appendChild(h('div', { class: 'ci', style: 'top:0;color:var(--frost)' }, [h('div', { class: 'spinner' }), 'Hämtar kanaler…']));
    if (ids.length) NS.needEpg(ids);
  };
  Player.prototype.pickChannel = function () {
    var it = this.chItems[this.chI];
    if (!it) return;
    this.closePanel();
    if (it.id !== this.item.id) this.tune(it, this.chItems);
  };

  Player.prototype.closePanel = function () {
    this.panel = null;
    this.side.classList.remove('on');
    this.sideR.classList.remove('on');
    this.chList = null;
    if (!this.live) this.renderButtons();
  };

  /* ------------------------------------------------------------ errors */
  Player.prototype.showError = function (why) {
    var self = this;
    this.errShown = true;
    this.errI = 0;
    this.errEl.innerHTML = '';
    var b1 = h('div', { class: 'btn focus', onclick: function () { self.retry(); } }, [NS.icon('refresh'), 'Försök igen']);
    var b2 = h('div', { class: 'btn', onclick: function () { self.exit(); } }, [NS.icon('back'), 'Tillbaka']);
    this.errBtns = [b1, b2];
    this.errEl.appendChild(h('div', { class: 'box' }, [
      h('h2', { text: this.live ? 'Kanalen går inte att spela just nu' : 'Det går inte att spela upp' }),
      h('p', { text: (why || 'Okänt fel') + '. Leverantören kan ha tillfälliga problem, eller så används alla tillåtna anslutningar på kontot.' }),
      this.media ? h('p', { style: 'opacity:.6;font-size:.8em', text: 'Fil: ' + [this.media.v, this.media.h ? this.media.h + 'p' : '', this.media.a ? 'ljud ' + this.media.a + (this.media.ch ? ' ' + this.media.ch + 'ch' : '') : ''].filter(Boolean).join(', ') + ' · skärmen klarar: ' + (NS.caps || 'grundformat') + (this.safeMode ? ' · full konvertering provad' : '') }) : null,
      h('div', { class: 'btns' }, this.errBtns)
    ]));
    this.errEl.classList.add('on');
  };
  Player.prototype.hideError = function () { this.errShown = false; this.errEl.classList.remove('on'); };
  Player.prototype.retry = function () {
    this.hideError();
    if (this.item.t === 'catchup') { this.play(this.item, this.cur()); return; }
    this.si = 0;
    if (!this.sources) return this.play(this.item, this.start);
    this.startSource(this.live ? 0 : this.cur() || this.start);
  };

  /* ------------------------------------------------------------ keys */
  Player.prototype.onKey = function (a, e) {
    var v = this.video;
    this.autoCount = 0;
    if (this.skipOn && a === 'ok' && !this.panel && !this.nextOn && (!this.osdOn || (this.zone === 'bar' && (this.scrubbing === null || this.scrubbing === undefined)))) { this.skipIntro(); return; }
    if (this.nextOn && (a === 'left' || a === 'right')) {
      this.nextI = a === 'right' ? 1 : 0;
      this.nextBtns.forEach(function (b, i) { b.classList.toggle('focus', i === this.nextI); }, this);
      return;
    }
    if (this.nextOn && a === 'ok') { if (this.nextI === 1) { this.nextDismissed = true; this.hideNext(); } else this.playNext(true); return; }
    if (this.errShown) {
      if (a === 'left' || a === 'right') { this.errI = 1 - this.errI; this.errBtns.forEach(function (b, i) { b.classList.toggle('focus', i === this.errI); }, this); }
      else if (a === 'ok') { if (this.errI === 0) this.retry(); else this.exit(); }
      else if (a === 'back') this.exit();
      else if (this.live && (a === 'up' || a === 'chup')) { this.hideError(); this.zap(1); }
      else if (this.live && (a === 'down' || a === 'chdn')) { this.hideError(); this.zap(-1); }
      return;
    }
    if (a === 'stop') { this.exit(); return; }
    if (this.panel === 'channels') {
      if (a === 'up') { if (this.chI > 0) this.chI--; else this.chI = Math.max(0, this.chItems.length - 1); this.paintChannels(); }
      else if (a === 'down') { if (this.chI < this.chItems.length - 1) this.chI++; else this.chI = 0; this.paintChannels(); }
      else if (a === 'chup') { this.chI = Math.max(0, this.chI - 8); this.paintChannels(); }
      else if (a === 'chdn') { this.chI = Math.min(this.chItems.length - 1, this.chI + 8); this.paintChannels(); }
      else if (a === 'left') this.switchCat(-1);
      else if (a === 'right') this.switchCat(1);
      else if (a === 'ok') this.pickChannel();
      else if (a === 'back') this.closePanel();
      return;
    }
    if (this.panel === 'tracks') {
      if (a === 'up' && this.ti > 0) { this.ti--; this.paintTracks(); }
      else if (a === 'down' && this.ti < this.trItems.length - 1) { this.ti++; this.paintTracks(); }
      else if (a === 'ok') this.pickTrack();
      else if (a === 'back' || a === 'left') this.closePanel();
      return;
    }
    if (a === 'playpause' || a === 'play' || a === 'pause') {
      if (this.live) { this.livePlayPause(a === 'play' ? true : a === 'pause' ? false : null); return; }
      if (a === 'play' || (a === 'playpause' && v.paused)) this.playPromise(); else v.pause();
      this.showOsd(v.paused);
      return;
    }

    if (this.live && this.tshift && (a === 'ff' || a === 'rw')) {
      // behind live: ▶▶ back to live, ◀◀ ten seconds back in what was recorded
      if (a === 'ff') this.goLive();
      else if (this.tshift.playing) { try { v.currentTime = Math.max(0, v.currentTime - 10); } catch (e) { /* ignore */ } this.paintTshift(); }
      return;
    }
    if (this.live) {
      if (this.tshift && this.tshift.mode === 'rec' && (a === 'left' || a === 'right')) { this.seekRec(this.recPos() + (a === 'left' ? -10 : 10)); this.showOsd(); return; }
      if (a === 'up' || a === 'chup') this.zap(1);
      else if (a === 'down' || a === 'chdn') this.zap(-1);
      else if (a === 'ok' || a === 'left') this.openChannels();
      else if (a === 'right') this.openTracks();
      else if (a === 'yellow' || a === 'num0' && !this.numBuf) { this.lastChannel(); }
      else if (a === 'back') this.exit();
      else if (a.indexOf('num') === 0) this.numKey(a.slice(3));
      else if (a === 'info' || a === 'blue') { NS.router.push(new NS.Guide({ cat: this.cat, player: this })); }
      else if (a === 'green') { var it0 = this.item; NS.toggleList(it0).then(function () { NS.state.dirty = true; }); }
      else if (a === 'red') this.restartProgramme();
      return;
    }

    // VOD
    if (this.nextOn) {
      if (a === 'ok') { this.playNext(true); return; }
      if (a === 'back') { this.nextDismissed = true; this.hideNext(); return; }
    }
    if (a === 'back') {
      if (this.scrubbing !== null && this.scrubbing !== undefined) { this.scrubbing = null; this.bar.classList.remove('scrub'); this.tick(); return; }
      this.exit();
      return;
    }
    var wasHidden = !this.osdOn;
    if (a === 'ff') { this.scrub(1, e && e.repeat); return; }
    if (a === 'rw') { this.scrub(-1, e && e.repeat); return; }
    if (this.zone === 'bar') {
      if (a === 'left') this.scrub(-1, e && e.repeat);
      else if (a === 'right') this.scrub(1, e && e.repeat);
      else if (a === 'ok') {
        if (this.scrubbing !== null && this.scrubbing !== undefined) this.commitScrub();
        else if (wasHidden) this.showOsd();
        else { if (v.paused) this.playPromise(); else v.pause(); this.showOsd(v.paused); }
      } else if (a === 'down') {
        if (wasHidden) { this.showOsd(); return; }
        this.zone = 'btns'; this.paintZone(); this.showOsd(true);
      } else if (a === 'up') this.showOsd();
      return;
    }
    // buttons zone
    if (a === 'left' && this.bi > 0) this.bi--;
    else if (a === 'right' && this.bi < this.btns.length - 1) this.bi++;
    else if (a === 'up') { this.zone = 'bar'; this.showOsd(); }
    else if (a === 'ok') { this.pressBtn(); return; }
    this.paintZone();
    this.showOsd(true);
  };

  /* ------------------------------------------------------------ skip intro (learned per series) */
  // When someone jumps 30–150 s forward during the first 6 minutes of an episode, remember it as the intro
  // and offer "Hoppa över intro" at the same spot in the next episodes.
  Player.prototype.learnIntro = function (from, to) {
    var it = this.item, self = this;
    if (it.t !== 'episode' || !it.sid) return;
    var jump = to - from;
    // jumped back shortly after skipping: the intro guess was wrong
    if (this.skippedAt && Date.now() - this.skippedAt < 20000 && jump < -15) {
      this.skippedAt = 0;
      NS.api.post('api/intro/' + encodeURIComponent(it.sid), { bad: true }).then(function (r) { NS.introCache[it.sid] = r && r.to ? r : null; }).catch(function () {});
      return;
    }
    if (from > 420 || jump < 20 || jump > 180) return;
    NS.api.post('api/intro/' + encodeURIComponent(it.sid), { from: from, to: to }).then(function (r) { NS.introCache[it.sid] = r && r.to ? r : null; self.introTick(); }).catch(function () {});
  };
  Player.prototype.introTick = function () {
    var it = this.item, self = this;
    if (it.t !== 'episode' || !it.sid || !this.skipEl) return;
    if (!(it.sid in NS.introCache)) {
      NS.introCache[it.sid] = null;
      NS.api.get('api/intro/' + encodeURIComponent(it.sid)).then(function (r) { NS.introCache[it.sid] = r && r.to ? r : null; }).catch(function () {});
      return;
    }
    var iv = NS.introCache[it.sid];
    var c = this.cur();
    var on = !!iv && c >= iv.from && c < iv.to - 3 && !this.introDone;
    if (on !== this.skipOn) { this.skipOn = on; this.skipEl.classList.toggle('on', on); }
  };
  Player.prototype.skipIntro = function () {
    var iv = NS.introCache[this.item.sid];
    if (!iv) return;
    this.introDone = true;
    this.skippedAt = Date.now();
    this.skipOn = false;
    this.skipEl.classList.remove('on');
    this.seekTo(iv.to);
  };

  /* ------------------------------------------------------------ mouse (Mac/PC browser) */
  Player.prototype.mouseUi = function () {
    var self = this, el = this.el;
    el.classList.add('mouse');
    var hideT = null;
    el.addEventListener('mousemove', function () {
      el.classList.remove('nocursor');
      self.showOsd();
      clearTimeout(hideT);
      hideT = setTimeout(function () { if (!self.osdOn) el.classList.add('nocursor'); }, 5000);
    });
    var close = h('button', { class: 'mbtn mclose', 'aria-label': 'Stäng' }, NS.icon('back'));
    close.addEventListener('click', function (e) { e.stopPropagation(); self.exit(); });
    this.osd.appendChild(close);
    if (el.requestFullscreen) {
      var fsb = h('button', { class: 'mbtn mfs', 'aria-label': 'Helskärm' }, NS.icon('fs'));
      fsb.addEventListener('click', function (e) { e.stopPropagation(); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen(); });
      this.osd.appendChild(fsb);
    }
    if (this.live) {
      // live: a pause button (the space bar works too)
      var pp = h('button', { class: 'mbtn mpp', 'aria-label': 'Pausa' }, NS.icon('pause'));
      pp.addEventListener('click', function (e) { e.stopPropagation(); self.livePlayPause(); });
      var syncPP = function () { pp.innerHTML = ''; var p0 = self.tshift ? !self.tshift.playing || self.video.paused : self.video.paused; pp.appendChild(NS.icon(p0 ? 'play' : 'pause')); };
      this.video.addEventListener('play', syncPP);
      this.video.addEventListener('pause', syncPP);
      this.osd.appendChild(pp);
    }
    // click the picture: play/pause (live: channel list); double click: full screen
    el.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button, .btn, .bar, .panel-side, .nextup, .perror, .ci, .ti, .skip-intro')) return;
      if (self.live) { if (self.panel) self.closePanel(); else self.openChannels(); return; }
      if (self.video.paused) self.playPromise(); else self.video.pause();
      self.showOsd(self.video.paused);
    });
    el.addEventListener('dblclick', function () { if (!el.requestFullscreen) return; if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen(); });
    // seek bar: click or drag
    if (this.bar) {
      var at = function (e) { var r = self.bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * self.duration(); };
      var drag = false;
      var move = function (e) { if (!drag) return; self.scrubbing = at(e); self.tick(); };
      var up = function () { if (!drag) return; drag = false; self.commitScrub(); };
      this.bar.style.cursor = 'pointer';
      this.bar.addEventListener('mousedown', function (e) { if (!self.duration()) return; drag = true; self.scrubbing = at(e); self.bar.classList.add('scrub'); self.showOsd(true); self.tick(); e.preventDefault(); });
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this._winOff = function () { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }
  };

  /* ------------------------------------------------------------ touch controls (phones/tablets) */
  Player.prototype.touchUi = function () {
    var self = this;
    var el = this.el;
    el.classList.add('touch');
    var btn = function (cls, icon, fn, label) {
      var b = h('button', { class: 'tbtn ' + cls, 'aria-label': label || '' }, NS.icon(icon));
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); self.showOsd(self.video.paused); });
      return b;
    };
    this.osd.appendChild(btn('tclose', 'back', function () { self.exit(); }, 'Stäng'));
    // AirPlay: iPhone Safari has no element fullscreen, so this must not depend on the fullscreen button.
    // Always shown in Safari (the picker says itself when no Apple TV is found); dimmed while none is seen.
    if (window.WebKitPlaybackTargetAvailabilityEvent) {
      var air = btn('tair', 'airplay', function () { self.airplay(); }, 'AirPlay');
      this.osd.appendChild(air);
      this.video.addEventListener('webkitplaybacktargetavailabilitychanged', function (e) { air.classList.toggle('dim', e.availability !== 'available'); });
      this.video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', function () {
        var on = !!self.video.webkitCurrentPlaybackTargetIsWireless;
        air.classList.toggle('on', on);
        if (on) clearTimeout(self.airT); else if (self.airNative) self.airBack();
      });
    }
    if (!(el.requestFullscreen || el.webkitRequestFullscreen)) el.classList.add('nofs');
    else {
      this.osd.appendChild(btn('tfs', 'fs', function () {
        var d = document;
        if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        else {
          var r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
          if (r && r.then && screen.orientation && screen.orientation.lock) r.then(function () { screen.orientation.lock('landscape').catch(function () {}); });
        }
      }, 'Helskärm'));
    }
    this.tPlay = btn('tplay', 'pause', function () { if (self.live) self.livePlayPause(); else if (self.video.paused) self.playPromise(); else self.video.pause(); }, 'Spela/pausa');
    var mid = this.live
      ? [btn('tside', 'up', function () { self.zap(1); }, 'Nästa kanal'), this.tPlay, btn('tside', 'down', function () { self.zap(-1); }, 'Föregående kanal')]
      : [btn('tside', 'rw', function () { self.seekTo(self.cur() - 10); }, 'Bakåt 10 s'), this.tPlay, btn('tside', 'ff', function () { self.seekTo(self.cur() + 10); }, 'Framåt 10 s')];
    this.osd.appendChild(h('div', { class: 'tmid' }, mid));
    if (this.live) {
      this.osd.appendChild(h('div', { class: 'tlive' }, [
        this.liveBtn = h('button', { class: 'btn golive', style: 'display:none', onclick: function (e) { e.stopPropagation(); self.goLive(); } }, [NS.icon('live'), 'Gå till live']),
        h('button', { class: 'btn', onclick: function (e) { e.stopPropagation(); self.openChannels(); } }, [NS.icon('episodes'), 'Kanaler']),
        h('button', { class: 'btn', onclick: function (e) { e.stopPropagation(); self.openTracks(); } }, [NS.icon('sub'), 'Ljud']),
        this.item.arc ? h('button', { class: 'btn', onclick: function (e) { e.stopPropagation(); self.restartProgramme(); } }, [NS.icon('restart'), 'Starta om']) : null,
        h('button', { class: 'btn', onclick: function (e) { e.stopPropagation(); if (NS.mOpenLive) NS.mOpenLive(self.cat); else self.exit(); } }, [NS.icon('episodes'), 'Tv-guide'])
      ]));
    }
    var sync = function () { self.tPlay.innerHTML = ''; self.tPlay.appendChild(NS.icon(self.video.paused ? 'play' : 'pause')); };
    this.video.addEventListener('play', sync);
    this.video.addEventListener('pause', sync);
    // tap anywhere: show/hide controls
    el.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button, .btn, .bar, .panel-side, .nextup, .perror, .ci, .ti')) return;
      if (self.osdOn) self.hideOsd(); else self.showOsd();
    });
    // drag on the progress bar
    if (this.bar) {
      var at = function (e) {
        var r = self.bar.getBoundingClientRect();
        var x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
        return Math.max(0, Math.min(1, x / r.width)) * self.duration();
      };
      var drag = false;
      var down = function (e) { if (!self.duration()) return; drag = true; self.scrubbing = at(e); self.bar.classList.add('scrub'); self.showOsd(true); self.tick(); e.preventDefault(); };
      var move = function (e) { if (!drag) return; self.scrubbing = at(e); self.tick(); e.preventDefault(); };
      var up = function () { if (!drag) return; drag = false; self.commitScrub(); };
      this.bar.addEventListener('touchstart', down, { passive: false });
      this.bar.addEventListener('touchmove', move, { passive: false });
      this.bar.addEventListener('touchend', up);
      this.bar.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this._winOff = function () { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }
    // channel list: tap the arrows to switch category, tap outside to close
    this.side.addEventListener('click', function (e) {
      var arr = e.target.closest && e.target.closest('.arr');
      if (arr) { var r = arr.getBoundingClientRect(); self.switchCat(e.clientX < r.left + r.width / 2 ? -1 : 1); }
    });
    // phones: go full screen sideways right away (we are still inside the tap that started playback)
    var portrait = window.innerHeight > window.innerWidth;
    if (portrait && (el.requestFullscreen || el.webkitRequestFullscreen) && !/[?&]nofs/.test(location.search)) {
      try {
        var fr = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        if (fr && fr.then) fr.then(function () { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); }).catch(function () {});
      } catch (e) { /* not allowed: controls still work in portrait */ }
    }
    this.showOsd();
    var closer = function (e) { if (self.panel && !(e.target.closest && e.target.closest('.panel-side, .tlive, .obtns'))) { e.stopPropagation(); self.closePanel(); } };
    el.addEventListener('click', closer, true);
  };

  NS.Player = Player;
})();
