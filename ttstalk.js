/**
 * Name Scrape : TikTok Viewer (via tik.ninja)
 * Owner       : Kersio
 * Base Web    : tik.ninja
 * Type        : Scraper
 * Function    : Mengambil data TikTok publik tanpa login: profil, daftar video, repost, story, followers, following, detail satu video/foto, dan komentar. Bisa juga mengunduh video/foto. Hasil berupa JSON beserta caption siap pakai untuk bot
 * Input       : Username / link profil / link video + mode (opsional: all | profile | posts | reposts | stories | followers | following | post | comments)
 * Output      : JSON (+ file video/foto di folder tiktok kalau pakai download)
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan)
 * Note        : Token halaman dan seed diambil otomatis dari tik.ninja tiap kali jalan (tidak hardcode), jeda 1 detik antar request. Hanya untuk akun dan konten publik. Jangan spam request. Struktur web dan proteksinya bisa berubah kapan saja. Fitur Highlights belum tersedia di webnya
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'https://tik.ninja';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BUILD = 'js-token-body-v3';
const GAP_MS = 1000;                  // jeda antar request
const MAX_PAGES = 5;                  // batas halaman per sekali jalan
const MAX_BYTES = 100 * 1024 * 1024;  // batas ukuran file yang diunduh

const MODES = ['all', 'profile', 'posts', 'reposts', 'stories', 'followers', 'following', 'post', 'comments'];
const LABEL = { all: 'Video', posts: 'Video', reposts: 'Repost', stories: 'Story', followers: 'Followers', following: 'Following' };

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

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

// Username / link profil / link video / ID video
function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const isPost = /tiktok\.com\/@[^/]+\/(video|photo)\/\d+/i.test(raw)
    || /^https?:\/\/(vm|vt)\.tiktok\.com\//i.test(raw)
    || /^https?:\/\/www\.tiktok\.com\/t\//i.test(raw)
    || /^\d{15,25}$/.test(raw);
  if (isPost) return { type: 'post', value: raw };

  const m = raw.match(/tiktok\.com\/@([\w.]+)/i);
  const uid = (m ? m[1] : raw.replace(/^@/, '')).toLowerCase();
  if (!/^[\w.]{1,40}$/.test(uid)) return null;
  return { type: 'user', value: uid };
}

// ---------- Sesi & token ----------
// Ambil halaman utama: token, seed, dan cookie sesi
async function createSession() {
  const res = await fetch(BASE + '/', {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 403 || res.status === 503) {
    throw new ScrapeError('BLOCKED', 'Akses ke tik.ninja diblokir (proteksi anti-bot). Coba lagi nanti atau ganti jaringan.', res.status);
  }
  if (!res.ok) throw new ScrapeError('API_ERROR', `tik.ninja membalas HTTP ${res.status}`, res.status);

  const html = await res.text();
  const token = (html.match(/const\s+TOKEN\s*=\s*"([^"]+)"/) || [])[1];
  const seed = (html.match(/const\s+JS_CHALLENGE_SEED\s*=\s*"([^"]+)"/) || [])[1];
  if (!token || !seed) {
    throw new ScrapeError('TOKEN_NOT_FOUND', 'Token halaman tidak ditemukan. Struktur tik.ninja mungkin berubah.');
  }

  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else if (res.headers.get('set-cookie')) list = res.headers.get('set-cookie').split(/,(?=\s*[\w.-]+=)/);
  const cookie = list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');

  return { token, seed, cookie, last: Date.now() };
}

// Token per request (bucket 30 detik), sama seperti script di webnya
function jsToken(s, action) {
  const bucket = Math.floor(Date.now() / 30000);
  const hex = sha256(`${s.seed}:${s.token}:${bucket}:${action}:tik.ninja`).toString('hex');
  return { token: hex, bucket };
}

// Respons API bisa terenkripsi AES-256-CBC
function decodeEnvelope(s, payload) {
  const compact = payload && payload._t === 'p' && payload._i && payload._d;
  const legacy = payload && payload.enc === true && payload.iv && payload.data;
  if (!compact && !legacy) return payload;

  const key = sha256(`${s.seed}:${s.token}:response:tik.ninja`);
  const iv = Buffer.from(compact ? payload._i : payload.iv, 'base64');
  const data = Buffer.from(compact ? payload._d : payload.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function apiHeaders(s, jt) {
  const h = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Origin': BASE,
    'Referer': BASE + '/',
    'X-Api-Token': s.token,
    'X-JS-Token': jt.token,
    'X-JS-Bucket': String(jt.bucket),
    'X-Client-Build': BUILD
  };
  if (s.cookie) h.Cookie = s.cookie;
  return h;
}

// Jaga jeda minimal antar request
async function pace(s) {
  const wait = s.last + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  s.last = Date.now();
}

async function api(s, action, params = {}) {
  await pace(s);
  const jt = jsToken(s, action);
  const body = { ...params, action, hp: '', js_token: jt.token, js_bucket: String(jt.bucket), __client_build: BUILD };

  const res = await fetch(BASE + '/api.php', {
    method: 'POST',
    headers: apiHeaders(s, jt),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // respons bukan JSON
  }
  if (data) {
    try {
      data = decodeEnvelope(s, data);
    } catch {
      throw new ScrapeError('DECRYPT_FAILED', 'Gagal membuka respons terenkripsi. Cara enkripsi tik.ninja mungkin berubah.');
    }
  }

  if (res.status === 429) throw new ScrapeError('RATE_LIMITED', 'Terlalu banyak request. Coba lagi beberapa saat lagi.', 429);
  if (res.status === 403 && !data) throw new ScrapeError('BLOCKED', 'Request ditolak (HTTP 403). Kemungkinan kena proteksi anti-bot.', 403);
  if (!res.ok || !data) {
    throw new ScrapeError('API_ERROR', (data && data.error) || `Layanan membalas HTTP ${res.status}`, res.status);
  }
  if (!data.data) throw new ScrapeError('NO_DATA', 'Data tidak ditemukan di respons. Struktur layanan mungkin berubah.');
  return data.data;
}

// Ambil beberapa halaman sekaligus
async function collect(s, action, base, o) {
  const items = [];
  let cur = o.start;
  let hasMore = false;
  for (let i = 0; i < o.pages; i++) {
    const d = await api(s, action, { ...base, [o.curIn]: cur, count: o.count });
    items.push(...(d[o.list] || []));
    hasMore = !!d.hasMore;
    const next = d[o.curOut];
    if (next) cur = typeof o.start === 'string' ? String(next) : next;
    if (!hasMore || !next) break;
  }
  return { items, hasMore };
}

// ---------- Rapikan data ----------
function mapUser(d) {
  const u = d.user || {};
  const st = d.stats || {};
  return {
    id: u.id || null,
    username: u.uniqueId || null,
    nickname: u.nickname || '',
    verified: !!u.verified,
    bio: u.signature || '',
    avatar: u.avatarMedium || u.avatarThumb || null,
    created: u.createTime || null,
    followers: num(st.followerCount),
    following: num(st.followingCount),
    likes: num(st.heartCount),
    videos: num(st.videoCount)
  };
}

function mapVideo(v) {
  const isPhoto = Array.isArray(v.images) && v.images.length > 0;
  return {
    id: v.id || v.video_id || null,
    type: isPhoto ? 'photo' : 'video',
    title: v.title || '',
    created: v.create_time || null,
    duration: v.duration || null,
    cover: v.cover || v.origin_cover || null,
    play: v.play || null,
    images: isPhoto ? v.images : [],
    stats: {
      plays: num(v.play_count),
      likes: num(v.digg_count),
      comments: num(v.comment_count),
      shares: num(v.share_count),
      saves: num(v.collect_count)
    }
  };
}

function mapPost(p) {
  const v = mapVideo(p);
  v.author = p.author
    ? { username: p.author.unique_id || null, nickname: p.author.nickname || '', avatar: p.author.avatar || null }
    : null;
  return v;
}

const mapPerson = (u) => ({
  username: u.unique_id || null,
  nickname: u.nickname || '',
  avatar: u.avatar || null,
  verified: !!u.verified,
  followers: num(u.follower_count)
});

const mapComment = (c) => ({
  id: c.cid || c.id || null,
  username: (c.user && c.user.unique_id) || null,
  text: c.text || '',
  likes: num(c.digg_count),
  created: c.create_time || null,
  replies: num(c.reply_total)
});

// ---------- Unduh file ----------
async function downloadMedia(s, token, filename, outDir) {
  await pace(s);
  const jt = jsToken(s, 'download');
  const body = { action: 'download', token, filename, hp: '', js_token: jt.token, js_bucket: String(jt.bucket), __client_build: BUILD };

  const res = await fetch(BASE + '/api.php', {
    method: 'POST',
    headers: apiHeaders(s, jt),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok || type.includes('json')) {
    let msg = `Gagal mengunduh file (HTTP ${res.status})`;
    try {
      const e = decodeEnvelope(s, await res.json());
      if (e && e.error) msg = e.error;
    } catch {
      // abaikan
    }
    throw new ScrapeError('DOWNLOAD_FAILED', msg, res.status);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw new ScrapeError('FILE_TOO_LARGE', `Ukuran file melebihi ${MAX_BYTES / 1024 / 1024}MB`);
  }

  const ext = type.includes('mpeg') ? 'mp3' : type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : 'mp4';
  const safe = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]/g, '_');
  const file = path.join(outDir, `${safe}_${Date.now()}.${ext}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, buffer);
  return { file, filesize: buffer.length };
}

// ---------- Caption ----------
function userLines(u) {
  return `👤 ${u.nickname}${u.verified ? ' ✓' : ''}\n` +
    `🔖 @${u.username}\n` +
    `👥 Followers : ${fmt(u.followers)}\n` +
    `➡️ Following : ${fmt(u.following)}\n` +
    `❤️ Likes     : ${fmt(u.likes)}\n` +
    `🎬 Video     : ${fmt(u.videos)}\n` +
    (u.bio ? `📝 Bio       : ${u.bio.slice(0, 150)}\n` : '');
}

function buildCaption(mode, out) {
  let c = '🎵 *TikTok Viewer*\n\n';

  if (out.post) {
    const p = out.post;
    c += (p.author ? `👤 @${p.author.username} (${p.author.nickname})\n` : '') +
      `📌 Tipe : ${p.type}\n` +
      (p.title ? `📝 ${p.title.slice(0, 200)}\n` : '') +
      `▶️ ${fmt(p.stats.plays)}  ❤️ ${fmt(p.stats.likes)}  💬 ${fmt(p.stats.comments)}  🔁 ${fmt(p.stats.shares)}\n`;
    if (out.comments) c += `\n💬 Komentar terambil : ${out.comments.length}${out.has_more ? ' (masih ada)' : ''}\n`;
    return c;
  }

  if (out.user) c += userLines(out.user);
  else c += `🔖 @${out.target}\n`;

  const list = out.videos || out.users;
  if (list) {
    c += `\n📦 ${LABEL[mode]} terambil : ${list.length}${out.has_more ? ' (masih ada)' : ''}\n`;
    c += out.videos
      ? out.videos.slice(0, 5).map((v, i) => `${i + 1}. ${(v.title || '(tanpa caption)').slice(0, 50)} (▶ ${fmt(v.stats.plays)})`).join('\n')
      : out.users.slice(0, 5).map((u, i) => `${i + 1}. @${u.username}`).join('\n');
  }
  return c;
}

/**
 * TikTok Viewer - Single function
 * @param {string} input - Username, link profil, link video, atau ID video
 * @param {object} [options]
 * @param {string} [options.mode='auto'] - auto | all | profile | posts | reposts | stories | followers | following | post | comments
 * @param {number} [options.pages=1] - Jumlah halaman yang diambil (maksimal 5)
 * @param {boolean} [options.download=false] - true = unduh video/foto (khusus mode post)
 * @param {string} [options.outDir] - Folder simpan (default: ./tiktok)
 * @returns {Promise<object>} JSON hasil
 */
async function tiktok(input, options = {}) {
  try {
    const parsed = parseInput(input);
    if (!parsed) {
      return { success: false, error: 'INVALID_INPUT', message: 'Input tidak valid. Contoh: node tiktok.js tiktok atau node tiktok.js https://www.tiktok.com/@user/video/123' };
    }

    let mode = String(options.mode || 'auto').toLowerCase();
    if (mode === 'auto') mode = parsed.type === 'post' ? 'post' : 'all';
    if (!MODES.includes(mode)) {
      return { success: false, error: 'INVALID_MODE', message: `Mode tidak dikenal. Pilihan: ${MODES.join(', ')}` };
    }

    const needsPost = mode === 'post' || mode === 'comments';
    if (needsPost && parsed.type !== 'post') {
      return { success: false, error: 'INVALID_INPUT', message: `Mode ${mode} butuh link video/foto TikTok atau ID postingan` };
    }
    if (!needsPost && parsed.type === 'post') {
      return { success: false, error: 'INVALID_INPUT', message: `Mode ${mode} butuh username, bukan link video. Pakai mode post atau comments` };
    }

    const pages = Math.min(Math.max(num(options.pages) || 1, 1), MAX_PAGES);
    const outDir = options.outDir || path.join(process.cwd(), 'tiktok');
    const s = await createSession();
    const out = { success: true, target: parsed.value, mode };

    if (needsPost) {
      // ----- Satu video / foto (+ komentar) -----
      const p = await api(s, 'get_post', { url_or_id: parsed.value });
      out.post = mapPost(p);

      if (mode === 'comments') {
        const videoId = p.id || p.video_id;
        if (!videoId) throw new ScrapeError('NO_DATA', 'ID video tidak ditemukan di respons.');
        const c = await collect(s, 'get_comments', { video_id: videoId }, { list: 'comments', curIn: 'cursor', curOut: 'cursor', count: 20, pages, start: 0 });
        out.comments = c.items.map(mapComment);
        out.has_more = c.hasMore;
      } else if (options.download) {
        const uid = (p.author && p.author.unique_id) || 'tiktok';
        const id = out.post.id || 'post';
        const jobs = out.post.type === 'photo'
          ? (p._image_tokens || []).map((t, i) => [t, `${uid}_${id}_photo${i + 1}.jpg`])
          : (p._play_token ? [[p._play_token, `${uid}_${id}.mp4`]] : []);
        out.files = [];
        for (const [token, name] of jobs) {
          const f = await downloadMedia(s, token, name, outDir);
          out.files.push(f.file);
        }
      }
    } else {
      // ----- Akun: profil, video, repost, story, followers, following -----
      if (['all', 'profile', 'posts', 'followers', 'following'].includes(mode)) {
        const d = await api(s, 'get_user', { unique_id: parsed.value });
        if (!d.user) throw new ScrapeError('NO_DATA', 'Akun tidak ditemukan atau bersifat privat.');
        out.user = mapUser(d);
      }

      if (mode === 'all' || mode === 'posts') {
        const r = await collect(s, 'get_posts', { user_id: out.user.id }, { list: 'videos', curIn: 'cursor', curOut: 'cursor', count: 20, pages, start: '0' });
        out.videos = r.items.map(mapVideo);
        out.has_more = r.hasMore;
      } else if (mode === 'reposts') {
        const r = await collect(s, 'get_reposts', { unique_id: parsed.value }, { list: 'videos', curIn: 'cursor', curOut: 'cursor', count: 20, pages, start: '0' });
        out.videos = r.items.map(mapVideo);
        out.has_more = r.hasMore;
      } else if (mode === 'stories') {
        const d = await api(s, 'get_stories', { unique_id: parsed.value });
        out.videos = (d.stories || d.videos || []).map(mapVideo);
        out.has_more = false;
      } else if (mode === 'followers' || mode === 'following') {
        const r = await collect(s, mode === 'followers' ? 'get_followers' : 'get_following', { user_id: out.user.id }, { list: 'users', curIn: 'time', curOut: 'time', count: 30, pages, start: '0' });
        out.users = r.items.map(mapPerson);
        out.has_more = r.hasMore;
      }
    }

    out.caption = buildCaption(mode, out);
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

module.exports = { tiktok };

// Profil + video terbaru      : node tiktok.js tiktok
// Satu mode saja              : node tiktok.js tiktok reposts   (profile | posts | reposts | stories | followers | following)
// Beberapa halaman            : node tiktok.js tiktok posts --pages=3
// Info satu video             : node tiktok.js https://www.tiktok.com/@user/video/1234567890123456789
// Unduh video/foto            : node tiktok.js https://www.tiktok.com/@user/video/1234567890123456789 post --download
// Komentar video              : node tiktok.js https://www.tiktok.com/@user/video/1234567890123456789 comments --pages=2
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const pagesArg = args.find((a) => a.startsWith('--pages='));
  const outArg = args.find((a) => a.startsWith('--out='));

  tiktok(pos[0], {
    mode: pos[1],
    pages: pagesArg ? pagesArg.split('=')[1] : 1,
    download: args.includes('--download'),
    outDir: outArg ? outArg.split('=').slice(1).join('=') : undefined
  }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r.success) process.exitCode = 1;
  });
}
