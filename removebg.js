/*
Name Scrape : remove background
Owner       : Kersio
Base Web    : https://www.pixelcut.ai/background-remover
Type        : Scraper (REST API, multipart upload)
Function    : pixelcutbg(input, options)
Input       : path file gambar / URL gambar / Buffer
Output      : JSON { status, creator, result: { file, size, mime, format } }
Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
Require     : Node.js 18+ (fetch/FormData/Blob bawaan, tanpa package)
Note        : Tanpa login, captcha, dan cloudflare. Tanpa puppeteer.
              Hasil disimpan sebagai PNG transparan.
              Kalau x-client-version kedaluwarsa, ambil yang baru dari DevTools
              lalu kirim lewat options.clientVersion.
*/

const fs = require('fs')
const path = require('path')

const API = 'https://api2.pixelcut.app/image/matte/v1'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic'
}

async function pixelcutbg(input, options = {}) {
  const {
    format = 'png',
    model = 'v1',
    output,
    clientVersion = 'web:pixelcut.ai:7f330d51'
  } = options

  try {
    if (!input) throw new Error('Input kosong: isi path file, URL, atau Buffer')

    // 1. siapkan gambar
    let buffer, filename, mime
    if (Buffer.isBuffer(input)) {
      buffer = input
      filename = 'image.jpg'
      mime = 'image/jpeg'
    } else if (/^https?:\/\//i.test(String(input))) {
      const r = await fetch(input, { headers: { 'user-agent': UA } })
      if (!r.ok) throw new Error(`Gagal download gambar (HTTP ${r.status})`)
      buffer = Buffer.from(await r.arrayBuffer())
      mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]
      filename = 'image.' + (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
    } else {
      if (!fs.existsSync(input)) throw new Error(`File tidak ditemukan: ${input}`)
      buffer = fs.readFileSync(input)
      const ext = path.extname(input).toLowerCase()
      mime = MIME[ext] || 'image/jpeg'
      filename = path.basename(input)
    }

    if (buffer.length > 50 * 1024 * 1024) throw new Error('Ukuran gambar maksimal 50MB')

    // 2. kirim ke API (multipart, boundary diatur otomatis oleh fetch)
    const form = new FormData()
    form.append('image', new Blob([buffer], { type: mime }), filename)
    form.append('format', format)
    form.append('model', model)

    const res = await fetch(API, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        origin: 'https://www.pixelcut.ai',
        referer: 'https://www.pixelcut.ai/',
        'user-agent': UA,
        'x-client-version': clientVersion,
        'x-locale': 'en'
      },
      body: form
    })

    const ct = (res.headers.get('content-type') || '').toLowerCase()

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`HTTP ${res.status}: ${body}`)
    }

    // 3. ambil hasil: gambar langsung, atau JSON berisi URL / base64
    let out
    let outMime = 'image/png'

    if (ct.startsWith('image/') || ct.includes('octet-stream')) {
      out = Buffer.from(await res.arrayBuffer())
      if (ct.startsWith('image/')) outMime = ct.split(';')[0]
    } else {
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { throw new Error('Response tidak dikenali: ' + text.slice(0, 200)) }

      const url = findString(json, v => /^https?:\/\//i.test(v))
      const b64 = findString(json, v => v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v))
      if (url) {
        const r2 = await fetch(url, { headers: { 'user-agent': UA } })
        if (!r2.ok) throw new Error(`Gagal download hasil (HTTP ${r2.status})`)
        out = Buffer.from(await r2.arrayBuffer())
        outMime = (r2.headers.get('content-type') || outMime).split(';')[0]
      } else if (b64) {
        out = Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64')
      } else {
        throw new Error('Tidak ada gambar di response: ' + text.slice(0, 200))
      }
    }

    // 4. simpan
    const file = output || `pixelcut-${Date.now()}.${format}`
    fs.writeFileSync(file, out)

    return {
      status: true,
      creator: 'Kersio',
      result: {
        file: path.resolve(file),
        size: out.length,
        mime: outMime,
        format
      }
    }
  } catch (e) {
    return { status: false, creator: 'Kersio', message: e.message }
  }
}

// cari string pertama di JSON yang cocok dengan kondisi
function findString(obj, test) {
  if (typeof obj === 'string') return test(obj) ? obj : null
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = findString(obj[k], test)
      if (r) return r
    }
  }
  return null
}

module.exports = pixelcutbg

if (require.main === module) {
  const args = process.argv.slice(2)
  const getOpt = name => {
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : undefined
  }
  const input = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))

  if (!input) {
    console.log('Pemakaian: node pixelcutbg.js <path|url> [--out hasil.png] [--format png]')
    process.exit(1)
  }

  pixelcutbg(input, { output: getOpt('--out'), format: getOpt('--format') || 'png' })
    .then(r => console.log(JSON.stringify(r, null, 2)))
}
