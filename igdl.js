/**
 * Name Scrape : Instagram Reel/Post Downloader
 * Owner       : Kersio
 * Base Web    : www.instagram.com
 * Type        : scraper
 * Function    : Ambil video Instagram (prioritas 1080p) + foto carousel
 * Input       : Link Instagram (Reels/Post/IGTV)
 * Output      : JSON + file media di folder instagram (kalau --download)
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+
 * Note        : Reel baru (< 24 jam upload) Biasanya cuma 720p, Reel lama (> 1-2 hari) Sering ada 1080p, Video original HD + akun besar Prioritas 1080p lebih cepat, Reel dari akun kecil Kadang stuck di 720p selamanya (erorr fix sendiri ya)
 */

if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 300 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// PARSING URL INPUT
// ============================================================
function parseInstagramUrl(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  return {
    shortcode: m[1],
    original: raw,
    isReel: /instagram\.com\/(?:reel|reels)\//i.test(raw)
  };
}

// ============================================================
// PARSE RESOLUSI DARI PARAMETER efg (BASE64) — VERSI FIX
// ============================================================
function parseResolutionFromUrl(url) {
  try {
    let efg = null;
    const urlStr = String(url || '');

    // METODE 1: URL parser standar
    try {
      const clean = urlStr.replace(/&amp;/g, '&');
      efg = new URL(clean).searchParams.get('efg');
    } catch {}

    // METODE 2: regex langsung ke string (fallback)
    if (!efg) {
      const m = urlStr.match(/[?&]efg=([^&]+)/);
      if (m) efg = m[1];
    }

    if (!efg) return null;

    // Base64 URL-safe → standar, tambah padding
    const b64 = efg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const data = JSON.parse(json);

    const tag = data.vencode_tag || data.video_encode_tag || '';
    const m = tag.match(/\.(\d{3,4})\./);
    if (!m) return null;

    const h = parseInt(m[1], 10);
    if (h < 144 || h > 4320) return null;

    const w = Math.round(h * 9 / 16);
    return { height: h, width: w };
  } catch {
    return null;
  }
}

// ============================================================
// FETCH HALAMAN INSTAGRAM
// ============================================================
async function fetchPage(shortcode, isReel) {
  const url = isReel
    ? `https://www.instagram.com/reel/${shortcode}/`
    : `https://www.instagram.com/p/${shortcode}/`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) throw new Error(`Instagram balas HTTP ${res.status}`);
  return await res.text();
}

// ============================================================
// EKSTRAK SEMUA DATA DARI HTML
// ============================================================
function extractFromHtml(html) {
  const result = {
    caption: null, thumbnail: null, author: null, duration: null,
    likes: null, comments: null, takenAt: null,
    videoCandidates: [], imageUrls: []
  };

  const jsonMatches = html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of jsonMatches) {
    try { walkJson(JSON.parse(m[1]), result); } catch {}
  }

  if (!result.videoCandidates.length) {
    const vMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (vMatch) {
      const url = decodeStr(vMatch[1]);
      const res = parseResolutionFromUrl(url);
      result.videoCandidates.push({
        url,
        width: res?.width || 0,
        height: res?.height || 0,
        bandwidth: 0,
        source: 'regex'
      });
    }
  }

  if (!result.thumbnail) {
    const t = html.match(/"display_url"\s*:\s*"([^"]+)"/)
           || html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (t) result.thumbnail = decodeStr(t[1]);
  }

  if (!result.caption) {
    const c = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (c) result.caption = decodeStr(c[1]);
  }

  return result;
}

// ============================================================
// REKURSIF JSON
// ============================================================
function walkJson(obj, result) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkJson(item, result);
    return;
  }

  if (Array.isArray(obj.video_versions)) {
    for (const v of obj.video_versions) {
      if (!v || !v.url) continue;
      let w = parseInt(v.width, 10) || 0;
      let h = parseInt(v.height, 10) || 0;
      if (w > 5000) w = 0;
      if (h > 5000) h = 0;
      if (!h) {
        const fromUrl = parseResolutionFromUrl(v.url);
        if (fromUrl) { w = fromUrl.width; h = fromUrl.height; }
      }
      result.videoCandidates.push({
        url: v.url, width: w, height: h,
        bandwidth: parseInt(v.bandwidth, 10) || 0,
        source: 'video_versions'
      });
    }
  }

  if (typeof obj.video_url === 'string' && obj.video_url && !obj.video_versions) {
    let w = parseInt(obj.width || obj.original_width, 10) || 0;
    let h = parseInt(obj.height || obj.original_height, 10) || 0;
    if (w > 5000) w = 0;
    if (h > 5000) h = 0;
    if (!h) {
      const fromUrl = parseResolutionFromUrl(obj.video_url);
      if (fromUrl) { w = fromUrl.width; h = fromUrl.height; }
    }
    result.videoCandidates.push({
      url: obj.video_url, width: w, height: h, bandwidth: 0, source: 'video_url'
    });
  }

  if (!result.thumbnail) {
    if (obj.display_url) result.thumbnail = obj.display_url;
    else if (obj.thumbnail_src) result.thumbnail = obj.thumbnail_src;
  }

  if (Array.isArray(obj.carousel_media)) {
    for (const cm of obj.carousel_media) {
      const u = cm?.image_versions2?.candidates?.[0]?.url || cm?.display_url;
      if (u) result.imageUrls.push(u);
    }
  }
  if (Array.isArray(obj.edge_sidecar_to_children?.edges)) {
    for (const e of obj.edge_sidecar_to_children.edges) {
      const n = e.node;
      if (n?.is_video && n?.video_url) result.imageUrls.push(n.video_url);
      else if (n?.display_url) result.imageUrls.push(n.display_url);
    }
  }

  if (!result.caption) {
    if (obj.caption?.text) result.caption = obj.caption.text;
    else if (obj.edge_media_to_caption?.edges?.[0]?.node?.text) {
      result.caption = obj.edge_media_to_caption.edges[0].node.text;
    }
  }

  if (!result.author) {
    if (obj.owner?.username) result.author = obj.owner.username;
    else if (obj.user?.username) result.author = obj.user.username;
    else if (typeof obj.username === 'string') result.author = obj.username;
  }

  if (!result.duration && obj.video_duration) result.duration = obj.video_duration;
  if (!result.likes && obj.like_count) result.likes = obj.like_count;
  if (!result.likes && obj.edge_media_preview_like?.count) result.likes = obj.edge_media_preview_like.count;
  if (!result.comments && obj.comment_count) result.comments = obj.comment_count;
  if (!result.comments && obj.edge_media_to_comment?.count) result.comments = obj.edge_media_to_comment.count;
  if (!result.takenAt && obj.taken_at) result.takenAt = obj.taken_at;

  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) walkJson(obj[k], result);
  }
}

function decodeStr(s) {
  try {
    return JSON.parse('"' + s.replace(/"/g, '\\"') + '"');
  } catch {
    return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
  }
}

// ============================================================
// PILIH KANDIDAT TERBAIK
// ============================================================
function pickHD(candidates) {
  if (!candidates.length) return null;

  const seen = new Set();
  const unique = candidates.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  const withHeight = unique.filter(c => c.height > 0);
  if (withHeight.length) {
    const exact = withHeight.find(c => c.height === 1080);
    if (exact) return exact;
    const below = withHeight.filter(c => c.height < 1080).sort((a, b) => b.height - a.height);
    if (below.length) return below[0];
    return withHeight.sort((a, b) => a.height - b.height)[0];
  }

  return unique.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

// ============================================================
// DETEKSI EKSTENSI
// ============================================================
function detectExt(buffer, contentType) {
  if (buffer.length > 12) {
    if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4';
    if (buffer.slice(0, 3).toString('hex') === 'ffd8ff') return 'jpg';
    if (buffer.slice(0, 4).toString('hex') === '89504e47') return 'png';
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF'
        && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  }
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpeg') || ct.includes('mp4') || ct.includes('video')) return 'mp4';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return 'bin';
}

// ============================================================
// DOWNLOAD
// ============================================================
async function downloadMedia(url, filename, outDir) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.instagram.com/' },
      signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) return { error: `File >${MAX_BYTES / 1024 / 1024}MB` };
    if (buffer.length < 1000) return { error: `File terlalu kecil (${buffer.length} B)` };

    const ext = detectExt(buffer, res.headers.get('content-type'));
    const safe = filename.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]/g, '_');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${safe}.${ext}`);
    fs.writeFileSync(file, buffer);

    return { file, filesize: buffer.length, ext };
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// FORMAT
// ============================================================
function fmt(n) {
  n = parseInt(n, 10) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function fmtDuration(s) {
  if (!s) return null;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function fmtDate(unix) {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ============================================================
// BUILD CAPTION
// ============================================================
function buildCaption(out) {
  const L = [];
  const line = '─'.repeat(28);

  L.push('📸 *INSTAGRAM DOWNLOADER*');
  L.push('');

  L.push('📋 *INFORMASI*');
  L.push(line);
  if (out.author)    L.push(`👤 Author    : @${out.author}`);
  L.push(`🎬 Tipe      : ${out.type}`);
  if (out.quality)   L.push(`📺 Kualitas  : ${out.quality}`);
  if (out.duration)  L.push(`⏱️  Durasi    : ${fmtDuration(out.duration)}`);
  if (out.likes)     L.push(`❤️  Likes     : ${fmt(out.likes)}`);
  if (out.comments)  L.push(`💬 Komentar  : ${fmt(out.comments)}`);
  if (out.takenAt)   L.push(`📅 Diunggah  : ${fmtDate(out.takenAt)}`);
  L.push(`🔖 Shortcode : ${out.shortcode}`);
  L.push('');

  if (out.caption) {
    L.push('📝 *CAPTION*');
    L.push(line);
    const cap = out.caption.split('\n').map(l => l.trim()).filter(Boolean);
    cap.slice(0, 8).forEach(l => L.push(`   ${l.slice(0, 100)}`));
    if (cap.length > 8) L.push(`   ... (+${cap.length - 8} baris)`);
  }

  return L.join('\n');
}

// ============================================================
// MAIN
// ============================================================
async function instagram(input, options = {}) {
  try {
    const parsed = parseInstagramUrl(input);
    if (!parsed) {
      return {
        success: false, error: 'INVALID_INPUT',
        message: 'Link Instagram tidak valid. Contoh: https://www.instagram.com/reel/xxxx/',
        source: SOURCE
      };
    }

    const outDir = options.outDir || path.join(process.cwd(), 'instagram');
    const wantDownload = !!options.download;

    const html = await fetchPage(parsed.shortcode, parsed.isReel);
    const data = extractFromHtml(html);
    const hd = pickHD(data.videoCandidates);

    if (!hd && data.imageUrls.length === 0) {
      return {
        success: false, error: 'NO_MEDIA',
        message: 'Tidak ada video/foto ditemukan. Mungkin akun privat atau struktur Instagram berubah.',
        source: SOURCE
      };
    }

    let quality = null;
    if (hd) {
      if (hd.height > 0) {
        if (hd.height === 1080) quality = '1080p (Full HD)';
        else if (hd.height > 1080) quality = `${hd.height}p (di atas Full HD)`;
        else if (hd.height >= 720) quality = `${hd.height}p (HD)`;
        else quality = `${hd.height}p (SD)`;
      } else if (hd.bandwidth > 0) {
        quality = `~${(hd.bandwidth / 1000000).toFixed(1)} Mbps (resolusi tidak tersedia)`;
      } else {
        quality = 'Tidak diketahui';
      }
    }

    const out = {
      success: true,
      target: input,
      shortcode: parsed.shortcode,
      source: SOURCE,
      type: hd ? 'video' : (data.imageUrls.length > 1 ? 'carousel' : 'image'),
      author: data.author,
      caption: data.caption,
      thumbnail: data.thumbnail,
      duration: data.duration,
      likes: data.likes,
      comments: data.comments,
      takenAt: data.takenAt,
      quality,
      videoWidth: hd?.width || null,
      videoHeight: hd?.height || null,
      videoBandwidth: hd?.bandwidth || null,
      videoUrl: hd?.url || null,
      videoUrlSource: hd?.source || null,
      imageUrls: data.imageUrls,
      downloadErrors: []
    };

    if (wantDownload) {
      out.files = [];
      out.fileSizes = [];
      const jobs = [];
      if (hd) {
        const resLabel = hd.height > 0 ? `${hd.height}p` : 'hd';
        jobs.push({ url: hd.url, name: `ig_${parsed.shortcode}_${resLabel}` });
      }
      data.imageUrls.forEach((u, i) =>
        jobs.push({ url: u, name: `ig_${parsed.shortcode}_photo${i + 1}` }));

      for (const j of jobs) {
        const f = await downloadMedia(j.url, j.name, outDir);
        if (f && f.file) {
          out.files.push(f.file);
          out.fileSizes.push(f.filesize);
        } else if (f && f.error) {
          out.downloadErrors.push(`${path.basename(j.name)}: ${f.error}`);
        }
        await sleep(500);
      }
      if (out.files.length) out.outDir = outDir;
    }

    out.caption = buildCaption(out);
    return out;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama.', source: SOURCE };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err), source: SOURCE };
  }
}

module.exports = { instagram };

// ============================================================
// CLI
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const outArg = args.find((a) => a.startsWith('--out='));

  instagram(pos[0], {
    download: args.includes('--download'),
    outDir: outArg ? outArg.split('=').slice(1).join('=') : undefined
  }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log('');
    console.log(`Sumber: ${SOURCE}`);
    if (!r.success) process.exitCode = 1;
  });
}
