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

  /* ---------------------------------------------------------------- browse */
  var TABS = [{ id: 'live', label: 'Live-tv' }, { id: 'movie', label: 'Filmer' }, { id: 'series', label: 'Serier' }, { id: 'mylist', label: 'Min lista' }];

  function MBrowse(page) {
    var self = this;
    this.page = page || 'home';
    this.el = h('div', { class: 'screen m-screen' });
    this.ambient = new NS.Ambient();
    this.el.appendChild(this.ambient.el);
    this.scroll = h('div', { class: 'm-scroll' });
    this.el.appendChild(this.scroll);
    var p = NS.profile || { name: '?', color: '#888' };
    this.pills = TABS.map(function (t) {
      return h('button', { class: 'm-pill', onclick: function () { self.load(self.page === t.id ? 'home' : t.id); } }, t.label);
    });
    this.head = h('header', { class: 'm-head' }, [
      h('div', { class: 'm-bar' }, [
        h('div', { class: 'm-brand' }, [NS.icon('aurora'), h('span', { text: (NS.status && NS.status.appName) || 'Norrsken' })]),
        h('button', { class: 'm-icon', 'aria-label': 'Sök', onclick: function () { NS.router.push(new MSearch()); } }, NS.icon('search')),
        h('button', { class: 'm-avatar', style: 'background:' + p.color, 'aria-label': 'Profil', onclick: function () { NS.router.push(new MProfile()); } }, p.name.charAt(0).toUpperCase())
      ]),
      h('nav', { class: 'm-pills' }, this.pills)
    ]);
    this.scroll.appendChild(this.head);
    this.body = h('div', { class: 'm-body' });
    this.scroll.appendChild(this.body);
    this.scroll.addEventListener('scroll', function () { self.head.classList.toggle('solid', self.scroll.scrollTop > 10); }, { passive: true });
    this.load(this.page);
  }

  MBrowse.prototype.load = function (page) {
    var self = this;
    this.page = page;
    this.pills.forEach(function (b, i) { b.classList.toggle('on', TABS[i].id === page); });
    var tok = this._tok = {};
    this.body.innerHTML = '';
    this.body.appendChild(h('div', { class: 'm-loading' }, h('div', { class: 'spinner' })));
    NS.api.page(page).then(function (res) {
      if (tok !== self._tok) return;
      self.body.innerHTML = '';
      self.scroll.scrollTop = 0;
      var feat = res.featured || [];
      if (feat.length && page !== 'live' && page !== 'mylist') self.body.appendChild(self.hero(feat[Math.floor(Math.random() * Math.min(6, feat.length))]));
      (res.rows || []).forEach(function (r) {
        r.showCount = page !== 'home' && !!r.cat;
        if (r.grid) r.title = r.title || '';
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
    var self = this;
    var art = h('div', { class: 'm-hero-art' });
    var img = it.img || it.bd;
    if (img) art.appendChild(NS.pic(img, 'm-img'));
    else art.style.background = NS.fallbackBg(it.n);
    this.ambient.follow(it);
    var inl = NS.inList(it.k);
    var listBtn = h('button', { class: 'm-btn ghost', onclick: function () {
      NS.toggleList(it).then(function (on) { listBtn.innerHTML = ''; listBtn.appendChild(NS.icon(on ? 'check' : 'plus')); listBtn.appendChild(document.createTextNode('Min lista')); });
    } }, [NS.icon(inl ? 'check' : 'plus'), 'Min lista']);
    var meta = h('p', { class: 'm-hero-meta', text: [it.g && it.g.split(/[,/]/)[0].trim(), it.y, it.r > 0 ? '★ ' + (Math.round(it.r * 10) / 10).toFixed(1) : ''].filter(Boolean).join('  •  ') });
    var card = h('div', { class: 'm-hero' }, [art, h('div', { class: 'm-hero-txt' }, [
      h('h1', { text: it.n }), meta,
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
    if (!first && NS.state.dirty) {
      NS.state.dirty = false;
      var y = this.scroll.scrollTop;
      NS.loadState().then(function () { self.load(self.page); setTimeout(function () { self.scroll.scrollTop = y; }, 300); });
    }
  };

  /* ---------------------------------------------------------------- detail */
  function MDetail(item, opts) {
    var self = this;
    this.item = item;
    this.opts = opts || {};
    this.el = h('div', { class: 'screen m-screen m-detail' });
    this.scroll = h('div', { class: 'm-scroll' });
    this.el.appendChild(this.scroll);
    this.el.appendChild(h('button', { class: 'm-icon m-back', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')));
    this.render();
    NS.infoFor(item).then(function (info) {
      self.info = info;
      self.render();
      if (self.opts.autoplay) { self.opts.autoplay = false; self.play(false); }
    }).catch(function () { /* basic info only */ });
  }

  MDetail.prototype.data = function () { return this.info ? Object.assign({}, this.item, this.info) : this.item; };

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
    var s = this.scroll;
    var keep = s.scrollTop;
    s.innerHTML = '';
    var art = h('div', { class: 'm-d-art' });
    if (d.bd || d.img) art.appendChild(NS.pic(d.bd || d.img, 'm-img' + (d.bd ? '' : ' m-contain')));
    else art.style.background = NS.fallbackBg(d.n);
    s.appendChild(art);
    var box = h('div', { class: 'm-d-body' });
    box.appendChild(h('h1', { text: d.n }));
    box.appendChild(h('p', { class: 'm-d-meta', text: [d.y, d.t === 'movie' && d.dur ? NS.fmtDur(d.dur) : '', d.seasons ? (d.seasons.length === 1 ? '1 säsong' : d.seasons.length + ' säsonger') : '', d.r > 0 ? '★ ' + (Math.round(d.r * 10) / 10).toFixed(1) : '', d.g ? d.g.split(/[,/]/)[0].trim() : ''].filter(Boolean).join('  •  ') }));
    var label = 'Spela', sub = '';
    if (d.t === 'movie') {
      var pos = NS.resumePos(d);
      if (pos) { label = 'Fortsätt titta'; var pp = NS.state.progress[d.k]; sub = pp ? NS.left(pos, pp.dur) : ''; }
    } else {
      var t = this.target();
      if (!t) label = this.info ? 'Inga avsnitt' : 'Hämtar avsnitt…';
      else {
        var tp = NS.state.progress[t.k];
        label = tp && tp.pos > 15 && !tp.upnext ? 'Fortsätt ' + NS.epCode(t) : (t === d.seasons[0].eps[0] ? 'Spela upp serie' : 'Spela ' + NS.epCode(t));
      }
    }
    box.appendChild(h('button', { class: 'm-btn wide', onclick: function () { self.play(false); } }, [NS.icon('play'), label]));
    if (sub) box.appendChild(h('p', { class: 'm-d-sub', text: sub }));
    var inl = NS.inList(d.k);
    var row = h('div', { class: 'm-d-actions' }, [
      h('button', { class: 'm-act', onclick: function () { NS.toggleList(self.item).then(function () { self.render(); }); } }, [NS.icon(inl ? 'check' : 'plus'), h('span', { text: 'Min lista' })]),
      (d.t === 'movie' && NS.resumePos(d)) || (d.t === 'series' && this.target() && NS.state.progress[this.target().k]) ? h('button', { class: 'm-act', onclick: function () { self.play(true); } }, [NS.icon('restart'), h('span', { text: 'Från början' })]) : null
    ]);
    box.appendChild(row);
    if (d.p) box.appendChild(h('p', { class: 'm-d-desc', text: d.p }));
    if (d.cast) box.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Medverkande: ' }), d.cast]));
    if (d.dir) box.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Regi: ' }), d.dir]));
    s.appendChild(box);

    if (d.seasons && d.seasons.length) {
      var t2 = this.target();
      if (this.season === undefined) this.season = Math.max(0, d.seasons.findIndex(function (x) { return x.eps.indexOf(t2) >= 0; }));
      var sel = h('select', { class: 'm-season', onchange: function () { self.season = +sel.value; self.render(); } });
      d.seasons.forEach(function (x, i) { var o = h('option', { value: String(i), text: x.name }); if (i === self.season) o.selected = true; sel.appendChild(o); });
      var eps = h('div', { class: 'm-eps' }, d.seasons.length > 1 ? sel : h('h2', { text: 'Avsnitt' }));
      d.seasons[this.season].eps.forEach(function (e) {
        var th = h('div', { class: 'm-ep-img', style: 'background:' + NS.fallbackBg(e.n) }, [e.img ? NS.pic(e.img, 'm-img') : null, h('span', { class: 'm-ep-play' }, NS.icon('play'))]);
        var p = NS.state.progress[e.k];
        if (p && p.dur && p.pos > 0) th.appendChild(NS.progEl(p.pos / p.dur * 100));
        var ep = h('div', { class: 'm-ep', onclick: function () {
          NS.playItem(Object.assign({}, e, { sn: d.n, bd: d.bd }), { start: NS.resumePos(e), series: d });
        } }, [h('div', { class: 'm-ep-top' }, [th, h('div', {}, [h('b', { text: e.ep + '. ' + e.n }), e.dur ? h('span', { text: NS.fmtDur(e.dur) }) : null])]),
          e.p ? h('p', { text: e.p }) : null]);
        eps.appendChild(ep);
      });
      s.appendChild(eps);
    } else if (d.t === 'movie' && d.cat) {
      var more = h('div', { class: 'm-more' });
      s.appendChild(h('section', { class: 'm-row' }, [h('h2', { text: 'Mer som detta' }), more]));
      NS.api.list('movie', d.cat, 0, 30).then(function (r) {
        (r.items || []).filter(function (x) { return x.k !== d.k; }).slice(0, 18).forEach(function (x) {
          var c = poster(x);
          c.addEventListener('click', function () { NS.router.push(new MDetail(x)); });
          more.appendChild(c);
        });
      }).catch(function () {});
    }
    s.scrollTop = keep;
  };

  MDetail.prototype.activate = function (first) {
    var self = this;
    if (first) return;
    NS.loadState().then(function () { self.render(); });
  };

  /* ---------------------------------------------------------------- search */
  function MSearch() {
    var self = this;
    this.el = h('div', { class: 'screen m-screen m-search' });
    this.input = h('input', { type: 'search', placeholder: 'Sök kanaler, filmer och serier', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')),
      h('div', { class: 'm-field' }, [NS.icon('search'), this.input])
    ])));
    this.scroll = h('div', { class: 'm-scroll m-under-head' });
    this.el.appendChild(this.scroll);
    this.input.addEventListener('input', NS.debounce(function () { self.run(); }, 300));
    this.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') self.input.blur(); });
  }
  MSearch.prototype.activate = function (first) { var i = this.input; if (first) setTimeout(function () { i.focus(); }, 250); };
  MSearch.prototype.run = function () {
    var self = this;
    var q = this.input.value.trim();
    this.scroll.innerHTML = '';
    if (!q) return;
    NS.api.search(q).then(function (r) {
      if (self.input.value.trim() !== q) return;
      self.scroll.innerHTML = '';
      if (r.live.length) self.scroll.appendChild(rowEl({ id: 's-live', title: 'Kanaler', kind: 'live', items: r.live }));
      [['movie', 'Filmer'], ['series', 'Serier']].forEach(function (x) {
        if (!r[x[0]].length) return;
        var grid = h('div', { class: 'm-grid' });
        r[x[0]].forEach(function (it) { var c = poster(it); c.addEventListener('click', function () { open(it); }); grid.appendChild(c); });
        self.scroll.appendChild(h('section', { class: 'm-row' }, [h('h2', { text: x[1] }), grid]));
      });
      if (!r.live.length && !r.movie.length && !r.series.length) self.scroll.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Inga träffar' }), h('p', { text: 'Inget matchar ”' + q + '”. Prova ett kortare ord.' })]));
    }).catch(function () {});
  };

  /* ---------------------------------------------------------------- profile & settings */
  function MProfile() {
    this.el = h('div', { class: 'screen m-screen' });
    var sc = h('div', { class: 'm-scroll m-under-head' });
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')), h('div', { class: 'm-brand' }, h('span', { text: 'Profiler' }))])));
    this.el.appendChild(sc);
    var list = h('div', { class: 'm-profiles' });
    ((NS.status && NS.status.profiles) || []).forEach(function (p) {
      list.appendChild(h('button', { class: 'm-prof' + (NS.profile && NS.profile.id === p.id ? ' on' : ''), onclick: function () {
        NS.profile = p; NS.store.set('profile', p.id);
        NS.loadState().then(function () { NS.router.reset(new MBrowse('home')); try { history.replaceState(null, ''); } catch (e) { /* ignore */ } });
      } }, [h('span', { class: 'm-prof-av', style: 'background:' + p.color, text: p.name.charAt(0).toUpperCase() }), h('span', { text: p.name }), p.kids ? h('small', { text: 'Barn' }) : null]));
    });
    sc.appendChild(list);
    var st = NS.status || {};
    var c = st.counts || {};
    sc.appendChild(h('div', { class: 'm-info' }, [
      h('a', { class: 'm-btn wide ghost', href: 'setup' }, [NS.icon('settings'), 'Inställningar']),
      h('p', { text: (c.live || 0) + ' kanaler, ' + (c.movie || 0) + ' filmer, ' + (c.series || 0) + ' serier' }),
      h('p', { text: (st.appName || 'Norrsken') + ' ' + (st.version || '') })
    ]));
  }

  NS.Browse = MBrowse;
  NS.Detail = MDetail;
  NS.Search = MSearch;
  NS.MProfile = MProfile;
})();
