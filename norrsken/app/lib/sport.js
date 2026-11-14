'use strict';
/**
 * Favourite team on the start page (like TV4 Play): find the team's match in the TV guide while it is on
 * or about to start, and the channel to watch it on.
 */

// SHL 2026/27 plus a few more Swedish hockey teams. re matches the team in a programme title.
const TEAMS = [
  { id: 'lulea', name: 'Luleå Hockey', short: 'Luleå', re: /lule[åa]/i, col: ['#c8102e', '#111111'] },
  { id: 'bjorkloven', name: 'IF Björklöven', short: 'Björklöven', re: /bj[öo]rkl[öo]ven/i, col: ['#00843d', '#f2c500'] },
  { id: 'brynas', name: 'Brynäs IF', short: 'Brynäs', re: /bryn[äa]s/i, col: ['#f2c500', '#d0102c'] },
  { id: 'djurgarden', name: 'Djurgården', short: 'Djurgården', re: /djurg[åa]rden|\bdif\b/i, col: ['#0a2240', '#d4202a'] },
  { id: 'frolunda', name: 'Frölunda HC', short: 'Frölunda', re: /fr[öo]lunda/i, col: ['#008b4f', '#111111'] },
  { id: 'farjestad', name: 'Färjestad BK', short: 'Färjestad', re: /f[äa]rjestad|\bfbk\b/i, col: ['#008a3e', '#f5c400'] },
  { id: 'hv71', name: 'HV71', short: 'HV71', re: /\bhv\s?71\b/i, col: ['#0d3b8c', '#f2c500'] },
  { id: 'linkoping', name: 'Linköping HC', short: 'Linköping', re: /link[öo]ping|\blhc\b/i, col: ['#0b4fa0', '#e4002b'] },
  { id: 'malmo', name: 'Malmö Redhawks', short: 'Malmö', re: /malm[öo] redhawks|redhawks|malm[öo](?! ff)/i, col: ['#c8102e', '#ffffff'] },
  { id: 'rogle', name: 'Rögle BK', short: 'Rögle', re: /r[öo]gle/i, col: ['#00843d', '#ffffff'] },
  { id: 'skelleftea', name: 'Skellefteå AIK', short: 'Skellefteå', re: /skellefte[åa]/i, col: ['#111111', '#f5c400'] },
  { id: 'timra', name: 'Timrå IK', short: 'Timrå', re: /timr[åa]/i, col: ['#c8102e', '#ffffff'] },
  { id: 'vaxjo', name: 'Växjö Lakers', short: 'Växjö', re: /v[äa]xj[öo]/i, col: ['#f26522', '#0b2d5b'] },
  { id: 'orebro', name: 'Örebro Hockey', short: 'Örebro', re: /[öo]rebro/i, col: ['#111111', '#e4002b'] },
  { id: 'leksand', name: 'Leksands IF', short: 'Leksand', re: /leksand/i, col: ['#0b4fa0', '#ffffff'] },
  { id: 'modo', name: 'Modo Hockey', short: 'Modo', re: /\bmodo\b/i, col: ['#c8102e', '#00843d'] },
  { id: 'aik', name: 'AIK', short: 'AIK', re: /\baik\b(?! fotboll)/i, col: ['#0a2240', '#f5c400'] },
];
/*
 * Sweden's national teams, each its own favourite: the sport, men or women, seniors or juniors. A match is
 * Sweden's when "Sverige"/"Sweden" (or the team's nickname) is one side of "A – B"; which team it is comes from
 * what the title, description and channel say (classify). Nothing said about the sport on an event channel
 * ("Sverige – Bosnien" at 18:30) is read as the men's football team, the one that usually plays such a match.
 */
const SWE = ['#005293', '#fecb00'];
/* Countries by their Swedish, English and own names: a national side's flag (ISO code) and its three letters. */
const COUNTRIES = [
  ['SE', 'SWE', /^(sverige|sweden|svezia|schweden)\b/i],
  ['NO', 'NOR', /^(norge|norway|noreg)\b/i],
  ['DK', 'DEN', /^(danmark|denmark)\b/i],
  ['FI', 'FIN', /^(finland|suomi)\b/i],
  ['IS', 'ISL', /^(island|iceland)\b/i],
  ['FO', 'FRO', /^(färöarna|faroe|færøyene)\b/i],
  ['EE', 'EST', /^(estland|estonia)\b/i],
  ['LV', 'LVA', /^(lettland|latvia)\b/i],
  ['LT', 'LTU', /^(litauen|lithuania)\b/i],
  ['DE', 'GER', /^(tyskland|germany|deutschland)\b/i],
  ['FR', 'FRA', /^(frankrike|france)\b/i],
  ['ES', 'ESP', /^(spanien|spain|españa)\b/i],
  ['IT', 'ITA', /^(italien|italy|italia)\b/i],
  ['PT', 'POR', /^(portugal)\b/i],
  ['NL', 'NED', /^(nederländerna|holland|netherlands)\b/i],
  ['BE', 'BEL', /^(belgien|belgium)\b/i],
  ['CH', 'SUI', /^(schweiz|switzerland)\b/i],
  ['AT', 'AUT', /^(österrike|austria)\b/i],
  ['PL', 'POL', /^(polen|poland)\b/i],
  ['CZ', 'CZE', /^(tjeckien|czechia|czech republic)\b/i],
  ['SK', 'SVK', /^(slovakien|slovakia)\b/i],
  ['HU', 'HUN', /^(ungern|hungary)\b/i],
  ['RO', 'ROU', /^(rumänien|romania)\b/i],
  ['BG', 'BUL', /^(bulgarien|bulgaria)\b/i],
  ['GR', 'GRE', /^(grekland|greece)\b/i],
  ['TR', 'TUR', /^(turkiet|turkey|türkiye)\b/i],
  ['HR', 'CRO', /^(kroatien|croatia)\b/i],
  ['RS', 'SRB', /^(serbien|serbia)\b/i],
  ['SI', 'SVN', /^(slovenien|slovenia)\b/i],
  ['BA', 'BIH', /^(bosnien|bosnia)\b/i],
  ['ME', 'MNE', /^(montenegro)\b/i],
  ['AL', 'ALB', /^(albanien|albania)\b/i],
  ['MK', 'MKD', /^(nordmakedonien|north macedonia|makedonien)\b/i],
  ['XK', 'KOS', /^(kosovo)\b/i],
  ['UA', 'UKR', /^(ukraina|ukraine)\b/i],
  ['BY', 'BLR', /^(vitryssland|belarus)\b/i],
  ['RU', 'RUS', /^(ryssland|russia)\b/i],
  ['GB-ENG', 'ENG', /^(england)\b/i],
  ['GB-SCT', 'SCO', /^(skottland|scotland)\b/i],
  ['GB-WLS', 'WAL', /^(wales)\b/i],
  ['GB-NIR', 'NIR', /^(nordirland|northern ireland)\b/i],
  ['IE', 'IRL', /^(irland|ireland)\b/i],
  ['LU', 'LUX', /^(luxemburg|luxembourg)\b/i],
  ['LI', 'LIE', /^(liechtenstein)\b/i],
  ['MT', 'MLT', /^(malta)\b/i],
  ['CY', 'CYP', /^(cypern|cyprus)\b/i],
  ['AD', 'AND', /^(andorra)\b/i],
  ['SM', 'SMR', /^(san marino)\b/i],
  ['MD', 'MDA', /^(moldavien|moldova)\b/i],
  ['GI', 'GIB', /^(gibraltar)\b/i],
  ['GE', 'GEO', /^(georgien|georgia)\b/i],
  ['AM', 'ARM', /^(armenien|armenia)\b/i],
  ['AZ', 'AZE', /^(azerbajdzjan|azerbaijan)\b/i],
  ['KZ', 'KAZ', /^(kazakstan|kazakhstan)\b/i],
  ['IL', 'ISR', /^(israel)\b/i],
  ['CA', 'CAN', /^(kanada|canada)\b/i],
  ['US', 'USA', /^(usa|förenta staterna|united states)\b/i],
  ['MX', 'MEX', /^(mexiko|mexico)\b/i],
  ['BR', 'BRA', /^(brasilien|brazil)\b/i],
  ['AR', 'ARG', /^(argentina)\b/i],
  ['UY', 'URU', /^(uruguay)\b/i],
  ['CO', 'COL', /^(colombia)\b/i],
  ['CL', 'CHI', /^(chile)\b/i],
  ['JP', 'JPN', /^(japan)\b/i],
  ['KR', 'KOR', /^(sydkorea|south korea|korea)\b/i],
  ['CN', 'CHN', /^(kina|china)\b/i],
  ['AU', 'AUS', /^(australien|australia)\b/i],
  ['NZ', 'NZL', /^(nya zeeland|new zealand)\b/i],
  ['MA', 'MAR', /^(marocko|morocco)\b/i],
  ['EG', 'EGY', /^(egypten|egypt)\b/i],
  ['NG', 'NGA', /^(nigeria)\b/i],
  ['SN', 'SEN', /^(senegal)\b/i],
  ['GH', 'GHA', /^(ghana)\b/i],
  ['CM', 'CMR', /^(kamerun|cameroon)\b/i],
  ['CI', 'CIV', /^(elfenbenskusten|ivory coast|côte d'ivoire)\b/i],
  ['TN', 'TUN', /^(tunisien|tunisia)\b/i],
  ['DZ', 'ALG', /^(algeriet|algeria)\b/i],
  ['ZA', 'RSA', /^(sydafrika|south africa)\b/i],
  ['QA', 'QAT', /^(qatar)\b/i],
  ['SA', 'KSA', /^(saudiarabien|saudi arabia)\b/i],
  ['IR', 'IRN', /^(iran)\b/i],
];
/** "Bosnien-Hercegovina", "Bosnia-Herzegovina", "Danmark (dam)" → { flag: 'BA', ab: 'BIH' }; not a country → null. */
function countryOf(name) {
  const n = String(name || '').trim();
  const c = COUNTRIES.find(x => x[2].test(n));
  return c ? { flag: c[0], ab: c[1] } : null;
}
/** A side's name made comparable across languages and channels: "Bosnien-Hercegovina" = "Bosnia-Herzegovina". */
function sideKey(n) {
  const c = countryOf(n);
  if (c) return c.ab;
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
}
const NATIONS = [
  { id: 'tre-kronor', name: 'Tre Kronor', want: { sport: 'Ishockey', gender: 'Herr' }, nick: /tre kronor/i },
  { id: 'damkronorna', name: 'Damkronorna', want: { sport: 'Ishockey', gender: 'Dam' }, nick: /damkronorna/i },
  { id: 'juniorkronorna', name: 'Juniorkronorna (U20)', want: { sport: 'Ishockey', youth: true }, nick: /juniorkronorna|småkronorna/i },
  { id: 'sverige-fotboll', name: 'Fotboll herr (Blågult)', want: { sport: 'Fotboll', gender: 'Herr', fallback: true }, nick: /bl[åa]gult|herrlandslaget/i },
  { id: 'sverige-fotboll-dam', name: 'Fotboll dam', want: { sport: 'Fotboll', gender: 'Dam' }, nick: /damlandslaget/i },
  { id: 'sverige-u21', name: 'Fotboll U21', want: { sport: 'Fotboll', youth: true }, nick: /u-?21-?landslaget/i },
  { id: 'sverige-handboll', name: 'Handboll herr', want: { sport: 'Handboll', gender: 'Herr' }, nick: /handbollsherrarna/i },
  { id: 'sverige-handboll-dam', name: 'Handboll dam', want: { sport: 'Handboll', gender: 'Dam' }, nick: /handbollsdamerna/i },
  { id: 'sverige-bandy', name: 'Bandy herr', want: { sport: 'Bandy', gender: 'Herr' } },
  { id: 'sverige-bandy-dam', name: 'Bandy dam', want: { sport: 'Bandy', gender: 'Dam' } },
  { id: 'sverige-innebandy', name: 'Innebandy herr', want: { sport: 'Innebandy', gender: 'Herr' } },
  { id: 'sverige-innebandy-dam', name: 'Innebandy dam', want: { sport: 'Innebandy', gender: 'Dam' } },
  { id: 'sverige-basket', name: 'Basket herr', want: { sport: 'Basket', gender: 'Herr' } },
  { id: 'sverige-basket-dam', name: 'Basket dam', want: { sport: 'Basket', gender: 'Dam' } },
  { id: 'sverige-curling', name: 'Curling herr', want: { sport: 'Curling', gender: 'Herr' } },
  { id: 'sverige-curling-dam', name: 'Curling dam', want: { sport: 'Curling', gender: 'Dam' } },
];
// Premier League 2026/27. Every match the club plays counts (league, the cups, Europe): its name in a "A – B" title.
const PL = [
  { id: 'arsenal', name: 'Arsenal', short: 'Arsenal', re: /\barsenal\b/i, col: ['#ef0107', '#ffffff'] },
  { id: 'aston-villa', name: 'Aston Villa', short: 'Aston Villa', re: /aston villa/i, col: ['#670e36', '#95bfe5'] },
  { id: 'bournemouth', name: 'Bournemouth', short: 'Bournemouth', re: /bournemouth/i, col: ['#da291c', '#111111'] },
  { id: 'brentford', name: 'Brentford', short: 'Brentford', re: /brentford/i, col: ['#e30613', '#ffffff'] },
  { id: 'brighton', name: 'Brighton', short: 'Brighton', re: /brighton/i, col: ['#0057b8', '#ffffff'] },
  { id: 'chelsea', name: 'Chelsea', short: 'Chelsea', re: /\bchelsea\b/i, col: ['#034694', '#ffffff'] },
  { id: 'coventry', name: 'Coventry City', short: 'Coventry', re: /coventry/i, col: ['#59cbe8', '#ffffff'] },
  { id: 'crystal-palace', name: 'Crystal Palace', short: 'Crystal Palace', re: /crystal palace/i, col: ['#1b458f', '#c4122e'] },
  { id: 'everton', name: 'Everton', short: 'Everton', re: /\beverton\b/i, col: ['#003399', '#ffffff'] },
  { id: 'fulham', name: 'Fulham', short: 'Fulham', re: /\bfulham\b/i, col: ['#111111', '#ffffff'] },
  { id: 'hull', name: 'Hull City', short: 'Hull', re: /\bhull\b/i, col: ['#f5971d', '#111111'] },
  { id: 'ipswich', name: 'Ipswich Town', short: 'Ipswich', re: /ipswich/i, col: ['#0e4c92', '#ffffff'] },
  { id: 'leeds', name: 'Leeds United', short: 'Leeds', re: /\bleeds\b/i, col: ['#ffcd00', '#1d428a'] },
  { id: 'liverpool', name: 'Liverpool', short: 'Liverpool', re: /\bliverpool\b/i, col: ['#c8102e', '#00b2a9'] },
  { id: 'man-city', name: 'Manchester City', short: 'Man City', re: /manchester city|man\.? city/i, col: ['#6cabdd', '#1c2c5b'] },
  { id: 'man-utd', name: 'Manchester United', short: 'Man United', re: /manchester (united|utd)|man\.? (united|utd)/i, col: ['#da291c', '#fbe122'] },
  { id: 'newcastle', name: 'Newcastle United', short: 'Newcastle', re: /newcastle(?! jets)/i, col: ['#111111', '#ffffff'] },
  { id: 'nottingham', name: 'Nottingham Forest', short: 'Nottingham', re: /nottingham|nott'?m forest/i, col: ['#dd0000', '#ffffff'] },
  { id: 'sunderland', name: 'Sunderland', short: 'Sunderland', re: /sunderland/i, col: ['#eb172b', '#ffffff'] },
  { id: 'tottenham', name: 'Tottenham Hotspur', short: 'Tottenham', re: /tottenham/i, col: ['#132257', '#ffffff'] },
];
for (const t of TEAMS) { t.sport = 'hockey'; t.group = 'Ishockey'; }
for (const t of NATIONS) { t.short = 'Sverige'; t.col = SWE; t.sport = 'nation'; t.group = 'Landslag'; t.re = new RegExp('sverige|sweden' + (t.nick ? '|' + t.nick.source : ''), 'i'); TEAMS.push(t); }
for (const t of PL) { t.sport = 'football'; t.group = 'Premier League'; TEAMS.push(t); }
const BY_ID = new Map(TEAMS.map(t => [t.id, t]));

/** Hockey, not football or news: something hockey-ish in the title, description or channel name. */
const HOCKEY = /hockey|\bshl\b|\bchl\b|hockeyallsvenskan|ishockey|redhawks|lakers|tre kronor/i;
const NOT_LIVE = /\b(repris|i repris|h[öo]jdpunkter|highlights|sammandrag|studio|magasin|efter matchen)\b|\(r\)/i;

function teamId(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === '' || s === 'none' || s === 'inget') return 'none';
  if (BY_ID.has(s)) return s;
  const t = TEAMS.find(x => x.re.test(s) || x.name.toLowerCase() === s);
  return t ? t.id : 'lulea';
}
function team(id) { return BY_ID.get(id) || null; }
function list() { return TEAMS.map(t => ({ id: t.id, name: t.name, group: t.group })); }
/** The national teams a profile from before 1.16.3 followed without choosing them (Sweden's hockey and football). */
const NATION_DEFAULT = ['tre-kronor', 'sverige-fotboll'];
/** The profile's favourite teams as ids: a list, one id, or 'none'. Unknown ones are left out; at most 12. */
function teamIds(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : [v]) {
    const s = String(x || '').toLowerCase().trim();
    const id = BY_ID.has(s) ? s : (s && s !== 'none' && s !== 'inget' ? (TEAMS.find(t => t.name.toLowerCase() === s) || {}).id : '');
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 12);
}

/** "SHL: Luleå Hockey - Färjestad BK" → { home: 'Luleå', away: 'Färjestad' } (short names when known). */
function matchup(title, fav) {
  let clean = String(title || '').replace(/^(live|direkt|sport|ishockey|hockey|shl|chl|hockeyallsvenskan)\s*[:|.\-–]\s*/gi, '').replace(/^(live|direkt|sport|ishockey|hockey|shl|chl|hockeyallsvenskan)\s*[:|.\-–]\s*/gi, '');
  // "Fotboll: Premier League: Arsenal - Chelsea": whatever stands before a colon is the sport or the competition
  for (let i = 0; i < 3; i++) { const c = /^[^:|–—]{2,40}?[:|]\s+(?=\S.*\s(?:[-–—]|vs\.?|mot)\s)/i.exec(clean); if (!c || /\s[-–—]\s/.test(c[0])) break; clean = clean.slice(c[0].length); }
  const m = /^(.+?)\s+(?:[-–—]|vs\.?|mot)\s+(.+?)(?:\s*[,(|].*)?$/i.exec(clean);
  if (!m) return null;
  // a football club's name is read as football clubs', a hockey club's as hockey clubs' ("Malmö", "AIK" are both)
  const pool = fav && fav.sport ? TEAMS.filter(x => x.sport === fav.sport) : TEAMS;
  const name = (s) => {
    const t = pool.find(x => x.re.test(s));
    return t ? t.short : s.replace(/\s+(hockey|hc|if|bk|ik|aik|fc|afc|ff)$/i, '').replace(/^(fc|afc)\s+/i, '').trim();
  };
  const home = name(m[1]), away = name(m[2]);
  if (!home || !away || home === away) return null;
  if (fav && !fav.re.test(m[1]) && !fav.re.test(m[2])) return null;
  return { home, away };
}

/**
 * Where a channel comes from, by its category ("Sweden - Sport", "Norway - VG+ Play", "United Kingdom - …"):
 * 'se', 'foreign', or '' when the list has no countries in its category names.
 */
function regionOf(catName) {
  const c = String(catName || '');
  if (!c) return '';
  if (/^\s*(sweden|sverige|swe?)\b/i.test(c)) return 'se';
  if (/^\s*(norway|norge|denmark|danmark|finland|suomi|united kingdom|uk|usa|us|germany|deutschland|new zealand|canada|france|spain|italy|ireland)\b/i.test(c)) return 'foreign';
  return '';
}
/** How good a channel is for the match: Swedish always first, then Full HD/4K before HD before SD, not "backup"/"alt". */
function channelScore(name, region) {
  const n = String(name || '');
  let s = 0;
  if (region === 'se') s += 20;
  else if (region === 'foreign') s -= 20;
  if (/^\[(viaplay no|vgtv|tv2|hbo max uk|dazn uk)\b/i.test(n)) s -= 20; // an event channel of another country's service
  // Full HD first (what is recorded and shown), then HD
  if (/\b(4k|uhd|2160p?)\b/i.test(n)) s += 6;
  else if (/\b(fhd|1080[pi]?)\b/i.test(n)) s += 5;
  else if (/\bhd\b/i.test(n)) s += 3;
  if (/^\[tv4 ?play\]/i.test(n)) s += 4; // TV4 Play's own event channel: the Swedish broadcast, in full HD
  if (/\bsd\b/i.test(n)) s -= 3;
  if (/(^|[\s|:[(])(se|swe|sverige)([\s|:\])]|$)/i.test(n)) s += 2;
  if (/backup|alt\b|\braw\b/i.test(n)) s -= 4;
  if (/hockey|sport/i.test(n)) s += 1;
  return s;
}

const SE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** Swedish wall clock of an instant: its date, and the wall time as if it were UTC (ms). */
function wall(ms) {
  const p = {};
  for (const q of SE_FMT.formatToParts(new Date(ms))) p[q.type] = +q.value;
  return { y: p.year, mo: p.month, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
}
/** The instant (ms) of a Swedish wall-clock time; two passes get the summer/winter time change right. */
function stockholmTime(y, mo, d, hh = 0, mm = 0) {
  const g = Date.UTC(y, mo - 1, d, hh, mm);
  let t = g;
  for (let i = 0; i < 2; i++) t = g - (wall(t).ms - Math.floor(t / 1000) * 1000);
  return t;
}

/** Start and end (ms) of the Swedish calendar day that contains `now`. */
function stockholmDay(now) {
  const w = wall(now);
  return { start: stockholmTime(w.y, w.mo, w.d), end: stockholmTime(w.y, w.mo, w.d + 1) };
}

/**
 * Event channels carry the match in their name and have no TV guide, like the provider's TV4 Play ones:
 * "[TV4Play] (25/10) 18:00 Luleå HF - Djurgården IF" → { s, title, label: 'TV4 Play' }. The time is Swedish time.
 */
const EVENT_RE = /^\s*\[([^\]]{2,30})\]\s*\((\d{1,2})\/(\d{1,2})\)\s*(\d{1,2})[:.](\d{2})\s+(.+?)\s*$/;
function eventOf(name, now = Date.now()) {
  const m = EVENT_RE.exec(String(name || ''));
  if (!m) return null;
  const [, label, dd, mo, hh, mm, title] = m;
  const y = wall(now).y;
  // around new year the date can belong to the year before or after
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const t = stockholmTime(yy, +mo, +dd, +hh, +mm);
    if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
  }
  // "[Viapaly SE]" (the provider's spelling) → "Viaplay"; a country tag after the service is left out
  return { s: best, title, label: label.replace(/^\s*tv4\s*play\s*$/i, 'TV4 Play').replace(/^viapaly/i, 'Viaplay').replace(/\s+(se|no|dk|fi|uk)$/i, '').trim() };
}
const EVENT_LEN = 4 * 3600e3; // the name only says when it starts: a hockey broadcast with overtime and shootout

/* What the start page follows besides the favourite team: Sweden (hockey or football) and the skiing world cups. */
const SWE_NAMES = 'sverige|sweden|tre kronor|damkronorna|juniorkronorna|småkronorna|bl[åa]gult|damlandslaget|herrlandslaget';
const SWE_SIDE = new RegExp('(^|[:\\s])(' + SWE_NAMES + ')\\s+[-–—]\\s+\\S|\\S\\s+[-–—]\\s+(' + SWE_NAMES + ')(\\s|$|[,(])', 'i');
const JUNIOR = /\bjvm\b|junior-?vm|\bu-?(?:18|19|20|21)\b|\bj-?(?:18|20)\b|\bjunior/i;
const FOOTBALL = /fotboll|football|soccer|landskamp|vm-kval|em-kval|nations league|\bvm\b|\bem\b|\bos\b|fifa|uefa/i;
const YOUTH = /\b(u\d{2}[pfdj]?|j\d{2}|junior|ungdom|damjunior)\b/i;
const OTHER_SPORT = /handboll|bandy|innebandy|basket|volley|curling|tennis|padel|rugby|friidrott|simning|e-?sport|golf|dart/i;
const WORLD_CUP = /v[äa]rldscup|world cup|tour de ski/i;
const FOLLOW = {
  sverige: {
    id: 'sverige', name: 'Sverige', short: 'Sverige', col: ['#005293', '#fecb00'], maxLen: 5 * 3600e3, vs: BY_ID.get('tre-kronor'),
    ok: (t, d, chn, ev) => SWE_SIDE.test(t) && !OTHER_SPORT.test(t + ' ' + d) && (ev || HOCKEY.test(t + ' ' + d + ' ' + chn) || FOOTBALL.test(t + ' ' + d + ' ' + chn)),
  },
  langd: {
    id: 'langd', name: 'Längdskidor', short: 'Längd', col: ['#1d6fb8', '#ffffff'], maxLen: 6 * 3600e3,
    ok: (t, d) => /l[äa]ngdskid|l[äa]ngd(åkning|akning)|\bl[äa]ngd\b|cross[- ]?country|tour de ski/i.test(t + ' ' + d) && WORLD_CUP.test(t + ' ' + d) && !/skidskytte|biathlon/i.test(t),
  },
  skidskytte: {
    id: 'skidskytte', name: 'Skidskytte', short: 'Skidskytte', col: ['#0a7a5a', '#ffffff'], maxLen: 6 * 3600e3,
    ok: (t, d) => /skidskytte|biathlon/i.test(t + ' ' + d) && WORLD_CUP.test(t + ' ' + d),
  },
};

/* What kind of match it is, read from title, description and channel name: sport, women/men, age class, competition. */
const OTHER_SPORTS = [
  [/handboll/i, 'Handboll'], [/bandy/i, 'Bandy'], [/innebandy/i, 'Innebandy'], [/basket/i, 'Basket'], [/volley/i, 'Volleyboll'],
  [/curling/i, 'Curling'], [/tennis/i, 'Tennis'], [/padel/i, 'Padel'], [/rugby/i, 'Rugby'],
  [/skidskytte|biathlon/i, 'Skidskytte'], [/l[äa]ngdskid|l[äa]ngd(åkning|akning)|cross[- ]?country|tour de ski/i, 'Längdskidor'],
];
const GENDER_DAM = /\b(dam|damer|damerna|damlandslag(et)?|damkronorna|damallsvenskan|elitettan|women'?s?|female|kvinnor|flickor)\b/i;
const GENDER_HERR = /\b(herr|herrar|herrarna|herrlandslag(et)?|men'?s|m[äa]n)\b/i;
const AGE_RE = /\b(?:j-?(?:18|20)|u-?(?:15|16|17|18|19|20|21|23))\b|\bjunior(?:er|landslag(?:et)?)?\b|\bpojklandslag(?:et)?\b|\bflicklandslag(?:et)?\b/i;
const COMPS = [
  [/\bshl\b/i, 'SHL'], [/hockeyallsvenskan/i, 'Hockeyallsvenskan'], [/\bchl\b|champions hockey/i, 'CHL'],
  [/premier league/i, 'Premier League'], [/fa[- ]?cup/i, 'FA-cupen'], [/carabao|efl cup|league cup|ligacupen/i, 'Ligacupen'], [/community shield/i, 'Community Shield'],
  [/conference league/i, 'Conference League'], [/nations league/i, 'Nations League'], [/vm-kval/i, 'VM-kval'], [/em-kval/i, 'EM-kval'], [/landskamp/i, 'Landskamp'],
  [/vänskapsmatch|v[äa]nskaps/i, 'Vänskapsmatch'], [/damallsvenskan/i, 'Damallsvenskan'], [/allsvenskan/i, 'Allsvenskan'],
  [/superettan/i, 'Superettan'], [/champions league/i, 'Champions League'], [/europa league/i, 'Europa League'],
  [/euro hockey tour|\beht\b|karjala|beijer|channel one|german cup/i, 'Euro Hockey Tour'],
  [/world cup|v[äa]rldscup/i, 'Världscup'], [/\bvm\b/i, 'VM'], [/\bem\b/i, 'EM'],
];
/** { sport, gender: 'Dam'|'Herr'|'', age: 'U21'|'Junior'|'', comp, label: 'Fotboll · Dam · Landskamp' } — only what the text says. */
function classify(title, desc, chName, fallbackSport) {
  const all = [title, desc, chName].join(' ');
  let sport = '';
  const other = OTHER_SPORTS.find(x => x[0].test(all));
  if (HOCKEY.test(all) || /\bjvm\b|junior-?vm|hockey/i.test(all)) sport = 'Ishockey';
  else if (other) sport = other[1]; // before football: "handbollslandskamp" must not read as football
  else if (FOOTBALL.test(all)) sport = 'Fotboll';
  else sport = fallbackSport || '';
  // the title is the strongest hint; description and channel only when the title says nothing
  const pick = (re) => re.test(title) ? true : re.test(desc || '') || re.test(chName || '');
  const gender = pick(GENDER_DAM) ? 'Dam' : pick(GENDER_HERR) ? 'Herr' : '';
  const am = AGE_RE.exec(title) || AGE_RE.exec(desc || '') || AGE_RE.exec(chName || '');
  let age = '';
  if (am) { const s = am[0].toUpperCase().replace('-', ''); age = /^(J|U)\d/.test(s) ? s : 'Junior'; }
  const cm = COMPS.find(x => x[0].test(title + ' ' + (desc || '')));
  const comp = cm ? cm[1] : '';
  const label = [sport, [age && age, gender].filter(Boolean).join(' '), comp].filter(Boolean).join(' · ');
  return { sport, gender, age, comp, label };
}

/** The favourite team as something to follow: its name in the title, and hockey. */
function teamFollow(fav) {
  if (fav.sport === 'nation') {
    const w = fav.want;
    return {
      id: fav.id, name: fav.name, short: 'Sverige', col: SWE, maxLen: 5 * 3600e3, vs: fav, sport: w.sport, nation: true, youth: !!w.youth,
      ok: (t, d, chn, ev) => {
        if (!SWE_SIDE.test(t)) return false;
        const k = classify(t, d, chn, '');
        const nick = fav.nick && fav.nick.test(t + ' ' + d);
        const sport = k.sport || (w.fallback && (ev || !d) ? w.sport : '');
        if (sport !== w.sport) return false;
        const young = !!k.age || JUNIOR.test(t + ' ' + d);
        if (!!w.youth !== young && !nick) return false;
        if (w.gender === 'Dam' && k.gender !== 'Dam' && !nick) return false;
        if (w.gender === 'Herr' && k.gender === 'Dam') return false;
        return true;
      },
    };
  }
  if (fav.sport === 'football') {
    return {
      id: fav.id, name: fav.name, short: fav.short, col: fav.col, maxLen: 4 * 3600e3, vs: fav, sport: 'Fotboll',
      // every match the club plays, whatever the league or cup: its name on one side of "A – B", and not another sport
      ok: (t, d, chn) => fav.re.test(t) && !!matchup(t, fav) && !HOCKEY.test(t + ' ' + chn) && !OTHER_SPORT.test(t + ' ' + d) && !/\bnba\b|\bnhl\b|\bnfl\b/i.test(t + ' ' + chn),
    };
  }
  return {
    id: fav.id, name: fav.name, short: fav.short, col: fav.col, maxLen: 5 * 3600e3, vs: fav, sport: 'Ishockey',
    ok: (t, d, chn) => {
      if (!fav.re.test(t)) return false;
      // "Luleå HF - Färjestad BK" has no hockey word in it: two known hockey clubs in the title is hockey enough
      const other = TEAMS.some(x => x !== fav && x.sport === 'hockey' && x.re.test(t));
      return other || HOCKEY.test(t + ' ' + d + ' ' + chn);
    },
  };
}

/**
 * Everything followed (see FOLLOW) in the calendar day (Stockholm), best first: live, then the next to start,
 * then what already ran; within that the earliest. Programmes from the TV guide and event channels (name only).
 */
function collect(follows, channels, epg, now, days = 1) {
  if (!epg || !epg.map) epg = { map: new Map() };
  const day = stockholmDay(now);
  if (days > 1) day.end = stockholmDay(day.start + (days - 1) * 86400e3 + 6 * 3600e3).end; // the days ahead too (the list of matches)
  const hits = new Map(); // follow + start + teams → { f, prog, chans: [] }
  const add = (ch, s, e, t, d, label, ev) => {
    if (s >= day.end) return;
    if (s < day.start && now >= e) return; // yesterday's: only while it is still on (a late match past midnight)
    if (NOT_LIVE.test(t)) return;
    const youth = YOUTH.test(t); // U14, J20 …: a club's youth teams are not the team (Juniorkronorna is a team)
    d = d || '';
    for (const f of follows) {
      if (youth && !f.youth) continue;
      if (!f.ok(t, d, ch.n || '', ev)) continue;
      if (e - s > f.maxLen) continue; // hours of the same thing: a re-run block, not the event
      const mu = f.vs ? matchup(t, f.vs) : null;
      // the same match on several channels (TV4 Play 17:55, a Norwegian service 17:50) is one match
      // (names compared across languages; a match with its studio before it can start hours apart on two channels)
      const who = f.id + '|' + (mu ? [sideKey(mu.home), sideKey(mu.away)].sort().join('|') : t.toLowerCase());
      let h = null;
      // another country's channel showing it hours later (a rerun at 01:00) is the same match too, not a new one
      const span = mu ? (ch.region === 'foreign' ? 12 * 3600e3 : 4 * 3600e3) : 45 * 60e3;
      for (const x of hits.values()) if (x.who === who && Math.abs(x.s - s) <= span) { h = x; break; }
      if (h && ch.region === 'foreign' && s > h.s + 4 * 3600e3) { if (!h.d && d) h.d = d; if (!h.dx) h.dx = d; return; } // its text (arena, competition) is welcome; its channel is not
      if (!h) hits.set(who + '|' + s + '|' + hits.size, (h = { who, f, s, e, t, d, mu, chans: [], labels: new Map() }));
      else if (ch.region === 'se' && !h.chans.some(c => c.region === 'se')) { h.s = s; h.e = e; h.t = t; h.d = d || h.d; if (mu) h.mu = mu; } // the Swedish listing's times and names
      if (!h.chans.includes(ch)) h.chans.push(ch);
      h.labels.set(ch.id, label || ch.n);
      return; // one thing per programme
    }
  };
  for (const ch of channels) {
    const ev = eventOf(ch.n, now);
    if (ev) { add(ch, ev.s, ev.s + EVENT_LEN, ev.title, '', ev.label, true); continue; }
    if (!ch.epg) continue;
    const list = epg.map.get(ch.epg);
    if (!list) continue;
    for (const p of list) {
      const [s, e, t, d] = p;
      if (s >= day.end) break;
      add(ch, s, e, t, d);
    }
  }
  const rank = (h) => (h.s <= now && now < h.e) ? 0 : h.s > now ? 1 : 2;
  return [...hits.values()].sort((a, b) => (rank(a) - rank(b)) || a.s - b.s || b.chans.length - a.chans.length).map((best) => {
    let chans = best.chans.slice().sort((a, b) => channelScore(b.n, b.region) - channelScore(a.n, a.region));
    // Swedish channels only, when there is one; another country's broadcast only when nothing Swedish has it (yet)
    const swe = chans.filter(c => c.region === 'se' || (c.region !== 'foreign' && channelScore(c.n, c.region) > -10));
    const foreign = !swe.length;
    if (swe.length) chans = swe;
    const f = best.f;
    const kind = classify(best.t, [best.d, best.dx].filter(Boolean).join(' '), chans[0].n || '', f.id === 'langd' ? 'Längdskidor' : f.id === 'skidskytte' ? 'Skidskytte' : (f.vs && f.id !== 'sverige') ? (f.sport || 'Ishockey') : '');
    if (f.nation && !kind.sport) { kind.sport = f.sport; kind.label = [f.sport, kind.label].filter(Boolean).join(' · '); }
    // a national team's match that names no competition is still a national match: say so, not just the sport
    if (f.nation && !kind.comp) { kind.comp = 'Landskamp'; kind.label = [kind.label, 'Landskamp'].filter(Boolean).join(' · '); }
    return {
      team: { id: f.id, name: f.name, short: f.short, col: f.col, group: f.nation ? 'Landslag' : (f.vs && f.vs.group) || '' },
      kind, label: kind.label || f.name,
      state: best.s > now ? 'soon' : now < best.e ? 'live' : 'ended',
      title: best.mu ? best.mu.home + ' – ' + best.mu.away : best.t,
      raw: best.t,
      home: best.mu ? best.mu.home : '', away: best.mu ? best.mu.away : '',
      s: best.s, e: best.e, d: best.d || '',
      ch: chans[0],
      chName: best.labels.get(chans[0].id) || chans[0].n, // "TV4 Play" instead of the event channel's long name
      chans,
      alt: best.chans.filter(c => !chans.includes(c)).sort((a, b) => channelScore(b.n, b.region) - channelScore(a.n, a.region)), // other countries' broadcasts: only for a recording whose Swedish channel will not start
      arena: arenaOf(best, f),
      foreign, // only a foreign broadcast is known so far (the Swedish one usually shows up hours before the match)
    };
  });
}

/*
 * Where the home team plays. The guide's own text wins ("Ishockey från Löfbergs Arena där …"); otherwise the home
 * team's arena from this list (the names as of autumn 2026 – a sponsor's name changes now and then).
 */
const ARENAS = {
  lulea: 'Coop Norrbotten Arena', bjorkloven: 'Winpos Arena', brynas: 'Monitor ERP Arena', djurgarden: 'Hovet', frolunda: 'Scandinavium',
  farjestad: 'Löfbergs Arena', hv71: 'Husqvarna Garden', linkoping: 'Saab Arena', malmo: 'Malmö Arena', rogle: 'Catena Arena',
  skelleftea: 'Skellefteå Kraft Arena', timra: 'SCA Arena', vaxjo: 'Vida Arena', orebro: 'Behrn Arena', leksand: 'Tegera Arena', modo: 'Hägglunds Arena', aik: 'Hovet',
  arsenal: 'Emirates Stadium', 'aston-villa': 'Villa Park', bournemouth: 'Vitality Stadium', brentford: 'Gtech Community Stadium', brighton: 'Amex Stadium',
  chelsea: 'Stamford Bridge', coventry: 'Coventry Building Society Arena', 'crystal-palace': 'Selhurst Park', everton: 'Hill Dickinson Stadium', fulham: 'Craven Cottage',
  hull: 'MKM Stadium', ipswich: 'Portman Road', leeds: 'Elland Road', liverpool: 'Anfield', 'man-city': 'Etihad Stadium', 'man-utd': 'Old Trafford',
  newcastle: "St James' Park", nottingham: 'City Ground', sunderland: 'Stadium of Light', tottenham: 'Tottenham Hotspur Stadium',
};
const ARENA_RE = /(?:^|[.!]\s+|\bfrån\s+|\bi\s+|\bpå\s+)((?:[A-ZÅÄÖ][\wåäöÅÄÖé'&-]*\s+){0,3}(?:Arena|Garden|Stadium|Stadion|Park|Ishall|Center|Centrum|Scandinavium|Hovet|Globen)(?:\s+[A-ZÅÄÖ][\wåäöÅÄÖ-]+)?)(?=[\s.,]|$)/;
function arenaOf(best, f) {
  for (const txt of [best.d, best.dx]) {
    const m = ARENA_RE.exec(String(txt || '').replace(/<[^>]+>/g, ' '));
    if (m) return m[1].replace(/^(fra|från|from|aus|de)\s+/i, '').trim();
  }
  if (!best.mu || !f.vs || f.nation) return '';
  const pool = TEAMS.filter(x => x.sport === f.vs.sport);
  const home = pool.find(x => x.re.test(best.mu.home));
  return (home && ARENAS[home.id]) || '';
}

/** Every match of the favourite's team in the calendar day (used for the match recordings). */
function matchesToday(teamIdValue, channels, epg, { now = Date.now() } = {}) {
  const fav = team(teamIdValue);
  if (!fav) return [];
  return collect([teamFollow(fav)], channels, epg, now);
}

/** What the start page shows today: the favourite team, Sweden (hockey/football), the skiing world cups. */
function followsFor(teamIdValue) {
  return teamIds(teamIdValue).map(id => teamFollow(team(id))).concat([FOLLOW.langd, FOLLOW.skidskytte]);
}
/** The favourites' matches from now and `days` days ahead, in the order they are played (what is on now first). */
function upcoming(teamIdValue, channels, epg, { now = Date.now(), days = 7 } = {}) {
  return collect(teamIds(teamIdValue).map(id => teamFollow(team(id))), channels, epg, now, days).filter(m => m.state !== 'ended').sort((a, b) => a.s - b.s);
}
/** What is recorded by itself today: the team's matches and, when asked for, the skiing world cups. */
function recToday(teamIdValue, ski, channels, epg, { now = Date.now() } = {}) {
  const fav = team(teamIdValue);
  return collect((fav ? [teamFollow(fav)] : []).concat(ski ? [FOLLOW.langd, FOLLOW.skidskytte] : []), channels, epg, now);
}
function todayAll(teamIdValue, channels, epg, { now = Date.now() } = {}) {
  return collect(followsFor(teamIdValue), channels, epg, now);
}

/** The one for the start page billboard, or null. */
function findMatch(teamIdValue, channels, epg, opts = {}) {
  return todayAll(teamIdValue, channels, epg, opts)[0] || null;
}

module.exports = { countryOf, sideKey, NATION_DEFAULT, regionOf, classify, TEAMS, teamId, teamIds, upcoming, recToday, team, list, matchup, findMatch, matchesToday, todayAll, channelScore, stockholmDay, stockholmTime, eventOf };
