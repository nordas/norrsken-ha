'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

// A guide that says 19:45 for a match that really starts at 18:45 Swedish time (the whole guide is an hour late).
const XML = '<?xml version="1.0"?><tv><programme start="20261029194500 +0100" stop="20261029214500 +0100" channel="c1"><title>Luleå Björklöven</title></programme></tv>';

function run(offset) {
  const code = `
    const { Epg } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'epg.js'))});
    const http = require('http');
    const srv = http.createServer((q, r) => { r.setHeader('Content-Type', 'application/xml'); r.end(${JSON.stringify(XML)}); }).listen(0, async () => {
      const e = new Epg();
      await e.load('http://127.0.0.1:' + srv.address().port + '/x.xml', { now: Date.UTC(2026, 9, 29, 17, 30) });
      const l = e.map.get('c1');
      process.stdout.write('RESULT ' + JSON.stringify(l.map(p => new Date(p[0]).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }))) + '\\n');
      srv.close(); process.exit(0);
    });`;
  const env = Object.assign({}, process.env, offset === undefined ? {} : { NSK_EPG_OFFSET_MIN: String(offset) });
  const out = execFileSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  return JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
}

test('guide times are shown as the guide says, and epg_offset moves them (-60 → 18:45)', () => {
  assert.deepEqual(run(undefined), ['19:45']);
  assert.deepEqual(run(0), ['19:45']);
  assert.deepEqual(run(-60), ['18:45']);
  assert.deepEqual(run(30), ['20:15']);
});
