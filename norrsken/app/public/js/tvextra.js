/* Norrsken TV extras: category grid and the live TV guide. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;

  /* ================================================================ CATEGORY GRID */
  var SORTS = [{ k: 'sort:', label: 'Standard', value: '' }, { k: 'sort:new', label: 'Nyast', value: 'new' }, { k: 'sort:rating', label: 'Högst betyg', value: 'rating' }, { k: 'sort:az', label: 'A–Ö', value: 'az' }];
  var PER = 7;

  function Grid(type, cat, name) {
    var self = this;
    this.type = type; this.cat = cat; this.name = name; this.sort = NS.store.get('gridSort', '');
    this.el = h('div', { class: 'screen grid-screen' });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.el.appendChild(h('div', { class: 'grid-head' }, [h('h1', { text: name }), this.count = h('span', { class: 'grid-count' })]));
    this.info = h('div', { class: 'grid-info' });
    this.el.appendChild(this.info);
    this.rows = new NS.RowsView({
      className: 'page grid-page', expand: false, info: false, lead: 9,
      onFocus: function (it, row) {
        if (row.id === 'sort' || !it) return;
        self.ambient.follow(it);
        // details for the focused title live in one fixed place under the heading
        self.info.innerHTML = '';
        self.info.appendChild(h('b', { text: it.n }));
        self.info.appendChild(NS.metaEl(it, { kind: false }));
      },
      onSelect: function (it, row) {
        if (row.id === 'sort') { self.sort = it.value; NS.store.set('gridSort', it.value); self.load(); return; }
        NS.router.push(new NS.Detail(it));
      },
      onUp: function () {}
    });
    this.el.appendChild(this.rows.el);
    this.load();
  }
  Grid.prototype.load = function () {
    var self = this;
    var sel = this.sort;
    NS.api.get('api/list?type=' + this.type + '&cat=' + encodeURIComponent(this.cat) + '&offset=0&limit=3000&sort=' + sel).then(function (res) {
      var items = res.items || [];
      var sl = SORTS.filter(function (s) { return s.value === sel; })[0] || SORTS[0];
      self.count.textContent = items.length + (items.length === 1 ? ' titel' : ' titlar') + (sl.value ? '  ·  ' + sl.label : '');
      var rows = [{ id: 'sort', kind: 'pill', items: SORTS, selected: sel }];
      for (var i = 0; i < items.length; i += PER) rows.push({ id: 'g' + i, title: '', kind: 'poster', items: items.slice(i, i + PER), grid: true });
      var keep = self.rows.rows.length ? { rowId: 'sort', r: 0, col: SORTS.findIndex(function (s) { return s.value === sel; }) } : null;
      self.rows.setRows(rows, keep);
      if (!keep) { self.rows.r = rows.length > 1 ? 1 : 0; self.rows.layout(); }
      self.rows.emitFocus();
    });
  };
  Grid.prototype.onKey = function (a) {
    if (a === 'back') { NS.router.pop(); return; }
    var R = this.rows.currentRow();
    // keep the column when moving between grid rows
    if ((a === 'down' || a === 'up') && R && R.def.grid) {
      var next = this.rows.rows[this.rows.r + (a === 'down' ? 1 : -1)];
      if (next && next.def.grid) next.col = Math.min(R.col, next.items.length - 1);
    }
    this.rows.onKey(a);
  };
  Grid.prototype.activate = function (first) { if (!first) this.rows.refreshLive(); };
  Grid.prototype.destroy = function () { this.rows.destroy(); };
  NS.Grid = Grid;

  /* ================================================================ TV GUIDE */
  var HOUR = 46;          // rem per hour
  var WIN = 3;            // hours visible
  var ROWS = 7;           // channel rows visible
  var ROW_H = 10.4;       // rem
  var guideCache = {};    // id -> { at, list }

  function loadGuide(ch) {
    var id = ch.id;
    var c = guideCache[id];
    if (c && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.list);
    if (c && c.p) return c.p;
    var p = NS.api.guide(id, 36, ch.arc ? Math.min(72, ch.arc * 24) : 2).then(function (list) {
      guideCache[id] = { at: Date.now(), list: (list || []).filter(function (x) { return x.e > x.s; }) };
      return guideCache[id].list;
    }).catch(function () { guideCache[id] = { at: Date.now(), list: [] }; return []; });
    guideCache[id] = { at: 0, p: p, list: [] };
    return p;
  }

  /** Can this programme be played from the archive (catch-up)? */
  function canArc(ch, p) { return !!ch.arc && p.e <= Date.now() + 0 && p.s > Date.now() - ch.arc * 86400e3 && p.a !== 0; }
  NS.canArc = canArc;

  function Guide(opts) {
    var self = this;
    opts = opts || {};
    this.opts = opts;
    this.el = h('div', { class: 'screen guide' });
    this.cats = [];
    this.catI = 0;
    this.chans = [];
    this.r = 0;          // focused channel index
    this.top = 0;        // first visible channel
    this.zone = 'grid';
    this.t0 = Math.floor((Date.now() - 30 * 60e3) / (30 * 60e3)) * 30 * 60e3;
    this.focusT = Date.now();
    this.info = h('div', { class: 'gd-info' });
    this.pills = h('div', { class: 'gd-pills' });
    this.ruler = h('div', { class: 'gd-ruler' });
    this.body = h('div', { class: 'gd-body' });
    this.now = h('div', { class: 'gd-now' });
    this.el.appendChild(h('div', { class: 'gd-top' }, [h('h1', { text: 'Tv-guide' }), this.pills]));
    this.el.appendChild(this.info);
    // small live picture of the focused channel, top right
    this.pv = h('div', { class: 'gd-pv' });
    this.el.appendChild(this.pv);
    this.el.appendChild(h('div', { class: 'gd-grid' }, [this.ruler, this.body, this.now]));
    this.el.appendChild(h('div', { class: 'gd-hint' }, [
      h('span', {}, [h('kbd', { text: 'OK' }), 'Titta / påminn']), h('span', {}, [h('kbd', { text: '◀ ▶' }), 'Tid']),
      h('span', {}, [h('kbd', { text: 'P+ P−' }), 'Bläddra']), h('span', {}, [h('kbd', { text: '◀◀ ▶▶' }), '±1 dygn']), h('span', {}, [h('kbd', { style: 'color:#4c8dff', text: '●' }), 'Nu']), h('span', {}, [h('kbd', { class: 'g', text: '●' }), 'Favorit'])]));
    this.startCat = opts.cat || null;
    this._epg = function () { self.paint(); };
    this.clockT = setInterval(function () { self.paintNow(); }, 30000);
    NS.api.cats('live').then(function (cats) {
      var favs = Object.keys(NS.state.myList).filter(function (k) { return k.indexOf('l:') === 0; });
      self.cats = (favs.length ? [{ id: '__fav', name: '★ Favoriter' }] : []).concat(cats);
      self.catI = Math.max(0, self.cats.findIndex(function (c) { return c.id === self.startCat; }));
      self.loadCat();
    });
  }

  Guide.prototype.loadCat = function () {
    var self = this;
    var cat = this.cats[this.catI];
    this.paintPills();
    if (!cat) return;
    var tok = this._tok = {};
    var p = cat.id === '__fav'
      ? NS.api.page('live').then(function (res) { var r = (res.rows || []).find(function (x) { return x.id === 'fav'; }); return { items: r ? r.items : [] }; })
      : NS.api.list('live', cat.id, 0, 3000);
    p.then(function (res) {
      if (tok !== self._tok) return;
      self.chans = res.items || [];
      self.r = 0; self.top = 0;
      self.paint();
    });
  };

  Guide.prototype.paintPills = function () {
    var self = this;
    this.pills.innerHTML = '';
    var from = Math.max(0, this.catI - 2);
    this.cats.slice(from, from + 6).forEach(function (c, j) {
      var i = from + j;
      self.pills.appendChild(h('div', { class: 'nv' + (i === self.catI ? (self.zone === 'cats' ? ' focus' : ' active') : ''), text: c.name, onclick: function () { self.catI = i; self.loadCat(); } }));
    });
  };

  Guide.prototype.x = function (t) { return (t - this.t0) / 3600e3 * HOUR; };

  Guide.prototype.paintNow = function () {
    var x = this.x(Date.now());
    this.now.style.display = x >= 0 && x <= WIN * HOUR ? '' : 'none';
    this.now.style.left = 'calc(34rem + ' + x + 'rem)';
  };

  Guide.prototype.progAt = function (list, t) {
    for (var i = 0; i < list.length; i++) if (list[i].s <= t && list[i].e > t) return i;
    return -1;
  };

  Guide.prototype.paint = function () {
    var self = this;
    // ruler
    this.ruler.innerHTML = '';
    for (var k = 0; k < WIN * 2; k++) {
      var t = this.t0 + k * 30 * 60e3;
      var dl = NS.dayLabel(t);
      var midnight = new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0;
      this.ruler.appendChild(h('span', { class: (k === 0 || midnight) && dl !== 'i dag' ? 'day' : null, style: 'left:calc(34rem + ' + (k * HOUR / 2) + 'rem)', text: ((k === 0 || midnight) && dl !== 'i dag' ? dl + '  ' : '') + NS.fmtClock(t) }));
    }
    this.paintNow();
    // rows
    this.body.innerHTML = '';
    if (this.r < this.top) this.top = this.r;
    if (this.r >= this.top + ROWS) this.top = this.r - ROWS + 1;
    var end = this.t0 + WIN * 3600e3;
    var focusProg = null, focusChan = null;
    this.chans.slice(this.top, this.top + ROWS).forEach(function (ch, j) {
      var i = self.top + j;
      var row = h('div', { class: 'gd-row' + (i === self.r ? ' active' : ''), style: 'top:' + (j * ROW_H) + 'rem' });
      var lg = h('div', { class: 'gd-ch' }, [h('span', { class: 'n', text: ch.num ? String(ch.num) : '' }),
        h('div', { class: 'l' }, ch.img ? NS.pic(ch.img) : h('b', { text: ch.n })), h('span', { class: 'nm', text: ch.n }),
        NS.inList(ch.k) ? h('span', { class: 'fav', text: '★' }) : null]);
      row.appendChild(lg);
      var lane = h('div', { class: 'gd-lane' });
      row.appendChild(lane);
      var c = guideCache[ch.id];
      if (!c || (!c.list.length && !c.at)) {
        loadGuide(ch).then(function () { if (NS.router.top() === self) self.paint(); });
        lane.appendChild(h('div', { class: 'gd-p empty', style: 'left:0;width:' + (WIN * HOUR) + 'rem', text: 'Hämtar…' }));
      } else {
        var list = c.list;
        var shown = list.filter(function (p) { return p.e > self.t0 && p.s < end; });
        if (!shown.length) {
          var pe = h('div', { class: 'gd-p empty' + (i === self.r ? ' focus' : ''), style: 'left:0;width:' + (WIN * HOUR) + 'rem' }, [h('b', { text: ch.n }), h('span', { text: 'Ingen tv-guide' })]);
          lane.appendChild(pe);
          if (i === self.r) { focusProg = null; focusChan = ch; }
        }
        shown.forEach(function (p) {
          var x0 = Math.max(0, self.x(p.s)), x1 = Math.min(WIN * HOUR, self.x(p.e));
          var isF = i === self.r && p.s <= self.focusT && p.e > self.focusT;
          var live = p.s <= Date.now() && p.e > Date.now();
          var el = h('div', { class: 'gd-p' + (isF ? ' focus' : '') + (live ? ' live' : '') + (p.e <= Date.now() ? ' past' : ''), style: 'left:' + x0 + 'rem;width:' + Math.max(0.6, x1 - x0 - 0.4) + 'rem' },
            [h('b', {}, [canArc(ch, p) ? h('i', { class: 'gd-arc', title: 'Kan ses i efterhand' }, NS.icon('restart')) : null, p.s > Date.now() && NS.hasReminder(ch.id, p.s) ? h('i', { class: 'gd-arc gd-bell' }, NS.icon('bell')) : null, p.t]), x1 - x0 > 14 ? h('span', { text: NS.fmtClock(p.s) + '–' + NS.fmtClock(p.e) }) : null]);
          if (live) el.appendChild(h('i', { class: 'gd-prog', style: 'width:' + Math.min(100, NS.livePct(p)).toFixed(1) + '%' }));
          el.addEventListener('click', function () { self.r = i; self.focusT = Math.max(p.s, self.t0) + 1; self.paint(); self.ok(); });
          lane.appendChild(el);
          if (isF) { focusProg = p; focusChan = ch; }
        });
        if (i === self.r && !focusChan) focusChan = ch;
      }
      self.body.appendChild(row);
    });
    this.paintInfo(focusChan, focusProg);
    // fetch guides for the next page in the background
    this.chans.slice(this.top + ROWS, this.top + ROWS * 2).forEach(function (ch) { if (!guideCache[ch.id]) loadGuide(ch); });
  };

  Guide.prototype.paintInfo = function (ch, p) {
    var el = this.info;
    el.innerHTML = '';
    if (!ch) return;
    if (this.pvCh !== ch.id && NS.router.top() === this) {
      this.pvCh = ch.id;
      this.pv.style.background = 'radial-gradient(80% 90% at 50% 30%, ' + NS.rgba(NS.hueColor(ch.n), 0.6) + ', #111 80%)';
      this.pv.innerHTML = '';
      if (ch.img) this.pv.appendChild(NS.pic(ch.img, 'gd-pvlogo'));
      NS.preview.start(ch, this.pv, { delay: 1200 });
    }
    var meta = h('div', { class: 'meta' });
    if (p) {
      var live = p.s <= Date.now() && p.e > Date.now();
      if (live) meta.appendChild(h('span', {}, h('span', { class: 'live-dot', text: 'Nu' })));
      var dl = NS.dayLabel(p.s);
      meta.appendChild(h('span', { text: (dl !== 'i dag' ? dl.charAt(0).toUpperCase() + dl.slice(1) + '  ' : '') + NS.fmtClock(p.s) + '–' + NS.fmtClock(p.e) }));
    }
    meta.appendChild(h('span', { class: 'soft', text: (ch.num ? ch.num + '  ' : '') + ch.n }));
    if (p && p.e <= Date.now()) meta.appendChild(h('span', { class: 'tag' + (canArc(ch, p) ? '' : ' off') }, canArc(ch, p) ? [NS.icon('archive'), ' Arkiv · OK för att se'] : 'Finns inte i arkivet'));
    if (p && p.s > Date.now()) meta.appendChild(h('span', { class: 'tag' }, NS.hasReminder(ch.id, p.s) ? [NS.icon('bell'), ' Påminnelse satt'] : 'OK: påminn mig'));
    el.appendChild(h('h2', { text: p ? p.t : ch.n }));
    el.appendChild(meta);
    if (p && p.d) el.appendChild(h('p', { text: p.d }));
  };

  Guide.prototype.current = function () {
    var ch = this.chans[this.r];
    if (!ch) return {};
    var c = guideCache[ch.id];
    var list = c ? c.list : [];
    var i = this.progAt(list, this.focusT);
    return { ch: ch, list: list, i: i, p: i >= 0 ? list[i] : null };
  };

  Guide.prototype.move = function (dir) {
    var cur = this.current();
    if (!cur.ch) return;
    var t;
    if (cur.p) t = dir > 0 ? cur.p.e + 1 : cur.p.s - 1;
    else t = this.focusT + dir * 30 * 60e3;
    var backMs = cur.ch.arc ? Math.min(3, cur.ch.arc) * 86400e3 : 2 * 3600e3;
    if (dir < 0 && t < Date.now() - backMs) { NS.toast(cur.ch.arc ? 'Arkivet räcker inte längre bakåt' : 'Kanalen har inget arkiv', 'info'); return; }
    this.focusT = t;
    var end = this.t0 + WIN * 3600e3;
    var np = this.current().p;
    var ps = np ? np.s : t, pe = np ? np.e : t;
    while (dir > 0 && Math.min(pe, t + 60 * 60e3) > end) { this.t0 += 30 * 60e3; end += 30 * 60e3; }
    while (dir < 0 && Math.max(ps, t) < this.t0) { this.t0 -= 30 * 60e3; }
    this.paint();
  };

  Guide.prototype.jumpDay = function (dir) {
    var cur = this.current();
    var t = this.focusT + dir * 86400e3;
    var back = cur.ch && cur.ch.arc ? Math.min(3, cur.ch.arc) * 86400e3 : 2 * 3600e3;
    t = Math.max(Date.now() - back, Math.min(Date.now() + 34 * 3600e3, t));
    this.focusT = t;
    this.t0 = Math.floor((t - 30 * 60e3) / (30 * 60e3)) * 30 * 60e3;
    this.paint();
    NS.toast(NS.dayLabel(t).charAt(0).toUpperCase() + NS.dayLabel(t).slice(1) + ' ' + NS.fmtClock(t), 'episodes');
  };

  Guide.prototype.ok = function () {
    var self = this;
    var cur = this.current();
    if (!cur.ch) return;
    var now = Date.now();
    var pl = this.opts.player;
    // opened from the player: hand the choice back to it instead of stacking a second player
    var watch = function (item, list) {
      if (pl && NS.router.stack.indexOf(pl) >= 0) {
        pl.skipResume = true;
        NS.router.pop();
        if (item.t === 'catchup') NS.router.replace(new NS.Player({ item: item }));
        else { pl.suspended = false; pl.tune(item, list); }
        return;
      }
      if (item.t === 'catchup') NS.playItem(item); else NS.playItem(item, { list: list });
    };
    if (!cur.p || (cur.p.s <= now && cur.p.e > now)) { watch(cur.ch, this.chans); return; }
    if (cur.p.e <= now) {
      if (canArc(cur.ch, cur.p)) { watch(NS.catchupItem(cur.ch, cur.p, this.chans)); return; }
      NS.toast(cur.ch.arc ? 'Programmet finns inte i arkivet' : 'Kanalen har inget arkiv', 'info');
      return;
    }
    var on = NS.hasReminder(cur.ch.id, cur.p.s);
    NS.menu(cur.p.t, [
      { label: on ? 'Ta bort påminnelsen' : 'Påminn mig ' + NS.dayLabel(cur.p.s) + ' ' + NS.fmtClock(cur.p.s), icon: 'bell', value: 'rem' },
      { label: 'Titta på ' + cur.ch.n + ' nu', icon: 'play', value: 'watch' },
      { label: 'Titta från start ' + NS.fmtClock(cur.p.s) + ' (nedräkning)', icon: 'play', value: 'count' }
    ], cur.ch.n + '  ·  ' + NS.fmtClock(cur.p.s) + '–' + NS.fmtClock(cur.p.e)).then(function (v) {
      if (v === 'rem') { NS.toggleReminder(cur.ch, cur.p); self.paint(); }
      else if (v === 'watch') watch(cur.ch, self.chans);
      else if (v === 'count') NS.router.push(new NS.Countdown({ item: cur.ch, list: self.chans, at: cur.p.s, title: cur.p.t, sub: cur.ch.n }));
    });
  };

  Guide.prototype.onKey = function (a) {
    if (a === 'back') { if (this.zone === 'cats') { this.zone = 'grid'; this.paintPills(); this.paint(); return; } NS.router.pop(); return; }
    if (this.zone === 'cats') {
      if (a === 'left' && this.catI > 0) { this.catI--; this.loadCat(); }
      else if (a === 'right' && this.catI < this.cats.length - 1) { this.catI++; this.loadCat(); }
      else if (a === 'down' || a === 'ok') { this.zone = 'grid'; this.paintPills(); this.paint(); }
      return;
    }
    if (a === 'up') { if (this.r > 0) { this.r--; this.paint(); } else { this.zone = 'cats'; this.paintPills(); } return; }
    if (a === 'down') { if (this.r < this.chans.length - 1) { this.r++; this.paint(); } return; }
    if (a === 'chup') { this.r = Math.max(0, this.r - ROWS); this.paint(); return; }
    if (a === 'chdn') { this.r = Math.min(this.chans.length - 1, this.r + ROWS); this.paint(); return; }
    if (a === 'left') { this.move(-1); return; }
    if (a === 'right') { this.move(1); return; }
    if (a === 'ok') { this.ok(); return; }
    // whole days at a time, and back to now
    if (a === 'ff' || a === 'rw') { this.jumpDay(a === 'ff' ? 1 : -1); return; }
    if (a === 'blue' || a === 'num0' && !this.numBuf) { this.focusT = Date.now(); this.t0 = Math.floor((Date.now() - 30 * 60e3) / (30 * 60e3)) * 30 * 60e3; this.paint(); return; }
    if (a === 'green') {
      var ch = this.chans[this.r];
      if (ch) { var self = this; NS.toggleList(ch).then(function () { self.paint(); }); }
      return;
    }
    if (a.indexOf('num') === 0) {
      var n = a.slice(3);
      this.numBuf = ((this.numBuf || '') + n).slice(-4);
      clearTimeout(this.numT);
      var self2 = this;
      this.numT = setTimeout(function () {
        var i = self2.chans.findIndex(function (c) { return String(c.num) === self2.numBuf; });
        self2.numBuf = '';
        if (i >= 0) { self2.r = i; self2.paint(); }
      }, 900);
    }
  };
  Guide.prototype.activate = function (first) { document.addEventListener('nsk-epg', this._epg); if (!first) this.paint(); };
  Guide.prototype.deactivate = function () { document.removeEventListener('nsk-epg', this._epg); NS.preview.stop(); this.pvCh = null; };
  Guide.prototype.destroy = function () { NS.preview.stop(); clearInterval(this.clockT); document.removeEventListener('nsk-epg', this._epg); };
  NS.Guide = Guide;

  /* ================================================================ A TITLE ON A STREAMING SERVICE */
  /**
   * A film or series that is on Netflix, Max, Disney+ or Prime Video (not in the library). The TV can't start
   * another app from here, so "Öppna i Netflix" tells you what to search for there and gives a QR code that
   * opens the title in the service's app on the phone. If the library has it too, it plays here instead.
   */
  function ExtDetail(item) {
    var self = this;
    this.item = item;
    this.el = h('div', { class: 'screen detail ext' });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.bg = h('div', { class: 'dbg on' });
    this.el.appendChild(this.bg);
    this.el.appendChild(h('div', { class: 'dbg-shade' }));
    this.el.appendChild(h('div', { class: 'dbg-left' }));
    this.infoEl = h('div', { class: 'dinfo' });
    this.el.appendChild(this.infoEl);
    this.bi = 0;
    this.render();
    NS.api.get('api/services/title/' + item.mt + '/' + item.id).then(function (d) {
      self.item = Object.assign({}, item, d);
      self.render();
    }).catch(function () { /* keep what the card had */ });
  }
  ExtDetail.prototype.render = function () {
    var self = this, d = this.item;
    var art = d.bd || d.img;
    if (art) this.bg.style.backgroundImage = 'url("' + NS.imgSrc(art).replace(/"/g, '%22') + '")';
    this.ambient.follow(d);
    var info = this.infoEl;
    info.innerHTML = '';
    info.appendChild(h('div', { class: 'kind' }, [NS.icon('aurora'), d.mt === 'tv' ? 'Serie' : 'Film']));
    info.appendChild(h('h1', { class: d.n.length > 22 ? 'long' : null, text: d.n }));
    var m = h('div', { class: 'meta' });
    var add = function (t) { if (t) m.appendChild(h('span', { text: String(t) })); };
    if (d.g) add(d.g.split(',')[0]);
    add(d.y);
    if (d.dur) add(NS.fmtDur(d.dur));
    if (d.seasons) add(d.seasons === 1 ? '1 säsong' : d.seasons + ' säsonger');
    if (d.r > 0) add('★ ' + d.r.toFixed(1));
    info.appendChild(m);
    if (d.svc && d.svc.length) info.appendChild(h('div', { class: 'svc-line' }, [h('span', { text: 'Finns på' }), NS.svcChips(d.svc)]));
    if (d.because) info.appendChild(h('div', { class: 'because', text: d.because }));
    if (d.p) info.appendChild(h('div', { class: 'desc', text: d.p }));
    if (d.cast) info.appendChild(h('div', { class: 'cast' }, [h('b', { text: 'Medverkande ' }), d.cast]));
    var btns = [];
    if (d.local) btns.push({ id: 'local', icon: 'play', label: 'Spela i ' + ((NS.status && NS.status.appName) || 'Norrsken') });
    (d.links || (d.svc || []).map(function (k) { return { svc: k, name: NS.svcName(k) }; })).forEach(function (l) { btns.push({ id: 'open', icon: 'link', label: 'Öppna i ' + l.name, link: l }); });
    this.btns = btns;
    this.btnEls = btns.map(function (b, i) { return h('div', { class: 'btn', onclick: function () { self.bi = i; self.paint(); self.press(); } }, [NS.icon(b.icon), b.label]); });
    info.appendChild(h('div', { class: 'btns' }, this.btnEls));
    if (d.svc && d.svc.length) info.appendChild(h('div', { class: 'jw', text: 'Uppgifter om tjänster från JustWatch via TMDB' }));
    this.paint();
  };
  ExtDetail.prototype.paint = function () {
    var self = this;
    if (this.bi >= this.btnEls.length) this.bi = 0;
    this.btnEls.forEach(function (e, i) { e.classList.toggle('focus', i === self.bi); });
  };
  ExtDetail.prototype.press = function () {
    var b = this.btns[this.bi], d = this.item;
    if (!b) return;
    if (b.id === 'local') { NS.router.push(new NS.Detail(d.local)); return; }
    var l = b.link;
    var qr = h('div', { class: 'qr-pop' }, [
      h('div', { class: 'qr' }, NS.img('api/qr.svg?text=' + encodeURIComponent(l.url || ''))),
      h('div', { class: 'qr-txt' }, [h('b', { text: 'På tv:n' }), h('p', { text: 'Öppna ' + l.name + '-appen och sök efter ”' + d.n + '”.' }),
        h('b', { text: 'På mobilen' }), h('p', { text: 'Skanna koden, så öppnas ' + l.name + ' direkt på titeln.' })])
    ]);
    NS.confirm({ title: 'Öppna i ' + l.name, body: l.url ? qr : null, text: l.url ? '' : 'Öppna ' + l.name + '-appen och sök efter ”' + d.n + '”.', buttons: [{ label: 'Klar', icon: 'check', value: true }], cancel: true });
  };
  ExtDetail.prototype.onKey = function (a) {
    if (a === 'back') { NS.router.pop(); return; }
    if (a === 'left' && this.bi > 0) this.bi--;
    else if (a === 'right' && this.bi < this.btns.length - 1) this.bi++;
    else if (a === 'ok') { this.press(); return; }
    this.paint();
  };
  NS.ExtDetail = ExtDetail;
})();
