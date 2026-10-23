/**
 * Name Scrape : Natural TTS (msedge-tts + Google Fallback) - Pure JSON
 * Owner       : Kersio
 * Base Web    : www.Microsoft Edge Read Aloud.com
 * Type        : Tool
 * Function    : Konversi teks ke suara MP3 suara ada 322 Suara lebih 
 * Input       : Teks + nama suara (opsional)
 * Output      : JSON
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+, msedge-tts (opsional)
 * Note        : (erorr fix sendiri ya)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE_VOICES = {
  'ardi': 'id-ID-ArdiNeural',
  'gadis': 'id-ID-GadisNeural',
  'aria': 'en-US-AriaNeural',
  'guy': 'en-US-GuyNeural',
  'sonia': 'en-GB-SoniaNeural',
  'natasha': 'en-AU-NatashaNeural',
  'nanami': 'ja-JP-NanamiNeural',
  'sunhi': 'ko-KR-SunHiNeural',
  'xiaoxiao': 'zh-CN-XiaoxiaoNeural'
};

const GOOGLE_LANGS = {
  'id': 'id', 'en': 'en', 'ja': 'ja', 'ko': 'ko', 'zh': 'zh'
};

function chunkText(text, limit = 200) {
  const words = text.split(' ');
  const chunks = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).length > limit) {
      if (current) chunks.push(current.trim());
      current = word;
    } else {
      current += (current ? ' ' : '') + word;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

async function generateEdgeTTS(text, voice) {
  // Menggunakan dynamic import agar kalau gagal, error-nya bisa ditangkap (catch)
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 15000 });
  const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || "audio-24khz-48kbitrate-mono-mp3";
  await tts.setMetadata(voice, format);
  
  const outputDir = path.join(os.homedir(), 'Downloads');
  const { audioFilePath } = await tts.toFile(outputDir, text);
  
  const buffer = fs.readFileSync(audioFilePath);
  fs.unlinkSync(audioFilePath);
  return buffer;
}

async function generateGoogleTTS(text, lang) {
  const chunks = chunkText(text, 200);
  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const url = https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&client=tw-ob&idx=${i}&total=${chunks.length};
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) throw new Error(HTTP ${res.status});
    buffers.push(Buffer.from(await res.arrayBuffer()));
    await new Promise(r => setTimeout(r, 400));
  }
  return Buffer.concat(buffers);
}

async function generateSpeech(text, voiceAlias = 'ardi') {
  try {
    const edgeVoice = EDGE_VOICES[voiceAlias.toLowerCase()] || voiceAlias;
    
    let audioBuffer;
    let usedEngine = 'Edge TTS';

    try {
      audioBuffer = await generateEdgeTTS(text, edgeVoice);
    } catch (edgeErr) {
      // Jika gagal, fallback ke Google
      const lang = GOOGLE_LANGS[voiceAlias.toLowerCase()] || 'id';
      audioBuffer = await generateGoogleTTS(text, lang);
      usedEngine = 'Google TTS';
    }

    const downloadsFolder = path.join(os.homedir(), 'Downloads');
    const filename = TTS_${Date.now()}.mp3;
    const filepath = path.join(downloadsFolder, filename);
    fs.writeFileSync(filepath, audioBuffer);

    return {
      success: true,
      engine: usedEngine,
      text: text,
      voice: edgeVoice,
      filePath: filepath,
      filesize: audioBuffer.length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==== CLI HANDLER ====
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'Teks tidak boleh kosong!' }, null, 2));
    process.exit(1);
  }

  let voice = 'ardi';
  let teksParts = [...args];
  const lastArg = teksParts[teksParts.length - 1].toLowerCase();

  if (EDGE_VOICES[lastArg] || GOOGLE_LANGS[lastArg]) {
    voice = lastArg;
    teksParts.pop();
  }

  const teks = teksParts.join(' ');
  if (!teks) {
    console.log(JSON.stringify({ success: false, error: 'Teks tidak boleh kosong!' }, null, 2));
    process.exit(1);
  }

  generateSpeech(teks, voice).then(res => {
    console.log(JSON.stringify(res, null, 2));
  });
}
