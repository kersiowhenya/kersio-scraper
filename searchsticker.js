/**
 * Name Scrape : SigStick Sticker Scraper
 * Owner       : Kersio
 * Base Web    : www.sigstick.com
 * Type        : Scraper
 * Function    : Cari paket stiker, lihat daftar trending/terbaru/teratas, dan ambil detail 1 paket
 *               (judul, pembuat, jumlah unduhan, tag, gambar stiker, paket terkait)
 * Input       : kata kunci / jenis daftar (trending, new, top) / link paket
 * Output      : JSON
 * Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Stiker adalah karya pembuatnya. Pakai untuk keperluan pribadi dan jangan spam request.
 *               Struktur halaman bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.sigstick.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 10 * 60 * 1000; // hasil disimpan 10 menit
const MIN_GAP_MS = 2000;             // jeda minimal antar request
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

const cache = new Map();
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
const decodeHtml = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const safeDecodeUri = (s) => {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
};

const abs = (u) => (u ? (u.startsWith('http') ? u : `${BASE}${u.startsWith('/') ? '' : '/'}${u}`) : null);

// Gambar bisa dibungkus /_next/image?url=... , ambil alamat aslinya
function unwrapImage(src) {
  if (!src) return null;
  const clean = src.replace(/&amp;/g, '&');
  const m = clean.match(/[?&]url=([^&]+)/);
  return m && /_next\/image/.test(clean) ? abs(safeDecodeUri(m[1])) : abs(clean);
}

async function getHtml(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { html: hit.html, cached: true };

  if (Date.now() < blockedUntil) {
    const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
    return { error: { success: false, error: 'RATE_LIMITED', message: `Situs sedang membatasi akses. Coba lagi dalam sekitar ${Math.ceil(secs / 60)} menit.`, retry_after: secs } };
  }

  const res = await enqueue(() =>
    fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    })
  );

  if (res.status === 429 || res.status === 403) {
    blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
    return { error: { success: false, error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED', status: res.status, message: 'Situs membatasi atau memblokir akses. Coba lagi nanti.' } };
  }
  if (res.status === 404) {
    return { error: { success: false, error: 'NOT_FOUND', message: 'Halaman tidak ditemukan' } };
  }
  if (!res.ok) {
    return { error: { success: false, error: 'HTTP_ERROR', status: res.status, message: `Situs membalas HTTP ${res.status}` } };
  }

  const html = await res.text();
  cache.set(url, { at: Date.now(), html });
  return { html, cached: false };
}

// Ambil kartu paket dari halaman daftar / paket terkait
function parsePackCards(html, excludeId) {
  const re = /<a\b[^>]*href="((?:https?:\/\/www\.sigstick\.com)?\/pack\/([A-Za-z0-9]{20})-([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const packs = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    const id = m[2];
    if (id === excludeId || seen.has(id)) continue;
    seen.add(id);

    const inner = m[4];
    const alt = (inner.match(/<img\b[^>]*alt="([^"]*)"/i) || [])[1];
    const slugTitle = safeDecodeUri(m[3]).replace(/-/g, ' ').trim();
    let title = decodeHtml(alt || '').replace(/^cover\b\s*/i, '').trim();
    if (!title) title = slugTitle; // alt hanya "cover": pakai nama dari link

    const text = decodeHtml(inner);
    const dl = (text.match(/file_download\s*([\d.,]+\s*[KkMm]?)/) || [])[1];

    const img = (inner.match(/<img\b[^>]*src="([^"]+)"/i) || [])[1];

    packs.push({
      id,
      title,
      downloads: dl ? dl.replace(/\s+/g, '') : null,
      cover: unwrapImage(img),
      url: abs(m[1])
    });
  }
  return packs;
}

// ---------- Fungsi utama ----------

/**
 * Cari paket stiker pakai kata kunci
 * @param {string} keyword
 */
async function sigstickSearch(keyword) {
  try {
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
      return { success: false, error: 'INVALID_KEYWORD', message: 'Kata kunci tidak boleh kosong' };
    }

    const url = `${BASE}/stickers?keyword=${encodeURIComponent(keyword.trim())}`;
    const r = await getHtml(url);
    if (r.error) return r.error;

    const packs = parsePackCards(r.html);
    if (packs.length === 0) {
      return { success: false, error: 'NO_RESULTS', message: `Tidak ada hasil untuk "${keyword.trim()}" (atau struktur halaman berubah)` };
    }

    return { success: true, keyword: keyword.trim(), source: url, count: packs.length, cached: r.cached, results: packs };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Daftar paket: "trending", "new", atau "top"
 * @param {string} [type='trending']
 */
async function sigstickList(type = 'trending') {
  try {
    const paths = { trending: '/stickers/trending', new: '/stickers/new', top: '/stickers' };
    const key = String(type || '').toLowerCase();
    if (!paths[key]) {
      return { success: false, error: 'INVALID_TYPE', message: 'Jenis daftar harus: trending, new, atau top' };
    }

    const url = `${BASE}${paths[key]}`;
    const r = await getHtml(url);
    if (r.error) return r.error;

    const packs = parsePackCards(r.html);
    if (packs.length === 0) {
      return { success: false, error: 'NO_DATA', message: 'Daftar kosong. Struktur halaman situs mungkin sudah berubah.' };
    }

    return { success: true, type: key, source: url, count: packs.length, cached: r.cached, results: packs };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Detail 1 paket stiker
 * @param {string} input - Link paket (https://www.sigstick.com/pack/ID-nama) atau "ID-nama"
 */
async function sigstickPack(input) {
  try {
    const t = String(input || '').trim();
    const m = t.match(/(?:sigstick\.com)?\/?(?:pack\/)?([A-Za-z0-9]{20})(?:-([^\s?#]*))?/);
    if (!m) {
      return { success: false, error: 'INVALID_INPUT', message: 'Kirim link paket, contoh: https://www.sigstick.com/pack/ID-nama' };
    }

    const id = m[1];
    const url = `${BASE}/pack/${id}${m[2] ? `-${m[2]}` : ''}`;
    const r = await getHtml(url);
    if (r.error) return r.error;
    const html = r.html;

    // Judul
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = decodeHtml(h1 ? h1[1] : (titleTag ? titleTag[1].replace(/\s*-\s*Download Stickers.*$/i, '') : '')) || null;

    // Pembuat
    const userA = html.match(/<a\b[^>]*href="((?:https?:\/\/www\.sigstick\.com)?\/user\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const author = userA ? { name: decodeHtml(userA[2]) || null, url: abs(userA[1]) } : null;

    // Jumlah unduhan
    const dlMatch = decodeHtml(html).match(/file_download\s*([\d.,]+\s*[KkMm]?)/);
    const downloads = dlMatch ? dlMatch[1].replace(/\s+/g, '') : null;

    // Topik dan tag
    const topicA = html.match(/<a\b[^>]*href="(?:https?:\/\/www\.sigstick\.com)?\/topic\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const topic = topicA ? { slug: safeDecodeUri(topicA[1]), name: decodeHtml(topicA[2]).replace(/→/g, '').trim() } : null;

    const tags = [];
    const tagRe = /<a\b[^>]*href="(?:https?:\/\/www\.sigstick\.com)?\/stickers\?keyword=([^"]+)"/gi;
    let tm;
    while ((tm = tagRe.exec(html)) !== null) {
      const tag = safeDecodeUri(tm[1].replace(/&amp;/g, '&'));
      if (!tags.includes(tag)) tags.push(tag);
    }

    // Gambar: cover dan stiker (alamat CDN dari halaman, ukuran thumbnail)
    const imgRe = new RegExp(`https?:\\/\\/[a-z0-9.-]*cdnstep\\.com\\/${id}\\/([A-Za-z0-9_-]+?)\\.(thumb\\d+\\.)?(png|webp|jpg|jpeg|gif)`, 'gi');
    const files = new Map();
    let im;
    const decodedHtml = html.replace(/&amp;/g, '&').replace(/%2F/gi, '/').replace(/%3A/gi, ':');
    while ((im = imgRe.exec(decodedHtml)) !== null) {
      const name = im[1];
      const link = im[0];
      const prev = files.get(name);
      // Utamakan file ukuran penuh (tanpa .thumbNNN) kalau tersedia
      if (!prev || (/\.thumb\d+\./.test(prev) && !/\.thumb\d+\./.test(link))) files.set(name, link);
    }

    let cover = null;
    const stickers = [];
    for (const [name, link] of files) {
      if (/^cover/i.test(name)) cover = link;
      else if (/^og/i.test(name)) continue;
      else {
        const idx = parseInt((name.match(/^(\d+)/) || [])[1], 10);
        stickers.push({ index: Number.isNaN(idx) ? null : idx, name, url: link, is_thumbnail: /\.thumb\d+\./.test(link) });
      }
    }
    stickers.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const related = parsePackCards(html, id);

    if (!title && stickers.length === 0 && !cover) {
      return { success: false, error: 'NO_DATA', message: 'Data paket tidak ditemukan. Struktur halaman situs mungkin sudah berubah.' };
    }

    const caption =
      `🎨 *${title || '-'}*\n\n` +
      `👤 Pembuat   : ${author?.name || '-'}\n` +
      `⬇️ Unduhan   : ${downloads || '-'}\n` +
      (topic ? `📂 Topik     : ${topic.name}\n` : '') +
      (tags.length ? `🏷️ Tag       : ${tags.join(', ')}\n` : '') +
      `\n${url}`;

    return {
      success: true,
      id,
      url,
      title,
      author,
      downloads,
      topic,
      tags,
      cover,
      sticker_count_found: stickers.length,
      stickers,
      related,
      cached: r.cached,
      caption,
      note: stickers.some((s) => s.is_thumbnail)
        ? 'Sebagian gambar stiker hanya tersedia sebagai thumbnail (lihat is_thumbnail).'
        : 'URL stiker adalah file ukuran penuh sesuai yang ada di halaman.'
    };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Unduh semua stiker 1 paket ke folder
 * Hasil: downloads/sigstick/<id paket>/<nama file>
 * @param {string} input - Link paket
 * @param {object} [options]
 * @param {string} [options.outDir] - Folder induk (default: ./downloads/sigstick)
 */
async function sigstickDownload(input, options = {}) {
  try {
    const pack = await sigstickPack(input);
    if (!pack.success) return pack;

    if (pack.stickers.length === 0) {
      return { success: false, error: 'NO_STICKERS', message: 'Tidak ada file stiker yang ditemukan di halaman paket ini' };
    }

    const parent = options.outDir || path.join(process.cwd(), 'downloads', 'sigstick');
    const folder = path.join(parent, pack.id);
    fs.mkdirSync(folder, { recursive: true });

    const maxBytes = 10 * 1024 * 1024;
    const files = [];
    const failed = [];

    for (const s of pack.stickers) {
      try {
        const res = await fetch(s.url, {
          headers: { 'User-Agent': USER_AGENT, 'Referer': `${BASE}/` },
          redirect: 'follow',
          signal: AbortSignal.timeout(30000)
        });

        if (!res.ok) {
          failed.push({ index: s.index, url: s.url, reason: `HTTP ${res.status}` });
          continue;
        }

        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!type.startsWith('image/')) {
          failed.push({ index: s.index, url: s.url, reason: `Bukan gambar (${type || 'tidak diketahui'})` });
          continue;
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) {
          failed.push({ index: s.index, url: s.url, reason: 'Ukuran lebih dari 10MB' });
          continue;
        }

        const extFromUrl = (s.url.match(/\.(png|webp|jpg|jpeg|gif)$/i) || [])[1];
        const ext = String(extFromUrl || type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
        const filePath = path.join(folder, `${s.name}.${ext}`);
        fs.writeFileSync(filePath, buf);

        files.push({ index: s.index, file_path: filePath, filesize: buf.length, is_thumbnail: s.is_thumbnail });
      } catch (e) {
        failed.push({ index: s.index, url: s.url, reason: e.message || String(e) });
      }

      await new Promise((r) => setTimeout(r, 300)); // jeda kecil antar file
    }

    if (files.length === 0) {
      return { success: false, error: 'DOWNLOAD_FAILED', message: 'Tidak ada stiker yang berhasil diunduh', failed };
    }

    return {
      success: true,
      id: pack.id,
      title: pack.title,
      folder,
      total_found: pack.stickers.length,
      downloaded: files.length,
      failed,
      files
    };
  } catch (err) {
    return toError(err);
  }
}

function toError(err) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
  }
  return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
}

module.exports = { sigstickSearch, sigstickList, sigstickPack, sigstickDownload };

// Cari       : node sigstick.js search "cat"
// Daftar     : node sigstick.js list trending     (trending | new | top)
// Detail paket: node sigstick.js pack "https://www.sigstick.com/pack/pm67xT1aM8ZCmVpBAorI-cat-clapping"
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');
  const run = { search: sigstickSearch, list: sigstickList, pack: sigstickPack, download: sigstickDownload }[cmd];

  if (!run) {
    console.log('Pakai:\n  node sigstick.js search "kata kunci"\n  node sigstick.js list trending|new|top\n  node sigstick.js pack "link paket"\n  node sigstick.js download "link paket"');
  } else {
    run(arg).then((r) => console.log(JSON.stringify(r, null, 2)));
  }
}
