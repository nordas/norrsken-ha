'use strict';
/* The provider's account encrypted on disk with the key from Home Assistant's secrets.yaml. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-vault-'));
const secrets = path.join(dir, 'secrets.yaml');
process.env.NSK_SECRETS_FILE = secrets;
const vault = require('../lib/vault');
const { Store } = require('../lib/store');

const plain = { configured: true, source: 'xtream', xtream: { server: 'http://p.example:8080', username: 'oskar', password: 'hemligt123' }, m3u: { url: 'http://p.example/get.php?username=oskar&password=hemligt123' } };
const onDisk = (d) => fs.readFileSync(path.join(d, 'config.json'), 'utf8');
const fresh = () => { const d = fs.mkdtempSync(path.join(dir, 'data-')); fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(plain)); return d; };

test('vault: no key → nothing changes, the setup page offers the line to add', () => {
  fs.writeFileSync(secrets, 'wifi: abc\n');
  vault._reset();
  const d = fresh();
  const st = new Store(d);
  assert.equal(st.config.xtream.password, 'hemligt123');
  assert.match(onDisk(d), /hemligt123/);
  const s = vault.status();
  assert.equal(s.on, false);
  assert.match(s.line, /^norrsken_nyckel: \S{20,}$/);
});

test('vault: with the key the account is encrypted on disk and readable in the app; a wrong key locks it', () => {
  fs.writeFileSync(secrets, 'wifi: abc\nnorrsken_nyckel: "Zq8-very-long-random-key-for-tests"  # Norrsken\n');
  vault._reset();
  const d = fresh();
  let st = new Store(d);
  assert.equal(st.config.xtream.password, 'hemligt123');
  assert.equal(st.config.m3u.url, plain.m3u.url);
  const disk = onDisk(d);
  assert.doesNotMatch(disk, /hemligt123|oskar/);
  assert.match(disk, /enc:v1:/);
  assert.match(disk, /p\.example:8080/); // the server address is not secret
  // a restart reads it back
  st = new Store(d);
  assert.equal(st.config.xtream.username, 'oskar');
  assert.equal(st.locked, false);
  // the key changed: locked, the encrypted text is kept untouched when saving something else
  fs.writeFileSync(secrets, 'norrsken_nyckel: another-long-random-key-abcdefgh\n');
  vault._reset();
  st = new Store(d);
  assert.equal(st.locked, true);
  assert.ok(vault.isSealed(st.config.xtream.password));
  st.config.options = { appName: 'X' };
  st.saveConfig();
  assert.equal(JSON.parse(onDisk(d)).xtream.password, JSON.parse(disk).xtream.password);
  // typing the account in again unlocks it, encrypted with the new key
  st.config.xtream.username = 'oskar'; st.config.xtream.password = 'nytt456'; st.config.m3u.url = '';
  st.saveConfig();
  assert.equal(st.locked, false);
  assert.doesNotMatch(onDisk(d), /nytt456/);
  assert.equal(new Store(d).config.xtream.password, 'nytt456');
});
