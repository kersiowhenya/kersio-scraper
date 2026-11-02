/*
 * Name Scrape : All In One Video Downloader
 * Owner       : Kersio
 * Base Web    : https://allinonevideosdownloader.com
 * Type        : Downloader (scraper, WordPress REST API)
 * Function    : Ambil link download video/audio dari banyak platform (TikTok, Instagram, Facebook, YouTube, X, Pinterest, dll)
 * Input       : URL video, lewat argumen CLI
 * Output      : JSON bersih (title, thumbnail, source, medias[]) Field null/false otomatis dibuang
 * Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (pakai fetch bawaan, tanpa modul tambahan)
 * Note        : Token diambil otomatis dari halaman utama setiap request. Link hasil (fbcdn dll) ada masa berlaku, pakai segera. Kalau error "token not found" atau "Unknown error",kemungkinan web mengubah validasi atau video tidak bisa diambil.
 */

const BASE = "https://allinonevideosdownloader.com";
const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

async function getToken() {
  const res = await fetch(`${BASE}/`, {
    headers: { "user-agent": UA, accept: "text/html", cookie: "pll_language=en" },
  });
  if (!res.ok) throw new Error(`gagal buka halaman utama (HTTP ${res.status})`);

  const html = await res.text();
  const tag = html.match(/<input[^>]*name=["']token["'][^>]*>/i);
  if (!tag) throw new Error("token not found");

  const val = tag[0].match(/value=["']([^"']*)["']/i);
  if (!val) throw new Error("token not found");
  return val[1];
}

// Rapikan satu media: buang flag teknis, ubah flag video/audio jadi "type"
function cleanMedia(m) {
  const out = {};
  if (m.quality) out.quality = m.quality;
  if (m.extension) out.extension = m.extension;

  if (m.videoAvailable && m.audioAvailable) out.type = "video";
  else if (m.videoAvailable) out.type = "video-only";
  else if (m.audioAvailable) out.type = "audio";

  if (m.formattedSize) out.size = m.formattedSize;
  else if (m.size) out.size = m.size;

  out.url = m.url;
  return out;
}

function cleanResult(data) {
  const out = { status: true };
  for (const k of ["url", "title", "thumbnail", "duration", "source"]) {
    const v = data[k];
    if (v !== null && v !== undefined && v !== false && v !== "") out[k] = v;
  }
  out.medias = data.medias.map(cleanMedia);
  return out;
}

async function aiodl(url) {
  if (!url) throw new Error("URL video wajib diisi");
  if (!/^https?:\/\//i.test(url)) throw new Error("URL harus diawali http:// atau https://");

  const token = await getToken();

  const form = new URLSearchParams();
  form.append("url", url);
  form.append("token", token);
  form.append("hash", b64(url) + (url.length + 1000) + b64("aio-dl"));

  const res = await fetch(`${BASE}/wp-json/aio-dl/video-data/`, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      referer: `${BASE}/`,
      cookie: "pll_language=en",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
    body: form.toString(),
  });

  let data, raw;
  try {
    raw = await res.text();
    data = JSON.parse(raw);
  } catch {
    throw new Error(`respon bukan JSON (HTTP ${res.status}): ${String(raw).slice(0, 200)}`);
  }

  if (!data || !Array.isArray(data.medias) || !data.medias.length) {
    throw new Error(data?.message || data?.error || "gagal ambil data, link tidak didukung atau video privat");
  }
  return cleanResult(data);
}

if (require.main === module) {
  (async () => {
    const url = process.argv[2];
    if (!url) {
      console.log('Pakai: node aiodl.js "<url video>"');
      process.exit(1);
    }
    try {
      const result = await aiodl(url);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(JSON.stringify({ status: false, error: e.message }, null, 2));
      process.exit(1);
    }
  })();
}

module.exports = { aiodl, cleanResult };
