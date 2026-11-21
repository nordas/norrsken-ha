'use strict';
/* /setup always has a PIN (it holds the provider account), and guessing is slowed down. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app, base;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-pin-'));
  process.env.PORT = '0';
  delete process.env.NSK_SETUP_OPEN;
  delete process.env.SETUP_PIN;
  app = require('../server');
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
});
after(() => app.server.close());

const get = (pin) => fetch(base + '/api/setup', { headers: pin ? { 'X-Pin': pin } : {} });

test('setup: a PIN is made on the first start and asked for', async () => {
  const st = await (await fetch(base + '/api/status')).json();
  assert.equal(st.pinRequired, true);
  assert.equal((await get('')).status, 401);
  const pin = app.store.config.setupPin;
  assert.match(pin, /^\d{6}$/);
  const r = await get(pin);
  assert.equal(r.status, 200);
  const cfg = await r.json();
  assert.ok(!JSON.stringify(cfg).includes(pin), 'the PIN never goes back out');
  // the AirPlay test page asks for the same PIN (it shows what is recorded and starts test encodings)
  const a0 = await fetch(base + '/airtest');
  assert.equal(a0.status, 401);
  assert.match(await a0.text(), /name="pin"/, 'a page that asks for it');
  assert.equal((await fetch(base + '/airtest?pin=000000')).status, 401);
  // it stays the same after a restart (saved)
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'config.json'), 'utf8')).setupPin, pin);
});

test('setup: five wrong PINs and the right one has to wait', async () => {
  const pin = app.store.config.setupPin;
  for (let i = 0; i < 5; i++) assert.equal((await get('000000')).status, 401);
  const r = await get(pin);
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /vänta/);
});
