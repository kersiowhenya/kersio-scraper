/**
 * Name Scrape : scrape cari sekolah nih😹
 * Owner       : Kersio
 * Base Web    : www.sekolah.data.kemendikdasmen.go.id
 * Type        : Scraper
 * Function    : Mencari data sekolah (lembaga) di portal Sekolah Kita berdasarkan nama sekolah atau NPSN
 * Input       : kata kunci (nama sekolah / NPSN) + filter opsional (kabupaten_kota, bentuk_pendidikan, status_sekolah)
 * Output      : JSON
 * Source      : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Data lembaga sekolah yang tampil terbuka di portal resmi. Jangan spam request.
 *               Endpoint bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://sekolah.data.kemendikdasmen.go.id';
const API = `${BASE}/v1/sekolah-service/sekolah/cari-sekolah`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 10 * 60 * 1000;      // hasil disimpan 10 menit
const SESSION_TTL_MS = 20 * 60 * 1000;    // cookie sesi dipakai ulang 20 menit
const MIN_GAP_MS = 2000;                  // jeda minimal antar request
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000; // kalau dibatasi, berhenti mencoba 10 menit

const cache = new Map();
const jar = new Map();
let sessionAt = 0;
let queue = Promise.resolve();
let lastRunAt = 0;
let blockedUntil = 0;

// Antrean: request dijalankan satu per satu dengan jeda
function enqueue(task) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRunAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastRunAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

// Sesi: kunjungi beranda dulu supaya server memberi cookie, seperti browser
async function ensureSession() {
  if (jar.size > 0 && Date.now() - sessionAt < SESSION_TTL_MS) return;
  jar.clear();

  const res = await enqueue(() =>
    fetch(`${BASE}/`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    })
  );
  storeCookies(res);
  sessionAt = Date.now();
}

// Cari daftar objek di dalam respons (nama kunci bisa bermacam-macam)
function findArray(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object') {
    for (const k of ['data', 'content', 'items', 'results', 'rows', 'list', 'sekolah']) {
      if (k in obj) {
        const found = findArray(obj[k], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function findTotal(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['totalElements', 'total_elements', 'total', 'totalItems', 'total_items', 'count']) {
    if (typeof obj[k] === 'number') return obj[k];
  }
  for (const k of ['data', 'meta', 'pagination', 'page']) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      const t = findTotal(obj[k]);
      if (t !== null) return t;
    }
  }
  return null;
}

// ---------- Helper: merapikan data sekolah ----------
const titleCase = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const clean = (v) => (v == null ? null : String(v).trim() || null);

function normalizeSchool(x) {
  const jalan = clean(x.alamat_jalan);
  const dusun = clean(x.nama_dusun);
  const rt = Number(x.rt) || 0;
  const rw = Number(x.rw) || 0;

  const parts = [];
  if (jalan) parts.push(jalan);
  if (dusun && !(jalan || '').toLowerCase().includes(dusun.toLowerCase())) parts.push(dusun);
  if ((rt > 0 || rw > 0) && !/\bRT\b/i.test(jalan || '')) parts.push(`RT ${rt}/RW ${rw}`);

  const alamatLengkap = [...parts, clean(x.kecamatan), clean(x.kabupaten), clean(x.provinsi)].filter(Boolean).join(', ');

  const status = titleCase(x.status_sekolah) || '-';
  const akreditasi = clean(x.akreditasi) || 'Belum / tidak ada data';

  const caption =
    `🏫 *${clean(x.nama) || '-'}*\n\n` +
    `🆔 NPSN       : ${clean(x.npsn) || '-'}\n` +
    `🎓 Jenjang    : ${clean(x.bentuk_pendidikan) || '-'}\n` +
    `🏷️ Status     : ${status}\n` +
    `⭐ Akreditasi : ${akreditasi}\n\n` +
    `📍 Alamat:\n${alamatLengkap || '-'}\n` +
    (clean(x.kode_pos) ? `📮 Kode pos   : ${clean(x.kode_pos)}\n` : '');

  return {
    id: clean(x.sekolah_id),
    npsn: clean(x.npsn),
    nama: clean(x.nama),
    bentuk_pendidikan: clean(x.bentuk_pendidikan),
    status_sekolah: clean(x.status_sekolah),
    akreditasi: clean(x.akreditasi),
    alamat: {
      jalan,
      dusun,
      rt: rt || null,
      rw: rw || null,
      kecamatan: clean(x.kecamatan),
      kabupaten: clean(x.kabupaten),
      provinsi: clean(x.provinsi),
      kode_pos: clean(x.kode_pos),
      lengkap: alamatLengkap || null
    },
    foto: clean(x.path_file),
    caption
  };
}

// Urutkan hasil dalam 1 halaman berdasarkan kecocokan kata kunci (nama, kecamatan, kabupaten)
const STOP_WORDS = new Set(['sd', 'smp', 'sma', 'smk', 'tk', 'paud', 'mi', 'mts', 'ma', 'slb', 'kb', 'sekolah', 'negeri', 'swasta']);

function rankSchools(list, keyword, enabled) {
  if (!enabled || list.length < 2) return list;

  const tokens = String(keyword || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return list;

  const score = (s) => {
    const hay = `${s.nama || ''} ${s.alamat.kecamatan || ''} ${s.alamat.kabupaten || ''}`.toLowerCase();
    return tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };

  return list
    .map((s, i) => ({ s, i, sc: score(s) }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .map((x) => x.s);
}

function normalizeSchools(items) {
  return Array.isArray(items) ? items.filter((x) => x && typeof x === 'object').map(normalizeSchool) : [];
}

// Unduh foto sekolah jadi file lokal (foto bisa berubah atau hilang, jadi unduh saat dibutuhkan)
async function downloadPhoto(url, basePath, maxMB = 5) {
  try {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'NO_PHOTO', message: 'Sekolah ini tidak punya link foto' };
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': `${BASE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      return {
        success: false,
        error: res.status === 404 ? 'NO_PHOTO' : 'DOWNLOAD_FAILED',
        status: res.status,
        message: res.status === 404 ? 'Foto tidak tersedia di portal (HTTP 404)' : `Gagal mengunduh foto (HTTP ${res.status})`
      };
    }

    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) {
      return { success: false, error: 'NOT_IMAGE', message: `Isi unduhan bukan gambar (${type || 'tidak diketahui'})` };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxMB * 1024 * 1024) {
      return { success: false, error: 'FILE_TOO_LARGE', message: `Ukuran foto melebihi ${maxMB}MB` };
    }

    const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type] || 'jpg';
    const filePath = `${basePath}.${ext}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return { success: true, file_path: filePath, mime: type, filesize: buffer.length };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Mengunduh foto terlalu lama' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

/**
 * Sekolah Kita - cari sekolah
 * @param {string} keyword - Nama sekolah atau NPSN
 * @param {object} [options]
 * @param {number} [options.page=0]            - Halaman (mulai dari 0)
 * @param {number} [options.size=12]           - Jumlah per halaman (1-50)
 * @param {string} [options.kabupatenKota='']  - Filter kabupaten/kota (sesuai nilai di portal)
 * @param {string} [options.bentukPendidikan=''] - Filter bentuk pendidikan
 * @param {string} [options.statusSekolah='']  - Filter status (negeri/swasta, sesuai nilai di portal)
 * @returns {Promise<object>} JSON hasil
 */
async function sekolahCari(keyword, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { success: false, error: 'INVALID_KEYWORD', message: 'Kata kunci tidak boleh kosong' };
    if (kw.length > 100) return { success: false, error: 'KEYWORD_TOO_LONG', message: 'Kata kunci terlalu panjang (maks 100 karakter)' };

    const page = Math.max(parseInt(options.page, 10) || 0, 0);
    const size = Math.min(Math.max(parseInt(options.size, 10) || 12, 1), 50);

    const body = {
      page,
      size,
      keyword: kw,
      kabupaten_kota: options.kabupatenKota || '',
      bentuk_pendidikan: options.bentukPendidikan || '',
      status_sekolah: options.statusSekolah || ''
    };

    const key = JSON.stringify(body);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }

    if (Date.now() < blockedUntil) {
      const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
      return { success: false, error: 'RATE_LIMITED', message: `Portal sedang membatasi akses. Coba lagi dalam sekitar ${Math.ceil(secs / 60)} menit.`, retry_after: secs };
    }

    await ensureSession();

    const referer = `${BASE}/sekolah?keyword=${encodeURIComponent(kw)}&kabupaten_kota=&bentuk_pendidikan=&status_sekolah=&page=${page}&size=${size}`;

    const res = await enqueue(() =>
      fetch(API, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/json',
          'Origin': BASE,
          'Referer': referer,
          'User-Agent': USER_AGENT,
          'Cookie': cookieHeader()
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
    );
    storeCookies(res);

    if (res.status === 429 || res.status === 403) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      return { success: false, error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED', status: res.status, message: 'Portal membatasi atau memblokir akses. Coba lagi nanti.' };
    }

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* bukan JSON */ }

    if (!res.ok) {
      return { success: false, error: 'API_ERROR', status: res.status, message: String(json?.message || json?.error || text).slice(0, 300) };
    }
    if (json === null) {
      return { success: false, error: 'INVALID_RESPONSE', message: 'Respons bukan JSON', raw: text.slice(0, 300) };
    }

    const items = findArray(json);
    const schools = rankSchools(normalizeSchools(items), kw, options.rank);
    const total = findTotal(json);

    const result = {
      success: true,
      keyword: kw,
      page,
      size,
      count: schools.length,
      total,
      has_more: total != null ? (page + 1) * size < total : null,
      schools,
      ...(options.includeRaw ? { data: json } : {}),
      cached: false
    };

    cache.set(key, { at: Date.now(), result });
    return result;

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

/**
 * Cari sekolah + unduh foto sekolahnya (siap dikirim sebagai gambar + caption)
 * @param {string} keyword
 * @param {object} [options] - sama seperti sekolahCari + photoLimit (default 3) + outDir
 * @returns {Promise<object>} sama seperti sekolahCari, tiap sekolah punya photo_file / photo_error
 */
async function sekolahCariDenganFoto(keyword, options = {}) {
  const result = await sekolahCari(keyword, options);
  if (!result.success) return result;

  const outDir = options.outDir || path.join(process.cwd(), 'downloads', 'sekolah');
  const limit = Math.max(parseInt(options.photoLimit, 10) || 3, 0);

  const schools = [];
  let got = 0; // jumlah foto yang berhasil diunduh
  for (let i = 0; i < result.schools.length; i++) {
    const s = { ...result.schools[i], photo_file: null, photo_error: null };

    if (got < limit && s.foto) {
      const name = `${s.npsn || s.id || i}`.replace(/[^\w-]/g, '');
      const dl = await downloadPhoto(s.foto, path.join(outDir, name));
      if (dl.success) {
        s.photo_file = dl.file_path;
        got++;
      } else {
        s.photo_error = dl.message;
      }
      await new Promise((r) => setTimeout(r, 500)); // jeda kecil antar foto
    }

    s.has_photo = !!s.photo_file;
    schools.push(s);
  }

  return { ...result, schools };
}

// ---------- Pencarian pintar: langsung menemukan sekolah yang dimaksud ----------
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Singkatan jenjang -> nilai bentuk_pendidikan
const LEVEL_MAP = {
  sd: 'SD', sdn: 'SD', sds: 'SD', smp: 'SMP', smpn: 'SMP', smps: 'SMP', sma: 'SMA', sman: 'SMA', smas: 'SMA',
  smk: 'SMK', smkn: 'SMK', smks: 'SMK', tk: 'TK', paud: 'PAUD', mi: 'MI', min: 'MI', mts: 'MTS', mtsn: 'MTS',
  ma: 'MA', man: 'MA', slb: 'SLB', kb: 'KB'
};
const IGNORE_WORDS = new Set([...Object.keys(LEVEL_MAP), 'negeri', 'swasta', 'sekolah', 'dasar', 'menengah', 'pertama', 'atas', 'kejuruan']);

function scoreSchool(s, tokens, wantedLevel, wantedStatus) {
  const nameWords = norm(s.nama).split(' ').filter(Boolean);
  const nameSet = new Set(nameWords);
  const locSet = new Set(
    norm(`${s.alamat.kecamatan || ''} ${s.alamat.kabupaten || ''} ${s.alamat.provinsi || ''}`).split(' ').filter(Boolean)
  );

  let inName = 0;
  let inLoc = 0;
  for (const t of tokens) {
    if (nameSet.has(t)) inName++;
    else if (locSet.has(t)) inLoc++;
  }

  const needName = tokens.length - inLoc;
  const coverage = needName > 0 ? inName / needName : 1;
  const extra = nameWords.filter((w) => !IGNORE_WORDS.has(w) && !tokens.includes(w)).length;

  const levelOk = wantedLevel ? String(s.bentuk_pendidikan || '').toUpperCase() === wantedLevel : null;
  const statusOk = wantedStatus ? String(s.status_sekolah || '').toUpperCase() === wantedStatus : null;

  const exact = inName > 0 && coverage === 1 && extra === 0 && levelOk !== false && statusOk !== false;
  const score =
    coverage * 10 + inLoc * 4 + (levelOk ? 3 : 0) - (levelOk === false ? 3 : 0) + (statusOk ? 1 : 0) - extra * 0.5 + (exact ? 5 : 0);

  return { score: Math.round(score * 10) / 10, exact };
}

/**
 * Cari sekolah dengan pintar: memindai beberapa halaman hasil, lalu mengurutkan berdasarkan kecocokan
 * nama, jenjang, status, dan lokasi, sehingga sekolah yang dimaksud muncul paling atas lengkap dengan foto.
 * Contoh kata kunci: "sd pemuda bangsa depok", "sdn 1 depok", "smp negeri 2 bogor", atau NPSN.
 * @param {string} keyword
 * @param {object} [options]
 * @param {number} [options.size=5]       - Jumlah hasil teratas yang dikembalikan (1-10)
 * @param {number} [options.maxPages=6]   - Maksimal halaman yang dipindai (1-10)
 * @param {number} [options.pageSize=30]  - Jumlah per halaman saat memindai (5-50)
 * @param {number} [options.photoLimit=3] - Jumlah foto yang diunduh (0 = tanpa foto)
 * @param {string} [options.outDir]       - Folder foto (default: ./downloads/sekolah)
 */
async function sekolahTemukan(keyword, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) return { success: false, error: 'INVALID_KEYWORD', message: 'Kata kunci tidak boleh kosong' };

    const clampInt = (v, min, max, def) => Math.min(Math.max(parseInt(v, 10) || def, min), max);
    const top = clampInt(options.size, 1, 10, 5);
    const maxPages = clampInt(options.maxPages, 1, 10, 6);
    const pageSize = clampInt(options.pageSize, 5, 50, 30);
    const photoLimit = options.photoLimit === 0 ? 0 : clampInt(options.photoLimit, 0, 10, 3);

    // Pecah kata kunci
    const words = norm(kw).split(' ').filter(Boolean);
    let wantedLevel = null;
    let wantedStatus = null;
    const tokens = [];
    for (const w of words) {
      if (LEVEL_MAP[w]) { wantedLevel = wantedLevel || LEVEL_MAP[w]; if (w === 'sdn' || w === 'smpn' || w === 'sman' || w === 'smkn' || w === 'mtsn' || w === 'man' || w === 'min') wantedStatus = wantedStatus || 'NEGERI'; if (w.endsWith('s') && ['sds', 'smps', 'smas', 'smks'].includes(w)) wantedStatus = wantedStatus || 'SWASTA'; continue; }
      if (w === 'negeri') { wantedStatus = 'NEGERI'; continue; }
      if (w === 'swasta') { wantedStatus = 'SWASTA'; continue; }
      if (IGNORE_WORDS.has(w)) continue;
      tokens.push(w);
    }

    // Kalau hanya NPSN (8 digit), cari langsung
    const isNpsn = /^\d{8}$/.test(kw);

    const all = new Map();
    let total = null;
    let scannedPages = 0;
    let ranked = [];

    const rankAll = () => {
      ranked = [...all.values()]
        .map((s, i) => ({ s, i, m: isNpsn ? { score: s.npsn === kw ? 100 : 0, exact: s.npsn === kw } : scoreSchool(s, tokens, wantedLevel, wantedStatus) }))
        .sort((a, b) => b.m.score - a.m.score || a.i - b.i);
    };

    for (let p = 0; p < (isNpsn ? 1 : maxPages); p++) {
      const r = await sekolahCari(kw, { ...options, page: p, size: isNpsn ? 5 : pageSize });
      if (!r.success) {
        if (p === 0) return r; // gagal sejak awal: laporkan errornya
        break;                 // gagal di tengah: pakai hasil yang sudah ada
      }

      scannedPages++;
      total = r.total;
      for (const s of r.schools) {
        const k = s.npsn || s.id;
        if (!all.has(k)) all.set(k, s);
      }

      rankAll();
      if (ranked[0] && ranked[0].m.exact) break; // sudah ketemu yang persis, berhenti memindai
      if (!r.has_more) break;
    }

    if (ranked.length === 0) {
      return { success: false, error: 'NO_RESULTS', message: `Tidak ada sekolah untuk "${kw}"` };
    }

    // Ambil teratas + unduh foto (lewati yang tidak punya foto)
    const outDir = options.outDir || path.join(process.cwd(), 'downloads', 'sekolah');
    const results = [];
    let got = 0;

    for (const { s, m } of ranked.slice(0, top)) {
      const item = { ...s, match: m, photo_file: null, photo_error: null };

      if (got < photoLimit && s.foto) {
        const name = `${s.npsn || s.id}`.replace(/[^\w-]/g, '');
        const dl = await downloadPhoto(s.foto, path.join(outDir, name));
        if (dl.success) {
          item.photo_file = dl.file_path;
          got++;
        } else {
          item.photo_error = dl.message;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      item.has_photo = !!item.photo_file;
      results.push(item);
    }

    return {
      success: true,
      keyword: kw,
      exact_match: ranked[0].m.exact,
      scanned_pages: scannedPages,
      scanned: all.size,
      total,
      best: results[0],
      results
    };

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { sekolahCari, sekolahCariDenganFoto, sekolahTemukan };

// Cari biasa     : node sekolah.js "mardi yuana depok" [halaman] [jumlah]
// Cari + foto    : node sekolah.js "mardi yuana depok" 0 3 --foto
// Cari pintar    : node sekolah.js "sd pemuda bangsa" --pintar [jumlah hasil]
if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = ['--foto', '--urut', '--pintar'];
  const [keyword, a2, a3] = args.filter((a) => !flags.includes(a));
  const print = (r) => console.log(JSON.stringify(r, null, 2));

  if (args.includes('--pintar')) {
    sekolahTemukan(keyword, { size: a2 }).then(print);
  } else {
    const run = args.includes('--foto') ? sekolahCariDenganFoto : sekolahCari;
    run(keyword, { page: a2, size: a3, rank: args.includes('--urut') }).then(print);
  }
}
