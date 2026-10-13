/**
 * Name Scrape : Screenshot Website (via Microlink)
 * Owner       : Kersio
 * Base Web    : api.microlink.io
 * Type        : Scraper
 * Function    : Mengambil screenshot sebuah website di semua ukuran layar sekaligus (desktop, tablet, mobile) atau salah satunya, default full page, disimpan jadi file gambar beserta info ukuran dan caption siap pakai untuk bot
 * Input       : 1 link website + mode (opsional: all | desktop | tablet | mobile)
 * Output      : JSON + file gambar di folder screenshots
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Layanan gratis ada batas harian (sekitar 50 request/hari) dan mode all memakai 3 request sekali jalan. Jangan spam request. Hanya untuk halaman publik. Struktur respons bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.microlink.io';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 15 * 1024 * 1024; // batas ukuran gambar yang diunduh
const GAP_MS = 1000;                // jeda antar request di mode all

const MODES = {
  desktop: { width: 1920, height: 1080, scale: 1, isMobile: false },
  tablet: { width: 768, height: 1024, scale: 2, isMobile: true },
  mobile: { width: 390, height: 844, scale: 2, isMobile: true }
};
const ORDER = ['desktop', 'tablet', 'mobile'];

// ---------- Helper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tambahkan https:// kalau belum ada, hanya terima http/https
function normalizeUrl(input) {
  let t = String(input || '').trim();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'https://' + t;
  try {
    const u = new URL(t);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };

// Satu screenshot untuk satu mode
async function shoot(target, mode, full, options) {
  const m = MODES[mode];

  const params = new URLSearchParams({
    url: target,
    meta: 'false',
    screenshot: 'true',
    'screenshot.fullPage': String(full),
    'viewport.width': String(m.width),
    'viewport.height': String(m.height),
    'viewport.deviceScaleFactor': String(m.scale),
    'viewport.isMobile': String(m.isMobile),
    adblock: 'true'
  });

  const res = await fetch(`${API}/?${params}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(60000)
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // respons bukan JSON
  }

  if (res.status === 429) {
    return { success: false, mode, error: 'RATE_LIMITED', status: 429, message: 'Batas harian layanan gratis tercapai. Coba lagi besok.' };
  }
  if (!res.ok || !body || body.status !== 'success') {
    return { success: false, mode, error: 'API_ERROR', status: res.status, message: (body && body.message) || `Layanan membalas HTTP ${res.status}` };
  }

  const shot = body.data && body.data.screenshot;
  if (!shot || !shot.url) {
    return { success: false, mode, error: 'NO_DATA', message: 'Screenshot tidak ditemukan di respons. Struktur layanan mungkin berubah.' };
  }

  const result = {
    success: true,
    target,
    mode,
    full_page: full,
    viewport: { width: m.width, height: m.height, scale: m.scale },
    screenshot_url: shot.url,
    width: shot.width || null,
    height: shot.height || null,
    size: shot.size_pretty || null,
    file: null,
    filesize: null
  };

  // Unduh gambar jadi file lokal
  if (options.download !== false) {
    const img = await fetch(shot.url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
    if (!img.ok) {
      return { ...result, success: false, error: 'DOWNLOAD_FAILED', status: img.status, message: `Gagal mengunduh gambar (HTTP ${img.status})` };
    }

    const type = (img.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) {
      return { ...result, success: false, error: 'NOT_IMAGE', message: `Isi unduhan bukan gambar (${type || 'tidak diketahui'})` };
    }

    const buffer = Buffer.from(await img.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return { ...result, success: false, error: 'FILE_TOO_LARGE', message: `Ukuran gambar melebihi ${MAX_BYTES / 1024 / 1024}MB` };
    }

    const host = new URL(target).hostname.replace(/[^a-z0-9.-]/gi, '_');
    const dir = options.outDir || path.join(process.cwd(), 'screenshots');
    const file = path.join(dir, `ss_${host}_${mode}_${Date.now()}.${EXT[type] || 'png'}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buffer);

    result.file = file;
    result.filesize = buffer.length;
  }

  result.caption =
    `🖼️ *Screenshot Website*\n\n` +
    `🌐 ${target}\n` +
    `📱 Mode   : ${mode}${full ? ' (full page)' : ''}\n` +
    (result.width && result.height ? `📐 Ukuran : ${result.width} x ${result.height}\n` : '') +
    (result.size ? `📦 File   : ${result.size}\n` : '');

  return result;
}

/**
 * Screenshot Website - Single function
 * @param {string} input - Link website (https:// boleh dikosongkan)
 * @param {object} [options]
 * @param {string} [options.mode='all'] - all | desktop | tablet | mobile
 * @param {boolean} [options.full=true] - true = seluruh halaman, false = satu layar saja
 * @param {boolean} [options.download=true] - false = hanya ambil link gambar, tidak disimpan
 * @param {string} [options.outDir] - Folder simpan (default: ./screenshots)
 * @returns {Promise<object>} JSON hasil
 */
async function screenshot(input, options = {}) {
  try {
    const target = normalizeUrl(input);
    if (!target) {
      return { success: false, error: 'INVALID_URL', message: 'Link tidak valid. Contoh: node ss.js https://example.com' };
    }

    const mode = String(options.mode || 'all').toLowerCase();
    if (mode !== 'all' && !MODES[mode]) {
      return { success: false, error: 'INVALID_MODE', message: 'Mode tidak dikenal. Pilihan: all, desktop, tablet, mobile' };
    }
    const full = options.full !== false;

    // Satu mode saja
    if (mode !== 'all') return await shoot(target, mode, full, options);

    // Semua mode: desktop, tablet, mobile (satu per satu, dengan jeda)
    const results = [];
    for (let i = 0; i < ORDER.length; i++) {
      const r = await shoot(target, ORDER[i], full, options);
      delete r.caption;
      results.push(r);
      if (r.error === 'RATE_LIMITED') break;
      if (i < ORDER.length - 1) await sleep(GAP_MS);
    }

    const ok = results.filter((r) => r.success);
    if (!ok.length) {
      return { success: false, target, mode, error: results[0].error, message: results[0].message, results };
    }

    const caption =
      `🖼️ *Screenshot Website*\n\n` +
      `🌐 ${target}\n` +
      `📄 ${full ? 'Full page' : 'Satu layar'}\n\n` +
      ok.map((r) => `✅ ${r.mode}${r.width && r.height ? ` (${r.width} x ${r.height}${r.size ? `, ${r.size}` : ''})` : ''}`).join('\n');

    return {
      success: true,
      target,
      mode,
      full_page: full,
      total: ORDER.length,
      done: ok.length,
      failed: ORDER.length - ok.length,
      files: ok.map((r) => r.file).filter(Boolean),
      results,
      caption
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { screenshot };

// Semua ukuran, full page : node ss.js https://example.com
// Satu ukuran saja        : node ss.js https://example.com mobile
// Satu layar saja         : node ss.js https://example.com all --viewport
// Hanya link, tanpa simpan file : node ss.js https://example.com --nofile
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const outArg = args.find((a) => a.startsWith('--out='));

  screenshot(pos[0], {
    mode: pos[1],
    full: !args.includes('--viewport'),
    download: !args.includes('--nofile'),
    outDir: outArg ? outArg.split('=').slice(1).join('=') : undefined
  }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.success) process.exitCode = 1;
  });
}
