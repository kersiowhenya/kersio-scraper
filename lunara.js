/**
 * Name Scrape : Lunara Pro Upload (Berbagi File)
 * Owner       : Kersio
 * Base Web    : lunara.softbotz.my.id
 * Type        : Uploader
 * Function    : Mengunggah file lokal ke Lunara Pro dan mengembalikan link permanen yang siap dibagikan
 * Input       : 1 path file lokal (maks. 100 MB), nama tampilan opsional
 * Output      : JSON
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Dilarang mengunggah malware, konten ilegal, atau data pribadi orang lain. Jangan spam request. File .txt tampil sebagai halaman teks (tambahkan ?raw=1 untuk isi mentah). Struktur API bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://lunara.softbotz.my.id';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const MAX_MB = 100;                      // batas ukuran dari situs
const MIN_GAP_MS = 3000;                 // jeda minimal antar request
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000; // kalau diblokir, berhenti mencoba 10 menit
const TEXT_EXT = ['.txt', '.log', '.md', '.csv'];

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
  '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html'
};

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

// ---------- Helper ----------
const abs = (p) => (p ? (/^https?:\/\//i.test(p) ? p : `${BASE}${p.startsWith('/') ? '' : '/'}${p}`) : null);
const asText = (x) => (typeof x === 'string' ? x : x ? JSON.stringify(x) : null);

function fmtSize(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Lunara Pro Upload - Single function
 * @param {string} input - Path file lokal
 * @param {object} [options]
 * @param {string} [options.filename] - Nama tampilan file (default: nama file asli)
 * @returns {Promise<object>} JSON hasil
 */
async function lunaraUpload(input, options = {}) {
  try {
    const filePath = path.resolve(String(input || '').trim().replace(/^["']|["']$/g, ''));
    if (!input || !String(input).trim()) {
      return { success: false, error: 'INVALID_INPUT', message: 'Path file belum diisi' };
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { success: false, error: 'FILE_NOT_FOUND', message: `File tidak ditemukan: ${filePath}` };
    }
    if (!stat.isFile()) {
      return { success: false, error: 'NOT_A_FILE', message: 'Path ini bukan file (mungkin folder)' };
    }
    if (stat.size === 0) {
      return { success: false, error: 'EMPTY_FILE', message: 'File kosong (0 byte)' };
    }
    if (stat.size > MAX_MB * 1024 * 1024) {
      return { success: false, error: 'FILE_TOO_LARGE', message: `Ukuran file melebihi ${MAX_MB}MB (${fmtSize(stat.size)})` };
    }

    if (Date.now() < blockedUntil) {
      const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
      return { success: false, error: 'RATE_LIMITED', message: `Situs sedang membatasi akses. Coba lagi dalam sekitar ${Math.ceil(secs / 60)} menit.`, retry_after: secs };
    }

    const baseName = path.basename(filePath);
    const ext = path.extname(baseName).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const displayName = String(options.filename || baseName).trim() || baseName;

    const buffer = fs.readFileSync(filePath);

    const res = await enqueue(() => {
      // FormData dibuat ulang di tiap percobaan supaya aman
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), baseName);
      form.append('filename', displayName);

      return fetch(`${BASE}/upload`, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        body: form,
        redirect: 'follow',
        signal: AbortSignal.timeout(300000)
      });
    });

    if (res.status === 429 || res.status === 403) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      return { success: false, error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED', status: res.status, message: 'Situs membatasi atau memblokir akses. Coba lagi nanti.' };
    }

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* bukan JSON */ }
    const apiMsg = json ? asText(json.error || json.message) : null;

    if (res.status === 413) {
      return { success: false, error: 'FILE_TOO_LARGE', status: 413, message: apiMsg || `Situs menolak: file terlalu besar (maks. ${MAX_MB}MB)` };
    }
    if (!res.ok) {
      return { success: false, error: 'HTTP_ERROR', status: res.status, message: apiMsg || `Situs membalas HTTP ${res.status}` };
    }
    if (!json || json.success === false) {
      return { success: false, error: 'API_ERROR', message: apiMsg || 'Situs membalas dengan data yang tidak dikenali' };
    }

    const fileUrl = abs(json.file_url);
    if (!fileUrl) {
      return { success: false, error: 'NO_DATA', message: 'Link file tidak ditemukan di respons situs. Struktur API mungkin sudah berubah.', response: json };
    }

    // File teks otomatis tampil sebagai halaman teks; ?raw=1 untuk isi mentah
    const rawUrl = TEXT_EXT.includes(ext) ? `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}raw=1` : null;

    const caption =
      `📤 *Upload Lunara*\n\n` +
      `📄 Nama   : ${displayName}\n` +
      `📦 Ukuran : ${fmtSize(stat.size)}\n` +
      `🔗 Link   : ${fileUrl}` +
      (rawUrl ? `\n📝 Mentah : ${rawUrl}` : '');

    return {
      success: true,
      file_name: displayName,
      original_name: baseName,
      file_size: { bytes: stat.size, display: fmtSize(stat.size) },
      mime,
      file_url: fileUrl,
      raw_url: rawUrl,
      response: json,
      caption
    };

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Upload terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { lunaraUpload };

// Upload file             : node lunara.js "C:\kersioscraper\laporan.pdf"
// Upload + nama tampilan  : node lunara.js "C:\kersioscraper\laporan.pdf" --name=laporan-final
if (require.main === module) {
  const args = process.argv.slice(2);
  const nameArg = args.find((a) => a.startsWith('--name='));
  lunaraUpload(args[0], { filename: nameArg ? nameArg.slice(7) : undefined }).then((r) => console.log(JSON.stringify(r, null, 2)));
}
