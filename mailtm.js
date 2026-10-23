/**
 * Name Scrape : Mail.tm API Scraper (Fix Array)
 * Owner       : Kersio
 * Base Web    : https://mail.tm (API: https://api.mail.tm)
 * Type        : scraper
 * Function    : Membuat email sementara, membaca daftar inbox, dan mengambil isi pesan
 * Input       : Command (create | inbox | read | domains)
 * Output      : JSON
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan)
 * Note        : API gratis, jangan spam request. (erorr fix sendiri ya)
 */

const API_BASE = 'https://api.mail.tm';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const crypto = require('crypto');

async function apiFetch(endpoint, options = {}) {
  const url = ${API_BASE}${endpoint};
  const res = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.log('\n\x1b[31m%s\x1b[0m', '❌ RESPONS SERVER BUKAN JSON:');
    console.log(text.slice(0, 300));
    throw new Error(Respons bukan JSON (HTTP ${res.status}). Kemungkinan diblokir Cloudflare.);
  }

  if (!res.ok) {
    const errMsg = data.detail || data.message || data['hydra:description'] || HTTP Error ${res.status};
    throw new Error(API Error: ${errMsg});
  }

  return data;
}

async function getDomains() {
  const data = await apiFetch('/domains');
  let domainsArray = [];

  // Deteksi format: Apakah API Platform (hydra:member) atau Array Biasa?
  if (data && data['hydra:member'] && Array.isArray(data['hydra:member'])) {
    domainsArray = data['hydra:member'];
  } else if (Array.isArray(data)) {
    domainsArray = data;
  } else {
    console.log('\n\x1b[33m%s\x1b[0m', '⚠️ RESPONS TIDAK DIKENALI:');
    console.log(JSON.stringify(data, null, 2));
    throw new Error('Format domain tidak dikenali.');
  }

  // Ambil domain yang aktif saja
  const activeDomains = domainsArray.filter(d => d.isActive !== false).map(d => d.domain);
  if (activeDomains.length === 0) throw new Error('Tidak ada domain aktif yang tersedia.');
  
  return activeDomains;
}

async function createAccount(address, password) {
  return await apiFetch('/accounts', {
    method: 'POST',
    body: JSON.stringify({ address, password })
  });
}

async function getToken(address, password) {
  const data = await apiFetch('/token', {
    method: 'POST',
    body: JSON.stringify({ address, password })
  });
  if (!data.token) throw new Error('Token tidak ditemukan di respons.');
  return data.token;
}

async function getInbox(token) {
  const data = await apiFetch('/messages', {
    headers: { 'Authorization': Bearer ${token} }
  });
  
  let messagesArray = [];
  if (data && data['hydra:member'] && Array.isArray(data['hydra:member'])) {
    messagesArray = data['hydra:member'];
  } else if (Array.isArray(data)) {
    messagesArray = data;
  } else {
    return []; // Jika tidak ada pesan
  }

  return messagesArray.map(msg => ({
    id: msg.id,
    from: msg.from ? msg.from.address : 'Unknown',
    subject: msg.subject || '(Tanpa Subjek)',
    intro: msg.intro,
    createdAt: msg.createdAt,
    seen: msg.seen
  }));
}

async function readMessage(token, messageId) {
  const data = await apiFetch(/messages/${messageId}, {
    headers: { 'Authorization': Bearer ${token} }
  });
  return {
    id: data.id,
    from: data.from ? data.from.address : 'Unknown',
    to: (data.to || []).map(t => t.address),
    subject: data.subject,
    text: data.text || '(Tidak ada teks)',
    html: data.html || [],
    createdAt: data.createdAt
  };
}

// ============================================
// CLI HANDLER
// ============================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  (async () => {
    try {
      if (!command || command === 'help') {
        console.log('\n\x1b[36m%s\x1b[0m', '=== MAIL.TM SCRAPER ===');
        console.log('Cara Pakai:');
        console.log('  node mailtm.js domains            # Lihat domain yang tersedia');
        console.log('  node mailtm.js create             # Buat email random & dapatkan token');
        console.log('  node mailtm.js inbox <token>      # Lihat daftar pesan masuk');
        console.log('  node mailtm.js read <token> <id>  # Baca isi pesan tertentu\n');
        return;
      }

      if (command === 'domains') {
        console.log('⏳ Mengambil domain...');
        const domains = await getDomains();
        console.log(JSON.stringify({ success: true, domains }, null, 2));
      } 
      else if (command === 'create') {
        console.log('⏳ Membuat akun email baru...');
        const domains = await getDomains();
        const randomUser = bot_${crypto.randomBytes(4).toString('hex')};
        const domain = domains[0]; // Ambil domain pertama yang aktif
        const address = ${randomUser}@${domain};
        const password = crypto.randomBytes(8).toString('hex');

        await createAccount(address, password);
        const token = await getToken(address, password);

        console.log('\n\x1b[32m%s\x1b[0m', '✅ Email Berhasil Dibuat!');
        console.log(JSON.stringify({ success: true, address, password, token }, null, 2));
        console.log('\n\x1b[33m%s\x1b[0m', 'Simpan token di atas untuk cek inbox.');
      } 
      else if (command === 'inbox') {
        const token = args[1];
        if (!token) throw new Error('Butuh token. Contoh: node mailtm.js inbox <token>');
        console.log('⏳ Mengambil inbox...');
        const inbox = await getInbox(token);
        console.log(JSON.stringify({ success: true, total: inbox.length, messages: inbox }, null, 2));
      } 
      else if (command === 'read') {
        const token = args[1];
        const messageId = args[2];
        if (!token || !messageId) throw new Error('Butuh token dan ID. Contoh: node mailtm.js read <token> <id>');
        console.log('⏳ Membaca pesan...');
        const message = await readMessage(token, messageId);
        console.log(JSON.stringify({ success: true, message }, null, 2));
      } 
      else {
        console.log(❌ Perintah "${command}" tidak dikenali.);
      }
    } catch (err) {
      console.log('\n\x1b[31m%s\x1b[0m', ❌ GAGAL: ${err.message});
    }
  })();
}
