/**
 * Name Scrape : MangaPlus Scraper
 * Owner       : Kersio
 * Base Web    : mangaplus.shueisha.co.jp
 * Type        : scraper
 * Function    : Ambil data MangaPlus via browser otomatis (Puppeteer):
 *               update terbaru, cari manga, detail manga, daftar chapter,
 *               gambar chapter, dan download chapter.
 * Input       : Kosong (updates), keyword (search), link/ID title, link/ID chapter
 * Output      : JSON + file gambar di folder mangaplus (kalau --download)
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ + puppeteer + puppeteer-extra + puppeteer-extra-plugin-stealth
 * Note        : MangaPlus pakai Cloudflare + API bisa return protobuf. Script ini
 *               pakai browser otomatis (headless) dengan fallback DOM scraping.
 *               (erorr fix sendiri ya)
 */

const fs = require('fs');
const path = require('path');

let puppeteer;
let StealthPlugin;
try {
  puppeteer = require('puppeteer-extra');
  StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
} catch {
  console.error('❌ Dependencies belum terinstall.');
  console.error('   Jalankan: npm i puppeteer puppeteer-extra puppeteer-extra-plugin-stealth');
  process.exit(1);
}

const SOURCE = 'https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G';
const BASE = 'https://mangaplus.shueisha.co.jp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// PARSE INPUT
// ============================================================
function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw || raw === 'updates') return { type: 'updates' };

  const t = raw.match(/titles\/(\d+)/);
  if (t) return { type: 'title', id: t[1] };

  const c = raw.match(/viewer\/(\d+)/);
  if (c) return { type: 'chapter', id: c[1] };

  if (/^\d+$/.test(raw)) {
    return raw.length >= 7 ? { type: 'chapter', id: raw } : { type: 'title', id: raw };
  }

  return { type: 'search', query: raw };
}

// ============================================================
// INIT BROWSER
// ============================================================
async function initBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
    ]
  });
}

// ============================================================
// SETUP PAGE + INTERCEPT API
// ============================================================
async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  page.apiData = {};

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('jumpg-webapi.tokyo-cdn.com')) return;
    try {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return; }
      if (url.includes('web_home') || url.includes('homeV')) page.apiData.home = json;
      else if (url.includes('title_detail')) page.apiData.titleDetail = json;
      else if (url.includes('manga_viewer')) page.apiData.mangaViewer = json;
      else if (url.includes('updates')) page.apiData.updates = json;
      else if (url.includes('title_list')) page.apiData.allTitles = json;
    } catch {}
  });

  return page;
}

// ============================================================
// DEEP SEARCH HELPERS
// ============================================================
function deepFind(obj, predicate, results = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return results;
  if (predicate(obj)) results.push(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) deepFind(item, predicate, results, depth + 1);
  } else {
    for (const k of Object.keys(obj)) deepFind(obj[k], predicate, results, depth + 1);
  }
  return results;
}

function deepGet(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[key] !== undefined) return obj[key];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepGet(item, key);
      if (r !== null) return r;
    }
  } else {
    for (const k of Object.keys(obj)) {
      const r = deepGet(obj[k], key);
      if (r !== null) return r;
    }
  }
  return null;
}

// ============================================================
// API CALL DARI DALAM BROWSER
// ============================================================
async function browserApiCall(page, url) {
  return await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, {
        headers: { 'SESSION-TOKEN': crypto.randomUUID() }
      });
      const text = await r.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }, url);
}

// ============================================================
// HELPER: SPLIT NAME & AUTHOR
// ============================================================
function splitNameAuthor(raw) {
  if (!raw) return { name: '(tanpa judul)', author: '' };

  // Cari titik pisah antara name dan author
  const authorMatch = raw.match(/([a-z])([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})$/);
  if (authorMatch) {
    const splitIdx = raw.length - authorMatch[2].length;
    return {
      name: raw.slice(0, splitIdx).trim(),
      author: authorMatch[2].trim()
    };
  }

  const parts = raw.match(/^(.+?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)$/);
  if (parts && parts[1].length > 2) {
    return { name: parts[1].trim(), author: parts[2].trim() };
  }

  return { name: raw, author: '' };
}

// ============================================================
// HELPER: EXTRACT THUMBNAIL
// ============================================================
function extractThumb(img) {
  if (!img) return null;
  let thumb = img.getAttribute('data-src')
           || img.getAttribute('data-original')
           || img.getAttribute('data-lazy-src')
           || img.src
           || null;
  if (thumb && thumb.startsWith('data:')) thumb = null;
  if (!thumb && img.srcset) {
    const first = img.srcset.split(',')[0].trim().split(/\s+/)[0];
    if (first && !first.startsWith('data:')) thumb = first;
  }
  return thumb;
}

// ============================================================
// 1. UPDATES
// ============================================================
async function getUpdates(browser) {
  const page = await setupPage(browser);
  await page.goto(`${BASE}/updates`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  // Scroll untuk trigger lazy load gambar
  await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise(r => setTimeout(r, 400));
    }
    window.scrollTo(0, 0);
  });
  await sleep(2000);

  const items = await page.$$eval('a[href*="/titles/"]', (links) => {
    const out = [];
    const seen = new Set();

    const extractThumb = (img) => {
      if (!img) return null;
      let thumb = img.getAttribute('data-src')
               || img.getAttribute('data-original')
               || img.getAttribute('data-lazy-src')
               || img.src
               || null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      if (!thumb && img.srcset) {
        const first = img.srcset.split(',')[0].trim().split(/\s+/)[0];
        if (first && !first.startsWith('data:')) thumb = first;
      }
      return thumb;
    };

    const splitNameAuthor = (raw) => {
      if (!raw) return { name: '(tanpa judul)', author: '' };
      const authorMatch = raw.match(/([a-z])([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})$/);
      if (authorMatch) {
        const splitIdx = raw.length - authorMatch[2].length;
        return { name: raw.slice(0, splitIdx).trim(), author: authorMatch[2].trim() };
      }
      const parts = raw.match(/^(.+?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)$/);
      if (parts && parts[1].length > 2) {
        return { name: parts[1].trim(), author: parts[2].trim() };
      }
      return { name: raw, author: '' };
    };

    links.forEach(a => {
      const m = (a.href || '').match(/titles\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      const img = a.querySelector('img');
      const thumb = extractThumb(img);

      const raw = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw) return;

      // Parse views
      const viewMatch = raw.match(/(\d+(?:\.\d+)?[KM]?)\s*$/);
      const views = viewMatch ? viewMatch[1] : null;
      const viewsStart = viewMatch ? raw.length - viewMatch[1].length : raw.length;

      // Parse chapter marker
      const chMatch = raw.match(/#(\d+)/);
      let name = '', author = '', chapterNum = null, chapterTitle = '';

      if (chMatch) {
        chapterNum = String(parseInt(chMatch[1], 10));
        const beforeHash = raw.slice(0, chMatch.index).trim();
        const afterHash = raw.slice(chMatch.index + chMatch[0].length, viewsStart).trim();

        const split = splitNameAuthor(beforeHash);
        name = split.name;
        author = split.author;

        chapterTitle = afterHash
          .replace(/^Chapter\s*\d+\s*[:\-]?\s*/i, '')
          .replace(/^CHAPTER\s*\d+\s*[:\-]?\s*/i, '')
          .replace(/^\d+\s*[:\-]?\s*/, '')
          .trim();
      } else {
        const withoutViews = raw.slice(0, viewsStart).trim();
        const split = splitNameAuthor(withoutViews);
        name = split.name;
        author = split.author;
      }

      out.push({
        id,
        name: name || '(tanpa judul)',
        author: author || '',
        chapterNum,
        chapterTitle: chapterTitle || '',
        views: views || null,
        thumbnail: thumb
      });
    });

    return out;
  });

  return items;
}

// ============================================================
// 2. SEARCH
// ============================================================
async function searchManga(browser, keyword) {
  const page = await setupPage(browser);
  const searchUrl = `${BASE}/search?keyword=${encodeURIComponent(keyword)}`;

  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise(r => setTimeout(r, 400));
    }
    window.scrollTo(0, 0);
  });
  await sleep(1500);

  const items = await page.$$eval('a[href*="/titles/"]', (links) => {
    const out = [];
    const seen = new Set();

    const extractThumb = (img) => {
      if (!img) return null;
      let thumb = img.getAttribute('data-src')
               || img.getAttribute('data-original')
               || img.src
               || null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      return thumb;
    };

    const splitNameAuthor = (raw) => {
      if (!raw) return { name: '(tanpa judul)', author: '' };
      const authorMatch = raw.match(/([a-z])([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})$/);
      if (authorMatch) {
        const splitIdx = raw.length - authorMatch[2].length;
        return { name: raw.slice(0, splitIdx).trim(), author: authorMatch[2].trim() };
      }
      const parts = raw.match(/^(.+?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)$/);
      if (parts && parts[1].length > 2) {
        return { name: parts[1].trim(), author: parts[2].trim() };
      }
      return { name: raw, author: '' };
    };

    links.forEach(a => {
      const m = (a.href || '').match(/titles\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      const img = a.querySelector('img');
      const thumb = extractThumb(img);

      const raw = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length < 2) return;

      const split = splitNameAuthor(raw);
      out.push({
        id,
        name: split.name || '(tanpa judul)',
        author: split.author || '',
        thumbnail: thumb
      });
    });

    return out;
  });

  return items;
}

// ============================================================
// 3. TITLE DETAIL
// ============================================================
async function getTitleDetail(browser, titleId) {
  const page = await setupPage(browser);
  await page.goto(`${BASE}/titles/${titleId}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  let data = page.apiData.titleDetail;

  if (!data) {
    data = await browserApiCall(page,
      `https://jumpg-webapi.tokyo-cdn.com/api/title_detailV3?title_id=${titleId}&format=json`);
  }

  if (data) {
    const view = deepGet(data, 'titleDetailView') || data;
    const title = view.title || {};

    const chapters = [];
    const seen = new Set();
    ['firstChapterList', 'lastChapterList'].forEach(k => {
      for (const ch of (view[k] || [])) {
        if (seen.has(ch.chapterId)) continue;
        seen.add(ch.chapterId);
        chapters.push({
          id: ch.chapterId,
          number: ch.chapterNumber || null,
          title: ch.subTitle || '',
          startAt: ch.startAt || null,
          endAt: ch.endAt || null,
          isFree: !!ch.isFree
        });
      }
    });

    if (title.name) {
      chapters.sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
      return {
        id: titleId,
        name: title.name || '(tanpa judul)',
        author: title.author || '',
        artist: title.artist || '',
        overview: (title.overview || '').replace(/<[^>]+>/g, '').slice(0, 1000),
        thumbnail: view.titleImageUrl || title.portraitImageUrl || null,
        chapterCount: chapters.length,
        chapters
      };
    }
  }

  // Fallback DOM
  const domData = await page.evaluate(() => {
    const title = document.querySelector('h1')?.textContent?.trim() || '(tanpa judul)';
    const chapters = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/viewer/"]').forEach(a => {
      const m = (a.href || '').match(/viewer\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const numMatch = text.match(/chapter\s*(\d+)/i) || text.match(/(\d+)/);
      chapters.push({
        id,
        number: numMatch ? numMatch[1] : null,
        title: text.slice(0, 100)
      });
    });
    return { title, chapters };
  });

  return {
    id: titleId,
    name: domData.title,
    author: '',
    artist: '',
    overview: '',
    thumbnail: null,
    chapterCount: domData.chapters.length,
    chapters: domData.chapters
  };
}

// ============================================================
// 4. CHAPTER VIEWER
// ============================================================
async function getChapterViewer(browser, chapterId) {
  const page = await setupPage(browser);
  await page.goto(`${BASE}/viewer/${chapterId}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);

  let data = page.apiData.mangaViewer;

  if (!data) {
    data = await browserApiCall(page,
      `https://jumpg-webapi.tokyo-cdn.com/api/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high&format=json`);
  }

  if (!data) throw new Error('Data chapter tidak ditemukan (API + DOM fallback gagal).');

  const view = deepGet(data, 'mangaViewer') || data;
  const pages = [];
  for (const p of (view.pages || [])) {
    const mp = p.mangaPage;
    if (!mp || !mp.imageUrl) continue;
    pages.push({
      page: pages.length + 1,
      url: mp.imageUrl,
      width: mp.width,
      height: mp.height,
      key: mp.encryptionKey || null
    });
  }

  return {
    chapterId,
    titleId: view.titleId || null,
    chapterNumber: view.chapterNumber || null,
    pages
  };
}

// ============================================================
// XOR DECRYPT
// ============================================================
function xorDecrypt(buffer, keyHex) {
  if (!keyHex) return buffer;
  const key = [];
  for (let i = 0; i < keyHex.length; i += 2) key.push(parseInt(keyHex.substr(i, 2), 16));
  if (!key.length) return buffer;
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] ^ key[i % key.length];
  return out;
}

// ============================================================
// DOWNLOAD IMAGE
// ============================================================
async function downloadImage(browser, url, filepath, key) {
  const page = await browser.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    if (!res || !res.ok()) return null;
    const raw = Buffer.from(await res.buffer());
    const decrypted = xorDecrypt(raw, key);
    if (decrypted.length < 500) return null;
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, decrypted);
    return decrypted.length;
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// CAPTION
// ============================================================
function buildCaption(out) {
  const L = [];
  const line = '─'.repeat(28);

  L.push('📖 *MANGA PLUS*');
  L.push('');

  if (out.mode === 'updates') {
    L.push('🆕 *UPDATE TERBARU*');
    L.push(line);
    L.push(`📦 Total : ${out.updates.length} judul`);
    L.push('');
    out.updates.slice(0, 15).forEach((u, i) => {
      L.push(`[${i + 1}] ${u.name}`);
      if (u.author) L.push(`    👤 ${u.author}`);
      if (u.chapterNum) {
        let chLine = `    📖 Ch.${u.chapterNum}`;
        if (u.chapterTitle) chLine += ` — ${u.chapterTitle.slice(0, 60)}`;
        L.push(chLine);
      }
      if (u.views) L.push(`    👁️  ${u.views}`);
      L.push(`    🆔 ${u.id}`);
      L.push('');
    });

  } else if (out.mode === 'search') {
    L.push('🔍 *HASIL PENCARIAN*');
    L.push(line);
    L.push(`🔎 Keyword : ${out.query}`);
    L.push(`📦 Ditemukan: ${out.count} judul`);
    L.push('');
    out.results.slice(0, 15).forEach((r, i) => {
      L.push(`[${i + 1}] ${r.name}`);
      if (r.author) L.push(`    👤 ${r.author}`);
      L.push(`    🆔 ${r.id}`);
      L.push('');
    });
    if (out.results.length > 15) {
      L.push(`... (+${out.results.length - 15} lagi)`);
      L.push('');
    }

  } else if (out.mode === 'title') {
    const t = out.title;
    L.push(`📌 ${t.name}`);
    L.push('');
    L.push('📋 *INFORMASI*');
    L.push(line);
    if (t.author) L.push(`👤 Author    : ${t.author}`);
    L.push(`📖 Chapter   : ${t.chapterCount} tersedia`);
    L.push(`🆔 ID        : ${t.id}`);
    L.push('');
    if (t.overview) {
      L.push('📝 *OVERVIEW*');
      L.push(line);
      L.push(`   ${t.overview.slice(0, 250)}...`);
      L.push('');
    }
    if (t.chapters.length) {
      L.push(`📖 *CHAPTER (${t.chapters.length})*`);
      L.push(line);
      t.chapters.slice(0, 10).forEach((c, i) => {
        L.push(`   [${i + 1}] Ch.${c.number || '?'}${c.title ? ` — ${c.title.slice(0, 40)}` : ''}`);
      });
      if (t.chapters.length > 10) L.push(`   ... (+${t.chapters.length - 10} lagi)`);
      L.push('');
    }

  } else if (out.mode === 'chapter') {
    const c = out.chapter;
    L.push(`📖 *CHAPTER ${c.chapterNumber || ''}*`);
    L.push('');
    L.push('📋 *INFORMASI*');
    L.push(line);
    L.push(`🔢 Chapter : ${c.chapterNumber || '?'}`);
    L.push(`📄 Halaman : ${c.pages.length}`);
    L.push(`🆔 ID      : ${c.chapterId}`);
    L.push('');
    if (out.files?.length) {
      L.push('💾 *FILE TERSIMPAN*');
      L.push(line);
      L.push(`   📁 ${out.outDir}`);
      L.push(`   📊 ${out.files.length} halaman`);
      L.push('');
    }
  }

  L.push(`🌐 Sumber : ${SOURCE}`);
  return L.join('\n');
}

// ============================================================
// MAIN
// ============================================================
async function mangaplus(input, options = {}) {
  let browser;
  try {
    const parsed = parseInput(input);
    const outDir = options.outDir || path.join(process.cwd(), 'mangaplus');
    const wantDownload = !!options.download;

    browser = await initBrowser();

    // ----- UPDATES -----
    if (parsed.type === 'updates') {
      const updates = await getUpdates(browser);
      const out = { success: true, mode: 'updates', count: updates.length, updates, source: SOURCE };
      out.caption = buildCaption(out);
      return out;
    }

    // ----- SEARCH -----
    if (parsed.type === 'search') {
      const results = await searchManga(browser, parsed.query);
      const out = {
        success: true,
        mode: 'search',
        query: parsed.query,
        count: results.length,
        results,
        source: SOURCE
      };
      out.caption = buildCaption(out);
      return out;
    }

    // ----- TITLE DETAIL -----
    if (parsed.type === 'title') {
      const title = await getTitleDetail(browser, parsed.id);
      const out = { success: true, mode: 'title', title, source: SOURCE };
      out.caption = buildCaption(out);
      return out;
    }

    // ----- CHAPTER -----
    if (parsed.type === 'chapter') {
      const chapter = await getChapterViewer(browser, parsed.id);
      const out = { success: true, mode: 'chapter', chapter, source: SOURCE };

      if (wantDownload && chapter.pages.length) {
        const folder = path.join(outDir, `chapter_${parsed.id}`);
        out.files = [];
        out.outDir = folder;

        for (const p of chapter.pages) {
          const filename = `page_${String(p.page).padStart(3, '0')}.jpg`;
          const filepath = path.join(folder, filename);
          const size = await downloadImage(browser, p.url, filepath, p.key);
          if (size) out.files.push({ path: filepath, size });
          await sleep(300);
        }
      }

      out.caption = buildCaption(out);
      return out;
    }

    return { success: false, error: 'INVALID_INPUT', message: 'Tipe input tidak dikenali.', source: SOURCE };
  } catch (err) {
    if (err.name === 'TimeoutError') return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama.', source: SOURCE };
    return { success: false, error: 'EXCEPTION', message: err.message || String(err), source: SOURCE };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { mangaplus };

// ============================================================
// CLI
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter(a => !a.startsWith('--'));
  const outArg = args.find(a => a.startsWith('--out='));

  const input = pos[0] || 'updates';

  mangaplus(input, {
    download: args.includes('--download'),
    outDir: outArg ? outArg.split('=').slice(1).join('=') : undefined
  }).then(r => {
    console.log(JSON.stringify(r, null, 2));
    console.log('');
    console.log(`Sumber: ${SOURCE}`);
    if (!r.success) process.exitCode = 1;
  });
}

// ============================================================
// Cara Pakai:
// Update terbaru      : node mangaplus.js
// Cari manga          : node mangaplus.js "One Piece"
// Detail manga        : node mangaplus.js https://mangaplus.shueisha.co.jp/titles/100020
// Lihat chapter       : node mangaplus.js https://mangaplus.shueisha.co.jp/viewer/1006611
// Download chapter    : node mangaplus.js https://mangaplus.shueisha.co.jp/viewer/1006611 --download
// ============================================================
