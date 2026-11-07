/*
 Name Scrape : Pixelcut Image Upscaler
 Owner       : Kersio
 Base Web    : https://www.pixelcut.ai/image-upscaler
 Type        : Scraper (HTTP + gRPC-web)
 Function    : Upscale gambar 2x / 4x (Fast Upscale, tanpa login)
 Input       : path file / URL gambar, scale (2 atau 4), --save (opsional)
 Output      : JSON { status, scale, upload_id, output }
 Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 Require     : Node.js 18+ (tanpa dependency, tanpa puppeteer)
 Note        : Pakai: node pixelcut.js foto.jpg 2  |  node pixelcut.js foto.jpg 4 --save
               Kalau error 4xx, kemungkinan X_CLIENT_VERSION sudah kedaluwarsa (ambil terbaru dari DevTools)
*/

const fs = require('fs');
const path = require('path');

const API = 'https://api2.pixelcut.app';
const X_CLIENT_VERSION = 'web:pixelcut.ai:50092aaa';
const MODEL = 'pixelcut-upscale';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'accept': '*/*',
  'origin': 'https://www.pixelcut.ai',
  'referer': 'https://www.pixelcut.ai/',
  'user-agent': UA,
  'x-client-version': X_CLIENT_VERSION,
  'x-locale': 'en'
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic' };

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
  throw new Error('varint terpotong');
}

// cari semua string http(s) di dalam pesan protobuf (rekursif)
function collectUrls(buf, found = [], depth = 0) {
  let pos = 0;
  try {
    while (pos < buf.length) {
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const wt = tag & 7;
      if (wt === 0) {
        [, pos] = readVarint(buf, pos);
      } else if (wt === 1) {
        pos += 8;
      } else if (wt === 5) {
        pos += 4;
      } else if (wt === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        const chunk = buf.subarray(pos, pos + len);
        if (chunk.length !== len) return found;
        pos += len;
        const s = chunk.toString('utf8');
        if (/^https?:\/\//.test(s)) found.push(s);
        else if (depth < 4) collectUrls(chunk, found, depth + 1);
      } else {
        return found;
      }
    }
  } catch (e) { /* abaikan, kembalikan yang sudah ketemu */ }
  return found;
}

function parseFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf[i];
    const len = buf.readUInt32BE(i + 1);
    frames.push({ trailer: (flag & 0x80) !== 0, data: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return frames;
}

function buildUpscaleBody(uploadId, scale) {
  const id = Buffer.from(uploadId, 'utf8');
  const model = Buffer.from(MODEL, 'utf8');
  const msg = Buffer.concat([
    Buffer.from([0x0a, id.length]), id,
    Buffer.from([0x18, scale]),
    Buffer.from([0x22, model.length]), model
  ]);
  const head = Buffer.alloc(5);
  head.writeUInt8(0, 0);
  head.writeUInt32BE(msg.length, 1);
  return Buffer.concat([head, msg]);
}

async function loadImage(input) {
  if (Buffer.isBuffer(input)) return { buf: input, mime: 'image/png' };
  if (/^https?:\/\//i.test(input)) {
    const r = await fetch(input, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`Gagal ambil gambar dari URL (HTTP ${r.status})`);
    const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
    return { buf: Buffer.from(await r.arrayBuffer()), mime };
  }
  const ext = path.extname(input).toLowerCase();
  return { buf: fs.readFileSync(input), mime: MIME[ext] || 'image/png' };
}

async function pixelcut(input, scale = 2, savePath = null) {
  try {
    scale = Number(scale);
    if (![2, 4].includes(scale)) throw new Error('scale harus 2 atau 4');

    const { buf, mime } = await loadImage(input);
    if (buf.length > 50 * 1024 * 1024) throw new Error('Ukuran gambar maksimal 50MB');

    // 1) upload
    const form = new FormData();
    form.append('image', new Blob([buf], { type: mime }), 'blob');
    const up = await fetch(`${API}/image/upload/v1`, { method: 'POST', headers: BASE_HEADERS, body: form });
    const upText = await up.text();
    if (!up.ok) throw new Error(`Upload gagal (HTTP ${up.status}): ${upText.slice(0, 200)}`);
    const uploadId = JSON.parse(upText).upload_id;
    if (!uploadId) throw new Error('upload_id tidak ditemukan: ' + upText.slice(0, 200));

    // 2) upscale (gRPC-web)
    const res = await fetch(`${API}/image_service.v1.ImageService/Upscale`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'content-type': 'application/grpc-web+proto',
        'grpc-timeout': '300000m',
        'x-grpc-web': '1',
        'x-user-agent': 'connect-es/2.3.0'
      },
      body: buildUpscaleBody(uploadId, scale)
    });
    const raw = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`Upscale gagal (HTTP ${res.status}): ${raw.toString('utf8').slice(0, 200)}`);

    const headerStatus = res.headers.get('grpc-status');
    if (headerStatus && headerStatus !== '0') {
      throw new Error(`gRPC ${headerStatus}: ${res.headers.get('grpc-message') || ''}`);
    }

    const frames = parseFrames(raw);
    for (const f of frames.filter(x => x.trailer)) {
      const t = f.data.toString('utf8');
      const m = t.match(/grpc-status:\s*(\d+)/i);
      if (m && m[1] !== '0') {
        const msg = (t.match(/grpc-message:\s*([^\r\n]*)/i) || [])[1] || '';
        throw new Error(`gRPC ${m[1]}: ${decodeURIComponent(msg)}`);
      }
    }

    const urls = [];
    for (const f of frames.filter(x => !x.trailer)) collectUrls(f.data, urls);
    if (!urls.length) {
      return { status: false, message: 'URL hasil tidak ditemukan di response', upload_id: uploadId, raw_hex: raw.toString('hex') };
    }
    const output = urls[0];

    if (savePath) {
      const dl = await fetch(output, { headers: { 'user-agent': UA } });
      if (!dl.ok) throw new Error(`Gagal unduh hasil (HTTP ${dl.status})`);
      fs.writeFileSync(savePath, Buffer.from(await dl.arrayBuffer()));
    }

    return { status: true, scale, upload_id: uploadId, output, saved: savePath || undefined };
  } catch (e) {
    return { status: false, message: e.message };
  }
}

module.exports = pixelcut;

if (require.main === module) {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const rest = args.filter(a => a !== '--save');
  const [file, scale] = rest;
  if (!file) {
    console.log(JSON.stringify({ status: false, message: 'Pakai: node pixelcut.js <file|url> [2|4] [--save]' }, null, 2));
    process.exit(1);
  }
  const savePath = save ? `upscaled_${Date.now()}.png` : null;
  pixelcut(file, scale || 2, savePath).then(r => console.log(JSON.stringify(r, null, 2)));
}
