/**
 * Name Scrape : Instagram Profile + Statistik (via InstaStoriesViewer)
 * Owner       : Kersio
 * Base Web    : www.insta-stories-viewer.com
 * Type        : Scraper
 * Function    : Mengambil info profil publik Instagram (nama, bio, followers, following, postingan, foto profil) beserta statistik harian yang ditampilkan situs (riwayat postingan, followers, following)
 * Input       : 1 link profil Instagram atau username
 * Output      : JSON                                                                                           * saluran : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Hanya akun publik. Jangan spam request. Struktur halaman bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://insta-stories-viewer.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 10 * 60 * 1000;     // hasil disimpan 10 menit
const MIN_GAP_MS = 3000;                 // jeda minimal antar request
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000; // kalau diblokir, berhenti mencoba 10 menit

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

// ---------- Helper: parsing ----------
const decode = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

function parseUsername(text) {
  const t = String(text || '').trim();
  const reserved = ['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about'];

  const m = t.match(/instagram\.com\/([A-Za-z0-9._]{1,30})/i);
  if (m) {
    return reserved.includes(m[1].toLowerCase()) ? { reservedPath: m[1] } : { username: m[1] };
  }

  const plain = t.replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(plain) ? { username: plain } : {};
}

function pickStat(html, cls) {
  const m = html.match(new RegExp(`${cls}[^>]*>\\s*([\\d.,]+\\s*[KMB]?)`, 'i'));
  return m ? m[1].replace(/\s+/g, '') : null;
}

// Tanggal MM/DD/YYYY -> YYYY-MM-DD
function isoDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : String(s).trim();
}

function parseTable(html, cls) {
  const block = html.match(new RegExp(`${cls}[^>]*>([\\s\\S]*?)<\\/table>`, 'i'));
  if (!block) return [];

  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<\/tr>/gi;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    const value = parseInt(m[2].replace(/[^\d-]/g, ''), 10);
    if (!Number.isNaN(value)) rows.push({ date: isoDate(m[1]), value });
  }
  return rows;
}

function trend(rows) {
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    from: first.date,
    to: last.date,
    start: first.value,
    end: last.value,
    change: last.value - first.value,
    days: rows.length
  };
}

const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/**
 * Unduh gambar (misalnya foto profil) jadi file lokal
 * Link foto profil lewat server perantara bisa kedaluwarsa, jadi unduh saat dibutuhkan.
 * @param {string} url - Link gambar
 * @param {string} basePath - Lokasi file TANPA ekstensi (ekstensi ditentukan otomatis)
 * @param {number} [maxMB=5] - Batas ukuran file
 */
async function downloadImage(url, basePath, maxMB = 5) {
  try {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'INVALID_URL', message: 'Link gambar tidak valid' };
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': `${BASE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      return { success: false, error: 'DOWNLOAD_FAILED', status: res.status, message: `Gagal mengunduh gambar (HTTP ${res.status}). Link mungkin sudah kedaluwarsa.` };
    }

    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) {
      return { success: false, error: 'NOT_IMAGE', message: `Isi unduhan bukan gambar (${type || 'tidak diketahui'})` };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxMB * 1024 * 1024) {
      return { success: false, error: 'FILE_TOO_LARGE', message: `Ukuran gambar melebihi ${maxMB}MB` };
    }

    const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type] || 'jpg';
    const filePath = `${basePath}.${ext}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return { success: true, file_path: filePath, mime: type, filesize: buffer.length };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Mengunduh gambar terlalu lama' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

/**
 * Instagram Profile + Statistik - Single function
 * @param {string} input - Link profil (instagram.com/username) atau username
 * @param {object} [options]
 * @param {boolean} [options.downloadAvatar=false] - Unduh foto profil jadi file (hasil: avatar_file)
 * @param {string} [options.outDir] - Folder simpan foto (default: ./downloads)
 * @returns {Promise<object>} JSON hasil
 */
async function igViewer(input, options = {}) {
  try {
    const parsed = parseUsername(input);

    if (parsed.reservedPath) {
      return { success: false, error: 'NOT_A_PROFILE_LINK', message: 'Ini bukan link profil. Kirim link profil: instagram.com/username' };
    }
    if (!parsed.username) {
      return { success: false, error: 'INVALID_INPUT', message: 'Link atau username tidak valid' };
    }

    const username = parsed.username;
    const key = username.toLowerCase();
    let cached = false;
    let data;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      data = hit.data;
      cached = true;
    } else {
      if (Date.now() < blockedUntil) {
        const secs = Math.ceil((blockedUntil - Date.now()) / 1000);
        return { success: false, error: 'RATE_LIMITED', message: `Situs sedang membatasi akses. Coba lagi dalam sekitar ${Math.ceil(secs / 60)} menit.`, retry_after: secs };
      }

      const res = await enqueue(() =>
        fetch(`${BASE}/${encodeURIComponent(username)}/`, {
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
        return { success: false, error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED', status: res.status, message: 'Situs membatasi atau memblokir akses. Coba lagi nanti.' };
      }
      if (res.status === 404) {
        return { success: false, error: 'NOT_FOUND', message: 'Akun tidak ditemukan' };
      }
      if (!res.ok) {
        return { success: false, error: 'HTTP_ERROR', status: res.status, message: `Situs membalas HTTP ${res.status}` };
      }

      const html = await res.text();

      // Foto profil
      let avatar = null;
      const imgTag = html.match(/<img[^>]*class="[^"]*profile__avatar-pic[^"]*"[^>]*>/i);
      if (imgTag) avatar = (imgTag[0].match(/src="([^"]+)"/i) || [])[1] || null;

      // Nama
      let nickname = null;
      const nick = html.match(/<h1[^>]*class="[^"]*profile__nickname[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
      if (nick) nickname = decode(nick[1].replace(/<span[\s\S]*?<\/span>/gi, '')) || null;

      // Bio
      let bio = null;
      const desc = html.match(/<div[^>]*class="[^"]*profile__description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (desc) bio = decode(desc[1]) || null;

      data = {
        avatar,
        nickname,
        verified: /profile__nickname-is-verify/i.test(html),
        bio,
        posts: pickStat(html, 'profile__stats-posts'),
        followers: pickStat(html, 'profile__stats-followers'),
        following: pickStat(html, 'profile__stats-follows'),
        stats: {
          posts: parseTable(html, 'charts__table_posts'),
          followers: parseTable(html, 'charts__table_followers'),
          following: parseTable(html, 'charts__table_followings')
        }
      };

      if (!data.nickname && !data.followers && !data.posts) {
        return {
          success: false,
          error: 'NO_DATA',
          message: 'Data profil tidak ditemukan. Akun mungkin private, tidak ada, atau struktur halaman situs sudah berubah.'
        };
      }

      cache.set(key, { at: Date.now(), data });
    }

    const lastOf = (rows) => (rows.length ? rows[rows.length - 1].value : null);
    const followersTrend = trend(data.stats.followers);

    const caption =
      `📸 *Instagram Profile*\n\n` +
      `👤 @${username}${data.verified ? ' ✅' : ''}\n` +
      `📛 Nama      : ${data.nickname || '-'}\n` +
      `👥 Followers : ${lastOf(data.stats.followers) != null ? fmt(lastOf(data.stats.followers)) : (data.followers || '-')}${data.followers && lastOf(data.stats.followers) != null ? ` (${data.followers})` : ''}\n` +
      `➡️ Following : ${lastOf(data.stats.following) != null ? fmt(lastOf(data.stats.following)) : (data.following || '-')}\n` +
      `🖼️ Postingan : ${lastOf(data.stats.posts) != null ? fmt(lastOf(data.stats.posts)) : (data.posts || '-')}\n` +
      (followersTrend ? `📈 Followers ${followersTrend.days} hari terakhir: ${signed(followersTrend.change)}\n` : '') +
      (data.bio ? `\n📝 Bio:\n${data.bio}\n` : '') +
      `\nhttps://www.instagram.com/${username}/`;

    // Unduh foto profil saat diminta (link perantara bisa kedaluwarsa, jadi jangan disimpan lama)
    let avatarFile = null;
    let avatarError = null;
    if (options.downloadAvatar && data.avatar) {
      const outDir = options.outDir || path.join(process.cwd(), 'downloads');
      const dl = await downloadImage(data.avatar, path.join(outDir, `avatar_${username.toLowerCase()}`));
      if (dl.success) {
        avatarFile = dl.file_path;
      } else if (cached && !options._retried) {
        // Link dari cache mungkin sudah kedaluwarsa: ambil data baru sekali lagi
        cache.delete(key);
        return igViewer(input, { ...options, _retried: true });
      } else {
        avatarError = dl.message;
      }
    }

    return {
      success: true,
      original_url: `https://www.instagram.com/${username}/`,
      username,
      nickname: data.nickname,
      verified: data.verified,
      avatar: data.avatar,
      avatar_file: avatarFile,
      avatar_error: avatarError,
      bio: data.bio,
      posts: { display: data.posts, latest: lastOf(data.stats.posts) },
      followers: { display: data.followers, latest: lastOf(data.stats.followers) },
      following: { display: data.following, latest: lastOf(data.stats.following) },
      stats: data.stats,
      trend: {
        posts: trend(data.stats.posts),
        followers: followersTrend,
        following: trend(data.stats.following)
      },
      cached,
      caption
    };

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { igViewer, downloadImage };

// Info profil          : node igviewer.js "nasa"
// Info + unduh foto    : node igviewer.js "nasa" --avatar
if (require.main === module) {
  const args = process.argv.slice(2);
  igViewer(args[0], { downloadAvatar: args.includes('--avatar') }).then((r) => console.log(JSON.stringify(r, null, 2)));
}
