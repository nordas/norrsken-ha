'use strict';
// Home Assistant silently drops an add-on whose config.yaml it cannot read: no update shows up. Its schema strings
// only allow a small set of forms, and the ranges in int(min,max) cannot be negative.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '..', '..', 'norrsken', 'config.yaml'), 'utf8');
const section = (name) => {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l === name + ':');
  const out = {};
  for (let k = i + 1; k < lines.length && /^\s+\S/.test(lines[k]); k++) { const m = /^\s+([\w]+):\s*(.*)$/.exec(lines[k]); if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
  return out;
};

test('every schema entry uses a form Home Assistant accepts, and every option has one', () => {
  const schema = section('schema');
  const options = section('options');
  assert.ok(Object.keys(schema).length >= 5);
  const OK = /^(bool|email|url|port|str|password|int|float)(\((\d+)?,(\d+)?\))?\??$|^match\(.+\)\??$|^list\(.+\)\??$/;
  for (const [k, v] of Object.entries(schema)) assert.match(v, OK, 'schema for ' + k + ' is "' + v + '"');
  for (const k of Object.keys(options)) assert.ok(k in schema, 'option ' + k + ' has no schema entry');
  assert.match(text, /^version: "\d+\.\d+\.\d+"$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'norrsken', 'app', 'package.json'), 'utf8'));
  assert.equal(text.match(/^version: "([\d.]+)"$/m)[1], pkg.version, 'config.yaml and package.json say the same version');
});
