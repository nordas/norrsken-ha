/* Norrsken previews: after a short dwell the billboard, the focused card or the detail page starts playing, like the big streaming apps. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;

  var VOD_SECONDS = 45; // how long a film/series preview runs before the artwork comes back

  function mode() { return (NS.status && NS.status.previews) || 'sound'; }

  /** Attach a source to a <video>; returns a teardown function. */
  function attach(v, src, at) {
    var hls = null, mp = null;
    if (src.kind === 'hls' && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true, maxBufferLength: 12, backBufferLength: 0, capLevelToPlayerSize: true, startPosition: at > 0 ? at : -1, startLevel: -1 });
      hls.loadSource(src.url);
      hls.attachMedia(v);
    } else if (src.kind === 'ts' && window.mpegts && window.mpegts.isSupported()) {
      mp = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src.url }, { enableWorker: true, liveBufferLatencyChasing: true, autoCleanupSourceBuffer: true });
      mp.attachMediaElement(v);
      mp.load();
    } else if (src.kind === 'remux') {
      v.src = src.url + '&ss=' + Math.floor(at || 0) + '&a=0';
    } else {
      v.src = src.url;
      if (at > 0) v.addEventListener('loadedmetadata', function once() { v.removeEventListener('loadedmetadata', once); try { v.currentTime = at; } catch (e) { /* ignore */ } });
    }
    return function () {
      if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } }
      if (mp) { try { mp.pause(); mp.unload(); mp.detachMediaElement(); mp.destroy(); } catch (e) { /* ignore */ } }
      try { v.pause(); } catch (e) { /* ignore */ }
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* ignore */ }
    };
  }

  /** What to actually play for an item: a series plays its next/first episode. */
  function resolve(it) {
    if (it.t === 'live' || it.t === 'movie' || it.t === 'episode') {
      var info = it.t === 'movie' ? NS.infoFor(it).catch(function () { return it; }) : Promise.resolve(it);
      return info.then(function (d) { return { type: it.t, id: it.id, ext: d.ext || it.ext, dur: d.dur || it.dur || 0, pos: it.pos || 0 }; });
    }
    if (it.t === 'series') {
      return NS.infoFor(it).then(function (s) {
        if (!s.seasons || !s.seasons.length || !s.seasons[0].eps.length) return null;
        var e = s.seasons[0].eps[0];
        return { type: 'episode', id: e.id, ext: e.ext, dur: e.dur || 0, pos: 0 };
      });
    }
    return Promise.resolve(null);
  }

  /** Where in the film to start: a bit in, past intros and logos. */
  function startAt(t, dur, pos) {
    if (t.type === 'live') return 0;
    if (pos > 30) return pos; // continue watching: preview from where you left off
    if (!dur) return 0;
    if (dur < 240) return Math.min(dur * 0.1, 10);
    return Math.max(60, Math.min(dur * 0.15, 900));
  }

  var cur = null;
  NS.preview = {
    lastStop: 0,

    /**
     * Start a preview of `it` inside `host` after `delay` ms.
     * opts: { delay, before (element to insert in front of), onStart(), onEnd() }
     */
    start: function (it, host, opts) {
      this.stop();
      if (!it || !host || mode() === 'off') return;
      opts = opts || {};
      var self = this;
      var job = cur = { it: it, host: host, opts: opts, stopped: false };
      job.timer = setTimeout(function () {
        if (job.stopped) return;
        resolve(it).then(function (t) {
          if (job.stopped || !t) return null;
          job.target = t;
          return NS.api.stream(t.type, t.id, t.ext);
        }).then(function (res) {
          if (job.stopped || !res || !res.sources || !res.sources.length) return;
          self._play(job, res);
        }).catch(function () { /* no preview */ });
      }, opts.delay === undefined ? 2000 : opts.delay);
    },

    _play: function (job, res) {
      var t = job.target;
      var v = h('video', { class: 'pv', playsinline: true, preload: 'auto' });
      v.muted = mode() !== 'sound';
      v.autoplay = true;
      if (job.opts.before && job.opts.before.parentNode === job.host) job.host.insertBefore(v, job.opts.before);
      else job.host.appendChild(v);
      job.video = v;
      // the server already orders sources best-first; fall back in order
      var list = res.sources.slice();
      var i = 0;
      var at = startAt(t, t.dur, t.pos);
      var self = this;
      var next = function () {
        if (job.stopped) return;
        if (job.teardown) job.teardown();
        if (i >= list.length) { self.stop(); return; }
        var src = list[i++];
        job.teardown = attach(v, src, at);
        var p = v.play();
        if (p && p.catch) p.catch(function () { v.muted = true; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () { /* give up quietly */ }); });
      };
      v.addEventListener('error', next);
      v.addEventListener('playing', function () {
        if (job.stopped || job.on) return;
        job.on = true;
        v.classList.add('on');
        job.host.classList.add('pvon');
        if (job.opts.onStart) job.opts.onStart();
        if (t.type !== 'live') job.end = setTimeout(function () { if (cur === job) self.stop(); }, VOD_SECONDS * 1000);
      });
      v.addEventListener('ended', function () { if (cur === job) self.stop(); });
      // nothing within 8 s: give up so the TV is not left fetching in the background
      job.guard = setTimeout(function () { if (!job.on && cur === job) self.stop(); }, 8000);
      next();
    },

    stop: function () {
      var job = cur;
      cur = null;
      if (!job) return;
      job.stopped = true;
      clearTimeout(job.timer); clearTimeout(job.end); clearTimeout(job.guard);
      if (job.video) {
        var v = job.video;
        var td = job.teardown;
        v.classList.remove('on');
        job.host.classList.remove('pvon');
        this.lastStop = Date.now();
        // let the artwork fade back in, then free the stream
        setTimeout(function () { if (td) td(); v.remove(); }, 450);
        if (td) { try { v.pause(); } catch (e) { /* ignore */ } }
        if (job.opts.onEnd) job.opts.onEnd();
      }
    },

    active: function () { return !!(cur && cur.on); },

    /** Some providers allow only one stream: give the old preview connection a moment to close. */
    settle: function () {
      var wait = 1200 - (Date.now() - this.lastStop);
      return new Promise(function (ok) { setTimeout(ok, wait > 0 ? wait : 0); });
    }
  };
})();
