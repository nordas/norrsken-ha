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
      dl.items = r.items || []; dl.storage = r.storage || null; dl.on = r.on !== false; dl.wait = r.wait || ''; dl.loaded = true;
      emit(); schedule();
      return r;
    }).catch(function () { schedule(); });
  };

  /** Queue items ({type, id, ext, title, sub, img}). Resolves when the server has them. */
  /*
   * The quality to save in, asked each time (the last choice first): the original as the provider sends it (4K stays
   * 4K), or made smaller on the server – a film in 720p is about a fifth of the size, enough for an iPad on a flight.
   */
  var QL = { orig: 'Original', '1080': '1080p', '720': '720p', '480': '480p' };
  dl.qLabel = function (q) { return QL[q || 'orig'] || 'Original'; };
  dl.askQuality = function (n) {
    var last = NS.store.get('dlQ', 'orig');
    var opts = [
      { label: 'Original – bästa bilden (4K om filmen är i 4K)', value: 'orig' },
      { label: '1080p – Full HD, ca 3,5 GB/timme', value: '1080' },
      { label: '720p – HD, ca 1,8 GB/timme', value: '720' },
      { label: '480p – minst, ca 0,8 GB/timme', value: '480' }];
    opts.forEach(function (o) { o.on = o.value === last; o.sel = o.value === last; });
    return NS.menu('Ladda ner i vilken kvalitet?', opts, n > 1 ? n + ' avsnitt · mindre än original görs om av servern, det tar längre tid' : 'Mindre än original görs om av servern, det tar längre tid').then(function (q) {
      if (q) NS.store.set('dlQ', q);
      return q;
    });
  };
  dl.add = function (list, q) {
    if (q === undefined) return dl.askQuality(list.length).then(function (qq) { return qq ? dl.add(list, qq) : null; });
    return NS.api.post('api/downloads' + NS.pq(), { items: list, q: q }).then(function (r) {
      NS.toast(list.length > 1 ? list.length + ' nedladdningar köade' : 'Laddar ner', 'save');
      return dl.refresh().then(function () { return r; });
    }).catch(function (e) { NS.toast(e.message || 'Kunde inte ladda ner', 'info'); });
  };
  dl.remove = function (it) {
    return NS.api.post('api/downloads/' + encodeURIComponent(it.id) + '/delete' + NS.pq(), {}).then(function () { return dl.refresh(); });
  };
  dl.retry = function (it) {
    return NS.api.post('api/downloads/' + encodeURIComponent(it.id) + '/retry' + NS.pq(), {}).then(function () { return dl.refresh(); });
  };

  /** The movie or episode as a download request. */
  dl.req = function (it, extra) {
    var e = extra || {};
    var ep = it.t === 'episode';
    return { type: ep ? 'episode' : 'movie', id: e.id || it.id, ext: e.ext || it.ext || '', series: it.sid || '', title: ep ? (it.sn ? it.sn + ' – ' : '') + (it.se ? 'S' + it.se : '') + (it.ep ? 'E' + it.ep + ' ' : ' ') + it.n : it.n, sub: ep ? '' : [it.y, it.dur ? NS.fmtDur(it.dur) : ''].filter(Boolean).join(' · '), img: it.img || '' };
  };

  dl.fmtBytes = function (n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB'; };
  dl.label = function (x) {
    if (x.status === 'done') return 'Nedladdad · ' + dl.qLabel(x.q) + ' · ' + dl.fmtBytes(x.bytes);
    if (x.status === 'downloading') return (x.q && x.q !== 'orig' ? 'Gör om till ' + dl.qLabel(x.q) + ' ' : 'Laddar ner ') + Math.round(x.pct) + '%' + (x.bytes ? ' · ' + dl.fmtBytes(x.bytes) : '');
    if (x.status === 'queued') return dl.wait === 'match' ? 'Väntar – matchen spelas in just nu' : 'Väntar – startar när ingen tittar';
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
