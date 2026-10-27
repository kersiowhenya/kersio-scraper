/**
 * Name Scrape : ML Stalk (via zenvan.store)
 * Base Web    : zenvan.store
 * Type        : Scraper
 * Function    : Cek akun Mobile Legends (nickname + region) dari User ID + Zone ID tanpa login.
 * Input       : User ID + Zone ID. Format bebas:
 *               "1114917746 13486" | "(1114917746)(13486)" | "1114917746|13486" | "1114917746:13486"
 * Output      : JSON
 * Require     : Node.js 18+ (tanpa library tambahan)
 * Endpoint    : GET https://zenvan.store/api/check-ml?id=<userId>&server=<zoneId>&locale=en
 * Note        : Jeda 1 detik antar request. Hanya untuk data publik.
 */

const BASE     = 'https://zenvan.store';
const PAGE     = BASE + '/en/cek-akun-ml';
const API      = BASE + '/api/check-ml';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GAP_MS   = 1000;

// ---------- Helper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ScrapeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// User ID + Zone ID dari berbagai format
function parseInput(a, b) {
  const uid0 = String(a || '').trim();
  const zid0 = String(b || '').trim();
  let m;
  if (uid0 && zid0) m = [null, uid0.replace(/\D/g, ''), zid0.replace(/\D/g, '')];
  else m = uid0.match(/(\d{5,})\D+(\d{1,6})/);
  if (!m) return null;
  const userId = m[1];
  const zoneId = m[2];
  if (!/^\d{5,15}$/.test(userId) || !/^\d{1,6}$/.test(zoneId)) return null;
  return { userId, zoneId };
}

// Cari nilai berdasarkan nama key di JSON bersarang
function deepFind(obj, re, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '') return String(v);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = deepFind(v, re, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ---------- Sesi ----------
async function createSession() {
  const res = await fetch(PAGE, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 403 || res.status === 503) {
    throw new ScrapeError('BLOCKED', 'Akses ke zenvan.store diblokir (proteksi anti-bot). Coba lagi nanti atau ganti jaringan.', res.status);
  }
  if (!res.ok) throw new ScrapeError('API_ERROR', `zenvan.store membalas HTTP ${res.status}`, res.status);

  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else if (res.headers.get('set-cookie')) list = res.headers.get('set-cookie').split(/,(?=\s*[\w.-]+=)/);
  const cookie = list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');

  return { cookie, last: Date.now() };
}

// Jaga jeda minimal antar request
async function pace(s) {
  const wait = s.last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  s.last = Date.now();
}

async function api(s, userId, zoneId) {
  await pace(s);
  const url = `${API}?${new URLSearchParams({ id: userId, server: zoneId, locale: 'en' })}`;
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': PAGE
  };
  if (s.cookie) headers.Cookie = s.cookie;

  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30000) });

  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }

  if (res.status === 429) throw new ScrapeError('RATE_LIMITED', 'Terlalu banyak request. Coba lagi beberapa saat lagi.', 429);
  if ((res.status === 403 || res.status === 503) && !data) throw new ScrapeError('BLOCKED', `Request ditolak (HTTP ${res.status}). Kemungkinan kena proteksi anti-bot.`, res.status);
  if (!data) throw new ScrapeError('API_ERROR', `Layanan membalas HTTP ${res.status} tanpa JSON`, res.status);

  const errMsg = data.error || (data.success === false && (data.message || data.msg));
  if (errMsg) throw new ScrapeError('NOT_FOUND', `Akun tidak ditemukan atau ditolak: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`, res.status);
  if (!res.ok) throw new ScrapeError('API_ERROR', `Layanan membalas HTTP ${res.status}`, res.status);
  return data;
}

// ---------- Rapikan data ----------
function mapAccount(d) {
  return {
    nickname: deepFind(d, /^(nick_?name|nick|ign|username|user_?name|player_?name|role_?name|name)$/i),
    region:   deepFind(d, /^(region|country|country_?name|country_?code|region_?name)$/i),
    age:      deepFind(d, /^(age|account_?age|age_?estimate|estimated_?age|created|created_?at|year)$/i)
  };
}

// ---------- Caption ----------
function buildCaption(out) {
  return '🎮 *ML Stalk*\n\n' +
    `🆔 User ID  : ${out.userId}\n` +
    `🌐 Zone ID  : ${out.zoneId}\n` +
    `👤 Nickname : ${out.nickname}\n` +
    `🌍 Region   : ${out.region || '-'}\n` +
    (out.age ? `📅 Umur akun (estimasi) : ${out.age}\n` : '');
}

/**
 * ML Stalk - Single function (zenvan only)
 * @param {string} userId - User ID, atau gabungan seperti "(1114917746)(13486)"
 * @param {string} [zoneId] - Zone ID (kosongkan jika sudah digabung di userId)
 * @param {object} [options]
 * @param {boolean} [options.raw=false] - true = sertakan respons mentah dari web
 * @returns {Promise<object>} JSON hasil
 */
async function mlstalk(userId, zoneId, options = {}) {
  try {
    const p = parseInput(userId, zoneId);
    if (!p) {
      return { success: false, error: 'INVALID_INPUT', message: 'Input tidak valid. Contoh: node mlstalk.js 1114917746 13486 atau node mlstalk.js "(1114917746)(13486)"' };
    }

    const s = await createSession();
    const d = await api(s, p.userId, p.zoneId);
    const acc = mapAccount(d);
    if (!acc.nickname) {
      throw new ScrapeError('NO_DATA', 'Nickname tidak ditemukan di respons. Jalankan dengan --raw untuk melihat respons mentahnya.');
    }

    const out = { success: true, source: 'kersio', userId: p.userId, zoneId: p.zoneId, ...acc };
    if (!out.age) delete out.age;
    if (options.raw) out.raw = d;
    out.caption = buildCaption(out);
    return out;
  } catch (err) {
    if (err instanceof ScrapeError) {
      return { success: false, error: err.code, status: err.status, message: err.message };
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { mlstalk };

// Cek akun                 : node mlstalk.js 1114917746 13486
// Format gabungan          : node mlstalk.js "(1114917746)(13486)"
// Sertakan respons mentah  : node mlstalk.js 1114917746 13486 --raw
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));

  mlstalk(pos[0], pos[1], { raw: args.includes('--raw') }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.success) process.exitCode = 1;
  });
}
