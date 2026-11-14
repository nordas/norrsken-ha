'use strict';
/**
 * Which picture is which: the user's own crest and logo files (Norrsken ships none), named the way they come from
 * the sites that collect them ("bayern-munich-logo-footylogos.svg", "bosnia-and-herzegovina-national-team-logo-…",
 * "uefa-champions-league-logo-footylogos.svg", "sweden-mens-national-ice-hockey-team-seeklogo-2.svg").
 *
 * A picture is kept under a key:
 *   a team Norrsken follows        lulea, man-utd, tre-kronor, sverige-fotboll …  (sport.TEAMS)
 *   a country's national team      nat-bih, nat-eng …                              (its three letters)
 *   a competition                  comp-champions-league, comp-shl …
 *   any other club                 club-bayern-munich, club-real-madrid …
 * and found again from a side's name in the TV guide ("Bayern München", "Bosnien-Hercegovina", "Real Madrid").
 */
const sport = require('./sport');

/** Competitions by the words in a file name or in the guide's competition: key and the name shown. */
const COMPS = [
  [/champions[- ]?hockey[- ]?league|\bchl\b/, 'comp-chl', 'CHL'],
  [/champions[- ]?league/, 'comp-champions-league', 'Champions League'],
  [/europa[- ]?league/, 'comp-europa-league', 'Europa League'],
  [/conference[- ]?league/, 'comp-conference-league', 'Conference League'],
  [/nations[- ]?league/, 'comp-nations-league', 'Nations League'],
  [/premier[- ]?league/, 'comp-premier-league', 'Premier League'],
  [/hockeyallsvenskan/, 'comp-hockeyallsvenskan', 'Hockeyallsvenskan'],
  [/damallsvenskan/, 'comp-damallsvenskan', 'Damallsvenskan'],
  [/allsvenskan/, 'comp-allsvenskan', 'Allsvenskan'],
  [/superettan/, 'comp-superettan', 'Superettan'],
  [/(^|[- ])shl([- ]|$)|svenska[- ]hockeyligan/, 'comp-shl', 'SHL'],
  [/fa[- ]?cup/, 'comp-fa-cupen', 'FA-cupen'],
  [/carabao|efl[- ]?cup|league[- ]?cup|ligacupen/, 'comp-ligacupen', 'Ligacupen'],
  [/la[- ]?liga/, 'comp-la-liga', 'La Liga'],
  [/serie[- ]a\b/, 'comp-serie-a', 'Serie A'],
  [/bundesliga/, 'comp-bundesliga', 'Bundesliga'],
  [/ligue[- ]?1/, 'comp-ligue-1', 'Ligue 1'],
  [/vm[- ]?kval|world[- ]?cup[- ]?qualif/, 'comp-vm-kval', 'VM-kval'],
  [/em[- ]?kval|euro[- ]?qualif/, 'comp-em-kval', 'EM-kval'],
  [/euro[- ]?hockey[- ]?tour/, 'comp-euro-hockey-tour', 'Euro Hockey Tour'],
  [/fifa[- ]?world[- ]?cup/, 'comp-vm', 'VM'],
  [/uefa[- ]?euro\b/, 'comp-em', 'EM'],
];
/** Words that say nothing about which club it is. */
const NOISE = new Set(['logo', 'logga', 'logotyp', 'footylogos', 'seeklogo', 'crest', 'emblem', 'badge', 'icon', 'ikon', 'transparent', 'vector', 'png', 'svg', 'hd', 'official', 'new', 'old']);
const GENERIC = new Set(['fc', 'cf', 'ac', 'afc', 'sc', 'sk', 'fk', 'if', 'ik', 'bk', 'ff', 'cd', 'ud', 'sv', 'vfb', 'vfl', 'tsg', 'rc', 'rb', 'as', 'ss', 'ssc', 'us', 'club', 'calcio', 'football', 'futbol', 'fotboll', 'de', 'the', 'and', 'of', 'real', 'sporting', 'united', 'city', 'hotspur', 'albion', 'national', 'team', 'mens', 'men', 'womens', 'women']);

/** Lower case, no accents, words split by spaces; the extension, sizes, "(1)" and trailing numbers gone. */
function words(s) {
  return String(s || '').replace(/\.[a-z0-9]{2,5}$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/\(\d+\)/g, ' ').replace(/\b\d{2,4}x\d{2,4}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter(w => w && !NOISE.has(w)).join(' ').replace(/ \d$/, '').trim();
}
function slug(s) { return words(s).replace(/ /g, '-').slice(0, 40).replace(/-+$/, ''); }
const distinct = (w) => w.split(' ').filter(x => x.length >= 3 && !GENERIC.has(x) && !/^\d+$/.test(x));

/** The key a competition's name has ("Champions League" → comp-champions-league), or ''. */
function compKey(name) {
  const w = words(name);
  const c = COMPS.find(x => x[0].test(w));
  return c ? c[1] : '';
}
/** A country's national team key ("Bosnien-Hercegovina" → nat-bih), or ''. */
function nationKey(name) {
  const c = sport.countryOf(name);
  return c ? 'nat-' + c.ab.toLowerCase() : '';
}

/** Which team Norrsken follows a file is for (its id, name, short name or abbreviation as whole words), or null. */
function followedTeam(w, abbr) {
  let best = null, bestLen = 0;
  for (const t of sport.TEAMS) {
    if (t.group === 'Landslag') continue; // Sweden's national teams are read below, by sport
    for (const n of [t.id.replace(/-/g, ' '), t.name, t.short, abbr[t.id]].filter(Boolean).map(words)) {
      if (!n) continue;
      const ww = ' ' + w + ' ';
      const len = n === w ? 1000 + n.length : (n.length >= 4 && (ww.includes(' ' + n + ' ') || ww.includes(' ' + n + 's '))) ? n.length : (n.length === 3 && w.split(' ')[0] === n && w.split(' ').length <= 2) ? 3 : 0;
      if (len > bestLen) { best = t; bestLen = len; }
    }
  }
  return best;
}

/**
 * The key for an uploaded file, from its name: { key, label } or null when it says nothing Norrsken can use.
 * `abbr`: the teams' abbreviations (LHF, FBK …).
 */
function keyForFile(fileName, abbr = {}) {
  const w = words(fileName);
  if (!w) return null;
  // Sweden's own national teams, by sport and men/women
  if (/^(sweden|sverige)\b/.test(w)) {
    const dam = /\b(women|womens|dam|damer)\b/.test(w);
    const pick = (id) => ({ key: id, label: sport.TEAMS.find(t => t.id === id).name });
    if (/hockey/.test(w)) return pick(/junior|u20/.test(w) ? 'juniorkronorna' : dam ? 'damkronorna' : 'tre-kronor');
    if (/handball|handboll/.test(w)) return pick(dam ? 'sverige-handboll-dam' : 'sverige-handboll');
    if (/floorball|innebandy/.test(w)) return pick(dam ? 'sverige-innebandy-dam' : 'sverige-innebandy');
    if (/bandy/.test(w)) return pick(dam ? 'sverige-bandy-dam' : 'sverige-bandy');
    if (/basket/.test(w)) return pick(dam ? 'sverige-basket-dam' : 'sverige-basket');
    if (/curling/.test(w)) return pick(dam ? 'sverige-curling-dam' : 'sverige-curling');
    if (/u21/.test(w)) return pick('sverige-u21');
    return pick(dam ? 'sverige-fotboll-dam' : 'sverige-fotboll');
  }
  const ck = compKey(w);
  if (ck && !/national/.test(w)) return { key: ck, label: COMPS.find(x => x[1] === ck)[2] };
  const t = followedTeam(w, abbr);
  if (t) return { key: t.id, label: t.name };
  // another country's national team: "national" in the name, or nothing but the country's name
  const plain = w.replace(/\b(national|team|mens|men|football|soccer|dutch|republic of)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const nk = nationKey(plain);
  if (nk && (/\bnational\b/.test(w) || sport.countryOf(plain) && plain.split(' ').length <= 3 && !distinct(plain).some(x => /^(fc|club)$/.test(x)))) {
    const c = sport.countryOf(plain);
    return { key: nk, label: plain.replace(/\b\w/g, (x) => x.toUpperCase()) + ' (' + c.ab + ')' };
  }
  // any other club
  const s = slug(fileName);
  // a camera's or a screenshot's name ("IMG_2092", "Skärmavbild 2026-…") says nothing of a club
  const real = w.split(' ').filter(x => /[a-z]{3}/.test(x) && !/^(img|image|dsc|dscn|pxl|screenshot|skarmavbild|skarmbild|bild|foto|photo|untitled|scan|visa|senaste|bilder)$/.test(x));
  if (s.length < 3 || !real.length) return null;
  return { key: 'club-' + s, label: w.replace(/\b\w/g, (x) => x.toUpperCase()) };
}

/**
 * A club's picture among the uploaded `club-…` keys for a side's name in the guide, or ''. The first word that
 * says which club it is must be the same ("AC Milan" is not inter-milan, "Real Madrid" is not atletico-madrid);
 * a name that is the whole short form ("PSG", "Roma") is matched to any word of the key.
 */
function clubKey(name, keys) {
  const w = words(name).replace(/\bmunchen\b/g, 'munich').replace(/\blissabon\b/g, 'lisbon').replace(/\baten\b/g, 'athens').replace(/\bprag\b/g, 'praha').replace(/\bneapel\b/g, 'napoli');
  const mine = distinct(w);
  if (!mine.length && !w) return '';
  const compact = w.replace(/ /g, '');
  let best = '', score = 0;
  for (const k of keys) {
    if (!k.startsWith('club-')) continue;
    const kw = k.slice(5).replace(/-/g, ' ');
    const theirs = distinct(kw);
    let sc = 0;
    if (kw.replace(/ /g, '') === compact) sc = 100;
    else if (mine.length && theirs.length && mine[0] === theirs[0]) sc = 50 + mine.filter(x => theirs.includes(x)).length;
    else if (w.split(' ').length === 1 && w.length >= 3 && kw.split(' ').includes(w)) sc = 30;
    else if (!theirs.length && w.split(' ')[0] === kw.split(' ')[0] && w.split(' ')[0].length >= 4) sc = 20; // "Sporting Lissabon" – sporting-cp
    if (sc > score) { score = sc; best = k; }
  }
  return best;
}

module.exports = { keyForFile, clubKey, compKey, nationKey, words, COMPS };
