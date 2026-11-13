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
    if (it.q === '4K') f.appendChild(h('span', { class: 'm-q', text: '4K' }));
    if (it.t === 'ext' && it.svc) f.appendChild(NS.svcChips(it.svc.slice(0, 2), 'on-card'));
    c.appendChild(f);
    if (opts.caption) c.appendChild(h('div', { class: 'm-cap', text: opts.caption }));
    return c;
  }

  var liveCards = {};
  function liveCard(it) {
    if (it.mt && it.mt.sides) { // a favourite team's match: the teams, not the channel's logo
      var mt = it.mt, onNow = Date.now() >= mt.s;
      var c1 = (mt.sides[0].col || mt.col || ['#333'])[0], c2 = (mt.sides[1].col || ['#222'])[0];
      var mf = h('div', { class: 'm-frame m-mcard', style: 'background: radial-gradient(90% 120% at 0% 0%, ' + NS.rgba(c1, 0.7) + ', transparent 62%), radial-gradient(90% 120% at 100% 100%, ' + NS.rgba(c2, 0.55) + ', transparent 62%), #18181a' }, [
        h('span', { class: 'm-livetag' + (onNow ? '' : ' when'), text: onNow ? 'LIVE' : NS.matchWhen(mt.s) }),
        h('div', { class: 'm-mvs' }, [NS.teamBadge(mt.sides[0], 'm-vs-b'), h('i', { text: '–' }), NS.teamBadge(mt.sides[1], 'm-vs-b')])
      ]);
      var mc = h('div', { class: 'm-card m-live' }, [mf, h('div', { class: 'm-now' }, [h('b', { text: mt.t }), h('span', { text: [mt.comp, it.n].filter(Boolean).join(' · ') })])]);
      mc._it = it;
      return mc;
    }
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
    if (c._it.mt) { // a favourite team's match: which match and when, then the channel
      c._now.appendChild(h('b', { text: c._it.mt.t }));
      c._now.appendChild(h('span', { text: (Date.now() >= c._it.mt.s ? 'Live nu' : NS.matchWhen(c._it.mt.s)) + ' · ' + c._it.n }));
      return;
    }
    c._now.appendChild(h('b', { text: (c._it.num ? c._it.num + '  ' : '') + c._it.n }));
    if (e && e.now) {
      c._now.appendChild(h('span', { text: e.now.t }));
      c._now.appendChild(NS.progEl(NS.livePct(e.now)));
    }
  }
  document.addEventListener('nsk-epg', function (ev) {
    (ev.detail || []).forEach(function (id) { (liveCards[id] || []).forEach(function (c) { if (c.isConnected) paintLive(c); }); });
  });

  /** Long-press (or the ⋯ button) opens the same quick menu as the TV's options key. */
  function longPress(el, fn) {
    var t = null, fired = false, sx = 0, sy = 0;
    el.addEventListener('touchstart', function (e) { fired = false; var p = e.touches[0]; sx = p.clientX; sy = p.clientY; t = setTimeout(function () { fired = true; if (navigator.vibrate) navigator.vibrate(12); fn(); }, 520); }, { passive: true });
    el.addEventListener('touchmove', function (e) { var p = e.touches[0]; if (Math.abs(p.clientX - sx) + Math.abs(p.clientY - sy) > 10) clearTimeout(t); }, { passive: true });
    el.addEventListener('touchend', function () { clearTimeout(t); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); fired = true; fn(); });
    el.addEventListener('click', function (e) { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  }
  NS.mLongPress = longPress;

  function open(it, row) {
    if (it.t === 'ext') { NS.router.push(new MExtDetail(it)); return; }
    if (it.mt) { NS.openMatchCard(it); return; }
    if (it.t === 'live') { NS.playItem(it, { list: (row && row.items) || [it], cat: (row && row.cat) || null }); return; }
    if (row && row.id === 'cw') { NS.playItem(it, { start: it.upnext ? 0 : it.pos || 0 }); return; }
    if (it.t === 'episode') { NS.playItem(it, { start: NS.resumePos(it) }); return; }
    NS.router.push(new MDetail(it));
  }

  /** A horizontally scrolling row that loads more items as you swipe. */
  function rowEl(def) {
    if (def.kind === 'pill') {
      return h('section', { class: 'm-row' }, h('div', { class: 'm-chips' }, (def.items || []).map(function (c) {
        return h('button', { class: 'm-chip', onclick: function () { NS.router.push(new MGrid(c.type, c.id, c.label)); } }, c.label);
      })));
    }
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
        longPress(c, function () { NS.cardMenu(it, def.id).then(function (changed) { if (changed) { NS.state.dirty = true; var top = NS.router.top(); if (top && top.refresh) top.refresh(); } }); });
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
    var head = null;
    if (def.title) {
      var canGrid = def.cat && def.type && def.type !== 'live';
      head = h('h2', canGrid ? { class: 'm-h2-link', onclick: function () { NS.router.push(new MGrid(def.type, def.cat, def.title)); } } : {},
        [def.title, def.showCount ? h('span', { text: ' ' + total }) : null, canGrid ? h('i', { class: 'm-chev' }, NS.icon('right')) : null]);
    }
    return h('section', { class: 'm-row' }, [head, track]);
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
      } }, [lead, h('span', { text: t.id === 'me' ? 'Min sida' : t.label })]);
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
    this.pillsEl.style.display = page === 'live' ? 'none' : '';
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
    if (page === 'live') { this.loadLive(tok); return; }
    NS.api.page(page).then(function (res) {
      if (tok !== self._tok) return;
      self.body.innerHTML = '';
      var feat = res.featured || [];
      if (res.sport && res.sport.ch) self.body.appendChild(sportCard(res.sport));
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

  /** Live-tv on the phone: category chips and a vertical channel list with what is on now (like a compact guide). */
  MBrowse.prototype.loadLive = function (tok) {
    var self = this;
    NS.api.cats('live').then(function (r) {
      if (tok !== self._tok) return;
      var cats = [{ id: 'fav', name: '★ Favoriter' }].concat((Array.isArray(r) ? r : r.cats || []).map(function (c) { return { id: c.id, name: c.name || c.n }; }));
      var cur = NS.store.get(NS.pkey('mLiveCat'), null);
      var favs = Object.keys(NS.state.myList || {}).filter(function (k) { return k.indexOf('l:') === 0; });
      if (!cur || !cats.some(function (c) { return c.id === cur; })) cur = favs.length ? 'fav' : (cats[1] && cats[1].id);
      self.body.innerHTML = '';
      var chips = h('div', { class: 'm-chips m-live-cats' });
      var list = h('div', { class: 'm-chlist' });
      var spot = h('div');
      self.body.appendChild(spot);
      NS.api.get('api/sport').then(function (r) {
        if (tok !== self._tok) return;
        if (r.match && r.match.ch) spot.appendChild(sportCard(r.match));
        var ml = matchList((r.upcoming || []).filter(function (m) { return !(r.match && r.match.ch && m.s === r.match.s && m.title === r.match.title); })); // the one in the card above is not listed again
        if (ml) spot.appendChild(ml);
      }).catch(function () {});
      self.body.appendChild(chips);
      self.body.appendChild(list);
      var show = function (id) {
        cur = id;
        NS.store.set(NS.pkey('mLiveCat'), id);
        Array.prototype.forEach.call(chips.children, function (b) { b.classList.toggle('on', b._id === id); });
        list.innerHTML = '';
        list.appendChild(h('div', { class: 'm-loading' }, h('div', { class: 'spinner' })));
        var get = id === 'fav'
          ? NS.api.page('live').then(function (pg) { var f = (pg.rows || []).filter(function (x) { return x.id === 'fav'; })[0]; return { items: f ? f.items : [] }; })
          : NS.api.list('live', id, 0, 3000);
        get.then(function (res) {
          if (cur !== id) return;
          list.innerHTML = '';
          var items = res.items || [];
          if (!items.length) list.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: id === 'fav' ? 'Inga favoriter än' : 'Inga kanaler' }), h('p', { text: id === 'fav' ? 'Tryck på stjärnan vid en kanal för att spara den här.' : '' })]));
          items.forEach(function (it) { list.appendChild(chanRow(it, items, id)); });
          NS.needEpg(items.slice(0, 80).map(function (x) { return x.id; }));
        }).catch(function () { list.innerHTML = ''; });
      };
      cats.forEach(function (c) { var b = h('button', { class: 'm-chip', onclick: function () { show(c.id); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); } }, c.name); b._id = c.id; chips.appendChild(b); });
      if (cur) show(cur);
    }).catch(function () { self.body.innerHTML = ''; });
  };
  var chanRows = {};
  function chanRow(it, items, cat) {
    var logo = h('div', { class: 'm-ch-logo', style: 'background:' + NS.rgba(NS.hueColor(it.n), 0.35) });
    if (it.img) logo.appendChild(NS.pic(it.img, 'm-logo', function () { logo.textContent = it.n.slice(0, 3); }));
    else logo.textContent = it.n.slice(0, 3);
    var info = h('div', { class: 'm-ch-info' });
    var fav = NS.inList(it.k);
    var star = h('button', { class: 'm-star' + (fav ? ' on' : ''), 'aria-label': 'Favorit', onclick: function (e) {
      e.stopPropagation();
      NS.toggleList(it).then(function (on) { star.classList.toggle('on', !!on); star.textContent = on ? '★' : '☆'; NS.state.dirty = true; });
    }, text: fav ? '★' : '☆' });
    var more = h('button', { class: 'm-star m-chmore', 'aria-label': 'Tablå', onclick: function (e) { e.stopPropagation(); NS.router.push(new MChannel(it, items)); } }, NS.icon('right'));
    var row = h('div', { class: 'm-ch', onclick: function () { NS.playItem(it, { list: items, cat: cat === 'fav' ? null : cat }); } }, [logo, info, star, more]);
    row._it = it; row._info = info;
    paintChan(row);
    (chanRows[it.id] = chanRows[it.id] || []).push(row);
    longPress(row, function () { NS.cardMenu(it, 'live'); });
    return row;
  }
  function paintChan(row) {
    var it = row._it, e = NS.epgFor(it.id);
    row._info.innerHTML = '';
    var qb = /\b(4K|UHD)\b/i.test(it.n) ? '4K' : /\b(FHD|HD|1080)\b/i.test(it.n) ? 'HD' : /\bSD\b/i.test(it.n) ? 'SD' : '';
    row._info.appendChild(h('b', {}, [(it.num ? it.num + '  ' : '') + it.n, qb ? h('span', { class: 'm-qb ' + qb.toLowerCase(), text: qb }) : null]));
    if (e && e.now) {
      row._info.appendChild(h('span', { class: 'm-ch-now', text: NS.fmtClock(e.now.s) + '  ' + e.now.t }));
      row._info.appendChild(NS.progEl(NS.livePct(e.now)));
      if (e.next) row._info.appendChild(h('span', { class: 'm-ch-next', text: NS.fmtClock(e.next.s) + '  ' + e.next.t }));
    }
  }
  document.addEventListener('nsk-epg', function (ev) {
    (ev.detail || []).forEach(function (id) { (chanRows[id] || []).forEach(function (r) { if (r.isConnected) paintChan(r); }); });
  });

  /** One channel's schedule: watch live, replay earlier programmes (catch-up), get reminded of later ones. */
  function MChannel(ch, list) {
    var self = this;
    this.ch = ch; this.list = list || [ch];
    this.el = h('div', { class: 'screen m-screen m-chan' });
    var logo = h('div', { class: 'm-ch-logo big', style: 'background:' + NS.rgba(NS.hueColor(ch.n), 0.35) });
    if (ch.img) logo.appendChild(NS.pic(ch.img, 'm-logo')); else logo.textContent = ch.n.slice(0, 3);
    this.el.appendChild(h('header', { class: 'm-head solid' }, [h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')),
      h('h1', { class: 'm-title small', text: ch.n })]), this.days = h('nav', { class: 'm-chips' })]));
    var body = h('div', { class: 'm-body' });
    body.appendChild(h('div', { class: 'm-chan-top' }, [logo, h('button', { class: 'm-btn', onclick: function () { NS.playItem(ch, { list: self.list, cat: ch.cat }); } }, [NS.icon('play'), 'Titta live'])]));
    this.listEl = h('div', { class: 'm-progs' });
    body.appendChild(this.listEl);
    this.el.appendChild(body);
    this.el.appendChild(tabbar('live'));
    this.listEl.appendChild(h('div', { class: 'm-loading' }, h('div', { class: 'spinner' })));
    NS.api.guide(ch.id, 30, ch.arc ? Math.min(72, ch.arc * 24) : 2).then(function (progs) {
      self.progs = (progs || []).filter(function (p) { return p.e > p.s; });
      var dayOf = function (t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
      var today = dayOf(Date.now());
      var days = [];
      self.progs.forEach(function (p) { var d = dayOf(p.s); if (days.indexOf(d) < 0) days.push(d); });
      var label = function (d) { var n = Math.round((d - today) / 86400e3); return n === 0 ? 'I dag' : n === -1 ? 'I går' : n === 1 ? 'I morgon' : new Date(d).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric' }); };
      self.day = days.indexOf(today) >= 0 ? today : days[0];
      var paintDays = function () {
        self.days.innerHTML = '';
        days.forEach(function (d) { self.days.appendChild(h('button', { class: 'm-chip' + (d === self.day ? ' on' : ''), onclick: function () { self.day = d; paintDays(); self.paint(); } }, label(d))); });
      };
      paintDays();
      self.paint();
    }).catch(function () { self.listEl.innerHTML = ''; self.listEl.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Ingen tablå' }), h('p', { text: 'Kanalen saknar tv-guide.' })])); });
  }
  MChannel.prototype.paint = function () {
    var self = this, ch = this.ch, now = Date.now();
    var d0 = this.day, d1 = d0 + 86400e3;
    var list = (this.progs || []).filter(function (p) { return p.s < d1 && p.e > d0; });
    this.listEl.innerHTML = '';
    if (!list.length) { this.listEl.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Ingen tablå' })])); return; }
    var nowEl = null;
    list.forEach(function (p) {
      var live = p.s <= now && p.e > now, past = p.e <= now, arc = past && NS.canArc && NS.canArc(ch, p);
      var rem = !past && !live && NS.hasReminder(ch.id, p.s);
      var act = live ? h('span', { class: 'm-pact live', text: 'Live' }) : arc ? h('span', { class: 'm-pact' }, NS.icon('archive')) : !past ? h('span', { class: 'm-pact bell' + (rem ? ' on' : '') }, NS.icon('bell')) : null;
      var row = h('div', { class: 'm-prog' + (past && !arc ? ' past' : '') + (live ? ' now' : ''), onclick: function () {
        if (live) NS.playItem(ch, { list: self.list, cat: ch.cat });
        else if (arc) NS.playItem(NS.catchupItem(ch, p, self.list));
        else if (!past) { NS.toggleReminder(ch, p); self.paint(); }
        else NS.toast('Programmet finns inte i arkivet', 'info');
      } }, [h('span', { class: 'm-ptime', text: NS.fmtClock(p.s) }), h('div', { class: 'm-ptxt' }, [h('b', { text: p.t }), live ? NS.progEl(NS.livePct(p)) : null, p.d ? h('p', { text: p.d }) : null]), act]);
      if (live) nowEl = row;
      self.listEl.appendChild(row);
    });
    if (nowEl) setTimeout(function () { window.scrollTo(0, Math.max(0, nowEl.getBoundingClientRect().top + window.scrollY - 200)); }, 50);
  };
  MChannel.prototype.activate = function (first) { if (first) top0(); else restoreY(this); };
  MChannel.prototype.deactivate = function () { saveY(this); };

  /** The favourite team's match on top of the start page: tap to switch to the channel. */
  function sportCard(m) {
    var live = m.state === 'live';
    var c = (m.team.col || ['#c8102e'])[0];
    var logo = h('span', { class: 'm-sport-logo' });
    if (m.ch.img) logo.appendChild(NS.pic(m.ch.img, '', function () { logo.remove(); }));
    var go = function () { NS.watchMatch(m, m.chans || [m.ch], m.ch.cat); };
    var rec = !!(m.rec && m.rec.id);
    var rem = m.state === 'soon' && NS.hasReminder(m.ch.id, m.s);
    var liveRec = live && rec ? h('button', { class: 'm-btn ghost', onclick: function (e) { e.stopPropagation(); NS.watchRec(m, true); } }, [NS.icon('live'), 'Titta live']) : null;
    var second = liveRec || (live || m.state === 'ended' ? null : h('button', { class: 'm-btn ghost', onclick: function (e) {
      e.stopPropagation();
      var on = NS.toggleReminder(m.ch, { s: m.s, t: m.title });
      second.innerHTML = ''; second.appendChild(NS.icon(on ? 'check' : 'bell')); second.appendChild(document.createTextNode(on ? 'Påminnelse satt' : 'Påminn mig'));
    } }, [NS.icon(rem ? 'check' : 'bell'), rem ? 'Påminnelse satt' : 'Påminn mig']));
    // each team: a round badge in its colours with its initials, and its name
    var badge = function (t) {
      var c1 = (t.col && t.col[0]) || '#444', c2 = (t.col && t.col[1]) || '#fff';
      // the club's own abbreviation (LHF, FBK…); the user's crest picture when one is there
      var ini = t.ab || t.n.slice(0, 3).toUpperCase();
      var b = t.img ? h('span', { class: 'm-vs-b img' }, NS.pic(t.img, '', function () { b.className = 'm-vs-b'; b.textContent = ini; b.style.cssText = 'background:' + c1 + ';box-shadow:inset 0 0 0 3px ' + c2; }))
        : h('span', { class: 'm-vs-b' + (ini.length > 3 ? ' sm' : ''), style: 'background:' + c1 + ';box-shadow:inset 0 0 0 3px ' + c2, text: ini });
      return h('div', { class: 'm-vs-t' }, [b, h('b', { text: t.n })]);
    };
    var stopB = rec && m.rec.recording ? h('button', { class: 'm-btn ghost', onclick: function (e) { e.stopPropagation(); NS.stopMatchRec(null, function () { stopB.remove(); }); } }, [NS.icon('x'), 'Avbryt inspelning']) : null;
    var oc = m.sides && m.sides.map(function (x) { return x.col && x.col[0]; }).filter(function (x) { return x && x.toLowerCase() !== c.toLowerCase(); })[0];
    var el = h('section', { class: 'm-sport' + (live ? ' live' : ''), style: 'background:radial-gradient(90% 140% at 100% 0%, ' + c + 'bb 0%, ' + c + '22 55%, transparent 80%)' + (oc ? ', radial-gradient(80% 130% at 0% 100%, ' + oc + '88 0%, ' + oc + '18 55%, transparent 80%)' : '') + ', #121318' }, [
      h('div', { class: 'm-sport-top' }, [live ? h('span', { class: 'live-pill', text: 'Live nu' }) : h('span', { class: 'soon-pill', text: m.state === 'ended' ? 'Slut' : 'Börjar ' + NS.fmtClock(m.s) }), h('span', { text: m.label || m.team.name })]),
      m.sides ? h('div', { class: 'm-vs' }, [badge(m.sides[0]), h('span', { class: 'm-vs-x', text: '–' }), badge(m.sides[1])]) : h('h2', { text: m.title }),
      h('div', { class: 'm-sport-meta' }, [logo, h('span', { text: (m.chName || m.ch.n) + '  ·  ' + NS.fmtClock(m.s) + '–' + NS.fmtClock(m.e) })]),
      m.recWait ? h('div', { class: 'm-sport-wait', text: m.recWait }) : null,
      live ? NS.progEl(NS.livePct(m)) : null,
      h('div', { class: 'm-sport-btns' }, [h('button', { class: 'm-btn', onclick: function (e) { e.stopPropagation(); go(); } }, [NS.icon('play'), live ? (rec ? 'Från start' : 'Titta nu') : m.state === 'ended' ? (rec ? 'Från start' : 'Tv-guide') : 'Från start']), second, stopB])
    ]);
    el.addEventListener('click', go);
    return el;
  }
  NS.mSportCard = sportCard;
  /** The favourite teams' coming matches (every league and cup the TV guide has): day, time, teams, channel. */
  function matchList(list) {
    if (!list.length) return null;
    var el = h('section', { class: 'm-matches' }, h('h3', { text: 'Dina lags matcher' }));
    var rowOf = function (m) {
      var live = Date.now() >= m.s;
      var w = NS.matchWhen(m.s).split(' ');
      var clock = w.pop();
      return h('button', { class: 'm-match', onclick: function () { NS.watchMatch(m, m.chans || [m.ch], m.ch.cat); } }, [
        h('span', { class: 'when' }, live ? h('span', { class: 'live-pill', text: 'Live' }) : [w.join(' '), h('b', { text: clock })]),
        m.sides ? h('span', { class: 'm-match-b' }, [NS.teamBadge(m.sides[0], 'm-vs-b'), NS.teamBadge(m.sides[1], 'm-vs-b')]) : null,
        h('span', { class: 'what' }, [h('b', { text: m.title }), h('span', { text: [m.label, m.chName || m.ch.n].filter(Boolean).join(' · ') })])
      ]);
    };
    list.slice(0, 5).forEach(function (m) { el.appendChild(rowOf(m)); });
    if (list.length > 5) {
      var more = h('button', { class: 'm-match-more', text: 'Visa alla ' + list.length, onclick: function () { more.remove(); list.slice(5).forEach(function (m) { el.appendChild(rowOf(m)); }); } });
      el.appendChild(more);
    }
    return el;
  }

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
      h('div', { class: 'm-hero-btns' }, [h('button', { class: 'm-btn', onclick: function () {
        if (it.t === 'movie') NS.playItem(it, { start: NS.resumePos(it) });
        else NS.router.push(new MDetail(it, { autoplay: true }));
      } }, [NS.icon('play'), 'Spela']),
      listBtn])
    ])]);
    art.addEventListener('click', function () { NS.router.push(new MDetail(it)); });
    return card;
  };

  MBrowse.prototype.refresh = function () { var y = window.scrollY; var self = this; NS.loadState().then(function () { self.load(self.page); setTimeout(function () { window.scrollTo(0, y); }, 400); }); };

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

  /* ---------------------------------------------------------------- downloads */
  /** A download button for a film/episode that follows its state. mode 'act' = labelled action, else a round icon. */
  function dlControl(scr, it, extraFn, mode) {
    var kind = it.t === 'episode' ? 'episode' : 'movie';
    var el = h('button', { class: mode === 'act' ? 'm-act' : 'm-ep-dl', 'aria-label': 'Ladda ner' });
    var paint = function () {
      var x = NS.dl.get(kind, extraFn().id);
      el.innerHTML = '';
      el.classList.toggle('on', !!x && x.status === 'done');
      el.appendChild(NS.dl.badge(x));
      if (mode === 'act') el.appendChild(h('span', { text: !x ? 'Ladda ner' : x.status === 'done' ? 'Nedladdad' : x.status === 'downloading' ? Math.round(x.pct) + '%' : x.status === 'queued' ? 'I kö' : 'Försök igen' }));
    };
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var x = NS.dl.get(kind, extraFn().id);
      if (NS.preview && NS.preview.stop) NS.preview.stop(); // the trailer holds the provider's connection
      if (x && x.status === 'error') NS.dl.retry(x); else NS.dl.tap(it, extraFn());
    });
    paint();
    scr.dlPaint.push(paint);
    return el;
  }

  /* ---------------------------------------------------------------- detail */
  function MDetail(item, opts) {
    var self = this;
    this.item = item;
    this.opts = opts || {};
    this.dlPaint = [];
    this._unDl = NS.dl.onChange(function () { self.dlPaint.forEach(function (f) { f(); }); });
    this.el = h('div', { class: 'screen m-screen m-detail' });
    this.art = h('div', { class: 'm-d-art' });
    this.el.appendChild(this.art);
    this.box = h('div', { class: 'm-d-wrap' });
    this.el.appendChild(this.box);
    // a slim bar with the back button that turns solid (with the title) once you scroll past the picture
    this.dtitle = h('span', { class: 'm-dhead-t', text: item.n });
    this.dhead = h('header', { class: 'm-dhead' }, [h('button', { class: 'm-icon m-back', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')), this.dtitle]);
    this.el.appendChild(this.dhead);
    this._onScroll = function () { if (NS.router.top() === self) self.dhead.classList.toggle('solid', (window.scrollY || 0) > 160); };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this.render();
    NS.infoFor(item).then(function (info) {
      self.info = info;
      self.render();
      if (info.tmdb && NS.svc.enabled && !(NS.profile && NS.profile.kids)) {
        NS.api.get('api/services/where/' + (item.t === 'series' ? 'tv' : 'movie') + '/' + info.tmdb).then(function (r) {
          if (r.svc && r.svc.length) { self.svcWhere = r.svc; self.render(); }
        }).catch(function () {});
        NS.api.get('api/extras/' + (item.t === 'series' ? 'tv' : 'movie') + '/' + info.tmdb).then(function (x) {
          if (x && ((x.cast && x.cast.length) || (x.videos && x.videos.length))) { self.extras = x; self.render(); }
        }).catch(function () {});
      }
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
    if (d.t === 'movie') { NS.playItem(this.ver ? Object.assign({}, d, { vid: this.ver.id, ext: this.ver.ext || d.ext }) : d, { start: restart ? 0 : NS.resumePos(d) }); return; }
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
    this.dlPaint = [];
    var b = h('div', { class: 'm-d-body' });
    b.appendChild(h('div', { class: 'm-kind' }, [NS.icon('aurora'), NS.kindLabel(d)]));
    b.appendChild(h('h1', { text: d.n }));
    if (this.svcWhere) b.appendChild(h('div', { class: 'm-svc-line' }, [h('span', { text: 'Finns även på' }), NS.svcChips(this.svcWhere)]));
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
      h('button', { class: 'm-act', onclick: function () { NS.rate(d).then(function (ch) { if (ch) self.render(); }); } }, [NS.icon(NS.likeOf(d.k) === -1 ? 'thumbdown' : 'thumb'), h('span', { text: NS.likeOf(d.k) === 1 ? 'Gillar' : NS.likeOf(d.k) === -1 ? 'Inte för mig' : 'Betygsätt' })]),
      d.t === 'movie' && NS.dl.on ? dlControl(this, d, function () { var v = self.ver; return { id: v ? v.id : d.id, ext: v ? v.ext : d.ext }; }, 'act') : null,
      canRestart ? h('button', { class: 'm-act', onclick: function () { self.play(true); } }, [NS.icon('restart'), h('span', { text: 'Från början' })]) : null,
      canRestart ? h('button', { class: 'm-act', onclick: function () {
        var tt = d.t === 'series' ? Object.assign({}, self.target(), { t: 'episode', sid: d.id, sn: d.n }) : d;
        NS.cardMenu(tt, 'cw').then(function (ch) { if (ch) NS.loadState().then(function () { self.render(); }); });
      } }, [NS.icon('more'), h('span', { text: 'Fler val' })]) : null
    ]));
    if (d.t === 'movie' && d.versions && d.versions.length > 1) {
      if (!this.ver) this.ver = NS.bestVersion(d.versions);
      var vsel = h('select', { class: 'm-season m-ver', onchange: function () { self.ver = d.versions[+vsel.value]; } });
      d.versions.forEach(function (v, i) { var o = h('option', { value: String(i), text: 'Version: ' + NS.versionLabel(v) }); if (v.id === self.ver.id) o.selected = true; vsel.appendChild(o); });
      b.appendChild(vsel);
    }
    if (d.p) b.appendChild(h('p', { class: 'm-d-desc', text: d.p }));
    var ex = this.extras;
    if (d.cast && !(ex && ex.cast && ex.cast.length)) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Medverkande: ' }), d.cast]));
    if (d.dir || (ex && ex.director)) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Regi: ' }), d.dir || ex.director]));
    if (d.g) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Genrer: ' }), d.g]));
    box.appendChild(b);
    // the cast with photos (tap a face to find everything else with that person) and trailers/extras
    if (ex && ex.cast && ex.cast.length) {
      var people = h('div', { class: 'm-people' });
      ex.cast.forEach(function (c) {
        var ph = h('div', { class: 'm-person-img', style: 'background:' + NS.fallbackBg(c.n) }, h('span', { text: c.n.charAt(0) }));
        if (c.img) ph.appendChild(NS.pic(c.img, 'm-img'));
        people.appendChild(h('button', { class: 'm-person', onclick: function () { var sc = new MSearch(); sc.input.value = c.n; sc.run(); NS.router.push(sc); } }, [ph, h('b', { text: c.n }), c.as ? h('span', { text: c.as }) : null]));
      });
      box.appendChild(h('section', { class: 'm-row m-cast' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Rollista' })), people]));
    }
    if (ex && ex.videos && ex.videos.length) {
      var vids = h('div', { class: 'm-vids' });
      ex.videos.forEach(function (v) {
        vids.appendChild(h('a', { class: 'm-vid', href: 'https://www.youtube.com/watch?v=' + v.key, target: '_blank', rel: 'noopener' }, [
          h('div', { class: 'm-vid-img' }, [NS.pic('https://img.youtube.com/vi/' + v.key + '/hqdefault.jpg', 'm-img'), h('span', { class: 'm-ep-play' }, NS.icon('play')), v.kind ? h('span', { class: 'm-vid-kind', text: v.kind }) : null]),
          h('b', { text: v.n })]));
      });
      box.appendChild(h('section', { class: 'm-row' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Trailers och extramaterial' })), vids]));
    }

    if (d.seasons && d.seasons.length) {
      var t2 = this.target();
      if (this.season === undefined) this.season = Math.max(0, d.seasons.findIndex(function (x) { return x.eps.indexOf(t2) >= 0; }));
      var sel = h('select', { class: 'm-season', onchange: function () { self.season = +sel.value; self.render(); } });
      d.seasons.forEach(function (x, i) { var o = h('option', { value: String(i), text: x.name }); if (i === self.season) o.selected = true; sel.appendChild(o); });
      var seasonDl = NS.dl.on ? h('button', { class: 'm-link m-season-dl', onclick: function () {
        var list = d.seasons[self.season].eps.filter(function (e) { var x = NS.dl.get('episode', e.id); return !x || x.status === 'error'; }).map(function (e) { return NS.dl.req(Object.assign({}, e, { sn: d.n }), {}); });
        if (!list.length) { NS.toast('Hela säsongen är redan nedladdad eller köad', 'info'); return; }
        NS.dl.add(list);
      } }, [NS.icon('download'), 'Ladda ner säsongen']) : null;
      var eps = h('div', { class: 'm-eps' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Avsnitt' })), d.seasons.length > 1 ? sel : null, seasonDl]);
      d.seasons[this.season].eps.forEach(function (e) {
        var th = h('div', { class: 'm-ep-img', style: 'background:' + NS.fallbackBg(e.n) }, [e.img ? NS.pic(e.img, 'm-img') : null, h('span', { class: 'm-ep-play' }, NS.icon('play'))]);
        var p = NS.state.progress[e.k];
        if (NS.isSeen(e.k) && !(p && p.pos > 0)) { th.appendChild(NS.progEl(100)); th.appendChild(h('span', { class: 'm-seen' }, NS.icon('check'))); }
        else if (p && p.dur && p.pos > 0) th.appendChild(NS.progEl(p.pos / p.dur * 100));
        var epEl;
        eps.appendChild(epEl = h('div', { class: 'm-ep', onclick: function () {
          NS.playItem(Object.assign({}, e, { sn: d.n, bd: d.bd }), { start: NS.resumePos(e), series: d });
        } }, [h('div', { class: 'm-ep-top' }, [th, h('div', { class: 'm-ep-txt' }, [h('b', { text: e.ep + '. ' + e.n }), e.dur ? h('span', { text: NS.fmtDur(e.dur) }) : null]), NS.dl.on ? dlControl(self, Object.assign({}, e, { sn: d.n }), function () { return { id: e.id, ext: e.ext }; }, 'ep') : null]),
          e.p ? h('p', { text: e.p }) : null]));
        var seasonEps = d.seasons[self.season].eps;
        longPress(epEl, function () { NS.cardMenu(Object.assign({}, e, { sn: d.n, sid: d.id }), 'eps', seasonEps).then(function (ch) { if (ch) self.render(); }); });
      });
      box.appendChild(eps);
    }
    if (d.t === 'movie' || d.t === 'series') {
      var more = h('div', { class: 'm-more' });
      var sec = h('section', { class: 'm-row' }, [h('div', { class: 'm-tabs' }, h('span', { class: 'on', text: 'Mer som detta' })), more]);
      var fill = function (list) {
        if (!list.length) { sec.remove(); return; }
        list.slice(0, 18).forEach(function (x) {
          var c = poster(x);
          c.addEventListener('click', function () { NS.router.push(new MDetail(x)); });
          more.appendChild(c);
        });
      };
      box.appendChild(sec);
      if (this.similar) fill(this.similar);
      else NS.api.get('api/similar/' + d.t + '/' + encodeURIComponent(d.id)).then(function (r) { self.similar = r.items || []; fill(self.similar); }).catch(function () { sec.remove(); });
    }
  };

  MDetail.prototype.activate = function (first) {
    var self = this;
    if (first) { top0(); return; }
    restoreY(this);
    NS.loadState().then(function () { self.render(); self.preview(); });
  };
  MDetail.prototype.deactivate = function () { saveY(this); NS.preview.stop(); };
  MDetail.prototype.destroy = function () { NS.preview.stop(); if (this._unDl) this._unDl(); window.removeEventListener('scroll', this._onScroll); };

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
    this.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { self.input.blur(); if (self.input.value.trim()) self.remember(self.input.value.trim()); } });
    this.idle();
  }
  MSearch.prototype.idle = function () {
    var self = this;
    var rec = NS.store.get(NS.pkey('searches'), []);
    this.res.innerHTML = '';
    if (NS.svc.enabled) {
      var sug = h('div');
      NS.api.get('api/services/suggest', 30000).then(function (x) {
        if (self.input.value.trim() || !x || !x.items || !x.items.length) return;
        sug.appendChild(rowEl({ id: 's-svc', title: 'Föreslaget på dina tjänster', kind: 'poster', items: x.items }));
      }).catch(function () {});
      setTimeout(function () { if (!self.input.value.trim()) self.res.appendChild(sug); }, 0);
    }
    var box = h('div', { class: 'm-recent' });
    if (rec.length) {
      box.appendChild(h('h2', {}, ['Senaste sökningar', h('button', { class: 'm-link', onclick: function () { NS.store.set(NS.pkey('searches'), []); self.idle(); }, text: 'Rensa' })]));
      rec.forEach(function (q) { box.appendChild(h('button', { class: 'm-rec', onclick: function () { self.input.value = q; self.run(); } }, [NS.icon('search'), h('span', { text: q })])); });
    } else box.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Sök i hela utbudet' }), h('p', { text: 'Titlar, kanaler, skådespelare, regissörer och genrer.' })]));
    this.res.appendChild(box);
  };
  MSearch.prototype.remember = function (q) {
    var rec = NS.store.get(NS.pkey('searches'), []).filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
    rec.unshift(q);
    NS.store.set(NS.pkey('searches'), rec.slice(0, 8));
  };
  MSearch.prototype.activate = function (first) { var i = this.input; if (first) { top0(); setTimeout(function () { i.focus(); }, 250); } else restoreY(this); };
  MSearch.prototype.deactivate = function () { saveY(this); };
  MSearch.prototype.run = function () {
    var self = this;
    var q = this.input.value.trim();
    this.res.innerHTML = '';
    if (!q) { this.idle(); return; }
    var extBox = h('div');
    if (NS.svc.enabled) {
      NS.api.get('api/services/search?q=' + encodeURIComponent(q)).then(function (x) {
        if (self.input.value.trim() !== q || !x.items || !x.items.length) return;
        var grid = h('div', { class: 'm-grid' });
        x.items.forEach(function (it) { var c = poster(it, { caption: it.n + (it.y ? ' (' + it.y + ')' : '') }); c.addEventListener('click', function () { self.remember(q); open(it); }); grid.appendChild(c); });
        extBox.innerHTML = '';
        extBox.appendChild(h('section', { class: 'm-row' }, [h('h2', { text: 'På dina tjänster' }), grid]));
        var empty = self.res.querySelector('.m-empty');
        if (empty) empty.remove();
      }).catch(function () {});
    }
    NS.api.search(q).then(function (r) {
      if (self.input.value.trim() !== q) return;
      self.res.innerHTML = '';
      if (r.live.length) self.res.appendChild(rowEl({ id: 's-live', title: 'Kanaler', kind: 'live', items: r.live }));
      var people = r.movie.concat(r.series).filter(function (x) { return x.why; });
      r.movie = r.movie.filter(function (x) { return !x.why; });
      r.series = r.series.filter(function (x) { return !x.why; });
      r.people = people;
      [['movie', 'Filmer'], ['series', 'Serier'], ['people', 'Medverkande, regi eller genre: ”' + q + '”']].forEach(function (x) {
        if (!r[x[0]].length) return;
        var grid = h('div', { class: 'm-grid' });
        // titles under the posters, so two similar ones (or a sequel with the same art) can be told apart
        r[x[0]].forEach(function (it) { var c = poster(it, { caption: it.n + (it.y ? ' (' + it.y + ')' : '') }); c.addEventListener('click', function () { self.remember(q); open(it); }); grid.appendChild(c); });
        self.res.appendChild(h('section', { class: 'm-row' }, [h('h2', { text: x[1] }), grid]));
      });
      if (!r.live.length && !r.movie.length && !r.series.length && !r.people.length && !extBox.childNodes.length) self.res.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Inga träffar' }), h('p', { text: 'Inget matchar ”' + q + '”' + (NS.svc.enabled ? ' i biblioteket. Letar på dina tjänster…' : '. Prova ett kortare ord.') })]));
      self.res.appendChild(extBox);
    }).catch(function () {});
  };

  /* ---------------------------------------------------------------- a title on a streaming service */
  /** On Netflix/Max/Disney+/Prime: the buttons open the service's app on the title (or its search). */
  function MExtDetail(item) {
    var self = this;
    this.item = item;
    this.el = h('div', { class: 'screen m-screen m-detail' });
    this.art = h('div', { class: 'm-d-art' });
    this.el.appendChild(this.art);
    this.box = h('div', { class: 'm-d-wrap' });
    this.el.appendChild(this.box);
    this.dhead = h('header', { class: 'm-dhead' }, [h('button', { class: 'm-icon m-back', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')), h('span', { class: 'm-dhead-t', text: item.n })]);
    this.el.appendChild(this.dhead);
    this._onScroll = function () { if (NS.router.top() === self) self.dhead.classList.toggle('solid', (window.scrollY || 0) > 160); };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this.render();
    NS.api.get('api/services/title/' + item.mt + '/' + item.id).then(function (d) { self.item = Object.assign({}, item, d); self.render(); }).catch(function () {});
  }
  MExtDetail.prototype.render = function () {
    var d = this.item;
    this.art.innerHTML = '';
    if (d.bd || d.img) this.art.appendChild(NS.pic(d.bd || d.img, 'm-img' + (d.bd ? '' : ' m-contain')));
    else this.art.style.background = NS.fallbackBg(d.n);
    var b = h('div', { class: 'm-d-body' });
    b.appendChild(h('div', { class: 'm-kind' }, [NS.icon('aurora'), d.mt === 'tv' ? 'Serie' : 'Film']));
    b.appendChild(h('h1', { text: d.n }));
    b.appendChild(h('p', { class: 'm-d-meta', text: [d.y, d.dur ? NS.fmtDur(d.dur) : '', d.seasons ? (d.seasons === 1 ? '1 säsong' : d.seasons + ' säsonger') : '', d.r > 0 ? '★ ' + d.r.toFixed(1) : ''].filter(Boolean).join('  •  ') }));
    if (d.svc && d.svc.length) b.appendChild(h('div', { class: 'm-svc-line' }, [h('span', { text: 'Finns på' }), NS.svcChips(d.svc)]));
    if (d.local) b.appendChild(h('button', { class: 'm-btn', onclick: function () { NS.router.push(new MDetail(d.local)); } }, [NS.icon('play'), 'Spela i ' + ((NS.status && NS.status.appName) || 'Norrsken')]));
    (d.links || []).forEach(function (l, i) {
      // a plain link: on the phone it opens the service's own app when it is installed
      b.appendChild(h('a', { class: 'm-btn' + (d.local || i ? ' ghost' : ''), href: l.url, target: '_blank', rel: 'noopener' }, [NS.icon('link'), 'Öppna i ' + l.name]));
    });
    if (d.because) b.appendChild(h('p', { class: 'm-d-cast', text: d.because }));
    if (d.p) b.appendChild(h('p', { class: 'm-d-desc', text: d.p }));
    if (d.cast) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Medverkande: ' }), d.cast]));
    if (d.g) b.appendChild(h('p', { class: 'm-d-cast' }, [h('b', { text: 'Genrer: ' }), d.g]));
    if (d.svc && d.svc.length) b.appendChild(h('p', { class: 'm-jw', text: 'Uppgifter om tjänster från JustWatch via TMDB' }));
    this.box.innerHTML = '';
    this.box.appendChild(b);
  };
  MExtDetail.prototype.activate = function (first) { if (first) top0(); else restoreY(this); };
  MExtDetail.prototype.deactivate = function () { saveY(this); };
  MExtDetail.prototype.destroy = function () { window.removeEventListener('scroll', this._onScroll); };

  /* ---------------------------------------------------------------- "Mitt": profile, my list, settings */
  function MMe() {
    var self = this;
    this.el = h('div', { class: 'screen m-screen' });
    var p = NS.profile || { name: '?', color: '#888' };
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('h1', { class: 'm-title', text: 'Min sida' })])));
    var body = h('div', { class: 'm-body' });
    this.el.appendChild(body);
    this.el.appendChild(tabbar('me'));
    body.appendChild(h('div', { class: 'm-me' }, [h('span', { class: 'm-prof-av big', style: 'background:' + p.color, text: p.name.charAt(0).toUpperCase() }), h('h2', { text: p.name })]));
    var list = h('div', { class: 'm-profiles' });
    ((NS.status && NS.status.profiles) || []).forEach(function (q) {
      if (q.id === p.id) return;
      list.appendChild(h('button', { class: 'm-prof', onclick: function () {
        (NS.pinNeeded(q, NS.profile) ? NS.askPin(q, NS.profile) : Promise.resolve(true)).then(function (okd) {
          if (!okd) return;
          NS.profile = q; NS.store.set('profile', q.id);
          NS.loadState().then(function () { NS.router.reset(new MBrowse('home')); top0(); });
        });
      } }, [h('span', { class: 'm-prof-av', style: 'background:' + q.color, text: q.name.charAt(0).toUpperCase() }), h('span', { text: 'Byt till ' + q.name }), q.hasPin ? h('span', { class: 'm-lock' }, NS.icon('lock')) : null]));
    });
    if (list.childNodes.length) body.appendChild(list);
    // the profile's own choices (kept on the server, so the TV gets them too)
    var teamV = h('span', { class: 'm-set-v' }), subV = h('span', { class: 'm-set-v' }), dlV = h('span', { class: 'm-set-v' });
    var paintDlV = function () { var n = NS.dl.items.filter(function (x) { return x.status === 'done'; }).length; dlV.textContent = n ? String(n) : ''; };
    this._unDl = NS.dl.onChange(paintDlV);
    NS.dl.refresh().then(paintDlV);
    var paintSet = function () { teamV.textContent = NS.teamNames(); subV.textContent = NS.pref('sub') ? NS.langName(NS.pref('sub')) : 'Av'; };
    body.appendChild(h('div', { class: 'm-sets' }, [
      h('button', { class: 'm-set', onclick: function () { NS.pickTeam().then(function (ch) { if (ch) { NS.state.dirty = true; paintSet(); } }); } }, [NS.icon('live'), h('span', { text: 'Favoritlag' }), teamV, NS.icon('right')]),
      h('button', { class: 'm-set', onclick: function () { NS.pickSubLang().then(function (ch) { if (ch) paintSet(); }); } }, [NS.icon('sub'), h('span', { text: 'Undertexter' }), subV, NS.icon('right')]),
      h('button', { class: 'm-set', onclick: function () { NS.router.push(new MDownloads()); } }, [NS.icon('download'), h('span', { text: 'Nedladdningar' }), dlV, NS.icon('right')])
    ]));
    paintSet();
    NS.loadTeams().then(paintSet);
    this.rows = h('div');
    body.appendChild(this.rows);
    var st = NS.status || {};
    var c = st.counts || {};
    body.appendChild(h('div', { class: 'm-info' }, [
      p.kids ? null : h('a', { class: 'm-btn ghost', href: 'setup' }, [NS.icon('settings'), 'Inställningar']),
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
  MMe.prototype.destroy = function () { if (this._unDl) this._unDl(); };

  /* ---------------------------------------------------------------- downloads */
  function dlPlayItem(x) {
    var ep = x.type === 'episode';
    return { t: x.type, id: x.mid, vid: ep ? undefined : x.mid, k: (ep ? 'e:' : 'm:') + x.mid, n: x.title, sn: ep ? '' : undefined, img: x.img, ext: 'mp4', dur: x.dur || 0 };
  }
  function MDownloads() {
    var self = this;
    this.el = h('div', { class: 'screen m-screen' });
    this.el.appendChild(h('header', { class: 'm-head solid' }, h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')),
      h('h1', { class: 'm-title small', text: 'Nedladdningar' })])));
    this.info = h('div', { class: 'm-dl-info' });
    this.list = h('div', { class: 'm-dls' });
    this.el.appendChild(h('div', { class: 'm-body' }, [this.info, this.list]));
    this.el.appendChild(tabbar('me'));
    this._un = NS.dl.onChange(function () { if (NS.router.top() === self) self.paint(); });
    NS.dl.refresh();
    this.paint();
  }
  MDownloads.prototype.paint = function () {
    var self = this;
    var s = NS.dl.storage;
    this.info.innerHTML = '';
    if (s) {
      if (s.configured && !s.ok) this.info.appendChild(h('p', { class: 'm-dl-warn', text: 'Lagringsdisken hittas inte (' + (s.err || 'okänt fel') + '). Tills den fungerar sparas filerna på tilläggets egen disk.' }));
      else this.info.appendChild(h('p', { text: (s.onNetwork ? 'Sparas på nätverksdisken' : 'Sparas på tilläggets egen disk') + (s.freeGb ? '  ·  ' + s.freeGb + ' GB ledigt' : '') }));
    }
    this.list.innerHTML = '';
    if (!NS.dl.items.length) {
      this.list.appendChild(h('div', { class: 'm-empty' }, [h('h2', { text: 'Inget nedladdat än' }), h('p', { text: NS.dl.on ? 'Tryck på Ladda ner på en film eller ett avsnitt. Filerna sparas på servern och spelas därifrån, utan att använda leverantörens anslutning.' : 'Nedladdning kräver ffmpeg på servern.' })]));
      return;
    }
    NS.dl.items.forEach(function (x) {
      var th = h('div', { class: 'm-dl-img', style: 'background:' + NS.fallbackBg(x.title) });
      if (x.img) th.appendChild(NS.pic(x.img, 'm-img'));
      if (x.status === 'downloading') th.appendChild(NS.progEl(x.pct));
      var acts = [];
      if (x.status === 'done') {
        acts.push(h('a', { class: 'm-icon', 'aria-label': 'Spara på enheten', href: 'dl/' + x.file + NS.pq() + '&dl=1', download: '', onclick: function (e) { e.stopPropagation(); } }, NS.icon('save')));
      }
      if (x.status === 'error') acts.push(h('button', { class: 'm-icon', 'aria-label': 'Försök igen', onclick: function (e) { e.stopPropagation(); NS.dl.retry(x); } }, NS.icon('refresh')));
      acts.push(h('button', { class: 'm-icon', 'aria-label': x.status === 'done' ? 'Ta bort' : 'Avbryt', onclick: function (e) {
        e.stopPropagation();
        NS.confirm({ title: x.status === 'done' ? 'Ta bort nedladdningen?' : 'Avbryta?', text: x.title, buttons: [{ label: x.status === 'done' ? 'Ta bort' : 'Avbryt', icon: 'trash', value: true }, { label: 'Behåll', value: false }], cancel: false }).then(function (yes) { if (yes) NS.dl.remove(x); });
      } }, NS.icon('trash')));
      self.list.appendChild(h('div', { class: 'm-dl' + (x.status === 'done' ? ' done' : ''), onclick: function () {
        if (x.status === 'done') NS.playItem(dlPlayItem(x), { start: 0 });
      } }, [th, h('div', { class: 'm-dl-txt' }, [h('b', { text: x.title }), h('span', { class: x.status === 'error' ? 'bad' : '', text: NS.dl.label(x) }), x.sub ? h('span', { text: x.sub }) : null]), h('div', { class: 'm-dl-acts' }, acts)]));
    });
  };
  MDownloads.prototype.activate = function (first) { if (first) top0(); else restoreY(this); };
  MDownloads.prototype.deactivate = function () { saveY(this); };
  MDownloads.prototype.destroy = function () { if (this._un) this._un(); };
  NS.openDownloads = function () { NS.router.push(new MDownloads()); };

  /* ---------------------------------------------------------------- a whole category as a grid, with sorting */
  var SORTS = [{ id: '', label: 'Standard' }, { id: 'new', label: 'Nyast' }, { id: 'rating', label: 'Högst betyg' }, { id: 'az', label: 'A–Ö' }];
  function MGrid(type, cat, name) {
    var self = this;
    this.type = type; this.cat = cat;
    this.sort = NS.store.get('gridSort', '');
    this.el = h('div', { class: 'screen m-screen' });
    this.el.appendChild(h('header', { class: 'm-head solid' }, [h('div', { class: 'm-bar' }, [
      h('button', { class: 'm-icon', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back')),
      h('h1', { class: 'm-title small', text: name })]), this.sorts = h('nav', { class: 'm-pills' })]));
    this.grid = h('div', { class: 'm-grid m-body' });
    this.el.appendChild(this.grid);
    this.el.appendChild(tabbar(type === 'live' ? 'live' : 'home'));
    this._onScroll = function () { if (NS.router.top() === self && window.innerHeight + window.scrollY > document.body.scrollHeight - 900) self.more(); };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this.paintSorts();
    this.reset();
  }
  MGrid.prototype.paintSorts = function () {
    var self = this;
    this.sorts.innerHTML = '';
    SORTS.forEach(function (s) { self.sorts.appendChild(h('button', { class: 'm-pill' + (s.id === self.sort ? ' on' : ''), onclick: function () { self.sort = s.id; NS.store.set('gridSort', s.id); self.paintSorts(); self.reset(); top0(); } }, s.label)); });
  };
  MGrid.prototype.reset = function () { this.items = []; this.total = 1; this.loading = false; this.grid.innerHTML = ''; this.more(); };
  MGrid.prototype.more = function () {
    var self = this;
    if (this.loading || this.items.length >= this.total) return;
    this.loading = true;
    var sort = this.sort;
    NS.api.get('api/list?type=' + this.type + '&cat=' + encodeURIComponent(this.cat) + '&offset=' + this.items.length + '&limit=60' + (sort ? '&sort=' + sort : '')).then(function (r) {
      if (sort !== self.sort) return;
      var list = r.items || [];
      self.items = self.items.concat(list);
      self.total = list.length ? r.total : self.items.length;
      list.forEach(function (it) { var c = poster(it); c.addEventListener('click', function () { open(it); }); longPress(c, function () { NS.cardMenu(it); }); self.grid.appendChild(c); });
      self.loading = false;
    }).catch(function () { self.loading = false; });
  };
  MGrid.prototype.activate = function (first) { if (first) top0(); else restoreY(this); };
  MGrid.prototype.deactivate = function () { saveY(this); };
  MGrid.prototype.destroy = function () { window.removeEventListener('scroll', this._onScroll); };
  NS.Grid = MGrid;
  // "Open the guide" from a menu goes to the phone's live list
  NS.mOpenLive = function (cat) {
    if (cat) NS.store.set(NS.pkey('mLiveCat'), cat);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
    var b = NS.router.stack[0];
    while (NS.router.stack.length > 1) origPop();
    if (b && b.load) { b.load('live'); top0(); }
  };
  NS.Guide = function (opts) { if (opts && opts.cat) NS.store.set(NS.pkey('mLiveCat'), opts.cat); return new MBrowse('live'); };

  NS.Browse = MBrowse;
  NS.Detail = MDetail;
  NS.ExtDetail = MExtDetail;
  NS.Search = MSearch;
  NS.MMe = MMe;
})();
