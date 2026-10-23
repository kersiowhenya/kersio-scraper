/**
 * Name Scrape : YouTube Downloader Info (via YtDown)
 * Owner       : Kersio
 * Base Web    : ytdown.biz.id
 * Type        : Scraper
 * Function    : Mengambil info video YouTube (judul, channel, durasi, views, thumbnail) beserta semua pilihan format unduhan: video MP4 (dengan audio), audio MP3/M4A, dan video tanpa suara, lengkap dengan ukuran file dan link unduhan
 * Input       : 1 link video YouTube (watch, shorts, youtu.be) atau ID video 11 karakter
 * Output      : JSON
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Hanya video publik. Jangan spam request. Link unduhan dibuat oleh server situs dan bisa berhenti berfungsi kapan saja. Struktur API bisa berubah kapan saja.
 */

const BASE = 'https://ytdown.biz.id';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

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
const abs = (p) => (p ? (/^https?:\/\//i.test(p) ? p : `${BASE}${p}`) : null);

// Ambil ID video dari link YouTube (watch, shorts, youtu.be, embed, live) atau ID polos
function parseVideo(text) {
  const t = String(text || '').trim();

  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return { id: t };

  const patterns = [
    /(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return { id: m[1] };
  }

  // Link YouTube tapi bukan link video (channel, playlist, dll)
  if (/youtube\.com|youtu\.be/i.test(t)) return { notVideo: true };
  return {};
}

const mapVideo = (v) => ({
  itag: v.itag,
  quality: v.quality,
  raw_quality: v.rawQuality,
  height: v.height,
  fps: v.fps,
  container: v.container,
  has_audio: !!v.hasAudio,
  type: v.type,
  audio_lang: v.audioLang || null,
  size_bytes: v.sizeBytes ?? null,
  size: v.sizeFormatted || null,
  download_url: abs(v.downloadUrl)
});

const mapAudio = (a) => ({
  label: a.label,
  bitrate: a.bitrate,
  format: a.format,
  type: a.type,
  itag: a.itag ?? null,
  audio_lang: a.audioLang || null,
  size_bytes: a.sizeBytes ?? null,
  size: a.sizeFormatted || null,
  download_url: abs(a.downloadUrl)
});

const mapVideoOnly = (v) => ({
  itag: v.itag,
  quality: v.quality,
  container: v.container,
  fps: v.fps,
  size_bytes: v.sizeBytes ?? null,
  size: v.sizeFormatted || null,
  download_url: abs(v.downloadUrl)
});

const asText = (x) => (typeof x === 'string' ? x : x ? JSON.stringify(x) : null);

/**
 * YouTube Downloader Info - Single function
 * @param {string} input - Link video YouTube atau ID video
 * @param {object} [options]
 * @param {string} [options.audioLang='id'] - Bahasa audio/dubbing ('id', 'original', dll). Kalau tidak tersedia, situs memakai audio asli
 * @returns {Promise<object>} JSON hasil
 */
async function ytDown(input, options = {}) {
  try {
    const parsed = parseVideo(input);

    if (parsed.notVideo) {
      return { success: false, error: 'NOT_A_VIDEO_LINK', message: 'Ini bukan link video. Kirim link video: youtube.com/watch?v=..., youtube.com/shorts/..., atau youtu.be/...' };
    }
    if (!parsed.id) {
      return { success: false, error: 'INVALID_INPUT', message: 'Link atau ID video tidak valid' };
    }

    const id = parsed.id;
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
    const audioLang = String(options.audioLang || 'id').trim() || 'id';
    const key = `${id}:${audioLang}`;
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
        fetch(`${BASE}/api/info`, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'Content-Type': 'application/json',
            'Origin': BASE,
            'Referer': `${BASE}/`
          },
          body: JSON.stringify({ url: videoUrl, audioLang }),
          redirect: 'follow',
          signal: AbortSignal.timeout(45000)
        })
      );

      if (res.status === 429 || res.status === 403) {
        blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
        return { success: false, error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED', status: res.status, message: 'Situs membatasi atau memblokir akses. Coba lagi nanti.' };
      }

      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* bukan JSON */ }
      const apiMsg = json ? asText(json.error || json.message) : null;

      if (res.status === 404) {
        return { success: false, error: 'NOT_FOUND', message: apiMsg || 'Video tidak ditemukan' };
      }
      if (!res.ok) {
        return { success: false, error: 'HTTP_ERROR', status: res.status, message: apiMsg || `Situs membalas HTTP ${res.status}` };
      }
      if (!json || json.success === false) {
        return { success: false, error: 'API_ERROR', message: apiMsg || 'Situs membalas dengan data yang tidak dikenali' };
      }
      if (!json.data || !json.data.formats) {
        return { success: false, error: 'NO_DATA', message: 'Data video tidak ditemukan. Video mungkin private, dibatasi umur, atau struktur API situs sudah berubah.' };
      }

      const d = json.data;
      const f = d.formats;

      data = {
        id: d.id || id,
        title: d.title || null,
        channel: d.channel || null,
        duration: { seconds: d.durationSeconds ?? null, display: d.durationFormatted || null },
        views: { count: d.views ?? null, display: d.viewsFormatted || null },
        thumbnail: d.thumbnail || null,
        description: d.description || null,
        audioLanguages: (d.audioLanguages || []).map((a) => ({ id: a.id, name: a.name, default: !!a.isDefault, indonesian: !!a.isIndonesian })),
        selectedAudioLang: d.selectedAudioLang || null,
        hasIndonesianAudio: !!d.hasIndonesianAudio,
        formats: {
          video: (f.videos || []).map(mapVideo),
          audio: (f.audios || []).map(mapAudio),
          video_only: (f.videoOnly || []).map(mapVideoOnly)
        }
      };

      cache.set(key, { at: Date.now(), data });
    }

    const qualities = data.formats.video.map((v) => String(v.quality).replace(/\s*\(.*\)/, '')).join(', ');
    const audios = data.formats.audio.map((a) => `${a.format} ${a.bitrate}`).join(', ');

    const caption =
      `🎬 *YouTube Downloader*\n\n` +
      `📌 Judul    : ${data.title || '-'}\n` +
      `📺 Channel  : ${data.channel || '-'}\n` +
      `⏱️ Durasi   : ${data.duration.display || '-'}\n` +
      `👁️ Views    : ${data.views.display || '-'}\n` +
      `🎞️ Video    : ${qualities || '-'}\n` +
      `🎵 Audio    : ${audios || '-'}\n` +
      `\n${videoUrl}`;

    return {
      success: true,
      original_url: videoUrl,
      id: data.id,
      title: data.title,
      channel: data.channel,
      duration: data.duration,
      views: data.views,
      thumbnail: data.thumbnail,
      description: data.description,
      audio_languages: data.audioLanguages,
      selected_audio_lang: data.selectedAudioLang,
      has_indonesian_audio: data.hasIndonesianAudio,
      formats: data.formats,
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

module.exports = { ytDown };

// Info video            : node ytdown.js "https://youtube.com/shorts/X6hvU4KKqxU"
// Pilih bahasa audio    : node ytdown.js "https://youtu.be/X6hvU4KKqxU" --lang=original
if (require.main === module) {
  const args = process.argv.slice(2);
  const langArg = args.find((a) => a.startsWith('--lang='));
  ytDown(args[0], { audioLang: langArg ? langArg.split('=')[1] : undefined }).then((r) => console.log(JSON.stringify(r, null, 2)));
}
