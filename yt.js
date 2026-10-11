/**
 * Name Scrape : YouTube Scraper
 * Owner       : Kersio
 * Base        : youtube.com
 * Type        : Scraper
 * Function    : Mengambil link video (dengan suara), video HD (tanpa suara), audio terbaik, dan metadata lengkap dari video YouTube / Shorts
 * Input       : 1 URL YouTube (youtube.com/watch, youtu.be, youtube.com/shorts)
 * Output      : JSON
 * sl               : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+, yt-dlp (pip install yt-dlp), ffmpeg
 * Note        : Erorr fix sendiri y
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * YouTube Scraper - Single function
 * @param {string} youtubeUrl - URL YouTube / Shorts / youtu.be
 * @returns {Promise<object>} JSON hasil scrape
 */
async function youtube(youtubeUrl) {
  // Helper: validasi URL
  function isYoutubeUrl(u) {
    return /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(u);
  }

  // Helper: jalankan yt-dlp
  function runYtDlp(url) {
    return new Promise((resolve, reject) => {
      execFile(
        'yt-dlp',
        ['-J', '--no-playlist', '--no-warnings', url],
        { maxBuffer: 100 * 1024 * 1024, timeout: 90000 },
        (err, stdout, stderr) => {
          if (err) {
            err.stderrText = String(stderr || '');
            return reject(err);
          }
          resolve(stdout);
        }
      );
    });
  }

  // Helper: petakan error yt-dlp ke kode yang rapi
  function mapError(err) {
    const text = `${err.stderrText || ''} ${err.message || ''}`.toLowerCase();

    if (err.code === 'ENOENT') {
      return { error: 'YTDLP_NOT_INSTALLED', message: 'yt-dlp belum terpasang. Jalankan: pip install yt-dlp' };
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return { error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    if (text.includes('private video')) {
      return { error: 'VIDEO_PRIVATE', message: 'Video bersifat private' };
    }
    if (text.includes('confirm your age') || text.includes('age-restricted')) {
      return { error: 'AGE_RESTRICTED', message: 'Video dibatasi usia' };
    }
    if (text.includes('not a bot')) {
      return { error: 'BOT_CHECK', message: 'YouTube meminta verifikasi bot. Coba lagi nanti.' };
    }
    if (text.includes('video unavailable') || text.includes('has been removed') || text.includes('not available')) {
      return { error: 'VIDEO_UNAVAILABLE', message: 'Video tidak tersedia atau sudah dihapus' };
    }
    if (text.includes('unable to download') || text.includes('network') || text.includes('timed out')) {
      return { error: 'NETWORK_ERROR', message: 'Gagal terhubung ke YouTube' };
    }
    return { error: 'EXCEPTION', message: (err.stderrText || err.message || 'Unknown error').trim().slice(0, 300) };
  }

  const bySizeDesc = (a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0);

  // Label kualitas pakai sisi terpendek, supaya video vertikal (Shorts) tampil benar: 1080x1920 -> 1080p
  const qLabel = (f) => {
    if (!f) return null;
    const s = Math.min(f.width || Infinity, f.height || Infinity);
    return Number.isFinite(s) ? `${s}p` : null;
  };

  // ========== MAIN LOGIC ==========
  try {
    if (!youtubeUrl || typeof youtubeUrl !== 'string') {
      return { success: false, error: 'INVALID_URL', message: 'URL tidak valid' };
    }

    const url = youtubeUrl.trim();
    if (!isYoutubeUrl(url)) {
      return { success: false, error: 'INVALID_URL', message: 'Bukan link YouTube yang valid' };
    }

    // 1. Ambil data dari yt-dlp
    const stdout = await runYtDlp(url);
    const d = JSON.parse(stdout);
    const formats = (d.formats || []).filter(f => f.url && f.protocol && f.protocol.startsWith('http'));

    // 2. Format gabungan (video + suara), cocok langsung diputar/diunduh
    const combined = formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .sort(bySizeDesc)[0] || null;

    // 3. Video kualitas tertinggi (biasanya tanpa suara)
    const videoOnly = formats
      .filter(f => f.vcodec !== 'none' && f.acodec === 'none')
      .sort(bySizeDesc)[0] || null;

    // 4. Audio terbaik
    const audio = formats
      .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;

    if (!combined && !videoOnly && !audio) {
      return { success: false, error: 'NO_MEDIA', message: 'Tidak ditemukan media yang bisa diunduh' };
    }

    // 5. Susun output
    return {
      success: true,
      original_url: url,
      title: d.title || null,
      author: d.uploader || d.channel || null,
      channel_url: d.channel_url || d.uploader_url || null,
      video_id: d.id || null,
      duration: d.duration || null,
      view_count: d.view_count ?? null,
      like_count: d.like_count ?? null,
      upload_date: d.upload_date || null,
      is_short: /\/shorts\//i.test(url),
      thumbnail: d.thumbnail || null,
      quality: qLabel(combined),
      download_url: combined?.url || null,
      video_hd: videoOnly
        ? {
            quality: qLabel(videoOnly),
            ext: videoOnly.ext || null,
            filesize: videoOnly.filesize || videoOnly.filesize_approx || null,
            url: videoOnly.url
          }
        : null,
      audio: audio
        ? {
            bitrate: audio.abr ? `${Math.round(audio.abr)}kbps` : null,
            ext: audio.ext || null,
            filesize: audio.filesize || audio.filesize_approx || null,
            url: audio.url
          }
        : null,
      audio_url: audio?.url || null,
      note: combined
        ? 'download_url sudah ada suara. video_hd tidak ada suara, gabungkan dengan audio_url pakai ffmpeg jika butuh HD + suara.'
        : 'YouTube tidak menyediakan format gabungan untuk video ini. video_hd tidak ada suara, gabungkan dengan audio_url pakai ffmpeg.'
    };

  } catch (err) {
    if (err instanceof SyntaxError) {
      return { success: false, error: 'PARSE_ERROR', message: 'Gagal membaca respons yt-dlp' };
    }
    return { success: false, ...mapError(err) };
  }
}

/**
 * YouTube MP4 - download video + suara jadi 1 file .mp4, lengkap dengan thumbnail & caption info
 * @param {string} youtubeUrl - URL YouTube / Shorts / youtu.be
 * @param {object} [options]
 * @param {number} [options.maxRes=720]  - Kualitas maksimal (sisi terpendek), contoh 360 / 480 / 720 / 1080
 * @param {string} [options.outDir]      - Folder penyimpanan (default: ./downloads)
 * @returns {Promise<object>} JSON: thumbnail, caption, file_path, dll
 */
async function youtubeMp4(youtubeUrl, options = {}) {
  const maxRes = options.maxRes || 720;
  const outDir = options.outDir || path.join(process.cwd(), 'downloads');

  const fmtDur = (s) => {
    if (!s) return '-';
    const m = Math.floor(s / 60);
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    return `${m}:${sec}`;
  };
  const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));
  const fmtDate = (d) => (d && d.length === 8 ? `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}` : '-');
  const fmtSize = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

  try {
    // 1. Ambil metadata dulu
    const info = await youtube(youtubeUrl);
    if (!info.success) return info;

    // 2. Download + gabung video & audio jadi mp4
    fs.mkdirSync(outDir, { recursive: true });
    const outTemplate = path.join(outDir, `${info.video_id}.%(ext)s`);

    await new Promise((resolve, reject) => {
      execFile(
        'yt-dlp',
        [
          '--no-playlist',
          '--no-warnings',
          '-f', 'bv*+ba/b',
          '-S', `res:${maxRes},ext:mp4:m4a`,
          '--merge-output-format', 'mp4',
          '-o', outTemplate,
          info.original_url
        ],
        { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            err.stderrText = String(stderr || '');
            return reject(err);
          }
          resolve();
        }
      );
    });

    // 3. Cari file hasilnya
    const fileName = fs.readdirSync(outDir).find(f => f.startsWith(`${info.video_id}.`) && f.endsWith('.mp4'));
    if (!fileName) {
      return { success: false, error: 'FILE_NOT_FOUND', message: 'File hasil download tidak ditemukan' };
    }
    const filePath = path.join(outDir, fileName);
    const size = fs.statSync(filePath).size;

    // 4. Caption informasi
    const caption =
      `🎬 *${info.title || '-'}*\n\n` +
      `👤 Channel : ${info.author || '-'}\n` +
      `⏱️ Durasi  : ${fmtDur(info.duration)}\n` +
      `👁️ Views   : ${fmtNum(info.view_count)}\n` +
      `👍 Like    : ${fmtNum(info.like_count)}\n` +
      `📅 Upload  : ${fmtDate(info.upload_date)}\n` +
      `📦 Ukuran  : ${fmtSize(size)}\n` +
      `🔗 ${info.original_url}`;

    return {
      success: true,
      original_url: info.original_url,
      title: info.title,
      author: info.author,
      video_id: info.video_id,
      duration: info.duration,
      thumbnail: info.thumbnail,
      max_quality: `${maxRes}p`,
      file_path: filePath,
      file_name: fileName,
      filesize: size,
      caption
    };

  } catch (err) {
    const text = String(err.stderrText || err.message || '');
    if (err.code === 'ENOENT') {
      return { success: false, error: 'YTDLP_NOT_INSTALLED', message: 'yt-dlp belum terpasang. Jalankan: pip install yt-dlp' };
    }
    if (text.toLowerCase().includes('ffmpeg')) {
      return { success: false, error: 'FFMPEG_NOT_INSTALLED', message: 'ffmpeg belum terpasang. Jalankan: pkg install ffmpeg' };
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return { success: false, error: 'TIMEOUT', message: 'Download terlalu lama, coba kualitas lebih rendah' };
    }
    return { success: false, error: 'EXCEPTION', message: text.trim().slice(0, 300) };
  }
}

module.exports = { youtube, youtubeMp4 };

// Scrape link   : node youtube.js "https://youtu.be/xxxxx"
// Download mp4  : node youtube.js mp4 "https://youtu.be/xxxxx" [720]
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'mp4') {
    youtubeMp4(args[1], { maxRes: Number(args[2]) || 720 }).then(r => console.log(JSON.stringify(r, null, 2)));
  } else {
    youtube(args[0]).then(r => console.log(JSON.stringify(r, null, 2)));
  }
}
