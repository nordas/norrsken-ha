/* Norrsken boot. */
(function () {
  'use strict';
  var NS = window.NS;

  NS.start = function (st) {
    NS.status = st;
    NS.loadServices();
    if (st.appName) document.title = st.appName;
    var profiles = st.profiles || [];
    // the kids profile stays on after a restart: leaving it always needs a parent's PIN
    var last = profiles.filter(function (p) { return p.id === NS.store.get('profile', ''); })[0];
    if (last && last.kids && profiles.length > 1) {
      NS.profile = last;
      NS.loadState().then(function () { NS.router.reset(new NS.Browse('home')); });
      return;
    }
    if (profiles.length === 1 && !profiles[0].hasPin) {
      NS.profile = profiles[0];
      NS.loadState().then(function () { NS.router.reset(new NS.Browse('home')); });
    } else {
      NS.router.reset(new NS.Profiles(profiles));
    }
  };

  NS.boot = function () {
    NS.router.root = document.getElementById('app');
    if (/[?&]noanim/.test(location.search)) document.body.classList.add('no-anim');
    NS.api.status().then(function (st) {
      NS.status = st;
      NS.bootVersion = st.version || '';
      if (st.ready) NS.start(st);
      else NS.router.reset(new NS.Welcome());
    }).catch(function () {
      NS.router.reset(new NS.Welcome('Når inte servern. Kontrollera att datorn med appen är igång och ladda om.'));
    });
    // a new version on the server: load it (a page left open for hours on a phone keeps running the old code), but
    // never in the middle of something playing
    var checkVersion = function () {
      if (!NS.bootVersion || document.hidden) return;
      NS.api.status().then(function (st) {
        var top = NS.router.top();
        var playing = top && top.video && !top.video.paused;
        if (st && st.version && st.version !== NS.bootVersion && !playing) location.reload();
      }).catch(function () {});
    };
    setInterval(checkVersion, 5 * 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkVersion(); });
    // keep "Live" progress bars honest without user input
    setInterval(function () {
      var top = NS.router.top();
      if (top && top.rows && top.rows.refreshLive) top.rows.refreshLive();
    }, 60000);
    setInterval(function () { NS.checkReminders(); NS.checkMatches(); }, 20000);
    // pick up reminders set on other devices
    setInterval(function () { if (NS.profile) NS.api.state().then(function (st) { NS.state.reminders = st.reminders || []; }).catch(function () {}); }, 120000);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', NS.boot);
  else NS.boot();
})();
