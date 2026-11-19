'use strict';
/*
 * Older Safari (an iPad that stopped at iOS 12–14) does not know three things the styles lean on, and without them
 * the page is empty: posters and cards have no height (aspect-ratio), pictures have no size (inset), and buttons
 * stick together (gap in a flex row). The server adds plain fallbacks when it sends the CSS – nothing for the screen
 * to work out:
 *   inset: a b c d        → top/right/bottom/left written out as well (every browser understands those)
 *   clamp(min, x, max)    → the same property once more before it, with x, for a browser that drops clamp()
 *   aspect-ratio: w / h   → under html.noar: a ::before with padding-top w/h (the classic way to give a box a ratio)
 *   gap in a flex row     → under html.nogap: a margin between the children
 * html.noar and html.nogap are set by a few lines in the page's head, only on a browser that lacks the feature, so a
 * new browser gets exactly the styles it had.
 */

function splitTop(v) {
  // split a value on spaces that are not inside parentheses
  const out = []; let depth = 0, cur = '';
  for (const ch of v.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && !depth) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function insetLonghands(v) {
  const imp = /!important/.test(v) ? ' !important' : '';
  const p = splitTop(v.replace(/!important/, ''));
  if (!p.length || p.length > 4) return '';
  const [t, r = t, b = t, l = r] = p;
  return 'top:' + t + imp + ';right:' + r + imp + ';bottom:' + b + imp + ';left:' + l + imp + ';';
}

// the middle value of clamp(a, b, c), at the top level of a value
function unclamp(v) {
  let out = v, guard = 0;
  while (/clamp\(/.test(out) && guard++ < 10) {
    const i = out.indexOf('clamp(');
    let depth = 0, j = i + 6, args = [], start = j;
    for (; j < out.length; j++) {
      const ch = out[j];
      if (ch === '(') depth++;
      else if (ch === ')') { if (!depth) break; depth--; }
      else if (ch === ',' && !depth) { args.push(out.slice(start, j)); start = j + 1; }
    }
    args.push(out.slice(start, j));
    if (args.length !== 3) return '';
    out = out.slice(0, i) + args[1].trim() + out.slice(j + 1);
  }
  return out;
}

function ratioPct(v) {
  const m = /^\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(v.replace(/!important/, ''));
  if (!m) return null;
  const w = +m[1], h = m[2] ? +m[2] : 1;
  if (!w || !h) return null;
  return Math.round(h / w * 100000) / 1000 + '%';
}

/** Rewrites one block of rules (no nested @media inside): returns the block and the extra rules it needs. */
function rules(css) {
  let out = '', extra = '';
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m, last = 0;
  while ((m = re.exec(css))) {
    out += css.slice(last, m.index);
    last = re.lastIndex;
    const sel = m[1].trim();
    let body = m[2];
    if (/^@/.test(sel) || /^(from|to|\d+%)/.test(sel)) { out += m[0]; continue; } // keyframes and the like
    // inset → longhands before it
    body = body.replace(/(^|;)(\s*)inset\s*:\s*([^;]+)/g, (all, a, sp, v) => {
      const lh = insetLonghands(v);
      return lh ? a + sp + lh + 'inset:' + v : all;
    });
    // clamp() → a fallback declaration before it
    body = body.replace(/(^|;)(\s*)([a-z-]+)\s*:\s*([^;]*clamp\([^;]*)/g, (all, a, sp, prop, v) => {
      const fb = unclamp(v);
      return fb ? a + sp + prop + ':' + fb + ';' + prop + ':' + v : all;
    });
    out += m[1] + '{' + body + '}';
    const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
    // aspect-ratio
    const ar = /(?:^|;)\s*aspect-ratio\s*:\s*([^;]+)/.exec(body);
    if (ar) {
      if (/auto/.test(ar[1])) extra += sels.map(s => 'html.noar ' + s + '::before').join(',') + '{display:none}';
      else {
        const pct = ratioPct(ar[1]);
        if (pct) {
          extra += sels.map(s => 'html.noar ' + s + '::before').join(',') + '{content:"";display:block;float:left;width:1px;margin-left:-1px;padding-top:' + pct + '}';
          extra += sels.map(s => 'html.noar ' + s + '::after').join(',') + '{content:"";display:table;clear:both}';
        }
      }
    }
    // gap in a flex container
    const gap = /(?:^|;)\s*(?:column-)?gap\s*:\s*([^;]+)/.exec(body);
    if (gap && /(?:^|;)\s*display\s*:\s*(?:inline-)?flex/.test(body)) {
      const g = splitTop(gap[1].replace(/!important/, ''));
      const col = /(?:^|;)\s*flex-direction\s*:\s*column/.test(body);
      const wrap = /(?:^|;)\s*flex-wrap\s*:\s*wrap|(?:^|;)\s*flex-flow\s*:[^;]*wrap/.test(body);
      const rowGap = g[0], colGap = g[1] || g[0];
      if (col) extra += sels.map(s => 'html.nogap ' + s + '>*+*').join(',') + '{margin-top:' + rowGap + '}';
      else {
        extra += sels.map(s => 'html.nogap ' + s + '>*+*').join(',') + '{margin-left:' + colGap + '}';
        if (wrap) extra += sels.map(s => 'html.nogap ' + s + '>*').join(',') + '{margin-bottom:' + rowGap + '}';
      }
    }
  }
  out += css.slice(last);
  return { out, extra };
}

/** The whole stylesheet: rules at the top and one level of @media / @supports blocks. */
function transform(css) {
  css = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '', plain = '', i = 0;
  const flush = () => { if (plain) { const r = rules(plain); out += r.out + r.extra; plain = ''; } };
  const blockEnd = (from) => { let d = 0, j = from; for (; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}') { d--; if (!d) return j; } } return css.length - 1; };
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) { plain += css.slice(i); break; }
    // an @ inside a rule's body (a url, a quoted string) is not an at-rule: only one at the top level counts
    const pre = plain + css.slice(i, at);
    if ((pre.split('{').length - pre.split('}').length) !== 0) { plain += css.slice(i, at + 1); i = at + 1; continue; }
    plain += css.slice(i, at);
    const semi = css.indexOf(';', at), brace = css.indexOf('{', at);
    if (brace < 0 || (semi >= 0 && semi < brace)) { flush(); out += css.slice(at, (semi < 0 ? css.length : semi + 1)); i = semi < 0 ? css.length : semi + 1; continue; }
    flush();
    const end = blockEnd(brace);
    const head = css.slice(at, brace);
    if (/^@(media|supports|layer)\b/.test(head)) { const r = rules(css.slice(brace + 1, end)); out += head + '{' + r.out + r.extra + '}'; }
    else out += css.slice(at, end + 1); // @keyframes, @font-face: as they are
    i = end + 1;
  }
  flush();
  return out;
}

module.exports = { transform };
