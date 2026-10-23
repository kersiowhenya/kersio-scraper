/**
 * Name Scrape : Shortlink
 * Base Web    : www.urlvanish.com
 * Type        : Scraper
 * Function    : Memendekkan URL dengan output JSON.
 * Input       : URL panjang (dari command line)
 * Output      : JSON (hanya JSON, tanpa teks tambahan)
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+
 * Note        : (erorr fix sendiri ya)
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function shortenUrl(longUrl) {
  const startTime = Date.now();
  
  try {
    const endpoint = https://urlvanish.com/api/shorten?url=${encodeURIComponent(longUrl)};
    
    const res = await fetch(endpoint, {
      headers: { 
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      }
    });

    const latencyMs = Date.now() - startTime;
    const data = await res.json();

    if (!res.ok) {
      return {
        success: false,
        status: {
          httpCode: res.status,
          message: data.error || 'Gagal memendekkan URL'
        },
        meta: {
          service: 'URLVanish',
          processedAt: new Date().toISOString(),
          latencyMs: latencyMs
        }
      };
    }

    // Menggabungkan data asli dari API dengan metadata tambahan
    return {
      success: true,
      data: {
        originalUrl: data.originalUrl || longUrl,
        shortUrl: data.shorturl,
        alias: data.alias,
        domain: 'urlvanish.com',
        protocol: 'https',
        isCustomAlias: false
      },
      meta: {
        service: 'URLVanish',
        apiVersion: 'v1',
        httpCode: res.status,
        processedAt: new Date().toISOString(),
        latencyMs: latencyMs,
        client: 'Node.js',
        userAgent: USER_AGENT
      }
    };

  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      status: {
        httpCode: 500,
        message: err.message
      },
      meta: {
        service: 'URLVanish',
        processedAt: new Date().toISOString(),
        latencyMs: latencyMs
      }
    };
  }
}

// --- CLI Handler ---
if (require.main === module) {
  const urlToShorten = process.argv[2];

  if (!urlToShorten) {
    // Jika tidak ada URL yang dimasukkan, tampilkan JSON error
    const errorJson = {
      success: false,
      error: 'MISSING_ARGUMENT',
      message: 'Cara pakai: node shortlinkurl.js <URL_PANJANG>',
      example: 'node shortlinkurl.js "https://www.detik.com/jatim/sepakbola/d-7523166"'
    };
    console.log(JSON.stringify(errorJson, null, 2));
    process.exit(1);
  }

  // Panggil fungsi dan langsung print JSON-nya tanpa embel-embel
  shortenUrl(urlToShorten).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  });
}
