'use strict';
/**
 * Where the big files go: the pause buffer, match recordings and downloads.
 *
 * NSK_STORAGE_DIR (the add-on's "storage_dir" setting) points at a folder on a network disk that Home Assistant
 * has mounted (Settings → System → Storage → Add network storage, e.g. the AirPort Extreme's disk, which then
 * shows up as /media/<name>). Norrsken keeps everything under <dir>/norrsken. If the folder is missing or can't be
 * written to (disk off, share not mounted yet) everything falls back to the add-on's own disk and says so.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WANT = String(process.env.NSK_STORAGE_DIR || '').trim();
const LOCAL_PAUSE = path.join(os.tmpdir(), 'norrsken-pause');
const LOCAL_DL = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'downloads');
const CHECK_MS = 30e3;

let state = { want: WANT, ok: false, err: '', at: 0 };

/** Can we write in <WANT>/norrsken? Checked at most every 30 s (the share may be mounted after we start). */
function check(force) {
  if (!WANT) return state;
  if (!force && Date.now() - state.at < CHECK_MS) return state;
  const base = path.join(WANT, 'norrsken');
  let ok = false;
  let err = '';
  try {
    if (!fs.existsSync(WANT)) throw new Error('Mappen finns inte (är nätverkslagringen monterad i Home Assistant?)');
    fs.mkdirSync(base, { recursive: true });
    const f = path.join(base, '.write-test');
    fs.writeFileSync(f, String(Date.now()));
    fs.rmSync(f, { force: true });
    ok = true;
  } catch (e) { err = e.code === 'EACCES' || e.code === 'EROFS' ? 'Mappen går inte att skriva i' : e.message; }
  if (ok !== state.ok || err !== state.err) console.log(ok ? '[lagring] använder ' + base : '[lagring] ' + WANT + ' fungerar inte: ' + err + ' – använder tillägget egen disk');
  state = { want: WANT, ok, err, at: Date.now(), base };
  return state;
}

/** Pause buffer and match recordings. */
function pauseDir() { const s = check(); return s.ok ? path.join(s.base, 'pause') : LOCAL_PAUSE; }
/** Downloaded films and episodes (kept until deleted). */
function downloadDir() { const s = check(); return s.ok ? path.join(s.base, 'downloads') : LOCAL_DL; }

function freeBytes(dir) {
  try { const st = fs.statfsSync(dir); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch (_) { return { free: 0, total: 0 }; }
}

/** For the status page: where things are kept and how much room there is. */
function info() {
  const s = check();
  const dir = downloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* reported by the sizes */ }
  const sz = freeBytes(dir);
  return {
    configured: !!WANT, ok: WANT ? s.ok : true, onNetwork: !!WANT && s.ok, dir: WANT ? WANT : '', err: WANT ? s.err : '',
    freeGb: Math.round(sz.free / 1e8) / 10, totalGb: Math.round(sz.total / 1e8) / 10,
    smb: require('./smb').info(),
  };
}

/** Is the network folder mounted and writable right now? (A Time Capsule through smbclient is only used when it is not.) */
function mounted() { return !!WANT && check().ok; }

module.exports = { pauseDir, downloadDir, freeBytes, info, check, mounted };
