/**
 * Name Scrape : UniScribe Info Publik (Statistik, Paket Harga, FAQ, Format)
 * Owner       : Kersio
 * Base Web    : www.uniscribe.co
 * Type        : Scraper
 * Function    : Mengambil info publik dari halaman utama UniScribe: statistik pengguna, daftar paket + harga + fitur, format file yang didukung, bahasa, dan FAQ
 * Input       : - (tidak perlu input)
 * Output      : JSON
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan, tanpa puppeteer)
 * Note        : Hanya halaman publik (tanpa login). Jangan spam request. Struktur halaman bisa berubah kapan saja.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.uniscribe.co';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CACHE_FILE = path.join(process.cwd(), '.uniscribe_cache.json');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit

// ---------- Helper: teks ----------
const decode = (s) =>
  String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const toInt = (s) => {
  const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
};

// HTML -> daftar baris teks. Item list (<li>) diberi awalan "• "
function htmlToLines(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/?(?:p|div|section|h[1-6]|ul|ol|li|br|tr|td|th|table|details|summary|header|footer|main|nav|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  const raw = decode(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Gabungkan "•" yang terpisah dari teksnya
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '•' && raw[i + 1] !== undefined) {
      lines.push('• ' + raw[i + 1]);
      i++;
    } else {
      lines.push(raw[i]);
    }
  }
  return lines;
}

// Ambil baris di antara dua penanda
function section(lines, start, end) {
  const s = lines.findIndex((l) => start.test(l));
  if (s === -1) return [];
  let e = lines.findIndex((l, i) => i > s && end.test(l));
  if (e === -1) e = lines.length;
  return lines.slice(s + 1, e);
}

// ---------- Parser per bagian ----------
const PLAN_NAMES = ['Free', 'Basic', 'Standard', 'Pro'];
const SKIP_LINE = /^(\/\s*month|most popular|subscribe now|get started|no credit card required|save \d+%)$/i;

function parsePlans(lines) {
  const plans = [];
  let cur = null;

  for (const line of lines) {
    if (PLAN_NAMES.includes(line)) {
      cur = { name: line, description: null, price_lines_raw: [], features: [] };
      plans.push(cur);
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('• ')) cur.features.push(line.slice(2).trim());
    else if (/\$\s?\d/.test(line)) cur.price_lines_raw.push(line);
    else if (!cur.description && !SKIP_LINE.test(line)) cur.description = line;
  }

  return plans.map((p) => {
    const all = p.price_lines_raw.join(' ');
    const amounts = [...all.matchAll(/\$\s?([\d,.]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    const yearly = all.match(/\$\s?([\d,.]+)\s*\/\s*year/i);
    const minutes = p.features.find((f) => /minutes of transcription per month/i.test(f));

    return {
      name: p.name,
      description: p.description,
      // Harga per bulan jika bayar tahunan, dan jika bayar bulanan (sesuai tampilan situs saat ini)
      monthly_price_usd_if_billed_yearly: amounts.length ? amounts[0] : null,
      monthly_price_usd_if_billed_monthly: amounts.length > 2 ? amounts[1] : null,
      yearly_total_usd: yearly ? Number(yearly[1].replace(/,/g, '')) : null,
      minutes_per_month: minutes ? toInt(minutes.match(/([\d,]+)/)[1]) : null,
      features: p.features,
      price_lines_raw: p.price_lines_raw
    };
  });
}

function parseFaq(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/\?$/.test(l) && !l.startsWith('• ')) {
      cur = { question: l, answer: [] };
      out.push(cur);
    } else if (cur) {
      cur.answer.push(l.replace(/^•\s*/, '- '));
    }
  }
  return out.map((f) => ({ question: f.question, answer: f.answer.join(' ') }));
}

function parseHome(html) {
  const lines = htmlToLines(html);
  const fullText = lines.join('\n');
  const warnings = [];

  const grab = (re) => {
    const m = fullText.match(re);
    return m ? toInt(m[1]) : null;
  };

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const description =
    (html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) ||
      html.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"/i) ||
      [])[1];

  const stats = {
    users: grab(/Trusted by\s+([\d,]{3,})\s+users/i) ?? grab(/([\d,]{3,})\s+users/i),
    minutes_transcribed: grab(/([\d,]{3,})\s+minutes transcribed/i),
    files_transcribed: grab(/([\d,]{3,})\s+files transcribed/i)
  };

  const plans = parsePlans(section(lines, /^Affordable Pricing$/i, /^More Audio\s*&\s*Video/i));
  const faq = parseFaq(section(lines, /^Frequently Asked Questions$/i, /^Best Practices/i));

  const fm = fullText.match(/We support\s+([a-z0-9,\s]+?)\.\s+You can also/i);
  const supportedFormats = fm ? fm[1].split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean) : [];

  const languagesShown = [
    ...new Set([...html.matchAll(/\/languages\/transcribe-([a-z-]+?)-audio/gi)].map((m) => m[1]))
  ].map((s) => s.charAt(0).toUpperCase() + s.slice(1));

  if (!plans.length) warnings.push('Paket harga tidak terbaca (struktur halaman mungkin berubah)');
  if (!faq.length) warnings.push('FAQ tidak terbaca (struktur halaman mungkin berubah)');
  if (stats.users == null) warnings.push('Statistik pengguna tidak terbaca');

  return {
    site: {
      title: title ? decode(title).trim() : null,
      description: description ? decode(description).trim() : null
    },
    stats,
    plans,
    supported_formats: supportedFormats,
    languages_shown: languagesShown,
    faq,
    links: {
      api_docs: /href="[^"]*\/docs"/i.test(html) ? `${BASE}/docs` : null
    },
    warnings
  };
}

/**
 * UniScribe info publik - Single function
 * @param {object} [options]
 * @param {boolean} [options.fresh=false] - Abaikan cache, ambil data baru
 * @returns {Promise<object>} JSON hasil
 */
async function uniscribe(options = {}) {
  try {
    let html = null;
    let cached = false;
    let fetchedAt = Date.now();

    if (!options.fresh && fs.existsSync(CACHE_FILE)) {
      try {
        const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (Date.now() - c.at < CACHE_TTL_MS && c.html) {
          html = c.html;
          fetchedAt = c.at;
          cached = true;
        }
      } catch {
        // cache rusak, abaikan
      }
    }

    if (!html) {
      const res = await fetch(`${BASE}/`, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      });

      if (res.status === 429 || res.status === 403) {
        return {
          success: false,
          error: res.status === 429 ? 'RATE_LIMITED' : 'BLOCKED',
          status: res.status,
          message: 'Situs membatasi atau memblokir akses. Tunggu beberapa saat lalu coba lagi.'
        };
      }
      if (!res.ok) {
        return { success: false, error: 'HTTP_ERROR', status: res.status, message: `Situs membalas HTTP ${res.status}` };
      }

      html = await res.text();
      fetchedAt = Date.now();
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: fetchedAt, html }));
      } catch {
        // gagal simpan cache, tidak masalah
      }
    }

    const data = parseHome(html);

    if (!data.plans.length && !data.faq.length && data.stats.users == null) {
      return {
        success: false,
        error: 'NO_DATA',
        message: 'Data tidak ditemukan. Struktur halaman situs kemungkinan sudah berubah.'
      };
    }

    return {
      success: true,
      source: `${BASE}/`,
      fetched_at: new Date(fetchedAt).toISOString(),
      cached,
      ...data
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama, coba lagi nanti' };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err) };
  }
}

module.exports = { uniscribe, parseHome };

// Jalankan biasa      : node uniscribe.js
// Ambil data baru     : node uniscribe.js --fresh
// Simpan ke file JSON : node uniscribe.js --save   (hasil: uniscribe.json)
if (require.main === module) {
  const args = process.argv.slice(2);
  uniscribe({ fresh: args.includes('--fresh') }).then((r) => {
    const json = JSON.stringify(r, null, 2);
    if (args.includes('--save') && r.success) fs.writeFileSync('uniscribe.json', json);
    console.log(json);
  });
}
