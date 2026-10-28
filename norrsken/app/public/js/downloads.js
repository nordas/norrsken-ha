/* Norrsken downloads (client): what the server has saved or is saving to its storage disk, and the buttons for it. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;
  var dl = NS.dl = { items: [], on: true, storage: null, loaded: false };
  var subs = [];
  var timer = 0;

  dl.key = function (type, id) { return type + '-' + String(id).replace(/[^\w.-]/g, '_').slice(0, 80); };
  dl.get = function (type, id) {
    var k = dl.key(type, id);
    for (var i = 0; i < dl.items.length; i++) if (dl.items[i].id === k) return dl.items[i];
    return null;
  };
  dl.busy = function () { return dl.items.some(function (x) { return x.status === 'downloading' || x.status === 'queued'; }); };
  dl.onChange = function (fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; };
  function emit() { subs.slice().forEach(function (f) { try { f(); } catch (e) { /* a screen that is gone */ } }); }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    if (!subs.length && !dl.busy()) return;
    timer = setTimeout(function () { dl.refresh(); }, dl.busy() ? 3000 : 15000);
  }
  dl.refresh = function () {
    return NS.api.get('api/downloads').then(function (r) {
      dl.items = r.items || []; dl.storage = r.storage || null; dl.on = r.on !== false; dl.loaded = true;
      emit(); schedule();
      return r;
    }).catch(function () { schedule(); });
  };

  /** Queue items ({type, id, ext, title, sub, img}). Resolves when the server has them. */
  dl.add = function (list) {
    return NS.api.post('api/downloads' + NS.pq(), { items: list }).then(function (r) {
      NS.toast(list.length > 1 ? list.length + ' nedladdningar köade' : 'Laddar ner', 'save');
      return dl.refresh().then(function () { return r; });
    }).catch(function (e) { NS.toast(e.message || 'Kunde inte ladda ner', 'info'); });
  };
  dl.remove = function (it) {
    return NS.api.post('api/downloads/' + encodeURIComponent(it.id) + '/delete', {}).then(function () { return dl.refresh(); });
  };
  dl.retry = function (it) {
    return NS.api.post('api/downloads/' + encodeURIComponent(it.id) + '/retry', {}).then(function () { return dl.refresh(); });
  };

  /** The movie or episode as a download request. */
  dl.req = function (it, extra) {
    var e = extra || {};
    var ep = it.t === 'episode';
    return { type: ep ? 'episode' : 'movie', id: e.id || it.id, ext: e.ext || it.ext || '', series: it.sid || '', title: ep ? (it.sn ? it.sn + ' – ' : '') + (it.se ? 'S' + it.se : '') + (it.ep ? 'E' + it.ep + ' ' : ' ') + it.n : it.n, sub: ep ? '' : [it.y, it.dur ? NS.fmtDur(it.dur) : ''].filter(Boolean).join(' · '), img: it.img || '' };
  };

  dl.fmtBytes = function (n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB'; };
  dl.label = function (x) {
    if (x.status === 'done') return 'Nedladdad · ' + dl.fmtBytes(x.bytes);
    if (x.status === 'downloading') return 'Laddar ner ' + Math.round(x.pct) + '%' + (x.bytes ? ' · ' + dl.fmtBytes(x.bytes) : '');
    if (x.status === 'queued') return 'Väntar – startar när ingen tittar';
    return x.err || 'Misslyckades';
  };

  /** A small round state icon for a download: arrow (not saved), ring with % (saving), check (saved), x (failed). */
  dl.badge = function (x) {
    if (!x) return NS.icon('download');
    if (x.status === 'done') return NS.icon('check');
    if (x.status === 'error') return NS.icon('x');
    var pct = x.status === 'downloading' ? Math.max(3, x.pct) : 0;
    var ring = h('span', { class: 'dl-ring' + (x.status === 'queued' ? ' wait' : ''), style: '--p:' + pct });
    ring.appendChild(h('i'));
    return ring;
  };

  /** Tap: save it, or (already queued/saved) open the list. */
  dl.tap = function (it, extra) {
    if (!dl.on) { NS.toast('Nedladdning kräver ffmpeg på servern', 'info'); return Promise.resolve(); }
    var r = dl.req(it, extra);
    var x = dl.get(r.type, r.id);
    if (x && x.status !== 'error') { if (NS.openDownloads) NS.openDownloads(); return Promise.resolve(); }
    return dl.add([r]);
  };

  dl.refresh();
})();
