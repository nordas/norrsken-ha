/* Norrsken core: helpers, api, keys, router. Plain ES2017 for older TV browsers. */
(function () {
  'use strict';
  var NS = window.NS = window.NS || {};

  /* ---------------------------------------------------------------- dom */
  NS.h = function (tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (kids) {
      if (!Array.isArray(kids)) kids = [kids];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      }
    }
    return el;
  };
  NS.esc = function (s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  NS.img = function (src, cls, onerr) {
    var im = document.createElement('img');
    if (cls) im.className = cls;
    im.decoding = 'async';
    im.alt = '';
    im.onerror = function () { im.remove(); if (onerr) onerr(); };
    if (src) im.src = src; else setTimeout(function () { im.onerror(); }, 0);
    return im;
  };

  /* ---------------------------------------------------------------- icons */
  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    home: '<path d="M3.5 10.5L12 3.5l8.5 7V20a.5.5 0 0 1-.5.5h-5.5v-6h-5v6H4a.5.5 0 0 1-.5-.5z"/>',
    live: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.5l4 3.5 4-3.5"/>',
    film: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><path d="M7.5 3.5v17M16.5 3.5v17M3 8h4.5M3 12h4.5M3 16h4.5M16.5 8H21M16.5 12H21M16.5 16H21"/>',
    series: '<rect x="3" y="7.5" width="18" height="13" rx="2"/><path d="M6 4.5h12M8.5 1.5h7"/>',
    list: '<path d="M6.5 3.5h11v17.5l-5.5-4-5.5 4z"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z"/>',
    pause: '<path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4"/>',
    star: '<path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.5-4.1 6-.7z"/>',
    sub: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 13h4M13 13h4M7 16h7"/>',
    next: '<path d="M5.5 5v14l10-7zM18.5 5v14"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    down: '<path d="M6 9.5l6 6 6-6"/>',
    left: '<path d="M14.5 6l-6 6 6 6"/>',
    right: '<path d="M9.5 6l6 6-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
    power: '<path d="M12 3v8M6.3 6.5a8 8 0 1 0 11.4 0"/>',
    del: '<path d="M9 5h11v14H9l-6-7z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/>',
    space: '<path d="M4 10v4h16v-4"/>',
    episodes: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    aurora: '<path d="M3 17c3-8 6-11 9-11s6 3 9 11" stroke-width="2.4"/><path d="M6 19c2-5 4-7 6-7s4 2 6 7" stroke-width="1.6"/>'
  };
  var FILLED = { play: 1, pause: 1, next: 1, star: 1 };
  NS.icon = function (name, extra) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'i' + (FILLED[name] ? ' fill' : '') + (extra ? ' ' + extra : ''));
    s.innerHTML = P[name] || '';
    return s;
  };

  /* ---------------------------------------------------------------- formatting */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  NS.fmtTime = function (sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  };
  NS.fmtClock = function (ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  NS.fmtDur = function (sec) {
    var m = Math.max(1, Math.round((sec || 0) / 60));
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
  };
  NS.left = function (pos, dur) {
    var m = Math.max(1, Math.round((dur - pos) / 60));
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min kvar' : m + ' min kvar';
  };
  NS.epCode = function (it) { return 'S' + (it.se || 1) + ':A' + (it.ep || 1); };
  NS.hue = function (str) {
    var h = 0, s = String(str || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  };
  NS.fallbackBg = function (str) {
    var h = NS.hue(str);
    return 'linear-gradient(150deg, hsl(' + h + ',42%,30%) 0%, hsl(' + ((h + 50) % 360) + ',48%,14%) 100%)';
  };
  NS.debounce = function (fn, ms) {
    var t;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  };
  NS.store = {
    get: function (k, d) { try { var v = localStorage.getItem('nsk.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('nsk.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------------------------------------------------------------- api */
  function req(method, path, body, timeout) {
    if (NS.mock) return NS.mock(method, path, body);
    return new Promise(function (resolve, reject) {
      var ctl = window.AbortController ? new AbortController() : null;
      var t = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('Servern svarar inte')); }, timeout || 20000);
      fetch(path, {
        method: method, cache: 'no-store', signal: ctl ? ctl.signal : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          clearTimeout(t);
          if (!r.ok) { var e = new Error(j.error || ('Fel ' + r.status)); e.status = r.status; reject(e); } else resolve(j);
        });
      }).catch(function (e) { clearTimeout(t); reject(e.name === 'AbortError' ? new Error('Servern svarar inte') : e); });
    });
  }
  function q(path) { return path + (path.indexOf('?') < 0 ? '?' : '&') + 'profile=' + encodeURIComponent(NS.profile ? NS.profile.id : ''); }
  NS.api = {
    get: function (p, t) { return req('GET', q(p), null, t); },
    post: function (p, b) { return req('POST', p, b); },
    status: function () { return req('GET', 'api/status'); },
    page: function (p) { return NS.api.get('api/page/' + p); },
    list: function (type, cat, offset, limit) { return NS.api.get('api/list?type=' + type + '&cat=' + encodeURIComponent(cat) + '&offset=' + (offset || 0) + '&limit=' + (limit || 40)); },
    info: function (type, id) { return NS.api.get('api/info/' + type + '/' + encodeURIComponent(id)); },
    item: function (type, id) { return NS.api.get('api/item/' + type + '/' + encodeURIComponent(id)); },
    search: function (s) { return NS.api.get('api/search?q=' + encodeURIComponent(s)); },
    cats: function (type) { return NS.api.get('api/cats/' + type); },
    stream: function (type, id, ext) { return NS.api.get('api/stream/' + type + '/' + encodeURIComponent(id) + (ext ? '?ext=' + ext : '')); },
    probe: function (t) { return req('GET', 'api/probe?t=' + t, null, 30000); },
    guide: function (id, h) { return NS.api.get('api/epg/channel/' + encodeURIComponent(id) + '?hours=' + (h || 6)); },
    state: function () { return req('GET', 'api/state/' + NS.profile.id); },
    myList: function (item, on) { return req('POST', 'api/state/' + NS.profile.id + '/mylist', { item: item, on: on }); },
    progress: function (item, pos, dur) { return req('POST', 'api/state/' + NS.profile.id + '/progress', { item: item, pos: pos, dur: dur }); },
    recent: function (item) { return req('POST', 'api/state/' + NS.profile.id + '/recent', { item: item }); }
  };

  /** The address other devices on the network use (not the Home Assistant ingress address). */
  NS.lanUrl = function () {
    var u = NS.status && NS.status.urls && NS.status.urls[0];
    if (u && !/\/\/(172\.(1[6-9]|2\d|3[01])|127\.)/.test(u)) return u.replace(/\/$/, '');
    return location.origin;
  };

  /* ---------------------------------------------------------------- direct playback */
  /** Kinds of direct (TV → provider) playback that failed this session; those go via the server instead. */
  NS.directBad = {};
  NS.usableSources = function (list) {
    var probe = document.createElement('video');
    var out = list.filter(function (s) {
      if (s.direct && NS.directBad[s.kind]) return false;
      if (s.needs && !probe.canPlayType(s.needs)) return false;
      return true;
    });
    return out.length ? out : list;
  };

  /* ---------------------------------------------------------------- profile state cache */
  NS.state = { myList: {}, progress: {}, dirty: false };
  NS.loadState = function () {
    return NS.api.state().then(function (s) {
      NS.state.myList = {};
      (s.myList || []).forEach(function (k) { NS.state.myList[k] = true; });
      NS.state.progress = s.progress || {};
    }).catch(function () { /* offline */ });
  };
  NS.inList = function (k) { return !!NS.state.myList[k]; };
  NS.toggleList = function (item) {
    var on = !NS.inList(item.k);
    if (on) NS.state.myList[item.k] = true; else delete NS.state.myList[item.k];
    NS.state.dirty = true;
    NS.toast(on ? 'Tillagd i Min lista' : 'Borttagen från Min lista', on ? 'check' : 'list');
    return NS.api.myList(item, on).then(function () { return on; });
  };

  /* ---------------------------------------------------------------- EPG cache */
  var epg = {};
  var epgWaiting = {};
  var epgQueue = [];
  var epgTimer = null;
  NS.epgFor = function (id) {
    var e = epg[id];
    if (!e) return null;
    var now = Date.now();
    if (e.data && e.data.now && e.data.now.e <= now && e.data.next && e.data.next.s <= now) {
      return { now: e.data.next, next: null };
    }
    return e.data;
  };
  /** Queue now/next lookups; listeners get a 'nsk-epg' event with the ids that arrived. */
  NS.needEpg = function (ids) {
    var now = Date.now();
    ids.forEach(function (id) {
      var e = epg[id];
      var stale = !e || now - e.at > 120000 || (e.data && e.data.now && e.data.now.e < now);
      if (stale && !epgWaiting[id]) { epgWaiting[id] = true; epgQueue.push(id); }
    });
    if (!epgTimer && epgQueue.length) epgTimer = setTimeout(flushEpg, 60);
  };
  function flushEpg() {
    epgTimer = null;
    var ids = epgQueue.splice(0, 60);
    if (!ids.length) return;
    NS.api.get('api/epg/now?ids=' + ids.join(','), 15000).then(function (res) {
      var now = Date.now();
      ids.forEach(function (id) { epg[id] = { at: now, data: res[id] || null }; delete epgWaiting[id]; });
      var ev;
      try { ev = new CustomEvent('nsk-epg', { detail: ids }); } catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('nsk-epg', false, false, ids); }
      document.dispatchEvent(ev);
    }).catch(function () { ids.forEach(function (id) { delete epgWaiting[id]; }); });
    if (epgQueue.length) epgTimer = setTimeout(flushEpg, 60);
  }

  /* ---------------------------------------------------------------- keys */
  NS.keyAction = function (e) {
    var k = e.keyCode, key = e.key;
    switch (k) {
      case 37: return 'left';
      case 38: return 'up';
      case 39: return 'right';
      case 40: return 'down';
      case 13: return 'ok';
      case 8: case 461: case 10009: case 27: return 'back';
      case 415: return 'play';
      case 19: return 'pause';
      case 179: case 32: return 'playpause';
      case 413: return 'stop';
      case 417: return 'ff';
      case 412: return 'rw';
      case 33: case 427: return 'chup';
      case 34: case 428: return 'chdn';
      case 403: return 'red';
      case 404: return 'green';
      case 405: return 'yellow';
      case 406: return 'blue';
      case 457: return 'info';
    }
    if (k >= 48 && k <= 57) return 'num' + (k - 48);
    if (k >= 96 && k <= 105) return 'num' + (k - 96);
    switch (key) {
      case 'MediaPlayPause': return 'playpause';
      case 'MediaPlay': return 'play';
      case 'MediaPause': return 'pause';
      case 'MediaStop': return 'stop';
      case 'MediaFastForward': case 'MediaTrackNext': return 'ff';
      case 'MediaRewind': case 'MediaTrackPrevious': return 'rw';
      case 'GoBack': case 'BrowserBack': return 'back';
    }
    if (key && key.length === 1 && /[a-zåäöéü]/i.test(key)) return 'char:' + key.toLowerCase();
    if (key && key.length === 1 && /[\-:&']/.test(key)) return 'char:' + key;
    return null;
  };

  var lastKey = 0;
  document.addEventListener('keydown', function (e) {
    var a = NS.keyAction(e);
    if (!a) return;
    var tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    var now = Date.now();
    if (e.repeat && now - lastKey < 70) return; // keep held arrows smooth on slow TVs
    lastKey = now;
    if (NS.dialog && NS.dialog.onKey(a, e)) return;
    var top = NS.router.top();
    if (top && top.onKey) top.onKey(a, e);
  }, true);

  /* ---------------------------------------------------------------- router */
  NS.router = {
    stack: [],
    root: null,
    top: function () { return this.stack[this.stack.length - 1]; },
    push: function (s) {
      var t = this.top();
      if (t) { if (t.deactivate) t.deactivate(); t.el.classList.add('hidden'); }
      this.stack.push(s);
      this.root.appendChild(s.el);
      if (s.activate) s.activate(true);
    },
    pop: function () {
      var s = this.stack.pop();
      if (s) { if (s.destroy) s.destroy(); s.el.remove(); }
      var t = this.top();
      if (t) { t.el.classList.remove('hidden'); if (t.activate) t.activate(false); }
    },
    replace: function (s) {
      var old = this.stack.pop();
      if (old) { if (old.destroy) old.destroy(); old.el.remove(); }
      this.push(s);
    },
    reset: function (s) {
      while (this.stack.length) { var x = this.stack.pop(); if (x.destroy) x.destroy(); x.el.remove(); }
      this.push(s);
    }
  };

  /* ---------------------------------------------------------------- toast & dialog */
  var toastEl, toastT;
  NS.toast = function (msg, icon) {
    if (!toastEl) { toastEl = NS.h('div', { class: 'toast' }); document.getElementById('app').appendChild(toastEl); }
    toastEl.innerHTML = '';
    if (icon) toastEl.appendChild(NS.icon(icon));
    toastEl.appendChild(document.createTextNode(msg));
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 2600);
  };

  /** Modal with buttons. opts: { title, text, buttons: [{label, icon, value}], focus, cancel } → Promise(value) */
  NS.confirm = function (opts) {
    return new Promise(function (resolve) {
      var idx = opts.focus || 0;
      var btns = opts.buttons.map(function (b, i) {
        return NS.h('div', { class: 'btn', onclick: function () { idx = i; close(b.value); } }, [b.icon ? NS.icon(b.icon) : null, b.label]);
      });
      var el = NS.h('div', { class: 'dialog' }, NS.h('div', { class: 'box' }, [
        NS.h('h2', { text: opts.title }), opts.text ? NS.h('p', { text: opts.text }) : null, NS.h('div', { class: 'btns' }, btns)
      ]));
      function paint() { btns.forEach(function (b, i) { b.classList.toggle('focus', i === idx); }); }
      function close(v) { el.remove(); NS.dialog = null; resolve(v); }
      NS.dialog = {
        onKey: function (a) {
          if (a === 'left' && idx > 0) idx--;
          else if (a === 'right' && idx < btns.length - 1) idx++;
          else if (a === 'ok') close(opts.buttons[idx].value);
          else if (a === 'back') close(opts.cancel);
          paint();
          return true;
        }
      };
      paint();
      document.getElementById('app').appendChild(el);
    });
  };

  NS.exitApp = function () {
    NS.confirm({ title: 'Vill du avsluta?', buttons: [{ label: 'Avsluta', icon: 'power', value: true }, { label: 'Stanna kvar', value: false }], focus: 1, cancel: false })
      .then(function (yes) {
        if (!yes) return;
        try { if (window.SmartTvA_API && window.SmartTvA_API.exit) { window.SmartTvA_API.exit(); return; } } catch (e) { /* not on TV */ }
        try { window.close(); } catch (e) { /* ignore */ }
        setTimeout(function () { NS.toast('Stäng fliken för att avsluta'); }, 300);
      });
  };

  /* clock */
  NS.clock = function (el) {
    function tick() { el.textContent = NS.fmtClock(Date.now()); }
    tick();
    return setInterval(tick, 15000);
  };
})();
