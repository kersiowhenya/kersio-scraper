/**
 * Name Scrape : Pinterest Viewer (via Internal Resource API)
 * Owner       : Kersio
 * Base Web    : id.pinterest.com
 * Type        : Scraper
 * Function    : Mengambil data Pinterest publik tanpa login: profil, daftar pin,
 *               hasil pencarian, board, dan detail satu pin. Bisa unduh gambar.
 * Input       : Username / link profil / link board / link pin / keyword
 *               + mode (all | profile | pins | board | search | pin)
 * Output      : JSON (+ file gambar di folder pinterest kalau pakai download)
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan)
 * Note        : Jeda 2.5 detik antar request. Hanya untuk konten publik.
 *               Jangan spam request. Struktur web bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://id.pinterest.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const APP_VERSION = '45d1a26';
const GAP_MS = 2500;
const MAX_PAGES = 5;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD = 25;

const SOURCE = 'https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G';
const MODES = ['all', 'profile', 'pins', 'board', 'search', 'pin'];

// ---------- Helper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => parseInt(x, 10) || 0;

class ScrapeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fmt(n) {
  n = num(n);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ---------- Parsing Input ----------
function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const pinMatch = raw.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i);
  if (pinMatch) return { type: 'pin', value: pinMatch[1] };

  const boardMatch = raw.match(/pinterest\.[a-z.]+\/([^\/]+)\/([^\/\?]+)\/?$/i);
  if (boardMatch && !boardMatch[2].startsWith('pin') && boardMatch[2] !== 'pins') {
    return { type: 'board', value: { username: boardMatch[1], board: boardMatch[2] } };
  }

  const profileMatch = raw.match(/pinterest\.[a-z.]+\/([^\/\?]+)\/?$/i);
  if (profileMatch) return { type: 'user', value: profileMatch[1] };

  return { type: 'search', value: raw };
}

// ---------- Sesi & Cookie ----------
async function createSession() {
  const res = await fetch(BASE + '/', {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });

  if (res.status === 403 || res.status === 503) {
    throw new ScrapeError('BLOCKED', 'Akses ke Pinterest diblokir (anti-bot). Coba ganti jaringan.', res.status);
  }
  if (!res.ok) throw new ScrapeError('API_ERROR', `Pinterest membalas HTTP ${res.status}`, res.status);

  let cookieParts = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookieParts = res.headers.getSetCookie().map(c => c.split(';')[0].trim());
  } else if (res.headers.get('set-cookie')) {
    cookieParts = res.headers.get('set-cookie').split(/,(?=\s*[\w.-]+=)/).map(c => c.split(';')[0].trim());
  }

  const html = await res.text();

  let cookieString = cookieParts.filter(Boolean).join('; ');
  if (!/csrftoken=/.test(cookieString)) {
    const m = html.match(/csrftoken["']?\s*[:=]\s*["']([^"']+)["']/);
    if (m) cookieString += (cookieString ? '; ' : '') + `csrftoken=${m[1]}`;
  }

  let appVersion = APP_VERSION;
  const verMatch = html.match(/"appVersion"\s*:\s*"([^"]+)"/);
  if (verMatch) appVersion = verMatch[1];

  return { cookie: cookieString, appVersion, last: Date.now() };
}

// ---------- Request Headers ----------
function apiHeaders(s, pwsHandler, sourceUrl) {
  const h = {
    'accept': 'application/json, text/javascript, */*, q=0.01',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'user-agent': USER_AGENT,
    'x-app-version': s.appVersion,
    'x-pinterest-appstate': 'background',
    'x-pinterest-pws-handler': pwsHandler,
    'x-pinterest-source-url': sourceUrl,
    'x-requested-with': 'XMLHttpRequest',
    'referer': BASE + '/',
    'origin': BASE
  };
  if (s.cookie) h.cookie = s.cookie;
  return h;
}

// ---------- Pace ----------
async function pace(s) {
  const wait = s.last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  s.last = Date.now();
}

// ---------- Resource API Call ----------
async function resource(s, resourceName, pwsHandler, options, sourceUrl) {
  await pace(s);

  const dataParam = JSON.stringify({ options, context: {} });
  const url = new URL(`${BASE}/resource/${resourceName}/get/`);
  url.searchParams.set('source_url', sourceUrl);
  url.searchParams.set('data', dataParam);
  url.searchParams.set('_', Date.now());

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: apiHeaders(s, pwsHandler, sourceUrl),
    signal: AbortSignal.timeout(60000)
  });

  let body = null;
  try { body = await res.json(); } catch {}

  if (res.status === 429) throw new ScrapeError('RATE_LIMITED', 'Terlalu banyak request. Tunggu 60 detik.', 429);
  if (res.status === 403) throw new ScrapeError('BLOCKED', 'Request ditolak (HTTP 403). Cookie/token mungkin kadaluarsa.', 403);
  if (!res.ok || !body) throw new ScrapeError('API_ERROR', `HTTP ${res.status}`, res.status);

  const rr = body.resource_response;
  if (!rr) throw new ScrapeError('NO_DATA', 'Struktur respons berubah atau tidak ada data.');

  return {
    data: rr.data,
    bookmark: (body.resource?.options?.bookmarks) || rr.bookmark || []
  };
}

// ---------- Collect multi-page ----------
async function collect(s, resourceName, pwsHandler, baseOptions, listKey, sourceUrl, pages) {
  const items = [];
  let bookmarks = [];
  let hasMore = false;

  for (let i = 0; i < pages; i++) {
    const d = await resource(s, resourceName, pwsHandler,
      { ...baseOptions, bookmarks }, sourceUrl);

    let list = [];
    if (Array.isArray(d.data)) list = d.data;
    else if (d.data && Array.isArray(d.data[listKey])) list = d.data[listKey];
    else if (d.data && Array.isArray(d.data.results)) list = d.data.results;

    items.push(...list);

    bookmarks = d.bookmark;
    hasMore = Array.isArray(bookmarks) && bookmarks.length > 0 && bookmarks[0] !== '-end-';
    if (!hasMore) break;
  }

  return { items, hasMore };
}

// ---------- Mapper ----------
function mapPin(p) {
  const images = p.images || {};
  const orig = images.orig || images['736x'] || images['564x'] || images['236x'] || {};
  return {
    id: p.id || null,
    title: p.title || p.grid_title || '',
    description: p.description || '',
    link: p.link || null,
    image: orig.url || null,
    image236: (images['236x'] || {}).url || null,
    image736: (images['736x'] || {}).url || null,
    image564: (images['564x'] || {}).url || null,
    width: orig.width || null,
    height: orig.height || null,
    dominantColor: p.dominant_color || null,
    repinCount: num(p.repin_count),
    board: p.board ? { id: p.board.id, name: p.board.name, url: p.board.url } : null,
    pinner: p.pinner ? { username: p.pinner.username, fullName: p.pinner.full_name } : null,
    createdAt: p.created_at || null
  };
}

function mapUser(u) {
  return {
    id: u.id || null,
    username: u.username || null,
    fullName: u.full_name || '',
    bio: u.about || '',
    avatar: u.image_xlarge_url || u.image_large_url || null,
    followers: num(u.follower_count),
    following: num(u.following_count),
    pins: num(u.pin_count),
    boards: num(u.board_count),
    website: u.website_url || null
  };
}

// ---------- Download ----------
async function downloadMedia(url, filename, outDir) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': BASE + '/'
      },
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) return null;

    const type = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const ext = type.includes('mpeg') ? 'mp4'
      : type.includes('webp') ? 'webp'
      : type.includes('png') ? 'png'
      : type.includes('gif') ? 'gif'
      : 'jpg';

    const safe = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]/g, '_');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${safe}_${Date.now()}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, filesize: buffer.length };
  } catch {
    return null;
  }
}

// ---------- Caption ----------
function buildCaption(mode, out) {
  const lines = [];
  lines.push('📌 *Pinterest Viewer*');
  lines.push('');

  if (out.pin) {
    const p = out.pin;
    lines.push(`🆔 ID       : ${p.id}`);
    lines.push(`📌 Judul    : ${p.title || '(tanpa judul)'}`);
    if (p.description) lines.push(`📝 Deskripsi: ${p.description.slice(0, 300)}`);
    lines.push(`🔁 Repin    : ${fmt(p.repinCount)}`);
    if (p.pinner) lines.push(`👤 Pinner   : @${p.pinner.username} (${p.pinner.fullName})`);
    if (p.board) lines.push(`📋 Board    : ${p.board.name}`);
    if (p.link) lines.push(`🔗 Link     : ${p.link}`);
    if (p.image) lines.push(`🖼️ Gambar   : ${p.image}`);
    if (p.createdAt) lines.push(`📅 Dibuat   : ${p.createdAt}`);
    if (out.files && out.files.length) lines.push(`💾 File     : ${out.files.length} tersimpan`);
    lines.push('');
    lines.push(`🌐 Sumber   : ${SOURCE}`);
    return lines.join('\n');
  }

  if (out.user) {
    const u = out.user;
    lines.push(`👤 Nama     : ${u.fullName}`);
    lines.push(`🔖 Username : @${u.username}`);
    if (u.bio) lines.push(`📝 Bio      : ${u.bio.slice(0, 200)}`);
    lines.push(`👥 Followers: ${fmt(u.followers)}`);
    lines.push(`➡️ Following: ${fmt(u.following)}`);
    lines.push(`📌 Pins     : ${fmt(u.pins)}`);
    lines.push(`📋 Boards   : ${fmt(u.boards)}`);
    if (u.website) lines.push(`🌐 Website  : ${u.website}`);
    lines.push('');
  } else {
    lines.push(`🔖 Target   : ${out.target}`);
    lines.push(`🎯 Mode     : ${out.mode}`);
    lines.push('');
  }

  const list = out.pins;
  if (list && list.length) {
    lines.push(`📦 Total    : ${list.length} pin${out.has_more ? ' (masih ada halaman lain)' : ''}`);
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    list.forEach((p, i) => {
      lines.push(`[${i + 1}] ${p.title || '(tanpa judul)'}`);
      if (p.description) lines.push(`    📝 ${p.description.slice(0, 120)}`);
      if (p.pinner) lines.push(`    👤 @${p.pinner.username} (${p.pinner.fullName})`);
      if (p.board) lines.push(`    📋 ${p.board.name}`);
      lines.push(`    🆔 ${p.id}`);
      lines.push(`    🔁 ${fmt(p.repinCount)} repins`);
      if (p.image) lines.push(`    🖼️ ${p.image}`);
      lines.push('');
    });
  } else if (list) {
    lines.push('📦 Tidak ada pin ditemukan.');
    lines.push('');
  }

  if (out.files && out.files.length) {
    lines.push(`💾 File tersimpan : ${out.files.length}`);
    lines.push(`📁 Folder         : ${out.outDir}`);
    lines.push('');
  }

  lines.push(`🌐 Sumber : ${SOURCE}`);
  return lines.join('\n');
}

// ---------- MAIN ----------
async function pinterest(input, options = {}) {
  try {
    const parsed = parseInput(input);
    if (!parsed) {
      return { success: false, error: 'INVALID_INPUT', message: 'Input tidak valid.', source: SOURCE };
    }

    let mode = String(options.mode || 'auto').toLowerCase();
    if (mode === 'auto') {
      mode = parsed.type === 'pin' ? 'pin'
        : parsed.type === 'board' ? 'board'
        : parsed.type === 'search' ? 'search' : 'all';
    }
    if (!MODES.includes(mode)) {
      return { success: false, error: 'INVALID_MODE', message: `Pilihan: ${MODES.join(', ')}`, source: SOURCE };
    }

    const pages = Math.min(Math.max(num(options.pages) || 1, 1), MAX_PAGES);
    const outDir = options.outDir || path.join(process.cwd(), 'pinterest');
    const wantDownload = !!options.download;

    const s = await createSession();
    const out = {
      success: true,
      target: typeof parsed.value === 'object' ? JSON.stringify(parsed.value) : parsed.value,
      mode,
      source: SOURCE
    };

    if (mode === 'pin') {
      const pinId = parsed.type === 'pin' ? parsed.value : String(parsed.value);
      const d = await resource(s, 'PinResource', 'www/pin/[id].js',
        { id: pinId, field_set_key: 'detailed' }, `/pin/${pinId}/`);
      out.pin = mapPin(d.data);

      if (wantDownload && out.pin.image) {
        const f = await downloadMedia(out.pin.image, `pin_${out.pin.id}`, outDir);
        if (f) {
          out.files = [f.file];
          out.outDir = outDir;
        }
      }
    } else if (mode === 'search') {
      const query = parsed.value;
      const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
      const r = await collect(s, 'SearchResource', 'www/search/[scope].js',
        { query, scope: 'pins', page_size: 25 }, 'results', sourceUrl, pages);
      out.pins = r.items.map(mapPin);
      out.has_more = r.hasMore;
    } else if (mode === 'board') {
      const { username, board } = parsed.value;
      const sourceUrl = `/${username}/${board}/`;
      const r = await collect(s, 'BoardFeedResource', 'www/boards/[username]/[slug]/[slug].js',
        { board_url: sourceUrl, page_size: 25, current_count: 0 }, 'data', sourceUrl, pages);
      out.pins = r.items.map(mapPin);
      out.has_more = r.hasMore;
    } else {
      const username = parsed.value;
      const sourceUrl = `/${username}/`;

      if (['all', 'profile'].includes(mode)) {
        const d = await resource(s, 'UserResource', 'www/user/[username].js',
          { username, field_set_key: 'profile' }, sourceUrl);
        out.user = mapUser(d.data);
      }

      if (mode === 'all' || mode === 'pins') {
        const r = await collect(s, 'UserPinsResource', 'www/user/[username]/pins.js',
          { username, page_size: 25 }, 'data', `${sourceUrl}pins/`, pages);
        out.pins = r.items.map(mapPin);
        out.has_more = r.hasMore;
      }
    }

    if (wantDownload && out.pins && out.pins.length) {
      out.files = [];
      const limit = Math.min(out.pins.length, MAX_DOWNLOAD);
      for (let i = 0; i < limit; i++) {
        const p = out.pins[i];
        const url = p.image || p.image736 || p.image236;
        if (!url) continue;
        const f = await downloadMedia(url, `pin_${p.id}`, outDir);
        if (f) {
          out.files.push(f.file);
          p.localFile = f.file;
        }
        await sleep(300);
      }
      if (out.files.length) out.outDir = outDir;
    }

    out.caption = buildCaption(mode, out);
    return out;
  } catch (err) {
    if (err instanceof ScrapeError) {
      return { success: false, error: err.code, status: err.status, message: err.message, source: SOURCE };
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama.', source: SOURCE };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err), source: SOURCE };
  }
}

module.exports = { pinterest };

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const pagesArg = args.find((a) => a.startsWith('--pages='));
  const outArg = args.find((a) => a.startsWith('--out='));

  pinterest(pos[0], {
    mode: pos[1],
    pages: pagesArg ? pagesArg.split('=')[1] : 1,
    download: args.includes('--download'),
    outDir: outArg ? outArg.split('=').slice(1).join('=') : undefined
  }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log('');
    console.log(`Sumber: ${SOURCE}`);
    if (!r.success) process.exitCode = 1;
  });
}

// ============================================================
// Cara Pakai:
// Profil + pins        : node pinterest.js home-decor
// Satu mode saja       : node pinterest.js home-decor pins
// Beberapa halaman     : node pinterest.js home-decor pins --pages=3
// Info satu pin        : node pinterest.js https://www.pinterest.com/pin/123456/
// Download gambar      : node pinterest.js "kucing" search --download
// Download 1 pin       : node pinterest.js https://www.pinterest.com/pin/123456/ pin --download
// Simpan ke file       : node pinterest.js "kucing" search --download > hasil.json
// Ganti folder output  : node pinterest.js "kucing" search --download --out=D:\gambar
// ============================================================
