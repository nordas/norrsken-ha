/* Norrsken boot. */
(function () {
  'use strict';
  var NS = window.NS;

  NS.start = function (st) {
    NS.status = st;
    if (st.appName) document.title = st.appName;
    var profiles = st.profiles || [];
    if (profiles.length === 1) {
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
      if (st.ready) NS.start(st);
      else NS.router.reset(new NS.Welcome());
    }).catch(function () {
      NS.router.reset(new NS.Welcome('Når inte servern. Kontrollera att datorn med appen är igång och ladda om.'));
    });
    // keep "Live" progress bars honest without user input
    setInterval(function () {
      var top = NS.router.top();
      if (top && top.rows && top.rows.refreshLive) top.rows.refreshLive();
    }, 60000);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', NS.boot);
  else NS.boot();
})();
