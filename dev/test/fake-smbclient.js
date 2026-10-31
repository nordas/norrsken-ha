#!/usr/bin/env node
'use strict';
// A stand-in for smbclient in tests: the "share" is a folder (FAKE_SMB_ROOT). Understands the commands Norrsken
// uses (cd, mkdir, rmdir, ls, put, get, del) and answers with smbclient's own wording, including NT_STATUS errors.
const fs = require('fs');
const path = require('path');

const root = process.env.FAKE_SMB_ROOT;
const args = process.argv.slice(2);
const cmdArg = args[args.indexOf('-c') + 1] || '';
const share = args[0];
if (process.env.FAKE_SMB_DOWN) { console.log('do_connect: Connection to host failed (Error NT_STATUS_CONNECTION_REFUSED)'); process.exit(1); }
if (process.env.FAKE_SMB_LEGACY_ONLY && !args.includes('--option=client ntlmv2 auth=no')) { console.log('session setup failed: NT_STATUS_LOGON_FAILURE'); process.exit(1); }
if ((process.env.PASSWD || '') !== (process.env.FAKE_SMB_PASS || '')) { console.log('session setup failed: NT_STATUS_LOGON_FAILURE'); process.exit(1); }
if (process.env.FAKE_SMB_LOG) fs.appendFileSync(process.env.FAKE_SMB_LOG, JSON.stringify({ args, hasPassOnArgv: args.some(a => a.includes(process.env.PASSWD || '\u0000')) }) + '\n');

let cwd = '';
const abs = (p) => path.join(root, cwd, p.replace(/\\/g, '/'));
const split = (s) => { const out = []; const re = /"([^"]*)"|(\S+)/g; let m; while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]); return out; };
const err = (code, what) => console.log(code + ' ' + what);
const df = () => console.log('\n\t\t100000000 blocks of size 1024. 90000000 blocks available');

for (const raw of cmdArg.split(';').map(x => x.trim()).filter(Boolean)) {
  const [c, a, b] = split(raw);
  try {
    if (c === 'cd') { if (!fs.existsSync(abs(a))) { err('NT_STATUS_OBJECT_PATH_NOT_FOUND', 'cd ' + a); continue; } cwd = path.join(cwd, a); }
    else if (c === 'mkdir') { if (fs.existsSync(abs(a))) err('NT_STATUS_OBJECT_NAME_COLLISION', 'making remote directory ' + a); else fs.mkdirSync(abs(a)); }
    else if (c === 'rmdir') { try { fs.rmdirSync(abs(a)); } catch (e) { err('NT_STATUS_OBJECT_NAME_NOT_FOUND', 'removing remote directory ' + a); } }
    else if (c === 'put') { fs.copyFileSync(path.resolve(a), abs(b)); console.log('putting file ' + a + ' as \\' + b); }
    else if (c === 'get') { if (!fs.existsSync(abs(a))) { err('NT_STATUS_OBJECT_NAME_NOT_FOUND', 'opening remote file \\' + a); continue; } fs.copyFileSync(abs(a), path.resolve(b)); }
    else if (c === 'del') {
      const dir = path.dirname(abs(a));
      const base = path.basename(a);
      if (!fs.existsSync(dir)) { err('NT_STATUS_OBJECT_PATH_NOT_FOUND', 'deleting remote file ' + a); continue; }
      for (const f of fs.readdirSync(dir)) if (base === '*' ? fs.statSync(path.join(dir, f)).isFile() : f === base) fs.rmSync(path.join(dir, f));
    } else if (c === 'ls') {
      const dir = a && a.endsWith('/*') ? abs(a.slice(0, -2)) : abs(a || '');
      if (!fs.existsSync(dir)) { err('NT_STATUS_OBJECT_NAME_NOT_FOUND', 'listing ' + a); continue; }
      const list = fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
      for (const f of list) { const st = fs.statSync(path.join(dir, f)); console.log('  ' + f.padEnd(30) + (st.isDirectory() ? 'D' : 'A').padStart(2) + String(st.isDirectory() ? 0 : st.size).padStart(10) + '  Sat Oct 31 08:01:16 2026'); }
      df();
    } else err('NT_STATUS_NOT_SUPPORTED', raw);
  } catch (e) { err('NT_STATUS_UNSUCCESSFUL', e.message); }
}
