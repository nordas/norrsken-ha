/* Norrsken on phones and tablets: touch layout in the style of the streaming apps' mobile versions. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;

  var touch = /[?&]mobile=1/.test(location.search) ||
    (!/[?&]mobile=0/.test(location.search) && window.matchMedia && (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 900px)').matches));
  NS.touch = !!touch;
  if (!NS.touch) return;
  document.documentElement.classList.add('m');

  /* ---------------------------------------------------------------- browser back button = app back */
  var router = NS.router;
  var origPush = router.push.bind(router);
  var origPop = router.pop.bind(router);
  router.push = function (s) { origPush(s); try { history.pushState({ nsk: router.stack.length }, ''); } catch (e) { /* ignore */ } };
  window.addEventListener('popstate', function () { if (router.stack.length > 1) origPop(); });
  NS.mBack = function () { if (router.stack.length > 1) { try { history.back(); } catch (e) { origPop(); } } };
  router.pop = function () { NS.mBack(); };

  /* ---------------------------------------------------------------- pieces */
  function poster(it, opts) {
    opts = opts || {};
    var title = it.t === 'episode' ? it.sn || it.n : it.n;
    var c = h('div', { class: 'm-card m-poster' + (opts.num ? ' m-top' : '') });
    if (opts.num) c.appendChild(h('span', { class: 'm-num', text: String(opts.num) }));
    var f = h('div', { class: 'm-frame', style: 'background:' + NS.fallbackBg(title) }, h('span', { class: 'm-fb', text: title }));
    if (it.img) f.appendChild(NS.pic(it.img, 'm-img'));
    var pr = NS.state.progress[it.k];
    var pos = it.pos || (pr && pr.pos) || 0, dur = it.dur || (pr && pr.dur) || 0;
    if (dur && pos > 0) f.appendChild(NS.progEl(pos / dur * 100));
    if (it.add && Date.now() / 1000 - it.add < 10 * 86400) f.appendChild(h('span', { class: 'm-new', text: it.t === 'series' ? 'Nytt' : 'Ny' }));
    c.appendChild(f);
    if (opts.caption) c.appendChild(h('div', { class: 'm-cap', text: opts.caption }));
    return c;
  }

  var liveCards = {};
  function liveCard(it) {
    var f = h('div', { class: 'm-frame', style: 'background: radial-gradient(80% 90% at 50% 20%, ' + NS.rgba(NS.hueColor(it.n), 0.85) + ', #18181a 75%)' });
    var name = h('span', { class: 'm-lname', text: it.n });
    f.appendChild(name);
    if (it.img) { name.style.display = 'none'; f.appendChild(NS.pic(it.img, 'm-logo', function () { name.style.display = ''; })); }
    f.appendChild(h('span', { class: 'm-livetag', text: 'LIVE' }));
    var now = h('div', { class: 'm-now' });
    var c = h('div', { class: 'm-card m-live' }, [f, now]);
    c._it = it; c._now = now;
    paintLive(c);
    (liveCards[it.id] = liveCards[it.id] || []).push(c);
    return c;
  }
  function paintLive(c) {
    var e = NS.epgFor(c._it.id);
    c._now.innerHTML = '';
    c._now.appendChild(h('b', { text: (c._it.num ? c._it.num + '  ' : '') + c._it.n }));
    if (e && e.now) {
      c._now.appendChild(h('span', { text: e.now.t }));
      c._now.appendChild(NS.progEl(NS.livePct(e.now)));
    }
  }
  document.addEventListener('nsk-epg', function (ev) {
    (ev.detail || []).forEach(function (id) { (liveCards[id] || []).forEach(function (c) { if (c.isConnected) paintLive(c); }); });
  });

  function open(it, row) {
    if (it.t === 'live') { NS.playItem(it, { list: (row && row.items) || [it], cat: (row && row.cat) || null }); return; }
    if (row && row.id === 'cw') { NS.playItem(it, { start: it.upnext ? 0 : it.pos || 0 }); return; }
    if (it.t === 'episode') { NS.playItem(it, { start: NS.resumePos(it) }); return; }
    NS.router.push(new MDetail(it));
  }

  /** A horizontally scrolling row that loads more items as you swipe. */
  function rowEl(def) {
    var items = (def.items || []).slice();
    var total = def.total || items.length;
    var kind = def.kind === 'live' ? 'live' : 'poster';
    var track = h('div', { class: 'm-track m-' + kind + 's' });
    var loading = false;
    var add = function (list, startIdx) {
      list.forEach(function (it, i) {
        var c;
        if (kind === 'live') c = liveCard(it);
        else c = poster(it, { num: def.kind === 'top10' ? startIdx + i + 1 : 0, caption: def.id === 'cw' ? (it.t === 'episode' ? NS.epCode(it) + ' ' + it.n : NS.left(it.pos || 0, it.dur || 1)) : '' });
        c.addEventListener('click', function () { open(it, { id: def.id, items: items, cat: def.cat }); });
        track.appendChild(c);
      });
      if (kind === 'live') NS.needEpg(list.map(function (x) { return x.id; }));
    };
    add(items, 0);
    var more = function () {
      if (loading || items.length >= total || !def.type || !def.cat) return;
      if (track.scrollLeft + track.clientWidth < track.scrollWidth - 600) return;
      loading = true;
      NS.api.list(def.type, def.cat, items.length, 40).then(function (r) {
        var start = items.length;
        items = items.concat(r.items || []);
        total = r.items && r.items.length ? r.total : items.length;
        add(r.items || [], start);
        loading = false;
      }).catch(function () { loading = false; });
    };
    track.addEventListener('scroll', more, { passive: true });
    if (!items.length && total) more();
    return h('section', { class: 'm-row' }, [def.title ? h('h2', {}, [def.title, def.showCount ? h('span', { text: ' ' + total }) : null]) : null, track]);
  }

  /* ---------------------------------------------------------------- page scrolling
     Phones scroll the whole page (smooth native scrolling, address bar hides). Each screen remembers its position. */
  function saveY(scr) { scr._y = window.scrollY || window.pageYOffset || 0; }
  function restoreY(scr) { var y = scr._y || 0; setTimeout(function () { window.scrollTo(0, y); }, 0); }
  function top0() { window.scrollTo(0, 0); }

  /* ---------------------------------------------------------------- bottom tab bar */
  var TABBAR = [
    { id: 'home', icon: 'home', label: 'Hem' },
    { id: 'live', icon: 'live', label: 'Live-tv' },
    { id: 'search', icon: 'search', label: 'Sök' },
    { id: 'me', label: 'Mitt' }
  ];
  function tabbar(active) {
    var p = NS.profile || { name: '?', color: '#888' };
    return h('nav', { class: 'm-tabbar' }, TABBAR.map(function (t) {
      var lead = t.id === 'me' ? h('span', { class: 'm-tab-av', style: 'background:' + p.color, text: p.name.charAt(0).toUpperCase() }) : NS.icon(t.icon);
      return h('button', { class: 'm-tab' + (t.id === active ? ' on' : ''), onclick: function () {
        if (t.id === active) { top0(); return; }
        if (t.id === 'search') { NS.router.push(new MSearch()); return; }
        if (t.id === 'me') { NS.router.push(new MMe()); return; }
        var b = NS.router.stack[0];
        while (NS.router.stack.length > 1) origPop();
        if (b && b.load) { b.load(t.id); top0(); }
      } }, [lead, h('span', { text: t.id === 'me' ? 'Mitt ' + ((NS.status && NS.status.appName) || 'Norrsken') : t.label })]);
    }));
  }

  /* ---------------------------------------------------------------- browse */
  var TABS = [{ id: 'series', label: 'Serier' }, { id: 'movie', label: 'Filmer' }, { id: 'live', label: 'Live-tv' }, { id: 'mylist', label: 'Min lista' }];
  var TITLES = { home: 'Hem', series: 'Serier', movie: 'Filmer', live: 'Live-tv', mylist: 'Min lista' };

  function MBrowse(page) {
    var self = this;
    this.page = page || 'home';
    this.el = h('div', { class: 'screen m-screen' });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.title = h('h1', { class: 'm-title' });
    this.pillsEl = h('nav', { class: 'm-pills' });
    this.head = h('header', { class: 'm-head' }, [
      h('div', { class: 'm-bar' }, [
        h('span', { class: 'm-logo-mark' }, NS.icon('aurora')), this.title,
        h('button', { class: 'm-icon', 'aria-label': 'Sök', onclick: function () { NS.router.push(new MSearch()); } }, NS.icon('search'))
      ]),
      this.pillsEl
    ]);
    this.el.appendChild(this.head);
    this.body = h('div', { class: 'm-body' });
    this.el.appendChild(this.body);
    this.tabs = h('div');
    this.el.appendChild(this.tabs);
    // like the phone apps: the top bar slides away while scrolling down and comes back as soon as you scroll up
    var lastY = 0, acc = 0;
    this._onScroll = function () {
      if (NS.router.top() !== self) return;
      var y = Math.max(0, window.scrollY || 0);
      var dy = y - lastY;
      lastY = y;
      acc = (dy > 0) === (acc > 0) ? acc + dy : dy;
      self.head.classList.toggle('solid', y > 8);
      if (y < 60) self.head.classList.remove('away');
      else if (acc > 24) self.head.classList.add('away');
      else if (acc < -12) self.head.classList.remove('away');
    };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this.load(this.page);
  }

  MBrowse.prototype.paintHead = function () {
    var self = this;
    this.head.classList.remove('away');
    var page = this.page;
    this.title.textContent = TITLES[page] || 'Hem';
    this.pillsEl.innerHTML = '';
    if (page !== 'home') this.pillsEl.appendChild(h('button', { class: 'm-pill m-pill-x', 'aria-label': 'Tillbaka till Hem', onclick: function () { self.load('home'); top0(); } }, NS.icon('x')));
    TABS.forEach(function (t) {
      if (page !== 'home' && t.id !== page) return;
      self.pillsEl.appendChild(h('button', { class: 'm-pill' + (t.id === page ? ' on' : ''), onclick: function () { self.load(t.id === page ? 'home' : t.id); top0(); } }, t.label));
    });
    this.tabs.innerHTML = '';
    this.tabs.appendChild(tabbar(page === 'live' ? 'live' : 'home'));
  };

  MBrowse.prototype.load = function (page) {
    var self = this;
    this.page = page;
    this.paintHead();
    var tok = this._tok = {};
    this.body.innerHTML = '';
    this.body.appendChild(h('div', { class: 'm-loading' }, h('div', { class: 'spinner' })));
    NS.api.page(page).then(function (res) {
      if (tok !== self._tok) return;
      self.body.innerHTML = '';
      var feat = res.featured || [];
      if (feat.length && page !== 'live' && page !== 'mylist') self.body.appendChild(self.hero(feat[Math.floor(Math.random() * Math.min(6, feat.length))]));
      var who = NS.profile ? NS.profile.name : '';
      (res.rows || []).forEach(function (r) {
        r.showCount = page !== 'home' && !!r.cat;
        if (r.id === 'cw' && who) r.title = 'Fortsätt titta som ' + who;
        self.body.appendChild(rowEl(r));
      });
      if (!(res.rows || []).length && !feat.length) {
        self.body.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: page === 'mylist' ? 'Din lista är tom' : 'Här är det tomt' }),
          h('p', { text: page === 'mylist' ? 'Tryck på Min lista på en film eller serie, så hamnar den här.' : 'Utbudet laddas fortfarande, eller så är kategorierna dolda i inställningarna.' })]));
      }
    }).catch(function (e) {
      if (e.status === 503) { NS.router.reset(new NS.Welcome()); return; }
      self.body.innerHTML = '';
      self.body.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Kunde inte hämta sidan' }), h('p', { text: e.message })]));
    });
  };

  MBrowse.prototype.hero = function (it) {
    var art = h('div', { class: 'm-hero-art' });
    var img = it.img || it.bd;
    if (img) art.appendChild(NS.pic(img, 'm-img'));
    else art.style.background = NS.fallbackBg(it.n);
    this.ambient.follow(it);
    var inl = NS.inList(it.k);
    var listBtn = h('button', { class: 'm-btn ghost', onclick: function () {
      NS.toggleList(it).then(function (on) { listBtn.innerHTML = ''; listBtn.appendChild(NS.icon(on ? 'check' : 'plus')); listBtn.appendChild(document.createTextNode('Min lista')); });
    } }, [NS.icon(inl ? 'check' : 'plus'), 'Min lista']);
    var genres = (it.g || '').split(/[,/|]/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 2);
    var meta = h('p', { class: 'm-hero-meta' }, [NS.kindLabel(it)].concat(genres).map(function (x, i) { return h('span', { class: i ? '' : 'b', text: x }); }));
    var card = h('div', { class: 'm-hero' }, [art, h('span', { class: 'm-hero-mark' }, NS.icon('aurora')), h('div', { class: 'm-hero-txt' }, [
      h('h1', { class: it.n.length > 18 ? 'long' : '', text: it.n }), meta,
      h('button', { class: 'm-btn', onclick: function () {
        if (it.t === 'movie') NS.playItem(it, { start: NS.resumePos(it) });
        else NS.router.push(new MDetail(it, { autoplay: true }));
      } }, [NS.icon('play'), it.t === 'series' ? 'Spela upp serie' : 'Spela']),
      listBtn
    ])]);
    art.addEventListener('click', function () { NS.router.push(new MDetail(it)); });
    return card;
  };

  MBrowse.prototype.activate = function (first) {
    var self = this;
    this.paintHead();
    if (first) return;
    restoreY(this);
    if (NS.state.dirty) {
      NS.state.dirty = false;
      var y = this._y;
      NS.loadState().then(function () { self.load(self.page); setTimeout(function () { window.scrollTo(0, y || 0); }, 400); });
    }
  };
  MBrowse.prototype.deactivate = function () { saveY(this); };
  MBrowse.prototype.destroy = function () { window.removeEventListener('scroll', this._onScroll); };

  /* ---------------------------------------------------------------- detail */
  function MDetail(item, opts) {
    var self = this;
    this.item = item;
    this.opts = opts || {};
    this.el = h('div', { class: 'screen m-screen m-detail' });
    this.art = h('div', { class: 'm-d-art' });
    this.el.appendChild(this.art);
    this.box = h('div', { class: 'm-d-wrap' });
    this.el.appendChild(this.box);
    this.el.appendChild(h('button', { class: 'm-icon m-back', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')));
    this.render();
    NS.infoFor(item).then(function (info) {
      self.info = info;
      self.render();
      if (self.opts.autoplay) { self.opts.autoplay = false; self.play(false); return; }
      self.preview();
    }).catch(function () { /* basic info only */ });
  }

  MDetail.prototype.data = function () { return this.info ? Object.assign({}, this.item, this.info) : this.item; };

  MDetail.prototype.preview = function () {
    if (NS.router.top() !== this) return;
    var d = this.data();
    var t = d.t === 'series' ? this.target() : null;
    if (d.t === 'series' && !t) return;
    NS.preview.start(t ? Object.assign({}, t, { t: 'episode' }) : d, this.art, { delay: 1800 });
  };

  MDetail.prototype.target = function () {
    var d = this.data();
    if (!d.seasons || !d.seasons.length) return null;
    var best = null, ts = 0;
    d.seasons.forEach(function (s) { s.eps.forEach(function (e) { var p = NS.state.progress[e.k]; if (p && p.ts > ts) { best = e; ts = p.ts; } }); });
    return best || d.seasons[0].eps[0];
  };

  MDetail.prototype.play = function (restart) {
    var d = this.data();
    if (d.t === 'movie') { NS.playItem(d, { start: restart ? 0 : NS.resumePos(d) }); return; }
    var t = this.target();
    if (!t) return;
    var p = NS.state.progress[t.k];
    NS.playItem(Object.assign({}, t, { sn: d.n, bd: d.bd }), { start: restart || !p || p.upnext ? 0 : p.pos, series: d });
  };

  MDetail.prototype.render = function () {
    var self = this;
    var d = this.data();
    if (!this.artDone || (d.bd && !this.artBd)) {
      this.artDone = true;
      this.artBd = !!d.bd;
      Array.prototype.slice.call(this.art.querySelectorAll('img')).forEach(function (x) { x.remove(); });
      if (d.bd || d.img) this.art.insertBefore(NS.pic(d.bd || d.img, 'm-img' + (d.bd ? '' : ' m-contain')), this.art.firstChild);
      else this.art.style.background = NS.fallbackBg(d.n);
    }
    var box = this.box;
    box.innerHTML = '';
    var b = h('div', { class: 'm-d-body' });
    b.appendChild(h('div', { class: 'm-kind' }, [NS.icon('aurora'), NS.kindLabel(d)]));
    b.appendChild(h('h1', { text: d.n }));
    b.appendChild(h('p', { class: 'm-d-meta', text: [d.y, d.t === 'movie' && d.dur ? NS.fmtDur(d.dur) : '', d.seasons ? (d.seasons.length === 1 ? '1 säsong' : d.seasons.length + ' säsonger') : '', d.r > 0 ? '★ ' + (Math.round(d.r * 10) / 10).toFixed(1) : '', d.age || ''].filter(Boolean).join('  •  ') }));
    var label = 'Spela', sub = '', prog = 0;
    if (d.t === 'movie') {
      var pos = NS.resumePos(d);
      if (pos) { label = 'Fortsätt titta'; var pp = NS.state.progress[d.k]; if (pp) { sub = NS.left(pos, pp.dur); prog = pos / pp.dur * 100; } }
    } else {
      var t = this.target();
      if (!t) label = this.info ? 'Inga avsnitt' : 'Hämtar avsnitt…';
      else {
        var tp = NS.state.progress[t.k];
        if (tp && tp.pos > 15 && !tp.upnext) { label = 'Fortsätt'; sub = NS.epCode(t) + ' ' + t.n + (tp.dur ? '  ·  ' + NS.left(tp.pos, tp.dur) : ''); prog = tp.dur ? tp.pos / tp.dur * 100 : 0; }
        else label = t === d.seasons[0].eps[0] ? 'Spela upp serie' : 'Spela ' + NS.epCode(t);
      }
    }
    b.appendChild(h('button', { class: 'm-btn', onclick: function () { self.play(false); } }, [NS.icon('play'), label]));
    if (prog) b.appendChild(h('div', { class: 'm-d-prog' }, [NS.progEl(prog), h('span', { text: sub })]));
    var inl = NS.inList(d.k);
    var canRestart = (d.t === 'movie' && NS.resumePos(d)) || (d.t === 'series' && this.target() && NS.state.progress[this.target().k]);
    b.appendChild(h('div', { class: 'm-d-actions' }, [
      h('button', { class: 'm-act', onclick: function () { NS.toggleList(self.item).then(function () { self.render(); }); } }, [NS.icon(inl ? 'check' : 'plus'), h('span', { text: 'Min lista' })]),
      canRestart ? h('button', { class: 'm-act', onclick: function () { self.play(true); } }, [NS.icon('restart'), h('span', { text: 'Från början' })]) : null
    ]));
    if (d.p) b.appendChild(h('p', { class: 'm-d-desc', text: d.p }));
    if (d.cast) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Medverkande: ' }), d.cast]));
    if (d.dir) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Regi: ' }), d.dir]));
    if (d.g) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Genrer: ' }), d.g]));
    box.appendChild(b);

    if (d.seasons && d.seasons.length) {
      var t2 = this.target();
      if (this.season === undefined) this.season = Math.max(0, d.seasons.findIndex(function (x) { return x.eps.indexOf(t2) >= 0; }));
      var sel = h('select', { class: 'm-season', onchange: function () { self.season = +sel.value; self.render(); } });
      d.seasons.forEach(function (x, i) { var o = h('option', { value: String(i), text: x.name }); if (i === self.season) o.selected = true; sel.appendChild(o); });
      var eps = h('div', { class: 'm-eps' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Avsnitt' })), d.seasons.length > 1 ? sel : null]);
      d.seasons[this.season].eps.forEach(function (e) {
        var th = h('div', { class: 'm-ep-img', style: 'background:' + NS.fallbackBg(e.n) }, [e.img ? NS.pic(e.img, 'm-img') : null, h('span', { class: 'm-ep-play' }, NS.icon('play'))]);
        var p = NS.state.progress[e.k];
        if (p && p.dur && p.pos > 0) th.appendChild(NS.progEl(p.pos / p.dur * 100));
        eps.appendChild(h('div', { class: 'm-ep', onclick: function () {
          NS.playItem(Object.assign({}, e, { sn: d.n, bd: d.bd }), { start: NS.resumePos(e), series: d });
        } }, [h('div', { class: 'm-ep-top' }, [th, h('div', {}, [h('b', { text: e.ep + '. ' + e.n }), e.dur ? h('span', { text: NS.fmtDur(e.dur) }) : null])]),
          e.p ? h('p', { text: e.p }) : null]));
      });
      box.appendChild(eps);
    } else if (d.t === 'movie' && d.cat) {
      var more = h('div', { class: 'm-more' });
      box.appendChild(h('section', { class: 'm-row' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Mer som detta' })), more]));
      NS.api.list('movie', d.cat, 0, 30).then(function (r) {
        (r.items || []).filter(function (x) { return x.k !== d.k; }).slice(0, 18).forEach(function (x) {
          var c = poster(x);
          c.addEventListener('click', function () { NS.router.push(new MDetail(x)); });
          more.appendChild(c);
        });
      }).catch(function () {});
    }
  };

  MDetail.prototype.activate = function (first) {
    var self = this;
    if (first) { top0(); return; }
    restoreY(this);
    NS.loadState().then(function () { self.render(); self.preview(); });
  };
  MDetail.prototype.deactivate = function () { saveY(this); NS.preview.stop(); };
  MDetail.prototype.destroy = function () { NS.preview.stop(); };

  /* ---------------------------------------------------------------- search */
  function MSearch() {
    var self = this;
    this.el = h('div', { class: 'screen m-screen m-search' });
    this.input = h('input', { type: 'search', placeholder: 'Sök kanaler, filmer och serier', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')),
      h('div', { class: 'm-field' }, [NS.icon('search'), this.input])
    ])));
    this.res = h('div', { class: 'm-body' });
    this.el.appendChild(this.res);
    this.el.appendChild(tabbar('search'));
    this.input.addEventListener('input', NS.debounce(function () { self.run(); }, 300));
    this.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') self.input.blur(); });
  }
  MSearch.prototype.activate = function (first) { var i = this.input; if (first) { top0(); setTimeout(function () { i.focus(); }, 250); } else restoreY(this); };
  MSearch.prototype.deactivate = function () { saveY(this); };
  MSearch.prototype.run = function () {
    var self = this;
    var q = this.input.value.trim();
    this.res.innerHTML = '';
    if (!q) return;
    NS.api.search(q).then(function (r) {
      if (self.input.value.trim() !== q) return;
      self.res.innerHTML = '';
      if (r.live.length) self.res.appendChild(rowEl({ id: 's-live', title: 'Kanaler', kind: 'live', items: r.live }));
      [['movie', 'Filmer'], ['series', 'Serier']].forEach(function (x) {
        if (!r[x[0]].length) return;
        var grid = h('div', { class: 'm-grid' });
        r[x[0]].forEach(function (it) { var c = poster(it); c.addEventListener('click', function () { open(it); }); grid.appendChild(c); });
        self.res.appendChild(h('section', { class: 'm-row' }, [h('h2', { text: x[1] }), grid]));
      });
      if (!r.live.length && !r.movie.length && !r.series.length) self.res.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Inga träffar' }), h('p', { text: 'Inget matchar ”' + q + '”. Prova ett kortare ord.' })]));
    }).catch(function () {});
  };

  /* ---------------------------------------------------------------- "Mitt": profile, my list, settings */
  function MMe() {
    var self = this;
    this.el = h('div', { class: 'screen m-screen' });
    var p = NS.profile || { name: '?', color: '#888' };
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('h1', { class: 'm-title', text: 'Mitt ' + ((NS.status && NS.status.appName) || 'Norrsken') })])));
    var body = h('div', { class: 'm-body' });
    this.el.appendChild(body);
    this.el.appendChild(tabbar('me'));
    body.appendChild(h('div', { class: 'm-me' }, [h('span', { class: 'm-prof-av big', style: 'background:' + p.color, text: p.name.charAt(0).toUpperCase() }), h('h2', { text: p.name })]));
    var list = h('div', { class: 'm-profiles' });
    ((NS.status && NS.status.profiles) || []).forEach(function (q) {
      if (q.id === p.id) return;
      list.appendChild(h('button', { class: 'm-prof', onclick: function () {
        NS.profile = q; NS.store.set('profile', q.id);
        NS.loadState().then(function () { NS.router.reset(new MBrowse('home')); top0(); });
      } }, [h('span', { class: 'm-prof-av', style: 'background:' + q.color, text: q.name.charAt(0).toUpperCase() }), h('span', { text: 'Byt till ' + q.name })]));
    });
    if (list.childNodes.length) body.appendChild(list);
    this.rows = h('div');
    body.appendChild(this.rows);
    var st = NS.status || {};
    var c = st.counts || {};
    body.appendChild(h('div', { class: 'm-info' }, [
      h('a', { class: 'm-btn ghost', href: 'setup' }, [NS.icon('settings'), 'Inställningar']),
      h('p', { text: (c.live || 0) + ' kanaler, ' + (c.movie || 0) + ' filmer, ' + (c.series || 0) + ' serier' }),
      h('p', { text: (st.appName || 'Norrsken') + ' ' + (st.version || '') })
    ]));
    this.fill = function () {
      NS.api.page('home').then(function (res) {
        self.rows.innerHTML = '';
        (res.rows || []).filter(function (r) { return r.id === 'cw' || r.id === 'ml'; }).forEach(function (r) { self.rows.appendChild(rowEl(r)); });
      }).catch(function () {});
    };
    this.fill();
  }
  MMe.prototype.activate = function (first) { if (first) top0(); else { restoreY(this); if (NS.state.dirty) this.fill(); } };
  MMe.prototype.deactivate = function () { saveY(this); };

  NS.Browse = MBrowse;
  NS.Detail = MDetail;
  NS.Search = MSearch;
  NS.MMe = MMe;
})();
