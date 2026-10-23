/**
 * Name Scrape : NaxaChat AI (Unlimited - Smart Time Edition)
 * Base Web    : https://www.naxachat.com
 * Function    : Bypass limit guest dengan auto-generate akun via Temp Mail
 * source : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G 
 * type : scraper
 * input : text                  
 * output : JSON                                                                                                    
 * note : erorr fix sendiri                                                                                                           */

const BASE = 'https://www.naxachat.com';
const SUPABASE_URL = 'https://lhncvnrreuxjhyzcgzli.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_VE8NUgKll5s4p9tZ-i9D9w_CoX7bkbb';
const MAIL_API = 'https://api.mail.tm';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const readline = require('readline');
const crypto = require('crypto');

// ==========================================
// HELPER: Dapatkan Waktu Real-time (WIB)
// ==========================================
function getWaktuRealTime() {
  const now = new Date();
  const options = { 
    timeZone: 'Asia/Jakarta', 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  // Output contoh: "Sabtu, 17 Oktober 2026 pukul 13.15"
  return new Intl.DateTimeFormat('id-ID', options).format(now);
}

// 1. Bikin Temp Mail
async function createTempMail(isJson = false) {
  try {
    const domRes = await fetch(${MAIL_API}/domains);
    const domain = (await domRes.json())['hydra:member'][0].domain;
    const randomStr = crypto.randomBytes(4).toString('hex');
    const email = bot_${randomStr}@${domain};
    const password = Pass_${randomStr}!;

    await fetch(${MAIL_API}/accounts, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: email, password })
    });

    const loginRes = await fetch(${MAIL_API}/token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: email, password })
    });
    return { email, password, token: (await loginRes.json()).token };
  } catch (err) { return null; }
}

// 2. Registrasi ke Supabase (NaxaChat)
async function registerSupabase(tempMail, isJson = false) {
  if (!isJson) console.log(\n[!] Kuota habis. Mendaftarkan akun baru: ${tempMail.email}...);
  try {
    const res = await fetch(${SUPABASE_URL}/auth/v1/signup, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': Bearer ${SUPABASE_ANON_KEY},
        'Content-Type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify({ email: tempMail.email, password: tempMail.password })
    });
    
    const signupData = await res.json();
    if (!res.ok) throw new Error(Signup gagal: ${JSON.stringify(signupData)});
    
    if (!isJson) console.log('[+] Signup berhasil. Menunggu email verifikasi...');

    let verifyLink = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const msgRes = await fetch(${MAIL_API}/messages, { headers: { 'Authorization': Bearer ${tempMail.token} } });
      const msgs = (await msgRes.json())['hydra:member'];
      
      if (msgs.length > 0) {
        if (!isJson) console.log(\n[debug] Email masuk: ${msgs[0].subject});
        const msgData = await (await fetch(${MAIL_API}/messages/${msgs[0].id}, { headers: { 'Authorization': Bearer ${tempMail.token} } })).json();
        const content = msgData.html[0] || msgData.text;
        const match = content.match(/href="([^"]+)"/i) || content.match(/(https?:\/\/[^\s"']+)/i);
        if (match) {
          verifyLink = match[1].replace(/&amp;/g, '&');
          break;
        }
      }
      if (!isJson) process.stdout.write('.');
    }

    if (!verifyLink) throw new Error('Email verifikasi tidak masuk atau link tidak ditemukan dalam 30 detik.');
    if (!isJson) console.log(\n[+] Link verifikasi ditemukan. Memverifikasi...);
    
    await fetch(verifyLink, { headers: { 'User-Agent': USER_AGENT } });
    await new Promise(r => setTimeout(r, 3000));

    if (!isJson) console.log('[+] Mencoba login ke Supabase...');
    const loginRes = await fetch(${SUPABASE_URL}/auth/v1/token?grant_type=password, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': Bearer ${SUPABASE_ANON_KEY},
        'Content-Type': 'application/json;charset=UTF-8'
      },
      body: JSON.stringify({ email: tempMail.email, password: tempMail.password })
    });
    
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error(loginData.error_description || loginData.error || 'Login gagal');
    if (!loginData.access_token) throw new Error('Respons login tidak mengandung access_token.');

    if (!isJson) console.log('[+] Akun siap digunakan!');
    return loginData.access_token;

  } catch (err) {
    if (!isJson) console.error(\n[-] Gagal: ${err.message});
    return null;
  }
}

// 3. Chat NaxaChat (Pakai Token + Injeksi Waktu)
async function naxachat(message, token, history = [], isJson = false) {
  try {
    // Ambil waktu saat ini
    const waktuSekarang = getWaktuRealTime();
    
    // Suntikkan info waktu ke pesan user (tanpa merusak history asli)
    const augmentedMessage = [Info Sistem: Saat ini adalah ${waktuSekarang} WIB. Jawablah pertanyaan berdasarkan waktu ini.]\n\nPesan Pengguna: ${message.trim()};

    const body = {
      // Masukkan pesan yang sudah disuntik waktu ke history
      history: [...history, { role: 'user', content: augmentedMessage }],
      memoryEnabled: true, 
      chatModel: 'azure'
    };
    
    const headers = {
      'Content-Type': 'application/json', 'Origin': BASE, 'Referer': ${BASE}/, 'User-Agent': USER_AGENT
    };
    if (token) headers['Authorization'] = Bearer ${token};

    const res = await fetch(${BASE}/api/chat, { method: 'POST', headers, body: JSON.stringify(body) });
    const raw = await res.text();
    
    let reply = null;
    try {
      const json = JSON.parse(raw);
      reply = json.reply || json.message || json.choices?.[0]?.message?.content;
    } catch(e) {
      reply = raw;
    }

    if (!res.ok || raw.includes('Kuota Guest habis')) {
      return { success: false, quotaExceeded: true, raw };
    }
    
    // Simpan history asli (tanpa info sistem) agar chat tetap bersih di memori
    const cleanHistory = [
      ...history, 
      { role: 'user', content: message.trim() },
      { role: 'assistant', content: reply }
    ];

    return { success: true, reply, history: cleanHistory };
  } catch (err) { return { success: false, error: err.message }; }
}

// ==========================================
// CLI HANDLER 
// ==========================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const singleMessage = args.join(' ').trim();

  if (singleMessage) {
    // === MODE SINGLE-SHOT (WAJIB JSON) ===
    (async () => {
      let currentToken = null;
      let chatHistory = [];
      
      let res = await naxachat(singleMessage, currentToken, chatHistory, true);

      if (res.quotaExceeded) {
        const tempMail = await createTempMail(true);
        if (tempMail) {
          currentToken = await registerSupabase(tempMail, true);
          if (currentToken) {
            res = await naxachat(singleMessage, currentToken, chatHistory, true);
          }
        }
      }

      console.log(JSON.stringify(res, null, 2));
    })();

  } else {
    // === MODE INTERAKTIF ===
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let chatHistory = [];
    let currentToken = null;

    console.log('\x1b[36m%s\x1b[0m', '🤖 NaxaChat Unlimited Mode (Smart Time Edition)');
    console.log('\x1b[90m%s\x1b[0m', 'Ketik "exit" untuk keluar.\n');

    const chatLoop = () => {
      rl.question('\x1b[32m%s\x1b[0m', 'Kamu: ', async (input) => {
        const text = input.trim();
        if (text === 'exit') return rl.close();
        if (!text) return chatLoop();

        console.log('\x1b[90m%s\x1b[0m', '⏳ Mengetik...');
        let res = await naxachat(text, currentToken, chatHistory, false);

        if (res.quotaExceeded) {
          const tempMail = await createTempMail(false);
          if (tempMail) {
            currentToken = await registerSupabase(tempMail, false);
            if (currentToken) {
              console.log('\x1b[33m%s\x1b[0m', '[+] Mencoba ulang pesan...');
              res = await naxachat(text, currentToken, chatHistory, false);
            }
          }
        }

        if (res.success) {
          console.log(\x1b[35m%s\x1b[0m ${res.reply}\n, 'AI:');
          chatHistory = res.history;
        } else {
          console.log(\x1b[31m%s\x1b[0m ${res.error || res.raw}\n, 'Error:');
        }
        chatLoop();
      });
    };
    chatLoop();
  }
}
