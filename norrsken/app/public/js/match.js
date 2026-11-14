/* Norrsken – the match page: one match, as TV4 Play shows it, with a twist.
 *
 * The two clubs' colours meet across the top with their badges and a clock that counts down (or the live minute),
 * then the channel and time chips, the title, the buttons, the guide's text, where it is on, the two teams to follow
 * (a tap makes a team a favourite) and the favourites' other matches. One screen for the TV (remote) and the phone.
 */
(function () {
  'use strict';
  var h = NS.h;
  var mobile = function () { return document.documentElement.classList.contains('m'); };

  function sameMatch(a, b) { return a && b && a.title === b.title && Math.abs(a.s - b.s) <= 45 * 60e3; }
  function stateOf(m) { var n = Date.now(); return n < m.s ? 'soon' : n < m.e ? 'live' : 'ended'; }

  function MatchPage(m) {
    var self = this;
    this.m = Object.assign({}, m);
    this.others = [];
    this.focus = { row: 0, col: 0 };
    this.el = h('div', { class: 'screen matchpage' + (mobile() ? ' m-screen' : '') });
    this.render();
    NS.api.get('api/sport').then(function (r) { self.take(r); }).catch(function () {});
  }

  /** The newest from the server: this match (recording, text, channels) and the other matches. */
  MatchPage.prototype.take = function (r) {
    var self = this;
    var all = (r.upcoming || []).slice();
    if (r.match && !all.some(function (x) { return sameMatch(x, r.match); })) all.unshift(r.match);
    var me = all.filter(function (x) { return sameMatch(x, self.m); })[0];
    if (me) this.m = Object.assign({}, this.m, me);
    this.others = all.filter(function (x) { return !sameMatch(x, self.m); }).slice(0, 8);
    this.render();
  };

  MatchPage.prototype.btns = function () {
    var self = this, m = this.m, st = stateOf(m);
    var rec = !!(m.rec && m.rec.id);
    var out = [];
    var play = function () { NS.playItem(m.ch, { list: m.chans || [m.ch], cat: m.ch.cat }); };
    if (st === 'live') {
      if (rec) {
        out.push({ label: 'Från start', icon: 'play', primary: true, go: function () { NS.watchRec(m, false); } });
        out.push({ label: 'Live', icon: 'live', go: function () { NS.watchRec(m, true); } });
      } else out.push({ label: 'Titta live', icon: 'play', primary: true, go: play });
    } else if (st === 'soon') {
      if (m.s - Date.now() < 30 * 60e3) out.push({ label: 'Titta', icon: 'play', primary: true, go: function () { NS.watchMatch(Object.assign({}, m, { state: 'soon' }), m.chans || [m.ch], m.ch.cat); } });
      var rem = NS.hasReminder(m.ch.id, m.s);
      out.push({ label: rem ? 'Påminnelse satt' : 'Påminn mig', icon: rem ? 'check' : 'bell', primary: !out.length, go: function () { NS.toggleReminder(m.ch, { s: m.s, t: m.title }); self.render(); } });
    } else if (rec) out.push({ label: 'Se matchen', icon: 'play', primary: true, go: function () { NS.watchRec(m, false); } });
    if (rec && m.rec.recording) out.push({ label: 'Avbryt inspelning', icon: 'x', go: function () { NS.stopMatchRec(null, function () { m.rec.recording = false; self.render(); }); } });
    return out;
  };

  MatchPage.prototype.render = function () {
    var self = this, m = this.m, st = stateOf(m);
    var sides = m.sides || [];
    var c1 = (sides[0] && sides[0].col && sides[0].col[0]) || (m.team && m.team.col && m.team.col[0]) || '#2a2a2e';
    var c2 = (sides[1] && sides[1].col && sides[1].col[0]) || '#1b1c22';
    var el = this.el;
    el.innerHTML = '';
    this.rows = [];
    var row = function (list) { if (list.length) self.rows.push(list); return list; };

    // the hero: the two clubs' colours meet at an angle; the badges big; the clock in between
    this.clock = h('div', { class: 'mp-clock' });
    var hero = h('div', { class: 'mp-hero' + (st === 'live' ? ' live' : ''), style: '--c1:' + c1 + ';--c2:' + c2 }, [
      h('div', { class: 'mp-split' }),
      sides.length === 2 ? h('div', { class: 'mp-face' }, [
        h('div', { class: 'mp-side' }, [NS.teamBadge(sides[0], 'mp-badge'), h('b', { text: sides[0].n })]),
        this.clock,
        h('div', { class: 'mp-side' }, [NS.teamBadge(sides[1], 'mp-badge'), h('b', { text: sides[1].n })])
      ]) : h('div', { class: 'mp-face solo' }, [h('b', { class: 'mp-solo', text: m.title }), this.clock])
    ]);
    if (mobile()) el.appendChild(h('header', { class: 'm-dhead mp-head' }, [h('button', { class: 'm-icon m-back', 'aria-label': 'Tillbaka', onclick: NS.mBack }, NS.icon('back'))]));
    el.appendChild(hero);

    var body = h('div', { class: 'mp-body' });
    el.appendChild(body);
    var chName = m.foreign && st !== 'live' ? 'Svensk kanal kommer' : (m.chName || (m.ch && m.ch.n) || '');
    body.appendChild(h('div', { class: 'mp-chips' }, [h('span', { class: 'mp-ch', text: chName }), h('span', { class: 'mp-when' + (st === 'live' ? ' live' : ''), text: st === 'live' ? 'Live nu' : st === 'ended' ? 'Slut' : NS.matchWhen(m.s) })]));
    body.appendChild(h('h1', { class: 'mp-title', text: m.title }));
    var lab = String(m.label || '').split(' · ').filter(Boolean);
    var tags = lab.map(function (x) { return h('span', { text: x }); });
    if (m.compImg) tags.unshift(h('span', { class: 'mp-comp' }, h('img', { src: m.compImg, alt: '' }))); // the league's or tournament's logo
    if (m.autoRec) tags.push(h('span', { class: 'mp-rec' + (m.rec && m.rec.recording ? ' on' : '') }, [h('i'), m.rec && m.rec.recording ? 'Spelas in' : m.rec ? 'Inspelad' : 'Spelas in automatiskt']));
    body.appendChild(h('div', { class: 'mp-tags' }, tags));

    var bs = row(this.btns().map(function (b) {
      return h('button', { class: 'btn mp-btn' + (b.primary ? ' primary' : ''), onclick: b.go }, [NS.icon(b.icon), b.label]);
    }));
    body.appendChild(h('div', { class: 'mp-btns' }, bs));
    if (m.recWait) body.appendChild(h('p', { class: 'mp-note', text: m.recWait }));
    if (m.d) body.appendChild(h('p', { class: 'mp-desc', text: m.d }));
    if (m.foreign && st !== 'live') body.appendChild(h('p', { class: 'mp-note', text: 'Just nu finns matchen bara hos en utländsk kanal. Den svenska (TV4 Play) visas här när den läggs ut, oftast några timmar innan.' }));

    // where it is on (Swedish first, the best picture first)
    var chans = (m.chans || []).slice(0, 6);
    if (chans.length > 1 && !(m.foreign && st !== 'live')) {
      body.appendChild(h('h2', { class: 'mp-h2', text: 'Sänds på' }));
      body.appendChild(h('div', { class: 'mp-chans' }, row(chans.map(function (c, i) {
        return h('button', { class: 'mp-chan' + (i === 0 ? ' best' : ''), onclick: function () { NS.playItem(c, { list: chans, cat: c.cat }); } }, [c.n.replace(/^\[[^\]]+\]\s*\([^)]*\)\s*\d\d:\d\d\s*/, ''), i === 0 ? h('small', { text: 'Bäst bild' }) : null]);
      }))));
    }

    // the two teams: a tap makes one a favourite (or not)
    var known = sides.filter(function (t) { return t && t.id; });
    if (known.length) {
      var favs = NS.prefTeams();
      body.appendChild(h('h2', { class: 'mp-h2', text: 'Följ ditt lag' }));
      body.appendChild(h('div', { class: 'mp-teams' }, row(known.map(function (t) {
        var on = favs.indexOf(t.id) >= 0;
        return h('button', { class: 'mp-team' + (on ? ' on' : ''), style: '--tc:' + ((t.col && t.col[0]) || '#333'), onclick: function () {
          var sel = NS.prefTeams(), i = sel.indexOf(t.id);
          if (i >= 0) sel.splice(i, 1); else sel.push(t.id);
          NS.state.prefs = NS.state.prefs || {};
          NS.state.prefs.team = sel[0] || 'none';
          NS.setPref('teams', sel).then(function () { NS.toast(i >= 0 ? t.n + ' är inte längre favorit' : t.n + ' är nu ett favoritlag', i >= 0 ? 'x' : 'check'); self.render(); });
        } }, [NS.teamBadge(t, 'mp-tbadge'), h('b', { text: t.n }), h('span', { class: 'mp-star', text: on ? '★ Favorit' : '☆ Följ' })]);
      }))));
    }

    // the favourites' other matches
    if (this.others.length) {
      body.appendChild(h('h2', { class: 'mp-h2', text: 'Fler matcher' }));
      body.appendChild(h('div', { class: 'mp-more' }, row(this.others.map(function (o) {
        var on = Date.now() >= o.s;
        var s0 = (o.sides && o.sides[0]) || {}, s1 = (o.sides && o.sides[1]) || {};
        var oc = o.compImg ? h('span', { class: 'mp-mcomp' }, h('img', { src: o.compImg, alt: '' })) : null;
      return h('button', { class: 'mp-mcard', style: '--c1:' + ((s0.col && s0.col[0]) || '#333') + ';--c2:' + ((s1.col && s1.col[0]) || '#222'), onclick: function () { NS.router.replace ? NS.router.replace(new MatchPage(o)) : NS.router.push(new MatchPage(o)); } }, [
          h('div', { class: 'mp-mtop' }, [h('span', { class: 'mp-ch', text: o.foreign && !on ? 'Svensk kanal kommer' : (o.chName || o.ch.n) }), h('span', { class: 'mp-when' + (on ? ' live' : ''), text: on ? 'Live' : NS.matchWhen(o.s) })]),
          o.sides ? h('div', { class: 'mp-mvs' }, [NS.teamBadge(s0, 'mp-mb'), NS.teamBadge(s1, 'mp-mb'), oc]) : oc,
          h('b', { text: o.title }),
          h('span', { text: String(o.label || '').split(' · ').pop() })
        ]);
      }))));
    }
    this.tick();
    this.paintFocus();
  };

  /** The clock in the hero: a countdown before, the minutes played during, the result line after. */
  MatchPage.prototype.tick = function () {
    var m = this.m, st = stateOf(m), now = Date.now();
    if (!this.clock) return;
    if (st === 'soon') {
      var s = Math.ceil((m.s - now) / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      this.clock.innerHTML = '';
      this.clock.appendChild(h('span', { class: 'mp-cl-t', text: d ? d + ' d ' + hh + ' h' : p(hh) + ':' + p(mm) + ':' + p(ss) }));
      this.clock.appendChild(h('span', { class: 'mp-cl-s', text: d ? NS.matchWhen(m.s) : 'till start' }));
    } else if (st === 'live') {
      var min = Math.max(0, Math.floor((now - m.s) / 60e3));
      this.clock.innerHTML = '';
      this.clock.appendChild(h('span', { class: 'mp-cl-live', text: 'LIVE' }));
      this.clock.appendChild(h('span', { class: 'mp-cl-s', text: 'sedan ' + NS.fmtClock(m.s) + ' · ' + min + ' min' }));
    } else {
      this.clock.innerHTML = '';
      this.clock.appendChild(h('span', { class: 'mp-cl-t', text: 'Slut' }));
    }
  };

  // the remote: up/down between rows (buttons, channels, teams, matches), left/right within one
  MatchPage.prototype.paintFocus = function () {
    if (mobile()) return;
    var f = this.focus;
    if (f.row >= this.rows.length) f.row = Math.max(0, this.rows.length - 1);
    var r = this.rows[f.row] || [];
    if (f.col >= r.length) f.col = Math.max(0, r.length - 1);
    this.rows.forEach(function (list, ri) { list.forEach(function (b, ci) { b.classList.toggle('focus', ri === f.row && ci === f.col); }); });
    var cur = r[f.col];
    if (cur && cur.scrollIntoView) {
      var body = this.el;
      var top = cur.getBoundingClientRect().top + body.scrollTop - body.getBoundingClientRect().top;
      body.scrollTo({ top: f.row === 0 ? 0 : Math.max(0, top - body.clientHeight * 0.45), behavior: 'smooth' });
      var strip = cur.parentNode;
      if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: Math.max(0, cur.offsetLeft - strip.clientWidth * 0.3), behavior: 'smooth' });
    }
  };
  MatchPage.prototype.onKey = function (a) {
    var f = this.focus;
    if (a === 'back') { NS.router.pop(); return; }
    if (a === 'up' && f.row > 0) { f.row--; f.col = 0; }
    else if (a === 'down' && f.row < this.rows.length - 1) { f.row++; f.col = 0; }
    else if (a === 'left' && f.col > 0) f.col--;
    else if (a === 'right' && this.rows[f.row] && f.col < this.rows[f.row].length - 1) f.col++;
    else if (a === 'ok' || a === 'play') { var b = (this.rows[f.row] || [])[f.col]; if (b) b.click(); return; }
    this.paintFocus();
  };

  MatchPage.prototype.activate = function () {
    var self = this;
    clearInterval(this._t);
    if (mobile()) window.scrollTo(0, 0);
    this.render();
    this._t = setInterval(function () {
      self.tick();
      // the state changes (the match starts, a recording appears): ask the server again now and then
      if (++self._n % 30 === 0) NS.api.get('api/sport').then(function (r) { if (NS.router.top() === self) self.take(r); }).catch(function () {});
    }, 1000);
    this._n = 0;
  };
  MatchPage.prototype.deactivate = function () { clearInterval(this._t); };
  MatchPage.prototype.destroy = function () { clearInterval(this._t); };

  NS.MatchPage = MatchPage;
  /** Open a match: a card's match, the start page's, a row in the list. */
  NS.openMatch = function (m) { NS.preview && NS.preview.stop && NS.preview.stop(); NS.router.push(new MatchPage(m)); };
})();
