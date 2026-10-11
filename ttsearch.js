/**
 * Name Scrape : TikTok Search (via GetDL)
 * Owner       : Kersio
 * Base Web    :  ww.tiktok.com
 * Type        : Scraper
 * Function    : Cari video TikTok pakai kata kunci, lengkap dengan link MP4 langsung, statistik, author, dan musik
 * Input       : 1 kata kunci (+ opsi limit, cursor, region, sortType)
 * Output      : JSON                                                                                                                                                                                  *  SALURAN :  https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : erorr fix sendiri ya
 *               Region: id | us | br | jp | cn | dll. sortType: 0 = relevansi (default).
 */

const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { finished } = require('stream/promises');

const BASE = 'https://getdl.space';
const SESSION_URL = `${BASE}/api/session`;
const SEARCH_URL = `${BASE}/api/search/tiktok`;
const REFERER = `${BASE}/id/search/tiktok`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 25000;
const MIN_GAP_MS = 3000; // jeda minimal antar request supaya sopan

// State sederhana (sesi dipakai ulang antar pemanggilan)
const jar = new Map();
let sessionId = null;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

// Helper: request JSON dengan jeda, timeout, dan cookie
async function request(url, { method = 'GET', body, extraHeaders = {} } = {}) {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Referer': REFERER,
      'Cookie': cookieHeader(),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT)
  });

  storeCookies(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* bukan JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}

// Helper: buat sesi (coba GET dulu, lalu POST)
async function ensureSession(force = false) {
  if (sessionId && !force) return sessionId;
  jar.clear();
  sessionId = null;

  for (const method of ['GET', 'POST']) {
    const r = await request(SESSION_URL, {
      method,
      extraHeaders: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}
    });
    if (r.data?.success && r.data?.sessionId) {
      sessionId = r.data.sessionId;
      return sessionId;
    }
  }
  throw new Error('SESSION_FAILED');
}

// Helper: ambil angka statistik dari beberapa kemungkinan nama kunci
const pick = (obj, keys) => {
  if (!obj) return null;
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
};
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));

/**
 * TikTok Search - Single function
 * @param {string} keyword - Kata kunci pencarian
 * @param {object} [options]
 * @param {number} [options.limit=5]     - Jumlah hasil (1-20)
 * @param {number} [options.cursor=0]    - Offset untuk halaman berikutnya
 * @param {string} [options.region='id'] - Kode negara
 * @param {number} [options.sortType=0]  - 0 = relevansi
 * @returns {Promise<object>} JSON hasil
 */
async function tiktokSearch(keyword, options = {}) {
  try {
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return { success: false, error: 'INVALID_KEYWORD', message: 'Kata kunci tidak boleh kosong' };
    }

    const limit = Math.min(Math.max(parseInt(options.limit, 10) || 5, 1), 20);
    const cursor = parseInt(options.cursor, 10) || 0;
    const region = options.region || 'id';
    const sortType = parseInt(options.sortType, 10) || 0;

    let sid = await ensureSession();
    let refreshed = false;
    let rateRetries = 0;
    let r;

    // Kirim pencarian (ulang sesi sekali, ulang 2x kalau kena rate limit)
    while (true) {
      r = await request(SEARCH_URL, {
        method: 'POST',
        body: { query: keyword.trim(), count: limit, cursor, region, sortType, sessionId: sid },
        extraHeaders: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
      });

      if (r.data?.code === 'RATE_LIMITED' || r.status === 429) {
        if (rateRetries < 2) {
          rateRetries++;
          await sleep(5000 * rateRetries);
          continue;
        }
        return { success: false, error: 'RATE_LIMITED', message: 'Terlalu banyak request. Tunggu beberapa saat lalu coba lagi.' };
      }

      const sessionProblem = [401, 403].includes(r.status) || /session/i.test(String(r.data?.error || ''));
      if (sessionProblem && !refreshed) {
        refreshed = true;
        sid = await ensureSession(true);
        continue;
      }
      break;
    }

    if (!r.data) {
      return { success: false, error: 'INVALID_RESPONSE', message: `Respons bukan JSON (HTTP ${r.status})`, raw: r.text.slice(0, 300) };
    }
    if (!r.data.success || !r.data.data) {
      return { success: false, error: 'SEARCH_FAILED', status: r.status, message: String(r.data.error || r.data.message || 'Pencarian gagal').slice(0, 300) };
    }

    const d = r.data.data;
    const results = (d.videos || []).map((v) => {
      const stats = v.stats || null;
      const author = v.author
        ? { id: v.author.id, username: v.author.username, nickname: v.author.nickname, avatar: v.author.avatar }
        : null;
      const music = v.music
        ? { id: v.music.id, title: v.music.title, author: v.music.author, duration: v.music.duration, url: v.music.play || null, cover: v.music.cover }
        : null;

      const plays = pick(stats, ['playCount', 'plays', 'play_count', 'views']);
      const likes = pick(stats, ['diggCount', 'likes', 'digg_count', 'likeCount']);
      const comments = pick(stats, ['commentCount', 'comments', 'comment_count']);
      const shares = pick(stats, ['shareCount', 'shares', 'share_count']);

      const caption =
        `🎵 *${v.title || '-'}*\n\n` +
        `👤 ${author?.nickname || '-'} (@${author?.username || '-'})\n` +
        `▶️ ${fmt(plays)}  ❤️ ${fmt(likes)}  💬 ${fmt(comments)}  🔁 ${fmt(shares)}\n` +
        `🎶 ${music?.title || '-'}${music?.author ? ` - ${music.author}` : ''}`;

      return {
        id: v.videoId || null,
        aweme_id: v.awemeId || null,
        title: v.title || null,
        duration: v.duration ?? null,
        region: v.region || null,
        cover: v.cover || v.originCover || null,
        play_url: v.playUrl || null,
        wm_play_url: v.wmPlayUrl || null,
        stats,
        author,
        music,
        created_at: v.createdAt ? new Date(v.createdAt * 1000).toISOString() : null,
        caption
      };
    });

    if (results.length === 0) {
      return { success: false, error: 'NO_RESULTS', message: `Tidak ada hasil untuk "${keyword.trim()}"` };
    }

    return {
      success: true,
      keyword: keyword.trim(),
      count: results.length,
      cursor: d.cursor ?? null,
      has_more: d.hasMore ?? null,
      region: d.region || region,
      results
    };

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    if (err.message === 'SESSION_FAILED') {
      return { success: false, error: 'SESSION_FAILED', message: 'Gagal membuat sesi di situs. Coba lagi nanti.' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

/**
 * TikTok Download - simpan video jadi file .mp4
 * @param {string|object} source - Link MP4 (play_url) atau 1 item dari hasil tiktokSearch
 * @param {object} [options]
 * @param {string} [options.outDir]  - Folder simpan (default: ./downloads)
 * @param {number} [options.maxMB=100] - Batas ukuran file dalam MB
 * @returns {Promise<object>} JSON hasil
 */
async function tiktokDownload(source, options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), 'downloads');
  const maxBytes = (Number(options.maxMB) || 100) * 1024 * 1024;
  let filePath = null;

  try {
    const url = typeof source === 'string' ? source : (source?.play_url || source?.wm_play_url);
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'INVALID_URL', message: 'Link video tidak valid' };
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000)
    });

    if (!res.ok) {
      return { success: false, error: 'DOWNLOAD_FAILED', status: res.status, message: `Gagal mengunduh (HTTP ${res.status}). Link mungkin sudah kedaluwarsa.` };
    }

    const type = res.headers.get('content-type') || '';
    if (type && !/video|octet-stream|mp4/i.test(type)) {
      return { success: false, error: 'NOT_VIDEO', message: `Isi unduhan bukan video (${type.split(';')[0]})` };
    }
    if (Number(res.headers.get('content-length') || 0) > maxBytes) {
      return { success: false, error: 'FILE_TOO_LARGE', message: `Ukuran file melebihi ${options.maxMB || 100}MB` };
    }

    fs.mkdirSync(outDir, { recursive: true });
    const rawId = (typeof source === 'object' && (source.id || source.aweme_id)) || Date.now();
    const safeId = String(rawId).replace(/[^\w-]/g, '') || String(Date.now());
    filePath = path.join(outDir, `tiktok_${safeId}.mp4`);

    // Tulis bertahap sambil menjaga batas ukuran
    const out = fs.createWriteStream(filePath);
    let written = 0;
    try {
      for await (const chunk of res.body) {
        written += chunk.length;
        if (written > maxBytes) throw new Error('FILE_TOO_LARGE');
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await finished(out);
    } catch (e) {
      out.destroy();
      throw e;
    }

    return {
      success: true,
      file_path: filePath,
      file_name: path.basename(filePath),
      filesize: written,
      source_url: url
    };

  } catch (err) {
    if (filePath) fs.rmSync(filePath, { force: true });
    if (err.message === 'FILE_TOO_LARGE') {
      return { success: false, error: 'FILE_TOO_LARGE', message: `Ukuran file melebihi ${options.maxMB || 100}MB` };
    }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Download terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

/**
 * Cari lalu langsung unduh salah satu hasilnya
 * @param {string} keyword
 * @param {object} [options] - sama seperti tiktokSearch + index (hasil ke-berapa, mulai 0) + outDir + maxMB
 */
async function tiktokSearchDownload(keyword, options = {}) {
  const search = await tiktokSearch(keyword, { ...options, limit: Math.max((options.index || 0) + 1, 1) });
  if (!search.success) return search;

  const item = search.results[options.index || 0];
  if (!item) return { success: false, error: 'NO_RESULTS', message: 'Hasil dengan nomor itu tidak ada' };

  const dl = await tiktokDownload(item, options);
  if (!dl.success) return dl;

  return { success: true, keyword: search.keyword, video: item, file: dl };
}

module.exports = { tiktokSearch, tiktokDownload, tiktokSearchDownload };

// Cari      : node tiktoksearch.js "kucing" 5 id
// Cari+unduh: node tiktoksearch.js dl "kucing" 1     (1 = hasil pertama)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'dl') {
    const [, keyword, nth, region] = args;
    tiktokSearchDownload(keyword, { index: Math.max((parseInt(nth, 10) || 1) - 1, 0), region })
      .then((r) => console.log(JSON.stringify(r, null, 2)));
  } else {
    const [keyword, limit, region] = args;
    tiktokSearch(keyword, { limit, region }).then((r) => console.log(JSON.stringify(r, null, 2)));
  }
}
