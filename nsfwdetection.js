/**
 * Scraper : JigsawStack NSFW Detection (v2)
 * Source  : https://jigsawstack.com/nsfw-detection
 * Input   : imageUrl (string), apiKey (string), opts (object, opsional)
 * Output  : JSON { status, level, reasons, nsfw, nudity, gore, nsfw_score, nudity_score, gore_score }
 * Saluran : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Owner   : Kersio
 */

// Ambang batas awal (tebakan, sesuaikan setelah dites dengan gambarmu sendiri)
const DEFAULTS = {
  unsafe: { nsfw: 0.9, nudity: 0.5, gore: 0.5 },
  borderline: { nsfw: 0.7, nudity: 0.2, gore: 0.2 },
  timeout: 20000,
  retries: 1
}

function judge(d, t) {
  const reasons = []
  const check = (type, flag, score) => {
    if (flag || score >= t.unsafe[type]) reasons.push({ type, level: 'unsafe', score })
    else if (score >= t.borderline[type]) reasons.push({ type, level: 'borderline', score })
  }
  check('nsfw', d.nsfw, d.nsfw_score)
  check('nudity', d.nudity, d.nudity_score)
  check('gore', d.gore, d.gore_score)

  const level = reasons.some(r => r.level === 'unsafe')
    ? 'unsafe'
    : reasons.length ? 'borderline' : 'safe'
  return { level, reasons }
}

async function request(imageUrl, apiKey, cfg) {
  let lastErr
  for (let i = 0; i <= cfg.retries; i++) {
    try {
      const res = await fetch('https://api.jigsawstack.com/v1/validate/nsfw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ url: imageUrl }),
        signal: AbortSignal.timeout(cfg.timeout)
      })
      const data = await res.json().catch(() => ({}))
      if (res.status >= 500 && i < cfg.retries) {
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return { res, data }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

async function nsfwDetection(imageUrl, apiKey, opts = {}) {
  if (!imageUrl) return { status: false, message: 'imageUrl wajib diisi' }
  if (!/^https?:\/\//i.test(imageUrl)) return { status: false, message: 'imageUrl harus diawali http:// atau https://' }
  if (!apiKey) return { status: false, message: 'apiKey wajib diisi' }

  const cfg = {
    ...DEFAULTS,
    ...opts,
    unsafe: { ...DEFAULTS.unsafe, ...(opts.unsafe || {}) },
    borderline: { ...DEFAULTS.borderline, ...(opts.borderline || {}) }
  }

  try {
    const { res, data } = await request(imageUrl, apiKey, cfg)
    if (!res.ok || !data.success) {
      return { status: false, message: data.message || `HTTP ${res.status}` }
    }

    const { level, reasons } = judge(data, cfg)
    return {
      status: true,
      level,
      reasons,
      nsfw: data.nsfw,
      nudity: data.nudity,
      gore: data.gore,
      nsfw_score: data.nsfw_score,
      nudity_score: data.nudity_score,
      gore_score: data.gore_score
    }
  } catch (e) {
    return { status: false, message: e.message }
  }
}

module.exports = nsfwDetection

// Pemakaian: node nsfw-detection.js <urlGambar> [apiKey]
if (require.main === module) {
  nsfwDetection(
    process.argv[2] || 'https://jigsawstack.com/preview/nsfw-example.jpg',
    process.argv[3] || 'sk_da4a23cc2c4ba0a6d7eeee199e1530e0e41b2b13afe7df36e8a16dd7f4877baf06859ae6250859f29e05bb9dd9ebfeee909634ddf41df6b444d1b6d870b07120024oUgUGHWdcWGxXvlEN3'
  ).then(r => console.log(JSON.stringify(r, null, 2)))
}
