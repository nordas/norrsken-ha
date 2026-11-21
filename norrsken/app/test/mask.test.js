'use strict';
/* Links with the provider account in them: shown masked, and the saved password only goes back to the same place. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
before(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-mask-'));
  process.env.PORT = '0';
  process.env.NSK_SETUP_OPEN = '1';
  app = require('../server');
});
after(() => { try { app.server.close(); } catch (_) { /* not listening */ } });

const forms = [
  'http://old.example:8080/get.php?username=anna&password=P%20W1&x=a%20b&type=m3u_plus',
  'http://h.example/get.php?username=anna&passwd=PW2',
  'http://anna:PW3@h.example/list.m3u?a=1',
  'http://h.example/live/anna/PW4/123.m3u8',
  'http://h.example/hls/anna/PW5',
  'http://h.example/x.m3u?token=PW6&key=PW7',
];

test('mask: every common link shape hides the password', () => {
  for (const u of forms) {
    const m = app._maskUrl(u);
    assert.doesNotMatch(m, /PW\d|P%20W1/, m);
    assert.match(m, /\*\*\*/, m);
  }
});

test('mask: the masked link back unchanged, or with another field edited, gets the saved password exactly', () => {
  for (const u of forms) assert.equal(app._unmaskUrl(app._maskUrl(u), u), u, u);
  const u = forms[0];
  const edited = app._maskUrl(u).replace('type=m3u_plus', 'type=m3u');
  assert.equal(app._unmaskUrl(edited, u), 'http://old.example:8080/get.php?username=anna&password=P%20W1&x=a%20b&type=m3u');
  const two = 'http://h.example/x.m3u?token=PW6&key=PW7';
  assert.equal(app._unmaskUrl(app._maskUrl(two), two), two, 'each *** gets its own value');
});

test('mask: never to another server, scheme or port, and not without a saved link', () => {
  const u = forms[0];
  const m = app._maskUrl(u);
  assert.equal(app._unmaskUrl(m.replace('old.example', 'evil.example'), u), null);
  assert.equal(app._unmaskUrl(m.replace(':8080', ':9090'), u), null);
  assert.equal(app._unmaskUrl(m.replace('http:', 'https:'), u), null);
  assert.equal(app._unmaskUrl(m, ''), null);
  assert.equal(app._unmaskUrl(m, 'enc:v1:abc'), null, 'a locked (encrypted) link is not filled in');
  assert.equal(app._unmaskUrl('http://old.example:8080/get.php?username=anna&password=new', u), 'http://old.example:8080/get.php?username=anna&password=new', 'a typed password is kept');
});

test('mask: secrets are found raw and decoded (for removing them from error messages)', () => {
  const s = app._linkSecrets(forms[0]);
  assert.ok(s.includes('P%20W1') && s.includes('P W1'));
});
