/*
 * Name Scrape : Catbox / Litterbox Uploader
 * Owner       : Kersio
 * Base Web    : https://catbox.moe
 * Type        : Uploader (API publik, tanpa akun)
 * Function    : Upload file lalu ambil link download. Catbox = permanen, Litterbox = sementara (1h/12h/24h/72h, maks 1GB)
 * Input       : Path file, lewat argumen CLI. Opsi: --time 1h|12h|24h|72h (pakai Litterbox)
 * Output      : JSON bersih (status, host, name, size, expires, link)
 * Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (pakai fetch dan FormData bawaan, tanpa modul tambahan)
 * Note        : Tanpa email atau login. Pemakaian: node catbox.js file.zip [--time 24h]. Kalau error, kemungkinan host sedang down atau ukuran file melebihi batas.
 */

const fs = require('fs');
const path = require('path');

const CATBOX_API = process.env.CATBOX_API || 'https://catbox.moe/user/api.php';
const LITTER_API =
  process.env.LITTER_API || 'https://litterbox.catbox.moe/resources/internals/api.php';
const TIMES = ['1h', '12h', '24h', '72h'];

async function catbox(filePath, options = {}) {
  const { time } = options;
  try {
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`File tidak ditemukan: ${filePath}`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('Path harus berupa file');
    if (stat.size === 0) throw new Error('Ukuran file 0 byte');
    if (time && !TIMES.includes(time)) {
      throw new Error(`--time harus salah satu dari: ${TIMES.join(', ')}`);
    }

    const name = path.basename(filePath);
    const blob =
      typeof fs.openAsBlob === 'function'
        ? await fs.openAsBlob(filePath)
        : new Blob([fs.readFileSync(filePath)]);

    const form = new FormData();
    form.append('reqtype', 'fileupload');
    if (time) form.append('time', time);
    form.append('fileToUpload', blob, name);

    const res = await fetch(time ? LITTER_API : CATBOX_API, {
      method: 'POST',
      body: form,
      headers: { 'User-Agent': 'Mozilla/5.0 (KersioScraper)' },
    });
    const text = (await res.text()).trim();

    if (!res.ok || !/^https?:\/\//i.test(text)) {
      throw new Error(`Upload gagal (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    return {
      status: true,
      host: time ? 'litterbox' : 'catbox',
      name,
      size: stat.size,
      expires: time || 'permanen',
      link: text,
    };
  } catch (e) {
    return { status: false, error: e.message };
  }
}

module.exports = catbox;

if (require.main === module) {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--time');
  const time = ti !== -1 ? args[ti + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && !(ti !== -1 && i === ti + 1));
  if (!file) {
    console.log(
      JSON.stringify({ status: false, error: 'Pakai: node catbox.js <path-file> [--time 1h|12h|24h|72h]' }, null, 2)
    );
    process.exit(1);
  }
  catbox(file, { time }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status ? 0 : 1);
  });
}
