// AniList Anime Catalogs for Stremio — with titles printed on the posters.
const express = require('express');
const sharp = require('sharp');

const PORT = process.env.PORT || 7000;
const PER_PAGE = 50;
const TITLE_LANG = process.env.TITLE_LANG || 'english'; // english | romaji
const MAPPING_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';

const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo',
  'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports',
  'Supernatural', 'Thriller'];

// ---------- catalogs ----------
function currentSeason() {
  const d = new Date(), m = d.getUTCMonth();
  const season = m < 3 ? 'WINTER' : m < 6 ? 'SPRING' : m < 9 ? 'SUMMER' : 'FALL';
  return { season, seasonYear: d.getUTCFullYear() };
}
const SERIES_FORMATS = ['TV', 'TV_SHORT', 'ONA', 'OVA'];
const CATALOGS = {
  airing:   { name: 'Airing Now', type: 'series', vars: () => ({ status: 'RELEASING', sort: ['POPULARITY_DESC'], format_in: SERIES_FORMATS }) },
  trending: { name: 'Trending',   type: 'series', vars: () => ({ sort: ['TRENDING_DESC'], format_in: SERIES_FORMATS }) },
  popular:  { name: 'Popular',    type: 'series', vars: () => ({ sort: ['POPULARITY_DESC'], format_in: SERIES_FORMATS }) },
  top:      { name: 'Top Rated',  type: 'series', vars: () => ({ sort: ['SCORE_DESC'], format_in: SERIES_FORMATS }) },
  season:   { name: 'This Season', type: 'series', vars: () => ({ ...currentSeason(), sort: ['POPULARITY_DESC'], format_in: SERIES_FORMATS }) },
  upcoming: { name: 'Upcoming',   type: 'series', vars: () => ({ status: 'NOT_YET_RELEASED', sort: ['POPULARITY_DESC'], format_in: SERIES_FORMATS }) },
  movies_popular: { name: 'Anime Movies – Popular', type: 'movie', vars: () => ({ sort: ['POPULARITY_DESC'], format_in: ['MOVIE'] }) },
  movies_top:     { name: 'Anime Movies – Top Rated', type: 'movie', vars: () => ({ sort: ['SCORE_DESC'], format_in: ['MOVIE'] }) },
};

const manifest = {
  id: 'community.anilist.titled',
  version: '1.3.0',
  name: 'Anime Catalogs (Titled Posters)',
  description: 'AniList anime catalogs — Airing, Trending, Popular, Top Rated, This Season, Upcoming — with the title printed on every poster.',
  logo: 'https://anilist.co/img/icons/android-chrome-512x512.png',
  resources: ['catalog', { name: 'meta', types: ['series', 'movie', 'anime'], idPrefixes: ['kitsu:', 'anilist:'] }],
  types: ['anime', 'series', 'movie'],
  catalogs: [
    ...Object.entries(CATALOGS).map(([id, c]) => ({
      type: 'anime', id: 'al_' + id, name: c.name,
      extra: [{ name: 'genre', options: GENRES }, { name: 'skip' }],
    })),
    { type: 'anime', id: 'al_search', name: 'Anime Search', extra: [{ name: 'search', isRequired: true }] },
  ],
  behaviorHints: { configurable: false },
};

// ---------- tiny TTL cache ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return val;
}

// ---------- AniList ----------
async function anilist(query, variables) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429) { await new Promise(s => setTimeout(s, (+r.headers.get('retry-after') || 2) * 1000)); continue; }
    const j = await r.json();
    if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
    return j.data;
  }
  throw new Error('AniList rate limited');
}

const LIST_FIELDS = `id idMal format status episodes averageScore genres seasonYear startDate { year month day }
  title { romaji english } coverImage { extraLarge large }
  nextAiringEpisode { episode timeUntilAiring } description(asHtml:false)`;

const PAGE_QUERY = `query ($page:Int,$perPage:Int,$sort:[MediaSort],$status:MediaStatus,$format_in:[MediaFormat],
  $season:MediaSeason,$seasonYear:Int,$genre:String,$search:String) {
  Page(page:$page, perPage:$perPage) { media(type:ANIME, sort:$sort, status:$status, format_in:$format_in,
    season:$season, seasonYear:$seasonYear, genre:$genre, search:$search, isAdult:false) { ${LIST_FIELDS} } } }`;

const META_QUERY = `query ($id:Int) { Media(id:$id, type:ANIME) { ${LIST_FIELDS} bannerImage duration
  studios(isMain:true) { nodes { name } }
  trailer { id site } streamingEpisodes { title thumbnail } airingSchedule(perPage:50) { nodes { episode airingAt } } } }`;

// ---------- ID mapping (AniList <-> Kitsu) so stream addons work ----------
let alToKitsu = new Map(), kitsuToAl = new Map(), alToImdb = new Map();
async function loadMapping() {
  try {
    const list = await (await fetch(MAPPING_URL)).json();
    const a = new Map(), k = new Map(), im = new Map();
    for (const e of list) {
      if (!e.anilist_id) continue;
      if (e.kitsu_id) { a.set(e.anilist_id, e.kitsu_id); k.set(e.kitsu_id, e.anilist_id); }
      const imdb = Array.isArray(e.imdb_id) ? e.imdb_id[0] : e.imdb_id;
      if (imdb && /^tt\d+$/.test(imdb)) im.set(e.anilist_id, imdb);
    }
    alToKitsu = a; kitsuToAl = k; alToImdb = im;
    console.log(`Loaded ${a.size} AniList→Kitsu mappings`);
  } catch (e) { console.error('Mapping load failed:', e.message); }
}
// IMDb first: Stremio then opens the full show (all seasons, episode thumbnails) via Cinemeta.
const stremioId = al => alToImdb.get(al) || (alToKitsu.has(al) ? `kitsu:${alToKitsu.get(al)}` : `anilist:${al}`);

// ---------- helpers ----------
const pickTitle = t => (TITLE_LANG === 'romaji' ? t.romaji || t.english : t.english || t.romaji) || '';
const cleanDesc = d => (d || '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function airingBadge(m) {
  if (!m.nextAiringEpisode) return '';
  const sec = m.nextAiringEpisode.timeUntilAiring, d = Math.floor(sec / 86400);
  return `EP ${m.nextAiringEpisode.episode} · ${d >= 1 ? d + 'd' : Math.max(Math.floor(sec / 3600), 1) + 'h'}`;
}
function dateLabel(m) {
  const sd = m.startDate || {};
  if (!sd.year) return m.status === 'NOT_YET_RELEASED' ? 'TBA' : '';
  return [sd.day && sd.month ? sd.day : null, sd.month ? MONTHS[sd.month - 1] : null, sd.year].filter(Boolean).join(' ');
}

function toMetaPreview(m, base, type) {
  const title = pickTitle(m.title);
  const img = m.coverImage.extraLarge || m.coverImage.large;
  return {
    id: stremioId(m.id), type, name: title,
    poster: `${base}/poster/${b64({ t: title, i: img, r: m.averageScore ? (m.averageScore / 10).toFixed(1) : '',
      e: airingBadge(m), dt: dateLabel(m) })}.jpg`,
    posterShape: 'poster', genres: m.genres,
    description: cleanDesc(m.description),
    releaseInfo: m.seasonYear ? String(m.seasonYear) : undefined,
    imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined,
  };
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers['x-forwarded-host'] || req.get('host')}`;
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.replace(/\.json$/, '').split('&')) {
    const [k, v] = part.split('=');
    if (k) out[k] = decodeURIComponent(v || '');
  }
  return out;
}

// ---------- poster rendering ----------
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function wrap(text, fontSize, maxWidth, maxLines) {
  const charW = fontSize * 0.62;
  const maxChars = Math.floor(maxWidth / charW);
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length <= maxChars) cur = next;
    else { if (cur) lines.push(cur); cur = w.length > maxChars ? w.slice(0, maxChars - 1) + '…' : w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '').slice(0, maxChars - 1) + '…';
    return { lines: kept, overflow: true };
  }
  return { lines, overflow: false };
}

function fitTitle(text, width) {
  for (let size = 40; size >= 24; size -= 2) {
    const r = wrap(text, size, width, 3);
    if (!r.overflow) return { size, lines: r.lines };
  }
  return { size: 24, lines: wrap(text, 24, width, 3).lines };
}

async function renderPoster({ t, i, r, e, dt, b }) {
  const W = 400, H = 600, pad = 22, FONT = 'DejaVu Sans, Inter, Arial, sans-serif';
  const coverBuf = Buffer.from(await (await fetch(i)).arrayBuffer());
  const { size, lines } = fitTitle(t, W - pad * 2);
  const lh = Math.round(size * 1.15);
  const dateH = dt ? 34 : 0;
  const titleBottom = H - pad - dateH;
  const textTop = titleBottom - lh * lines.length + size * 0.85;
  const gradStart = Math.max(0, (titleBottom - lh * lines.length - 120) / H);
  const tspans = lines.map((l, n) => `<tspan x="${pad}" y="${Math.round(textTop + n * lh)}">${esc(l)}</tspan>`).join('');

  let top = '';
  if (r) { // big rating, top-right
    const label = `★ ${r}`, w = Math.round(label.length * 19 + 30);
    top += `<rect x="${W - w - 12}" y="12" rx="18" width="${w}" height="52" fill="#000" fill-opacity="0.78"/>
      <text x="${W - w / 2 - 12}" y="49" text-anchor="middle" font-family="${FONT}" font-size="32" font-weight="800"
        fill="#FFC83D">${esc(label)}</text>`;
  }
  const ep = e || b;
  if (ep) { // next episode countdown, top-left
    const w = Math.round(ep.length * 12.5 + 26);
    top += `<rect x="12" y="14" rx="14" width="${w}" height="36" fill="#7b5bf5" fill-opacity="0.92"/>
      <text x="${12 + w / 2}" y="39" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="700"
        fill="#fff">${esc(ep)}</text>`;
  }
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="${gradStart}" stop-color="#000" stop-opacity="0"/>
      <stop offset="${Math.min(1, gradStart + 0.25)}" stop-color="#000" stop-opacity="0.78"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.96"/></linearGradient>
      <filter id="s"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.9"/></filter></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${top}
    <text font-family="${FONT}" font-size="${size}" font-weight="800" fill="#fff" filter="url(#s)">${tspans}</text>
    ${dt ? `<text x="${pad}" y="${H - pad - 4}" font-family="${FONT}" font-size="24" font-weight="600"
      fill="#d8d8e0" filter="url(#s)">${esc(dt)}</text>` : ''}</svg>`;

  return sharp(coverBuf).resize(W, H, { fit: 'cover', position: 'attention' })
    .composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82 }).toBuffer();
}

// ---------- server ----------
const app = express();
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); next(); });

app.get('/', (req, res) => {
  const url = `${baseUrl(req)}/manifest.json`;
  res.send(`<html><body style="font-family:sans-serif;background:#141320;color:#eee;padding:40px;text-align:center">
    <h2>${manifest.name}</h2><p>${manifest.description}</p>
    <p><a style="background:#7b5bf5;color:#fff;padding:14px 26px;border-radius:10px;text-decoration:none"
      href="${url.replace(/^https?:/, 'stremio:')}">Install in Stremio</a></p>
    <p>Or paste into Stremio's addon search:<br><code>${url}</code></p></body></html>`);
});

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/:type/:id{/:extra}', async (req, res) => {
  try {
    const id = req.params.id.replace(/\.json$/, '');
    const extra = parseExtra(req.params.extra);
    const page = Math.round((+extra.skip || 0) / PER_PAGE) + 1; // tolerant of de-duplicated pages
    let vars, type = 'series';
    if (id === 'al_search') {
      if (!extra.search) return res.json({ metas: [] });
      vars = { search: extra.search, sort: ['SEARCH_MATCH'] };
    } else {
      const c = CATALOGS[id.replace(/^al_/, '')];
      if (!c) return res.json({ metas: [] });
      vars = c.vars(); type = c.type;
    }
    if (extra.genre) vars.genre = extra.genre;
    vars.page = page; vars.perPage = PER_PAGE;
    const data = await cached('cat:' + JSON.stringify(vars), 30 * 60e3, () => anilist(PAGE_QUERY, vars));
    const base = baseUrl(req);
    const seen = new Set();
    const metas = data.Page.media.map(m => toMetaPreview(m, base, m.format === 'MOVIE' ? 'movie' : type))
      .filter(x => !seen.has(x.id) && seen.add(x.id)); // seasons of one show share an IMDb id
    res.setHeader('Cache-Control', 'max-age=1800');
    res.json({ metas });
  } catch (e) { console.error(e); res.json({ metas: [] }); }
});

app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    const { id } = req.params;
    let alId;
    if (id.startsWith('kitsu:')) alId = kitsuToAl.get(+id.split(':')[1]);
    else if (id.startsWith('anilist:')) alId = +id.split(':')[1];
    if (!alId) return res.json({ meta: null });

    const { Media: m } = await cached('meta:' + alId, 60 * 60e3, () => anilist(META_QUERY, { id: alId }));
    const base = baseUrl(req);
    const meta = toMetaPreview(m, base, m.format === 'MOVIE' ? 'movie' : 'series');
    meta.id = id;
    meta.background = m.bannerImage || m.coverImage.extraLarge;
    meta.runtime = m.duration ? `${m.duration} min` : undefined;
    if (m.startDate?.year) meta.released = new Date(Date.UTC(m.startDate.year, (m.startDate.month || 1) - 1, m.startDate.day || 1)).toISOString();
    const studio = m.studios?.nodes?.[0]?.name;
    if (studio) meta.director = [studio];
    if (m.trailer?.site === 'youtube') meta.trailers = [{ source: m.trailer.id, type: 'Trailer' }];

    if (meta.type === 'series') {
      const aired = new Map((m.airingSchedule?.nodes || []).map(n => [n.episode, n.airingAt]));
      const count = m.episodes || (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : aired.size) || 1;
      const thumbs = new Map();
      for (const se of m.streamingEpisodes || []) {
        const n = +(se.title.match(/^Episode\s+(\d+)/i) || [])[1];
        if (n && !thumbs.has(n)) thumbs.set(n, { thumb: se.thumbnail, name: se.title.replace(/^Episode\s+\d+\s*[-:–]\s*/i, '') });
      }
      meta.videos = Array.from({ length: count }, (_, k) => {
        const ep = k + 1, t = thumbs.get(ep);
        return {
          id: `${id}:${ep}`, title: t?.name || `Episode ${ep}`, season: 1, episode: ep,
          thumbnail: t?.thumb || meta.background,
          released: new Date(aired.has(ep) ? aired.get(ep) * 1000 : meta.released || Date.now()).toISOString(),
        };
      });
    }
    res.setHeader('Cache-Control', 'max-age=3600');
    res.json({ meta });
  } catch (e) { console.error(e); res.json({ meta: null }); }
});

app.get('/poster/:data.jpg', async (req, res) => {
  try {
    const raw = req.params.data;
    const d = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!/^https:\/\/s4\.anilist\.co\//.test(d.i)) return res.status(400).end();
    const img = await cached('img:' + raw, 6 * 3600e3, () => renderPoster(d));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=21600');
    res.end(img);
  } catch (e) { console.error(e); res.status(500).end(); }
});

loadMapping();
setInterval(loadMapping, 24 * 3600e3);
if (require.main === module) app.listen(PORT, () => console.log(`Addon running: http://localhost:${PORT}/manifest.json`));
module.exports = { renderPoster, fitTitle };
