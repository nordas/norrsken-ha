/* Norrsken screens: welcome, profiles, browse, detail, search, settings. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;
  var infoCache = {};

  function infoFor(item) {
    var key = item.t + ':' + item.id;
    if (infoCache[key]) return Promise.resolve(infoCache[key]);
    return NS.api.info(item.t, item.id).then(function (r) { infoCache[key] = r; return r; });
  }
  NS.infoFor = infoFor;

  /* ================================================================ play helpers */
  NS.playItem = function (item, opts) {
    opts = opts || {};
    NS.router.push(new NS.Player(Object.assign({ item: item }, opts)));
  };
  NS.resumePos = function (item) {
    var p = NS.state.progress[item.k];
    if (p && p.pos > 15 && p.dur && p.pos / p.dur < 0.95) return p.pos;
    return 0;
  };

  /* ================================================================ WELCOME (first run) */
  function Welcome(err) {
    this.el = h('div', { class: 'screen welcome' });
    this.firstErr = err;
    this.render();
  }
  Welcome.prototype.render = function () {
    var url = location.origin + '/setup';
    this.statusEl = h('div', { class: 'status' });
    this.errEl = h('div', { class: 'err' });
    this.titleEl = h('h1', { text: 'Välkommen till din nya tv-app' });
    this.textEl = h('p', { text: 'Skanna koden med mobilen, eller öppna adressen nedan, för att lägga in uppgifterna från din IPTV-leverantör. Tv:n startar av sig själv när allt är klart.' });
    this.el.appendChild(h('div', { class: 'txt' }, [h('div', { class: 'mark' }, NS.icon('aurora')), this.titleEl, this.textEl,
      h('div', { class: 'url' }, h('span', { text: url.replace(/^https?:\/\//, '') })), this.statusEl, this.errEl]));
    this.el.appendChild(h('div', { class: 'qr' }, NS.img('/api/qr.svg?text=' + encodeURIComponent(url))));
    if (this.firstErr) this.errEl.textContent = this.firstErr;
  };
  Welcome.prototype.activate = function () {
    var self = this;
    var poll = function () {
      NS.api.status().then(function (st) {
        NS.status = st;
        self.errEl.textContent = st.error ? st.error : '';
        if (st.ready && !st.loading) { clearInterval(self.t); NS.start(st); return; }
        self.statusEl.innerHTML = '';
        if (st.configured) {
          self.titleEl.textContent = 'Hämtar ditt utbud';
          self.textEl.textContent = 'Kanaler, filmer och serier laddas ner från leverantören. Första gången kan det ta en minut.';
          if (st.loading) self.statusEl.appendChild(h('div', { class: 'spinner' }));
          self.statusEl.appendChild(document.createTextNode(st.loading ? (st.stage || 'Laddar…') : st.error ? 'Kontrollera inställningarna i mobilen.' : 'Väntar…'));
        } else {
          self.statusEl.appendChild(h('div', { class: 'spinner' }));
          self.statusEl.appendChild(document.createTextNode('Väntar på inställningarna…'));
        }
      }).catch(function () { self.errEl.textContent = 'Når inte servern. Kontrollera att datorn med appen är igång.'; });
    };
    poll();
    this.t = setInterval(poll, 2500);
  };
  Welcome.prototype.deactivate = function () { clearInterval(this.t); };
  Welcome.prototype.destroy = function () { clearInterval(this.t); };
  Welcome.prototype.onKey = function (a) { if (a === 'back') NS.exitApp(); };
  NS.Welcome = Welcome;

  /* ================================================================ PROFILES */
  function Profiles(profiles) {
    this.list = profiles;
    var last = NS.store.get('profile', '');
    this.i = Math.max(0, profiles.findIndex(function (p) { return p.id === last; }));
    this.el = h('div', { class: 'screen profiles' });
    this.el.appendChild(h('h1', { text: 'Vem tittar?' }));
    var self = this;
    this.els = profiles.map(function (p, i) {
      return h('div', { class: 'p', onclick: function () { self.i = i; self.pick(); } }, [
        h('div', { class: 'av', style: 'background:' + p.color, text: p.name.charAt(0).toUpperCase() }),
        p.name, p.kids ? h('span', { class: 'kid', text: 'Barnprofil' }) : null
      ]);
    });
    this.el.appendChild(h('div', { class: 'plist' }, this.els));
    this.el.appendChild(h('div', { class: 'foot', text: 'Profiler ändrar du i mobilen: ' + location.host + '/setup' }));
    this.paint();
  }
  Profiles.prototype.paint = function () { var i = this.i; this.els.forEach(function (e, j) { e.classList.toggle('focus', i === j); }); };
  Profiles.prototype.pick = function () {
    var p = this.list[this.i];
    NS.profile = p;
    NS.store.set('profile', p.id);
    NS.loadState().then(function () { NS.router.reset(new Browse('home')); });
  };
  Profiles.prototype.onKey = function (a) {
    if (a === 'left' && this.i > 0) this.i--;
    else if (a === 'right' && this.i < this.list.length - 1) this.i++;
    else if (a === 'ok') return this.pick();
    else if (a === 'back') return NS.exitApp();
    this.paint();
  };
  NS.Profiles = Profiles;

  /* ================================================================ BROWSE */
  var PAGES = {
    home: { empty: ['Här är det tomt än så länge', 'Utbudet laddas fortfarande, eller så är alla kategorier dolda. Ändra urvalet i mobilen.'] },
    live: { empty: ['Inga kanaler', 'Leverantören har inga kanaler, eller så är kategorierna dolda i inställningarna.'] },
    movie: { empty: ['Inga filmer', 'Leverantören har inga filmer, eller så är kategorierna dolda i inställningarna.'] },
    series: { empty: ['Inga serier', 'Leverantören har inga serier, eller så är kategorierna dolda i inställningarna.'] },
    mylist: { empty: ['Din lista är tom', 'Välj en film eller serie och tryck på Min lista, så hamnar den här.'] }
  };

  function Browse(page) {
    var self = this;
    this.page = page;
    this.el = h('div', { class: 'screen browse' });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.holder = h('div');
    this.el.appendChild(this.holder);
    this.emptyEl = h('div', { class: 'welcome', style: 'display:none;position:absolute;inset:13rem 0 0 0' });
    this.el.appendChild(this.emptyEl);
    var p = NS.profile || { name: '?', color: '#888' };
    this.nav = new NS.TopNav([
      { id: 'profile', avatar: p.color, label: p.name },
      { id: 'search', icon: 'search' },
      { id: 'home', label: 'Hem' },
      { id: 'live', label: 'Live-tv' },
      { id: 'movie', label: 'Filmer' },
      { id: 'series', label: 'Serier' },
      { id: 'mylist', label: 'Min lista' }
    ], function (it) { self.navSelect(it); });
    this.el.appendChild(this.nav.el);
    this.mode = 'rows';
    this.load(page);
  }

  Browse.prototype.makeRows = function (rows, bb, keep) {
    var self = this;
    if (this.rows) { this.rows.destroy(); this.rows.el.remove(); }
    this.rows = new NS.RowsView({
      billboard: bb,
      rows: rows,
      onFocus: function (it) { self.focusItem(it); },
      onSelect: function (it, row) { self.select(it, row); },
      onPlay: function (it, row) { self.quickPlay(it, row); },
      onUp: function () { self.setMode('nav'); },
      onDeep: function (d) { self.el.classList.toggle('deep', d); }
    });
    if (keep) this.rows.setRows(rows, keep);
    this.holder.appendChild(this.rows.el);
    this.rows.focus(this.mode === 'rows');
  };

  Browse.prototype.load = function (page, keep) {
    var self = this;
    if (page !== this.page) NS.preview.stop();
    this.page = page;
    this.nav.setActive(page);
    var token = this._tok = {};
    return NS.api.page(page).then(function (res) {
      if (token !== self._tok) return;
      var rows = (res.rows || []).map(function (r) { r.showCount = page !== 'home' && !!r.cat; return r; });
      var bb = null;
      var feat = (res.featured || []);
      if (feat.length && page !== 'live' && page !== 'mylist') {
        var same = keep && self.bbItem && feat.some(function (f) { return f.k === self.bbItem.k; });
        var pick = same ? self.bbItem : feat[Math.floor(Math.random() * Math.min(feat.length, 6))];
        self.bbItem = pick;
        bb = new NS.Billboard();
        bb.show(pick);
        infoFor(pick).then(function (info) {
          if (self.rows && self.rows.bb === bb) { bb.show(Object.assign({}, pick, info)); if (self.rows.r < 0) self.ambient.follow(Object.assign({}, pick, info)); }
        }).catch(function () {});
      }
      self.makeRows(rows, bb, keep);
      if (!rows.length && !bb) {
        self.emptyEl.innerHTML = '';
        self.emptyEl.appendChild(h('div', { class: 'txt' }, [h('h1', { text: PAGES[page].empty[0] }), h('p', { text: PAGES[page].empty[1] })]));
        self.emptyEl.style.display = '';
        self.ambient.set(null);
        self.setMode('nav');
      } else {
        self.emptyEl.style.display = 'none';
        if (!keep) self.setMode('rows');
        self.rows.emitFocus();
      }
    }).catch(function (e) {
      if (e.status === 503) { NS.router.reset(new Welcome()); return; }
      NS.toast(e.message || 'Kunde inte hämta sidan', 'info');
    });
  };

  Browse.prototype.setMode = function (m) {
    if (m === 'rows' && this.rows && !this.rows.rows.length && !this.rows.bb) return;
    this.mode = m;
    if (m === 'nav' && this.rows && this.rows.r >= 0) NS.preview.stop();
    this.nav.focus(m === 'nav');
    if (this.rows) this.rows.focus(m === 'rows');
    if (m === 'nav') this.el.classList.remove('deep');
    else if (this.rows) this.rows.layout();
  };

  /** Start a preview of whatever has focus: the billboard, or the focused landscape/expanded card. */
  Browse.prototype.schedulePreview = function (it) {
    NS.preview.stop();
    if (!this.rows || NS.router.top() !== this) return;
    if (this.rows.r < 0) {
      if (this.rows.bb) NS.preview.start(it, this.rows.bb.art, { delay: 1500 });
      return;
    }
    var R = this.rows.currentRow();
    var card = this.rows.currentCard();
    if (!R || !card || this.mode !== 'rows') return;
    var f = card.querySelector('.frame');
    var kind = R.def.kind;
    if (kind === 'poster') NS.preview.start(it, f, { delay: 2400, before: f.querySelector('.xshade') });
    else if (kind === 'live') NS.preview.start(it, f, { delay: 1800, before: f.querySelector('.ltag') });
    else if (kind === 'continue') NS.preview.start(it, f, { delay: 2200, before: f.querySelector('.shade') });
  };

  Browse.prototype.focusItem = function (it) {
    var self = this;
    this.schedulePreview(it);
    var cached = (it.t === 'movie' || it.t === 'series') ? infoCache[it.t + ':' + it.id] : null;
    this.ambient.follow(cached ? Object.assign({}, it, cached) : it);
    clearTimeout(this._dwell);
    if (cached) { this.rows.applyInfo(it.k, cached); if (this.rows.r >= 0) this.rows.setInfo(it, cached); return; }
    if (it.t === 'movie' || it.t === 'series') {
      this._dwell = setTimeout(function () {
        infoFor(it).then(function (info) {
          self.rows.applyInfo(it.k, info);
          var cur = self.rows.current();
          if (cur && cur.k === it.k) {
            if (self.rows.r >= 0) self.rows.setInfo(it, info);
            if (info.bd) self.ambient.follow(Object.assign({}, it, info));
          }
        }).catch(function () { /* keep basic */ });
      }, 320);
    }
  };

  Browse.prototype.select = function (it, row) {
    if (it.t === 'live') {
      var R = this.rows.currentRow();
      NS.playItem(it, { list: R ? R.items : [it], cat: row.cat || null });
      return;
    }
    if (row.id === 'cw') { NS.playItem(it, { start: it.upnext ? 0 : it.pos || 0 }); return; }
    if (it.t === 'episode') { NS.playItem(it, { start: NS.resumePos(it) }); return; }
    NS.router.push(new Detail(it));
  };

  /** Play button on the remote: start right away instead of opening details. */
  Browse.prototype.quickPlay = function (it, row) {
    if (it.t === 'movie') { NS.playItem(it, { start: NS.resumePos(it) }); return; }
    if (it.t === 'series') { NS.router.push(new Detail(it, { autoplay: true })); return; }
    this.select(it, row || {});
  };

  Browse.prototype.navSelect = function (it) {
    if (it.id === 'search') { NS.router.push(new Search()); return; }
    if (it.id === 'profile') { NS.router.push(new Settings()); return; }
    if (it.id !== this.page) this.load(it.id);
    else this.setMode('rows');
  };

  Browse.prototype.activate = function (first) {
    var self = this;
    this._clk = NS.clock(this.nav.clockEl);
    if (this.rows) this.rows.focus(this.mode === 'rows');
    if (!first && NS.state.dirty) {
      NS.state.dirty = false;
      var R = this.rows ? this.rows.currentRow() : null;
      var cur = this.rows ? this.rows.current() : null;
      var r = this.rows ? this.rows.r : 0;
      NS.loadState().then(function () {
        self.load(self.page, { rowId: R ? R.def.id : '__bb', k: cur ? cur.k : '', r: r, col: R ? R.col : 0 });
      });
    } else if (!first && this.rows) {
      this.rows.refreshLive();
      var c = this.rows.current();
      if (c) this.schedulePreview(c);
    }
  };
  Browse.prototype.deactivate = function () { clearInterval(this._clk); NS.preview.stop(); };
  Browse.prototype.destroy = function () { clearInterval(this._clk); NS.preview.stop(); if (this.rows) this.rows.destroy(); };

  Browse.prototype.onKey = function (a) {
    if (this.mode === 'nav') {
      if (a === 'down') { this.setMode('rows'); if (this.rows) this.rows.emitFocus(); return; }
      if (a === 'back') {
        if (this.page !== 'home') { this.load('home'); return; }
        NS.exitApp();
        return;
      }
      this.nav.onKey(a);
      return;
    }
    if (a === 'back') {
      var top = this.rows.top();
      if (this.rows.r > top) { this.rows.go(top); return; }
      this.setMode('nav');
      return;
    }
    if (a === 'char:s' || a === 'yellow') { NS.router.push(new Search()); return; }
    if (a === 'blue' || a === 'info') {
      var cur = this.rows.current();
      if (cur && (cur.t === 'movie' || cur.t === 'series')) { NS.router.push(new Detail(cur)); return; }
    }
    this.rows.onKey(a);
  };
  NS.Browse = Browse;

  /* ================================================================ DETAIL */
  function Detail(item, opts) {
    var self = this;
    this.item = item;
    this.opts = opts || {};
    this.info = infoCache[item.t + ':' + item.id] || null;
    this.el = h('div', { class: 'screen detail' + (item.t === 'series' ? ' series' : '') });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.bgs = [h('div', { class: 'dbg' }), h('div', { class: 'dbg' })];
    this.el.appendChild(this.bgs[0]);
    this.el.appendChild(this.bgs[1]);
    this.bgi = 0;
    this.pvHost = h('div', { class: 'dpv' });
    this.el.appendChild(this.pvHost);
    this.el.appendChild(h('div', { class: 'dbg-shade' }));
    this.infoEl = h('div', { class: 'dinfo' });
    this.el.appendChild(this.infoEl);
    this.zone = 'btns';
    this.bi = 0;
    this.rows = new NS.RowsView({
      className: 'rowsonly', scroll: false, info: false, expand: false,
      onFocus: function (it, row) { self.rowFocus(it, row); },
      onSelect: function (it, row) { self.rowSelect(it, row); },
      onUp: function () { self.setZone('btns'); }
    });
    this.rows.focus(false);
    this.el.appendChild(this.rows.el);
    this.render();
    this.fetch();
  }

  Detail.prototype.fetch = function () {
    var self = this;
    infoFor(this.item).then(function (info) {
      self.info = info;
      self.render();
      self.buildRows();
      if (self.opts.autoplay) { self.opts.autoplay = false; self.press(); return; }
      self.preview();
    }).catch(function () {
      if (self.item.t === 'series') NS.toast('Kunde inte hämta avsnitten', 'info');
      self.buildRows();
    });
  };

  Detail.prototype.data = function () { return this.info ? Object.assign({}, this.item, this.info) : this.item; };

  /** Which episode "Play" means: the most recently watched one, else S1:A1. */
  Detail.prototype.target = function () {
    var d = this.data();
    if (!d.seasons || !d.seasons.length) return null;
    var best = null, bestTs = 0;
    d.seasons.forEach(function (s) {
      s.eps.forEach(function (e) {
        var p = NS.state.progress[e.k];
        if (p && p.ts > bestTs) { best = e; bestTs = p.ts; }
      });
    });
    return best || d.seasons[0].eps[0];
  };

  Detail.prototype.setBg = function (u) {
    if (!u || u === this.bgUrl) return;
    this.bgUrl = u;
    var self = this;
    var im = new Image();
    im.onload = function () {
      if (self.bgUrl !== u) return;
      self.bgi = 1 - self.bgi;
      var a = self.bgs[self.bgi], b = self.bgs[1 - self.bgi];
      a.className = 'dbg' + (im.naturalHeight > im.naturalWidth * 0.9 ? ' poster' : '');
      a.style.backgroundImage = 'url("' + im.src.replace(/"/g, '%22') + '")';
      void a.offsetWidth;
      a.classList.add('on');
      b.classList.remove('on');
    };
    im.src = NS.imgSrc(u);
  };

  Detail.prototype.preview = function () {
    if (NS.router.top() !== this || this.pvItem === this.item.k && NS.preview.active()) return;
    this.pvItem = this.item.k;
    var d = this.data();
    var t = d.t === 'series' ? this.target() : null;
    var sub = t ? Object.assign({}, t, { t: 'episode' }) : d;
    if (d.t === 'series' && !t) return;
    NS.preview.start(sub, this.pvHost, { delay: 2500 });
  };

  Detail.prototype.render = function () {
    var self = this;
    var d = this.data();
    this.setBg(d.bd || d.img);
    this.ambient.follow(d);
    var info = this.infoEl;
    info.innerHTML = '';
    info.appendChild(h('div', { class: 'kind' }, [NS.icon('aurora'), NS.kindLabel(d)]));
    info.appendChild(h('h1', { class: d.n.length > 22 ? 'long' : null, text: d.n }));
    info.appendChild(NS.metaEl(d));
    if (d.p) info.appendChild(h('div', { class: 'desc', text: d.p }));
    if (d.cast || d.dir) {
      info.appendChild(h('div', { class: 'cast' }, [d.cast ? h('b', { text: 'Medverkande ' }) : null, d.cast || '', d.dir ? h('b', { text: (d.cast ? '    ' : '') + 'Regi ' }) : null, d.dir || '']));
    }
    var btns = [];
    if (d.t === 'movie') {
      var pos = NS.resumePos(d);
      var p = NS.state.progress[d.k];
      btns.push({ id: 'play', icon: 'play', label: pos ? 'Fortsätt titta' : 'Spela', sub: pos && p ? NS.left(pos, p.dur) : '' });
      if (pos) btns.push({ id: 'restart', icon: 'restart', label: 'Från början' });
    } else {
      var t = this.target();
      if (t) {
        var tp = NS.state.progress[t.k];
        var resume = tp && tp.pos > 15 && !tp.upnext;
        var first = t === d.seasons[0].eps[0] && !tp;
        btns.push({ id: 'play', icon: 'play', label: first ? 'Spela upp serie' : (resume ? 'Fortsätt ' : 'Spela ') + NS.epCode(t), sub: resume && tp.dur ? NS.left(tp.pos, tp.dur) : '' });
        if (resume) btns.push({ id: 'restart', icon: 'restart', label: 'Från början' });
      } else if (!this.info) {
        btns.push({ id: 'wait', icon: 'play', label: 'Hämtar avsnitt…' });
      }
    }
    var inl = NS.inList(d.k);
    btns.push({ id: 'list', icon: inl ? 'check' : 'plus', label: 'Min lista' });
    this.btns = btns;
    this.btnEls = btns.map(function (b, i) {
      return h('div', { class: 'btn', onclick: function () { self.bi = i; self.setZone('btns'); self.press(); } }, [NS.icon(b.icon), b.label, b.sub ? h('span', { class: 'sub', text: b.sub }) : null]);
    });
    info.appendChild(h('div', { class: 'btns' }, this.btnEls));
    if (this.bi >= btns.length) this.bi = 0;
    this.paintBtns();
  };

  Detail.prototype.paintBtns = function () {
    var self = this;
    this.btnEls.forEach(function (e, i) { e.classList.toggle('focus', self.zone === 'btns' && i === self.bi); });
  };

  Detail.prototype.buildRows = function () {
    var self = this;
    var d = this.data();
    if (d.t === 'series') {
      var seasons = d.seasons || [];
      if (!seasons.length) { this.rows.setRows([]); return; }
      var t = this.target();
      var si = Math.max(0, seasons.findIndex(function (s) { return s.eps.indexOf(t) >= 0; }));
      this.season = si;
      var pills = seasons.map(function (s, i) { return { k: 'season' + i, label: s.name, value: i }; });
      var eps = seasons[si].eps;
      var rows = [];
      if (seasons.length > 1) rows.push({ id: 'seasons', kind: 'pill', items: pills, selected: si });
      else rows.push({ id: 'seasons', kind: 'pill', items: [{ k: 'season0', label: 'Avsnitt', value: 0 }], selected: 0 });
      rows.push({ id: 'eps', kind: 'episode', items: eps });
      this.rows.setRows(rows);
      this.rows.rows[1].col = Math.max(0, eps.indexOf(t));
      this.rows.rows[0].col = si;
      this.rows.r = 1;
      this.rows.layout();
      return;
    }
    if (!d.cat) return;
    NS.api.list('movie', d.cat, 0, 40).then(function (res) {
      var items = (res.items || []).filter(function (x) { return x.k !== d.k; });
      if (items.length) self.rows.setRows([{ id: 'more', title: 'Mer som detta', kind: 'poster', items: items }]);
      self.rows.focus(self.zone === 'rows');
    }).catch(function () { /* no extras */ });
  };

  Detail.prototype.setZone = function (z) {
    if (z === 'rows' && !this.rows.rows.length) return;
    this.zone = z;
    this.rows.focus(z === 'rows');
    this.paintBtns();
    if (z === 'rows') this.rows.layout();
  };

  Detail.prototype.rowFocus = function (it, row) {
    var self = this;
    if (row.id === 'seasons') {
      clearTimeout(this._st);
      this._st = setTimeout(function () {
        if (self.season === it.value) return;
        self.season = it.value;
        var d = self.data();
        row.selected = it.value;
        self.rows.repaintRow(0);
        self.rows.setRowItems(1, d.seasons[it.value].eps, 0);
      }, 220);
    }
  };

  Detail.prototype.rowSelect = function (it, row) {
    if (row.id === 'seasons') { this.rows.go(1); return; }
    if (it.t === 'episode') { this.playEpisode(it, NS.resumePos(it)); return; }
    NS.router.push(new Detail(it));
  };

  Detail.prototype.playEpisode = function (ep, start) {
    var d = this.data();
    NS.playItem(Object.assign({}, ep, { sn: d.n, bd: d.bd }), { start: start || 0, series: d });
  };

  Detail.prototype.press = function () {
    var self = this;
    var b = this.btns[this.bi];
    if (!b) return;
    var d = this.data();
    if (b.id === 'list') { NS.toggleList(this.item).then(function () { self.render(); }); return; }
    if (b.id === 'wait') return;
    if (d.t === 'movie') {
      NS.playItem(d, { start: b.id === 'restart' ? 0 : NS.resumePos(d) });
    } else {
      var t = this.target();
      if (!t) return;
      var p = NS.state.progress[t.k];
      this.playEpisode(t, b.id === 'restart' || !p || p.upnext ? 0 : p.pos);
    }
  };

  Detail.prototype.activate = function (first) {
    var self = this;
    if (first) { if (this.info) this.preview(); return; }
    this.pvItem = null;
    NS.loadState().then(function () {
      self.render();
      self.preview();
      if (self.data().t === 'series') {
        var keepZone = self.zone;
        self.buildRows();
        self.setZone(keepZone);
      }
    });
  };
  Detail.prototype.deactivate = function () { NS.preview.stop(); this.pvItem = null; };
  Detail.prototype.destroy = function () { NS.preview.stop(); this.rows.destroy(); };

  Detail.prototype.onKey = function (a) {
    if (a === 'back') { NS.router.pop(); return; }
    if (this.zone === 'btns') {
      if (a === 'left' && this.bi > 0) this.bi--;
      else if (a === 'right' && this.bi < this.btns.length - 1) this.bi++;
      else if (a === 'down') { this.setZone('rows'); return; }
      else if (a === 'ok') { this.press(); return; }
      else if (a === 'play' || a === 'playpause') { this.bi = 0; this.press(); return; }
      this.paintBtns();
      return;
    }
    this.rows.onKey(a);
  };
  NS.Detail = Detail;

  /* ================================================================ SEARCH */
  var KB = [
    ['a', 'b', 'c', 'd', 'e', 'f'], ['g', 'h', 'i', 'j', 'k', 'l'], ['m', 'n', 'o', 'p', 'q', 'r'], ['s', 't', 'u', 'v', 'w', 'x'],
    ['y', 'z', 'å', 'ä', 'ö', '0'], ['1', '2', '3', '4', '5', '6'],
    ['7', '8', '9', { v: ' ', label: 'Mellanslag', span: 3 }],
    [{ v: 'del', label: 'Radera', span: 3, icon: 'del' }, { v: 'clear', label: 'Rensa', span: 3 }]
  ];

  function Search() {
    var self = this;
    this.q = '';
    this.el = h('div', { class: 'screen search' });
    this.queryEl = h('div', { class: 'query' });
    var keysEl = h('div', { class: 'keys' });
    this.grid = KB.map(function (row, r) {
      var c0 = 0;
      return row.map(function (k) {
        var key = typeof k === 'string' ? { v: k, label: k, span: 1 } : k;
        key.c0 = c0; c0 += key.span; key.r = r;
        key.el = h('div', { class: 'key' + (key.span > 1 ? ' wide' : ''), style: key.span > 1 ? 'grid-column: span ' + key.span : null, onclick: function () { self.focusKey(key); self.type(key.v); } },
          [key.icon ? NS.icon(key.icon) : null, key.icon ? null : key.label]);
        keysEl.appendChild(key.el);
        return key;
      });
    });
    this.kr = 0; this.kc = 0;
    this.el.appendChild(h('div', { class: 'kb' }, [this.queryEl, keysEl]));
    this.hint = h('div', { class: 'hint' }, [h('b', { text: 'Sök' }), 'Skriv några bokstäver för att hitta kanaler, filmer och serier.']);
    this.el.appendChild(this.hint);
    this.rows = new NS.RowsView({
      className: 'rowsonly', info: false, expand: false,
      onSelect: function (it, row) { self.select(it, row); },
      onLeft: function () { self.setZone('kb'); },
      onUp: function () { }
    });
    this.rows.focus(false);
    this.el.appendChild(this.rows.el);
    this.zone = 'kb';
    this.run = NS.debounce(this.search.bind(this), 350);
    this.paint();
  }
  Search.prototype.focusKey = function (k) { this.kr = k.r; this.kc = this.grid[k.r].indexOf(k); this.setZone('kb'); };
  Search.prototype.paint = function () {
    var self = this;
    this.grid.forEach(function (row, r) { row.forEach(function (k, c) { k.el.classList.toggle('focus', self.zone === 'kb' && r === self.kr && c === self.kc); }); });
    this.queryEl.innerHTML = '';
    this.queryEl.appendChild(NS.icon('search'));
    if (this.q) this.queryEl.appendChild(h('span', { text: this.q }));
    if (this.zone === 'kb') this.queryEl.appendChild(h('span', { class: 'caret' }));
    if (!this.q) this.queryEl.appendChild(h('span', { class: 'ph', text: 'Titel eller kanal' }));
  };
  Search.prototype.setZone = function (z) {
    if (z === 'rows' && !this.rows.rows.length) return;
    this.zone = z;
    this.rows.focus(z === 'rows');
    if (z === 'rows') this.rows.layout();
    this.paint();
  };
  Search.prototype.type = function (v) {
    if (v === 'del') this.q = this.q.slice(0, -1);
    else if (v === 'clear') this.q = '';
    else if (this.q.length < 40) this.q += v;
    this.paint();
    this.run();
  };
  Search.prototype.search = function () {
    var self = this;
    var q = this.q.trim();
    if (!q) { this.rows.setRows([]); this.showHint('Sök', 'Skriv några bokstäver för att hitta kanaler, filmer och serier.'); return; }
    NS.api.search(q).then(function (r) {
      if (self.q.trim() !== q) return;
      var rows = [];
      if (r.live.length) rows.push({ id: 's-live', title: 'Kanaler', kind: 'live', items: r.live });
      if (r.movie.length) rows.push({ id: 's-movie', title: 'Filmer', kind: 'poster', items: r.movie });
      if (r.series.length) rows.push({ id: 's-series', title: 'Serier', kind: 'poster', items: r.series });
      self.rows.setRows(rows);
      self.rows.focus(self.zone === 'rows');
      if (!rows.length) self.showHint('Inga träffar', 'Inget matchar ”' + q + '”. Prova ett kortare ord eller en annan stavning.');
      else self.hint.style.display = 'none';
    }).catch(function (e) { self.showHint('Sökningen misslyckades', e.message); });
  };
  Search.prototype.showHint = function (t, p) {
    this.hint.innerHTML = '';
    this.hint.appendChild(h('b', { text: t }));
    this.hint.appendChild(document.createTextNode(p));
    this.hint.style.display = '';
  };
  Search.prototype.select = function (it, row) {
    if (it.t === 'live') { NS.playItem(it, { list: row.items }); return; }
    NS.router.push(new Detail(it));
  };
  Search.prototype.destroy = function () { this.rows.destroy(); };
  Search.prototype.onKey = function (a, e) {
    var key = e && e.key;
    // Esc (computer keyboard) always leaves search
    if (key === 'Escape') { NS.router.pop(); return; }
    // Backspace / the remote's Back: erase one letter, like a keyboard; with nothing left it leaves search
    if (a === 'back') {
      if (this.zone === 'rows') { this.setZone('kb'); return; }
      if (this.q) { this.type('del'); return; }
      NS.router.pop();
      return;
    }
    if (key === ' ' && this.zone === 'kb') { this.type(' '); return; }
    if (key && key.length === 1 && /[0-9a-zåäöéü\-:&']/i.test(key) && a.indexOf('char:') !== 0 && a.indexOf('num') !== 0 && a !== 'left' && a !== 'right') { this.type(key.toLowerCase()); return; }
    if (a.indexOf('num') === 0) { this.type(a.slice(3)); return; }
    if (a.indexOf('char:') === 0) { this.type(a.slice(5)); return; }
    if (this.zone === 'rows') { this.rows.onKey(a); return; }
    var row = this.grid[this.kr];
    var key = row[this.kc];
    if (a === 'left') { if (this.kc > 0) this.kc--; }
    else if (a === 'right') { if (this.kc < row.length - 1) this.kc++; else { this.setZone('rows'); return; } }
    else if (a === 'up' || a === 'down') {
      var nr = this.kr + (a === 'up' ? -1 : 1);
      if (nr >= 0 && nr < this.grid.length) {
        var target = this.grid[nr];
        var idx = target.findIndex(function (k) { return key.c0 >= k.c0 && key.c0 < k.c0 + k.span; });
        this.kr = nr; this.kc = idx < 0 ? target.length - 1 : idx;
      }
    } else if (a === 'ok') { this.type(key.v); return; }
    this.paint();
  };
  NS.Search = Search;

  /* ================================================================ SETTINGS */
  function Settings() {
    var self = this;
    this.el = h('div', { class: 'screen settings' });
    this.el.appendChild(h('h1', { text: 'Inställningar' }));
    this.items = [
      { id: 'profile', icon: 'user', label: 'Byt profil' },
      { id: 'refresh', icon: 'refresh', label: 'Uppdatera utbudet' },
      { id: 'phone', icon: 'phone', label: 'Ändra i mobilen' },
      { id: 'about', icon: 'info', label: 'Om appen' },
      { id: 'exit', icon: 'power', label: 'Avsluta' }
    ];
    this.i = 0;
    this.els = this.items.map(function (it, i) {
      return h('div', { class: 'mi', onclick: function () { self.i = i; self.paint(); self.press(); } }, [NS.icon(it.icon), it.label]);
    });
    this.el.appendChild(h('div', { class: 'menu' }, this.els));
    this.panel = h('div', { class: 'panel' });
    this.el.appendChild(this.panel);
    this.paint();
  }
  Settings.prototype.paint = function () {
    var self = this;
    this.els.forEach(function (e, i) { e.classList.toggle('focus', i === self.i); });
    var it = this.items[this.i];
    var p = this.panel;
    p.innerHTML = '';
    var st = NS.status || {};
    if (it.id === 'profile') {
      p.appendChild(h('h2', { text: 'Profil: ' + (NS.profile ? NS.profile.name : '') }));
      p.appendChild(h('p', { text: 'Varje profil har en egen lista, egen historik och egen ”Fortsätt titta”. Barnprofiler visar bara barnkategorier.' }));
    } else if (it.id === 'refresh') {
      p.appendChild(h('h2', { text: 'Uppdatera utbudet' }));
      p.appendChild(h('p', { text: 'Hämtar kanaler, filmer, serier och tv-guide från leverantören på nytt. Det sker också automatiskt två gånger per dygn.' }));
      if (this.refreshing) p.appendChild(h('p', {}, [h('span', { class: 'spinner', style: 'display:inline-block;vertical-align:middle;margin-right:1.6rem' }), this.refreshing]));
    } else if (it.id === 'phone') {
      var url = location.origin + '/setup';
      p.appendChild(h('h2', { text: 'Ändra inställningar i mobilen' }));
      p.appendChild(h('p', { text: 'Där byter du leverantör, lägger till profiler och väljer vilka kategorier som ska synas.' }));
      p.appendChild(h('p', { text: url }));
      p.appendChild(h('div', { class: 'qr' }, NS.img('/api/qr.svg?text=' + encodeURIComponent(url))));
    } else if (it.id === 'about') {
      p.appendChild(h('h2', { text: (st.appName || 'Norrsken') + ' ' + (st.version || '') }));
      var c = st.counts || {};
      var dl = h('dl');
      var row = function (k, v) { dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { text: v })); };
      row('Kanaler', String(c.live || 0));
      row('Filmer', String(c.movie || 0));
      row('Serier', String(c.series || 0));
      row('Tv-guide', st.epg && st.epg.count ? st.epg.count + ' program' : st.epg && st.epg.loading ? 'laddas…' : 'saknas');
      row('Senast uppdaterat', st.at ? new Date(st.at).toLocaleString('sv-SE') : '–');
      row('MKV och undertexter', st.ffmpeg ? 'Ja' : 'Nej (ffmpeg saknas på servern)');
      row('Server', location.host);
      p.appendChild(dl);
    } else if (it.id === 'exit') {
      p.appendChild(h('h2', { text: 'Avsluta appen' }));
      p.appendChild(h('p', { text: 'Du kommer tillbaka till tv:ns startskärm.' }));
    }
  };
  Settings.prototype.press = function () {
    var self = this;
    var it = this.items[this.i];
    if (it.id === 'profile') NS.router.reset(new Profiles(NS.status.profiles));
    else if (it.id === 'exit') NS.exitApp();
    else if (it.id === 'refresh' && !this.refreshing) {
      this.refreshing = 'Startar…';
      this.paint();
      NS.api.post('/api/refresh', {}).then(function () {
        var poll = function () {
          NS.api.status().then(function (st) {
            NS.status = st;
            if (st.loading) { self.refreshing = st.stage || 'Laddar…'; self.paint(); self._t = setTimeout(poll, 1200); return; }
            self.refreshing = null;
            self.paint();
            NS.state.dirty = true;
            NS.toast(st.error ? st.error : 'Utbudet är uppdaterat', st.error ? 'info' : 'check');
          });
        };
        self._t = setTimeout(poll, 800);
      });
    }
  };
  Settings.prototype.activate = function () {
    var self = this;
    NS.api.status().then(function (st) { NS.status = st; self.paint(); }).catch(function () {});
  };
  Settings.prototype.destroy = function () { clearTimeout(this._t); };
  Settings.prototype.onKey = function (a) {
    if (a === 'back') { NS.router.pop(); return; }
    if (a === 'up' && this.i > 0) this.i--;
    else if (a === 'down' && this.i < this.items.length - 1) this.i++;
    else if (a === 'ok') { this.press(); return; }
    this.paint();
  };
  NS.Settings = Settings;
})();
