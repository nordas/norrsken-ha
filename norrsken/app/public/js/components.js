/* Norrsken components: images & colour, ambient wash, top navigation, billboard, rows with expanding cards. */
(function () {
  'use strict';
  var NS = window.NS;
  var h = NS.h;

  /* ================================================================ images */
  /** All artwork goes through the server: same-origin (so we can read colours), cached, http on https pages OK. */
  NS.imgSrc = function (u) {
    if (!u) return '';
    if (u.charAt(0) === '/' || u.indexOf('data:') === 0 || NS.mock) return u;
    return 'img?u=' + encodeURIComponent(u);
  };
  NS.pic = function (u, cls, onerr, onload) {
    var im = NS.img(NS.imgSrc(u), cls, onerr);
    if (onload) im.addEventListener('load', function () { onload(im); });
    return im;
  };

  var colors = {};
  /** Average colour of an image, tuned to work as a background glow. Resolves [r,g,b] or null. */
  NS.colorOf = function (u) {
    if (!u) return Promise.resolve(null);
    if (colors[u]) return colors[u];
    colors[u] = new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = 12; c.height = 12;
          var x = c.getContext('2d');
          x.drawImage(im, 0, 0, 12, 12);
          var d = x.getImageData(0, 0, 12, 12).data;
          var r = 0, g = 0, b = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) {
            var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
            if (mx < 25 || mn > 235) continue; // skip near-black / near-white
            var w = 1 + (mx - mn) / 40; // favour saturated pixels
            r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
          }
          if (!n) return resolve(null);
          resolve(tune([r / n, g / n, b / n]));
        } catch (e) { resolve(null); }
      };
      im.onerror = function () { resolve(null); };
      im.src = NS.imgSrc(u);
    });
    return colors[u];
  };
  function tune(rgb) {
    // to HSL, push saturation up and lightness to a rich mid-dark tone
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = 0, hh = 0;
    if (mx !== mn) {
      var dd = mx - mn;
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      hh = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      hh /= 6;
    }
    s = Math.min(0.85, s * 1.35 + 0.08);
    l = 0.36;
    return hsl(hh, s, l);
  }
  function hsl(hh, s, l) {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    var f = function (t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    return [Math.round(f(hh + 1 / 3) * 255), Math.round(f(hh) * 255), Math.round(f(hh - 1 / 3) * 255)];
  }
  NS.hueColor = function (str) { return hsl(NS.hue(str) / 360, 0.55, 0.32); };
  NS.rgba = function (c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; };
  NS.itemColor = function (it) {
    var src = it && (it.t === 'live' ? it.img : it.bd || it.img);
    return NS.colorOf(src).then(function (c) { return c || NS.hueColor(it ? it.sn || it.n : ''); });
  };

  /* ================================================================ AMBIENT */
  function Ambient() {
    this.el = h('div', { class: 'ambient' });
    this.layers = [h('i'), h('i')];
    this.el.appendChild(this.layers[0]);
    this.el.appendChild(this.layers[1]);
    this.li = 0;
    this.key = '';
    this.set = NS.debounce(this._set.bind(this), 180);
  }
  Ambient.prototype._set = function (c) {
    var key = c ? c.join(',') : '';
    if (key === this.key) return;
    this.key = key;
    this.li = 1 - this.li;
    var a = this.layers[this.li], b = this.layers[1 - this.li];
    a.style.background = c
      ? 'radial-gradient(130% 75% at 50% 0%, ' + NS.rgba(c, 0.62) + ' 0%, ' + NS.rgba(c, 0.22) + ' 42%, rgba(5,5,5,0) 78%), radial-gradient(90% 60% at 50% 100%, ' + NS.rgba(c, 0.18) + ' 0%, rgba(5,5,5,0) 70%)'
      : 'none';
    a.classList.add('on');
    b.classList.remove('on');
  };
  Ambient.prototype.follow = function (it) {
    var self = this;
    var tok = this.tok = {};
    NS.itemColor(it).then(function (c) { if (tok === self.tok) self.set(c); });
  };
  NS.Ambient = Ambient;

  /* ================================================================ META */
  NS.kindLabel = function (it) {
    if (it.t === 'ext') return (it.mt === 'tv' ? 'Serie' : 'Film') + (it.svc && it.svc.length ? ' på ' + NS.svcName(it.svc[0]) : '');
    return it.t === 'series' ? 'Serie' : it.t === 'movie' ? 'Film' : it.t === 'episode' ? 'Avsnitt' : 'Live';
  };
  NS.metaEl = function (it, opts) {
    opts = opts || {};
    var m = h('div', { class: 'meta' });
    var add = function (t, cls) { if (t) m.appendChild(h('span', { class: cls || null, text: String(t) })); };
    if (it.t === 'live') {
      m.appendChild(h('span', {}, h('span', { class: 'live-dot', text: 'Live' })));
      var e = NS.epgFor(it.id);
      if (e && e.now) add(NS.fmtClock(e.now.s) + '–' + NS.fmtClock(e.now.e));
      add(it.num ? it.num + '  ' + it.n : it.n, 'soft');
      return m;
    }
    if (opts.kind) add(NS.kindLabel(it));
    if (it.g) add(it.g.split(/[,/|]/)[0].trim());
    if (it.y) add(it.y);
    if (it.t === 'movie' && it.dur) add(NS.fmtDur(it.dur));
    if (it.t === 'series' && it.seasons && it.seasons.length) add(it.seasons.length === 1 ? '1 säsong' : it.seasons.length + ' säsonger');
    if (it.r > 0) add('★ ' + (Math.round(it.r * 10) / 10).toFixed(1));
    if (it.age) add(it.age, 'tag');
    return m;
  };
  NS.progEl = function (pct) {
    return h('div', { class: 'prog' }, h('i', { style: 'width:' + Math.max(0, Math.min(100, pct)).toFixed(1) + '%' }));
  };
  NS.livePct = function (p) { return p ? (Date.now() - p.s) / (p.e - p.s) * 100 : 0; };

  /* ================================================================ TOP NAV */
  function TopNav(items, onSelect) {
    var self = this;
    this.items = items;
    this.onSelect = onSelect;
    this.i = 2;
    this.active = '';
    this.focused = false;
    this.el = h('div', { class: 'topnav' });
    var mid = h('div', { class: 'mid' });
    this.els = items.map(function (it, i) {
      var e;
      if (it.avatar) {
        e = h('div', { class: 'avatar' }, [h('b', { style: 'background:' + it.avatar, text: (it.label || '?').charAt(0).toUpperCase() }), NS.icon('down')]);
        self.el.appendChild(e);
      } else {
        e = h('div', { class: 'nv' + (it.icon && !it.label ? ' icon' : '') }, [it.icon ? NS.icon(it.icon) : null, it.label || null]);
        mid.appendChild(e);
      }
      e.addEventListener('click', function () { self.i = i; self.paint(); self.onSelect(it); });
      return e;
    });
    this.el.appendChild(mid);
    this.clockEl = h('div', { class: 'clock' });
    this.el.appendChild(this.clockEl);
    this.el.appendChild(h('div', { class: 'brand' }, NS.icon('aurora')));
  }
  TopNav.prototype.focus = function (on) {
    this.focused = on;
    if (on) { var a = this.items.findIndex(function (x) { return x.id === this.active; }, this); if (a >= 0) this.i = a; }
    this.paint();
  };
  TopNav.prototype.setActive = function (id) { this.active = id; this.paint(); };
  TopNav.prototype.paint = function () {
    var self = this;
    this.els.forEach(function (e, i) {
      e.classList.toggle('focus', self.focused && i === self.i);
      e.classList.toggle('active', self.items[i].id === self.active);
    });
  };
  TopNav.prototype.onKey = function (a) {
    if (a === 'left') { if (this.i > 0) this.i--; this.paint(); return true; }
    if (a === 'right') { if (this.i < this.items.length - 1) this.i++; this.paint(); return true; }
    if (a === 'ok') { this.onSelect(this.items[this.i]); return true; }
    return false;
  };
  NS.TopNav = TopNav;

  /* ================================================================ BILLBOARD */
  function Billboard(onOk) {
    var self = this;
    this.el = h('div', { class: 'billboard' });
    this.art = h('div', { class: 'art' });
    this.bgs = [h('div', { class: 'bgl' }), h('div', { class: 'bgl' })];
    this.bi = 0;
    this.art.appendChild(this.bgs[0]);
    this.art.appendChild(this.bgs[1]);
    this.el.appendChild(this.art);
    this.txt = h('div', { class: 'txt' });
    this.el.appendChild(this.txt);
    this.hint = h('div', { class: 'hint' });
    this.sel = 0;
    this.el.addEventListener('click', function () { if (onOk) onOk(self.item); });
    this.height = 65;
  }
  Billboard.prototype.show = function (it) {
    this.item = it;
    var t = this.txt;
    t.innerHTML = '';
    t.appendChild(h('div', { class: 'kind' }, [NS.icon('aurora'), NS.kindLabel(it)]));
    t.appendChild(h('h1', { class: it.n.length > 22 ? 'long' : null, text: it.n }));
    t.appendChild(NS.metaEl(it));
    if (it.p) t.appendChild(h('div', { class: 'desc', text: it.p }));
    // the buttons always show, under the text like on the streaming apps; left/right picks between them
    this.hint.innerHTML = '';
    this.btnEls = [h('div', { class: 'btn' }, [NS.icon('play'), it.t === 'series' ? 'Spela upp serie' : 'Spela']), h('div', { class: 'btn' }, [NS.icon('info'), 'Mer info'])];
    this.btnEls.forEach(function (b) { this.hint.appendChild(b); }, this);
    t.appendChild(this.hint);
    this.paintBtns();
    this.setArt(it.bd || it.img, !it.bd);
  };
  /**
   * The favourite team's match, like TV4 Play: "Live nu: Luleå – Färjestad" on top of the start page.
   * OK switches to the channel; the second button opens the guide (live) or sets a reminder (soon).
   */
  Billboard.prototype.showSport = function (m) {
    var it = Object.assign({}, m.ch, { sport: m });
    this.item = it;
    this.el.classList.add('sport');
    this.el.classList.toggle('soon', m.state !== 'live');
    var c = m.team.col || ['#c8102e', '#111'];
    this.art.style.background = 'radial-gradient(70% 120% at 88% 30%, ' + c[0] + 'cc 0%, ' + c[0] + '33 45%, transparent 70%), linear-gradient(115deg, #0c0d10 0%, #121419 52%, ' + c[0] + '55 100%)';
    if (this.ice) this.ice.remove();
    // the teams, big and quiet behind the text (no club logos: the names carry it)
    this.ice = h('div', { class: 'ice' }, [h('span', { text: m.home || m.team.short }), h('i', { text: m.away ? '–' : '' }), h('span', { text: m.away || '' })]);
    this.art.appendChild(this.ice);
    var t = this.txt;
    t.innerHTML = '';
    var live = m.state === 'live';
    t.appendChild(h('div', { class: 'kind' }, [live ? h('span', { class: 'live-pill', text: 'Live nu' }) : h('span', { class: 'soon-pill', text: m.state === 'ended' ? 'Slut' : 'Börjar ' + NS.fmtClock(m.s) }), m.team.name]));
    t.appendChild(h('h1', { class: m.title.length > 22 ? 'long' : null, text: m.title }));
    var meta = h('div', { class: 'meta' });
    var logo = h('span', { class: 'chlogo' });
    if (m.ch.img) logo.appendChild(NS.pic(m.ch.img, '', function () { logo.remove(); }));
    meta.appendChild(logo);
    meta.appendChild(h('span', { text: m.ch.n }));
    meta.appendChild(h('span', { text: NS.fmtClock(m.s) + '–' + NS.fmtClock(m.e) }));
    if (m.chans && m.chans.length > 1) meta.appendChild(h('span', { class: 'soft', text: 'på ' + m.chans.length + ' kanaler' }));
    t.appendChild(meta);
    if (live) t.appendChild(h('div', { class: 'sprog' }, NS.progEl(NS.livePct(m))));
    if (m.d) t.appendChild(h('div', { class: 'desc', text: m.d }));
    this.hint.innerHTML = '';
    var rem = !live && NS.hasReminder(m.ch.id, m.s);
    var rec = !!(m.rec && m.rec.id); // the match is recorded: from its start, or live
    var first = live ? (rec ? 'Börja från start' : 'Titta nu') : m.state === 'ended' ? (rec ? 'Börja från start' : 'Tv-guide') : 'Titta från start';
    this.btnEls = [h('div', { class: 'btn' }, [NS.icon(!live && m.state === 'ended' && !rec ? 'episodes' : 'play'), first]),
      h('div', { class: 'btn' }, live ? (rec ? [NS.icon('live'), 'Titta live'] : [NS.icon('episodes'), 'Tv-guide'])
        : m.state === 'ended' ? [NS.icon('episodes'), 'Tv-guide'] : [NS.icon(rem ? 'check' : 'bell'), rem ? 'Påminnelse satt' : 'Påminn mig'])];
    this.btnEls.forEach(function (b) { this.hint.appendChild(b); }, this);
    t.appendChild(this.hint);
    this.paintBtns();
  };
  Billboard.prototype.setArt = function (u, maybePoster) {
    if (!u || u === this.artUrl) return;
    this.artUrl = u;
    var self = this;
    var im = new Image();
    im.onload = function () {
      if (self.artUrl !== u) return;
      self.bi = 1 - self.bi;
      var a = self.bgs[self.bi], b = self.bgs[1 - self.bi];
      a.className = 'bgl' + (im.naturalHeight > im.naturalWidth * 0.9 ? ' poster' : '');
      a.style.backgroundImage = 'url("' + im.src.replace(/"/g, '%22') + '")';
      void a.offsetWidth;
      a.classList.add('on');
      b.classList.remove('on');
    };
    im.src = NS.imgSrc(u);
  };
  Billboard.prototype.focus = function (on) { this.el.classList.toggle('focus', on); if (!on) this.sel = 0; this.paintBtns(); };
  Billboard.prototype.paintBtns = function () {
    var self = this;
    (this.btnEls || []).forEach(function (b, i) { b.classList.toggle('focus', i === self.sel); });
  };
  NS.Billboard = Billboard;

  /* ================================================================ ROWS */
  var GAP = 1.6;
  var KIND = {
    poster: { w: 23, h: 34.5, xw: 61.3, title: 6.2, gap: 5, info: true },
    top10: { w: 36, h: 34.5, title: 6.2, gap: 5, info: true },
    continue: { w: 46, h: 25.9, title: 6.2, gap: 5, info: true },
    live: { w: 46, h: 25.9, title: 6.2, gap: 5, info: true },
    episode: { w: 44, h: 36, title: 0, gap: 3, info: false },
    pill: { w: 0, h: 6, title: 0, gap: 3, info: false }
  };
  NS.KIND = KIND;
  var INFO_H = 15.5;
  var VIEW_W = 176;

  function cardFor(item, kind, row, idx) {
    var c = h('div', { class: 'card' });
    var f = h('div', { class: 'frame' });
    c.appendChild(f);
    c._item = item;
    if (kind === 'pill') {
      f.textContent = item.label;
      if (row.selected === item.value) c.classList.add('sel');
      return c;
    }
    if (kind === 'poster' || kind === 'top10') {
      if (kind === 'top10') c.insertBefore(h('div', { class: 'num', text: String(idx + 1) }), f);
      var xbg = h('div', { class: 'xbg', style: 'background:' + NS.fallbackBg(item.n) });
      f.appendChild(xbg);
      var title0 = item.t === 'episode' ? item.sn || item.n : item.n;
      f.appendChild(h('div', { class: 'fb', style: 'background:' + NS.fallbackBg(title0), text: title0 }));
      if (item.img) f.appendChild(NS.pic(item.img, kind === 'top10' ? 'cover' : 'pimg'));
      if (kind === 'poster') {
        f.appendChild(h('div', { class: 'xshade' }));
        var ep = item.t === 'episode';
        f.appendChild(h('div', { class: 'xt' }, [h('small', {}, [NS.icon('aurora'), ep ? NS.epCode(item) + ' ' + item.n : NS.kindLabel(item)]), h('b', { text: ep ? item.sn || item.n : item.n })]));
        if (item.r > 0) f.appendChild(h('div', { class: 'badge' }, [NS.icon('star'), (Math.round(item.r * 10) / 10).toFixed(1)]));
        if (item.q === '4K') f.appendChild(h('div', { class: 'qbadge', text: '4K' }));
        if (item.t === 'ext' && item.svc) f.appendChild(NS.svcChips(item.svc.slice(0, 2), 'on-card'));
        if (item.add && Date.now() / 1000 - item.add < 10 * 86400) c.appendChild(h('div', { class: 'nbadge', text: item.t === 'series' ? 'Nytt' : 'Ny' }));
        NS.itemColor(item).then(function (col) {
          xbg.style.background = 'linear-gradient(120deg, ' + NS.rgba(col, 1) + ' 0%, ' + NS.rgba(col.map(function (v) { return Math.round(v * 0.35); }), 1) + ' 70%)';
        });
        if (item.bd) setBd(c, item.bd);
      }
      var pr = NS.state.progress[item.k];
      var pos = item.pos || (pr && pr.pos) || 0, dur = item.dur || (pr && pr.dur) || 0;
      if (dur && pos > 0) {
        f.appendChild(NS.progEl(pos / dur * 100));
        // a progress bar says more than the rating here, and they would overlap
        var bdg = f.querySelector('.badge');
        if (bdg) bdg.remove();
      }
      return c;
    }
    if (kind === 'continue') {
      f.style.background = NS.fallbackBg(item.sn || item.n);
      var src = item.bd || item.img;
      if (src) f.appendChild(NS.pic(src, 'cover' + (item.bd || item.t === 'episode' ? '' : ' poster')));
      f.appendChild(h('div', { class: 'shade' }));
      f.appendChild(h('div', { class: 'cap' }, [
        h('b', { text: item.t === 'episode' ? (item.sn || item.n) : item.n }),
        h('span', { text: item.t === 'episode' ? (item.upnext ? 'Nästa: ' : '') + NS.epCode(item) + '  ' + item.n : (item.dur ? NS.left(item.pos || 0, item.dur) : '') })
      ]));
      if (item.dur && item.pos) f.appendChild(NS.progEl(item.pos / item.dur * 100));
      return c;
    }
    if (kind === 'live') {
      var col = NS.hueColor(item.n);
      var glow = h('div', { class: 'glow', style: 'background: radial-gradient(80% 90% at 50% 20%, ' + NS.rgba(col, 0.9) + ', rgba(24,24,26,0) 75%)' });
      f.appendChild(glow);
      if (item.img) NS.colorOf(item.img).then(function (cc) { if (cc) glow.style.background = 'radial-gradient(80% 90% at 50% 20%, ' + NS.rgba(cc, 0.9) + ', rgba(24,24,26,0) 75%)'; });
      var name = h('div', { class: 'lname', text: item.n });
      f.appendChild(name);
      if (item.img) {
        name.style.display = 'none';
        f.appendChild(NS.pic(item.img, 'logo', function () { name.style.display = ''; }));
      }
      f.appendChild(h('div', { class: 'ltag', text: 'LIVE' }));
      var now = h('div', { class: 'lnow' });
      f.appendChild(now);
      var bar = NS.progEl(0);
      bar.style.display = 'none';
      f.appendChild(bar);
      c._live = { item: item, now: now, bar: bar };
      paintLive(c);
      return c;
    }
    if (kind === 'episode') {
      f.style.background = NS.fallbackBg(item.n);
      if (item.img) f.appendChild(NS.pic(item.img, 'cover'));
      f.appendChild(h('div', { class: 'play' }, NS.icon('play')));
      var p2 = NS.state.progress[item.k];
      if (NS.isSeen(item.k) && !(p2 && p2.pos > 0)) { f.appendChild(NS.progEl(100)); f.appendChild(h('div', { class: 'seen-badge' }, [NS.icon('check'), 'Sedd'])); }
      else if (p2 && p2.dur && p2.pos > 0) f.appendChild(NS.progEl(p2.pos / p2.dur * 100));
      c.appendChild(h('div', { class: 'etxt' }, [h('b', { text: item.ep + '. ' + item.n }), h('span', { text: [item.dur ? NS.fmtDur(item.dur) : '', item.p || ''].filter(Boolean).join('  ·  ') })]));
      return c;
    }
    return c;
  }

  function setBd(c, url) {
    if (c._bd === url) return;
    c._bd = url;
    var f = c.firstChild.classList && c.firstChild.classList.contains('frame') ? c.firstChild : c.querySelector('.frame');
    var im = NS.pic(url, 'xbd', null, function () { c.classList.add('hasbd'); });
    var shade = f.querySelector('.xshade');
    f.insertBefore(im, shade);
  }

  function paintLive(c) {
    var L = c._live;
    var e = NS.epgFor(L.item.id);
    L.now.innerHTML = '';
    if (L.item.num) L.now.appendChild(h('span', { class: 'num', text: String(L.item.num) }));
    if (e && e.now) {
      L.now.appendChild(document.createTextNode(e.now.t));
      L.bar.style.display = '';
      L.bar.firstChild.style.width = Math.max(0, Math.min(100, NS.livePct(e.now))).toFixed(1) + '%';
    } else {
      L.now.appendChild(document.createTextNode(L.item.img ? L.item.n : ''));
      L.bar.style.display = 'none';
    }
  }

  /**
   * A vertically scrolling page of horizontal rows (optionally under a billboard).
   * The focused card sits at the left edge; poster cards expand to 16:9 and the row shows details underneath.
   * opts: { billboard, scroll, info, expand, onFocus(item,row,ri), onSelect(item,row,ri), onUp(), onDeep(bool), className }
   */
  function RowsView(opts) {
    this.o = opts;
    this.bb = opts.billboard || null;
    this.el = h('div', { class: opts.className || 'page' });
    this.inner = h('div', { class: 'page-inner' });
    this.el.appendChild(this.inner);
    if (this.bb) this.inner.appendChild(this.bb.el);
    this.infoEl = h('div', { class: 'rowinfo' });
    this.r = this.bb ? -1 : 0;
    this.hasFocus = true;
    var self = this;
    this._epg = function (ev) { self.refreshLive(ev.detail); };
    document.addEventListener('nsk-epg', this._epg);
    this.setRows(opts.rows || []);
  }

  RowsView.prototype.destroy = function () { document.removeEventListener('nsk-epg', this._epg); };

  RowsView.prototype.setRows = function (rows, keep) {
    var self = this;
    Array.prototype.slice.call(this.inner.querySelectorAll('.row')).forEach(function (e) { e.remove(); });
    this.rows = rows.map(function (def) {
      var k = KIND[def.kind] || KIND.poster;
      var R = { def: def, items: def.items ? def.items.slice() : [], total: def.total || (def.items ? def.items.length : 0), col: 0, cards: {}, k: k, loading: false, rendered: false };
      R.el = h('div', { class: 'row k-' + def.kind, style: 'height:' + ((def.title && k.title ? k.title : 0) + k.h) + 'rem' });
      if (def.title && k.title) R.el.appendChild(h('div', { class: 'row-title' }, [def.title, def.showCount && R.total ? h('span', { class: 'count', text: String(R.total) }) : null]));
      R.track = h('div', { class: 'track' });
      R.el.appendChild(R.track);
      self.inner.appendChild(R.el);
      if (def.kind === 'pill') self.layoutPills(R);
      if (keep && def.id === keep.rowId) {
        var ci = R.items.findIndex(function (it) { return it.k === keep.k; });
        R.col = ci >= 0 ? ci : Math.min(keep.col || 0, Math.max(0, R.total - 1));
      }
      return R;
    });
    this.inner.appendChild(this.infoEl);
    if (keep) {
      var ri = this.rows.findIndex(function (R) { return R.def.id === keep.rowId; });
      this.r = ri >= 0 ? ri : keep.r !== undefined ? Math.min(keep.r, this.rows.length - 1) : (this.bb ? -1 : 0);
    } else this.r = this.bb ? -1 : 0;
    if (!this.rows.length && !this.bb) this.r = 0;
    this.el.classList.add('instant');
    this.layout();
    void this.el.offsetWidth;
    this.el.classList.remove('instant');
  };

  RowsView.prototype.layoutPills = function (R) {
    var x = 0;
    R.pos = R.items.map(function (it) { var w = 6 + it.label.length * 1.35; var p = { x: x, w: w }; x += w + GAP; return p; });
  };

  RowsView.prototype.current = function () {
    if (this.r < 0) return this.bb ? this.bb.item : null;
    var R = this.rows[this.r];
    return R ? R.items[R.col] : null;
  };
  RowsView.prototype.currentRow = function () { return this.r >= 0 ? this.rows[this.r] : null; };
  RowsView.prototype.currentCard = function () { var R = this.currentRow(); return R ? R.cards[R.col] || null : null; };

  RowsView.prototype.focus = function (on) {
    this.hasFocus = on;
    this.el.classList.toggle('has-focus', on);
    if (this.bb) this.bb.focus(on && this.r < 0);
    var R = this.currentRow();
    if (R) this.renderRow(R, true);
  };

  RowsView.prototype.showsInfo = function (R) { return this.o.info !== false && R && R.k.info; };

  RowsView.prototype.layout = function () {
    var self = this;
    var y = this.bb ? this.bb.height + 4 : 0;
    var scroll = this.o.scroll !== false;
    this.rows.forEach(function (R, i) {
      R.y = y;
      var hgt = (R.def.title && R.k.title ? R.k.title : 0) + R.k.h + R.k.gap;
      if (i === self.r && self.showsInfo(R)) hgt += INFO_H;
      y += hgt;
    });
    var deep = scroll && this.r >= 1 && !!this.o.onDeep;
    var sy = 0;
    if (scroll && this.r >= 0 && this.rows[this.r]) sy = Math.max(0, this.rows[this.r].y - 1 + (deep ? 8 : 0) - (this.o.lead || 0));
    this.inner.style.transform = 'translateY(' + (-sy) + 'rem)';
    if (this.o.onDeep) this.o.onDeep(deep);
    if (this.bb) { this.bb.el.classList.toggle('gone', this.r >= 0 && scroll); this.bb.focus(this.hasFocus && this.r < 0); }
    this.rows.forEach(function (R, i) {
      R.el.style.transform = 'translateY(' + R.y + 'rem)';
      R.el.classList.toggle('active', i === self.r);
      R.el.classList.toggle('gone', scroll && i < self.r && (!self.o.lead || R.y + R.k.h < sy));
      var near = i >= self.r - 1 && i <= self.r + 3;
      if (near) self.renderRow(R, i === self.r); else if (R.rendered) self.unrenderRow(R);
    });
    this.el.classList.toggle('has-focus', this.hasFocus);
    this.placeInfo();
  };

  RowsView.prototype.placeInfo = function () {
    var R = this.currentRow();
    var show = this.showsInfo(R);
    this.infoEl.style.display = show ? '' : 'none';
    if (!show) return;
    var top = R.y + (R.def.title ? R.k.title : 0) + R.k.h + 2.8;
    this.infoEl.style.transform = 'translateY(' + top + 'rem)';
    this.infoEl.style.top = '0';
  };

  /** Fill the details block under the focused row. */
  RowsView.prototype.setInfo = function (it, extra) {
    var el = this.infoEl;
    var d = extra ? Object.assign({}, it, extra) : it;
    var R0 = this.currentRow();
    var topTen = !!(R0 && R0.def.kind === 'top10');
    el.classList.toggle('t10', topTen);
    var build = function () {
      el.innerHTML = '';
      if (!d) return;
      if (d.t === 'live') {
        var e = NS.epgFor(d.id);
        el.appendChild(NS.metaEl(d));
        el.appendChild(h('div', { class: 'big', text: e && e.now ? e.now.t : d.n }));
        if (e && e.next) el.appendChild(h('div', { class: 'desc', style: 'color:var(--text-2)' }, ['Härnäst ' + NS.fmtClock(e.next.s) + '  ', h('b', { text: e.next.t })]));
        else if (e && e.now && e.now.d) el.appendChild(h('div', { class: 'desc', text: e.now.d }));
        if (!e) NS.needEpg([d.id]);
        return;
      }
      if (d.t === 'episode') {
        el.appendChild(h('div', { class: 'meta' }, [h('span', { text: d.sn || '' }), h('span', { class: 'soft', text: NS.epCode(d) + '  ' + d.n })]));
        if (d.p) el.appendChild(h('div', { class: 'desc', text: d.p }));
        else if (d.dur && d.pos) el.appendChild(h('div', { class: 'desc', style: 'color:var(--text-2)', text: NS.left(d.pos, d.dur) }));
        return;
      }
      // Top 10 cards don't expand, so the title goes into the details instead
      if (topTen) el.appendChild(h('div', { class: 'big', text: d.n }));
      el.appendChild(NS.metaEl(d, { kind: true }));
      if (d.because) el.appendChild(h('div', { class: 'desc', style: 'color:var(--text-2)', text: d.because }));
      else if (d.pos && d.dur) el.appendChild(h('div', { class: 'desc', style: 'color:var(--text-2)', text: NS.left(d.pos, d.dur) }));
      else if (d.p) el.appendChild(h('div', { class: 'desc', text: d.p }));
    };
    if (this._infoK === (d && d.k)) { build(); return; }
    this._infoK = d && d.k;
    el.classList.add('fade');
    clearTimeout(this._it);
    this._it = setTimeout(function () { build(); el.classList.remove('fade'); }, 140);
  };

  /** Details arrived for an item: give its cards a backdrop. */
  RowsView.prototype.applyInfo = function (k, info) {
    if (!info || !info.bd) return;
    this.rows.forEach(function (R) {
      if (R.def.kind !== 'poster') return;
      R.items.forEach(function (it, i) { if (it.k === k) { it.bd = info.bd; var c = R.cards[i]; if (c) setBd(c, info.bd); } });
    });
  };

  RowsView.prototype.unrenderRow = function (R) {
    R.track.innerHTML = '';
    R.cards = {};
    R.rendered = false;
  };

  RowsView.prototype.cardX = function (R, i, isActive) {
    var k = R.k;
    var step = k.w + GAP;
    var x = i * step;
    if (k.xw && this.o.expand !== false && isActive && this.hasFocus && i > R.col) x += k.xw - k.w;
    return x;
  };

  RowsView.prototype.renderRow = function (R, isActive) {
    var self = this;
    R.rendered = true;
    var k = R.k;
    var step = k.w + GAP;
    var vis = R.def.kind === 'pill' ? R.items.length : Math.ceil(VIEW_W / step) + 2;
    var tx = 0;
    if (R.def.kind === 'pill') {
      var p = R.pos[R.col];
      if (p && p.x + p.w > VIEW_W - 10) tx = -(p.x + p.w - VIEW_W + 10);
    } else tx = -R.col * step;
    R.track.style.transform = 'translateX(' + tx + 'rem)';

    if (!R.items.length && R.total) {
      if (!R.track.firstChild) for (var s = 0; s < vis; s++) R.track.appendChild(h('div', { class: 'card skeleton', style: 'transform:translateX(' + (s * step) + 'rem)' }, h('div', { class: 'frame' })));
      this.load(R);
      return;
    }
    if (R.track.firstChild && R.track.firstChild.classList.contains('skeleton')) R.track.innerHTML = '';

    var from = R.def.kind === 'pill' ? 0 : R.col;
    var to = Math.min(R.items.length - 1, R.col + vis);
    for (var key in R.cards) {
      var ki = +key;
      if (ki < from || ki > to) { R.cards[key].remove(); delete R.cards[key]; }
    }
    var expand = k.xw && this.o.expand !== false;
    for (var i = from; i <= to; i++) {
      var c = R.cards[i];
      if (!c) {
        c = cardFor(R.items[i], R.def.kind, R.def, i);
        if (R.def.kind === 'pill') { c.style.width = R.pos[i].w + 'rem'; }
        (function (idx, ri) {
          c.addEventListener('click', function () {
            var at = self.rows.indexOf(ri);
            if (self.r !== at || ri.col !== idx) { self.r = at; ri.col = idx; self.layout(); self.emitFocus(); return; }
            if (self.o.onSelect) self.o.onSelect(ri.items[idx], ri.def, self.r);
          });
        })(i, R);
        R.cards[i] = c;
        R.track.appendChild(c);
      }
      var x = R.def.kind === 'pill' ? R.pos[i].x : this.cardX(R, i, isActive);
      c.style.transform = 'translateX(' + x + 'rem)';
      var foc = isActive && i === R.col;
      c.classList.toggle('focus', foc);
      if (expand) c.classList.toggle('x', foc && this.hasFocus);
    }
    if (R.def.kind === 'live') {
      var ids = [];
      for (var j = from; j <= to; j++) if (R.items[j]) ids.push(R.items[j].id);
      if (ids.length) NS.needEpg(ids);
    }
    if (R.items.length < R.total && R.col + vis + 8 >= R.items.length) this.load(R);
  };

  RowsView.prototype.load = function (R) {
    var self = this;
    var def = R.def;
    if (R.loading || !def.type || !def.cat) return;
    R.loading = true;
    NS.api.list(def.type, def.cat, R.items.length, R.items.length ? 60 : 30).then(function (res) {
      R.loading = false;
      if (self.rows.indexOf(R) < 0) return;
      R.items = R.items.concat(res.items || []);
      R.total = res.total;
      if (!res.items || !res.items.length) R.total = R.items.length;
      var ri = self.rows.indexOf(R);
      if (ri >= self.r - 1 && ri <= self.r + 3) self.renderRow(R, ri === self.r);
      if (ri === self.r) self.emitFocus();
    }).catch(function () { R.loading = false; });
  };

  RowsView.prototype.refreshLive = function (ids) {
    var set = {};
    (ids || []).forEach(function (id) { set[id] = 1; });
    this.rows.forEach(function (R) {
      if (R.def.kind !== 'live' || !R.rendered) return;
      for (var key in R.cards) { var c = R.cards[key]; if (c._live && (!ids || set[c._live.item.id])) paintLive(c); }
    });
    var cur = this.current();
    if (cur && cur.t === 'live' && (!ids || set[cur.id])) { this._infoK = null; this.setInfo(cur); }
  };

  RowsView.prototype.setRowItems = function (ri, items, col, extra) {
    var R = this.rows[ri];
    if (!R) return;
    R.items = items.slice();
    R.total = items.length;
    R.col = Math.min(col || 0, Math.max(0, items.length - 1));
    if (extra) Object.assign(R.def, extra);
    if (R.def.kind === 'pill') this.layoutPills(R);
    this.unrenderRow(R);
    if (ri >= this.r - 1 && ri <= this.r + 3) this.renderRow(R, ri === this.r);
  };

  RowsView.prototype.repaintRow = function (ri) {
    var R = this.rows[ri];
    if (!R) return;
    this.unrenderRow(R);
    this.renderRow(R, ri === this.r);
  };

  RowsView.prototype.emitFocus = function () {
    var it = this.current();
    var R = this.currentRow();
    if (R && this.showsInfo(R) && it) this.setInfo(it);
    if (it && this.o.onFocus) this.o.onFocus(it, R ? R.def : { id: 'billboard' }, this.r);
  };

  RowsView.prototype.go = function (r, col) {
    if (r !== undefined) this.r = r;
    if (col !== undefined && this.rows[this.r]) this.rows[this.r].col = col;
    this.layout();
    this.emitFocus();
  };

  RowsView.prototype.top = function () { return this.bb ? -1 : 0; };

  RowsView.prototype.onKey = function (a) {
    if (this.r < 0) {
      if (a === 'down' && this.rows.length) { this.r = 0; this.layout(); this.emitFocus(); return true; }
      if (a === 'up') { if (this.o.onUp) this.o.onUp(); return true; }
      if (a === 'left' || a === 'right') { this.bb.sel = a === 'right' ? 1 : 0; this.bb.paintBtns(); return true; }
      if (a === 'ok') {
        if (this.bb.sel === 0 && this.o.onPlay) this.o.onPlay(this.bb.item, { id: 'billboard' });
        else if (this.o.onSelect) this.o.onSelect(this.bb.item, { id: 'billboard' }, -1);
        return true;
      }
      if (a === 'play' || a === 'playpause') { if (this.o.onPlay) this.o.onPlay(this.bb.item); return true; }
      return a === 'left' || a === 'right';
    }
    var R = this.rows[this.r];
    if (!R) { if (a === 'up' && this.o.onUp) { this.o.onUp(); return true; } return false; }
    if (a === 'left') {
      if (R.col > 0) { R.col--; this.renderRow(R, true); this.emitFocus(); }
      else if (this.o.onLeft) this.o.onLeft();
      return true;
    }
    if (a === 'right') {
      if (R.col < R.items.length - 1) { R.col++; this.renderRow(R, true); this.emitFocus(); }
      return true;
    }
    if (a === 'up') {
      if (this.r > this.top()) { this.r--; this.layout(); this.emitFocus(); }
      else if (this.o.onUp) this.o.onUp();
      return true;
    }
    if (a === 'down') {
      if (this.r < this.rows.length - 1) { this.r++; this.layout(); this.emitFocus(); }
      return true;
    }
    if (a === 'ok') {
      var it = R.items[R.col];
      if (it && this.o.onSelect) this.o.onSelect(it, R.def, this.r);
      return true;
    }
    if ((a === 'play' || a === 'playpause') && this.o.onPlay) { var it2 = R.items[R.col]; if (it2) this.o.onPlay(it2, R.def); return true; }
    return false;
  };

  NS.RowsView = RowsView;
})();
