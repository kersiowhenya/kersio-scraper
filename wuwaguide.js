/**
 * Name Scrape : Wuwa Guide Parser
 * Base Web    : https://guide-server.aki-game.net
 * Type        : scraper (API based)
 * Function    : Mengambil data karakter dan merapikannya jadi JSON + Caption.
 * Input       : Role ID + Strategy ID
 * Output      : JSON rapi + Caption
 * Note        : (erorr fix sendiri ya)
 */

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>?/gm, '').replace(/&rarr;/g, '→').replace(/&rsquo;/g, "'").trim();
}

async function scrapeWuwaGuide(roleGbId = '1413', id = '14131') {
  try {
    const url = https://guide-server.aki-game.net/introduction/info?roleGbId=${roleGbId}&id=${id}&_t=${Date.now()};

    const res = await fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, /',
        'x-language': 'en',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    });

    if (!res.ok) throw new Error(HTTP Error ${res.status});
    
    const json = await res.json();
    const data = json.data; // Ambil objek utama

    // 1. Ambil Info Dasar
    const roleText = data.role.texts.find(t => t.language === 'en') || {};
    const baseText = data.baseTexts.find(t => t.language === 'en') || {};
    const name = roleText.name || 'Unknown';
    const rarity = data.role.star || 0;
    
    // 2. Ambil Senjata & Echo
    const weapon = data.weapon.items[0]?.texts.find(t => t.language === 'en')?.name || 'Unknown';
    const mainEcho = data.echo.main?.echoProps?.texts.find(t => t.language === 'en')?.name || 'Unknown';
    const echoSet = data.echo.main?.echoSetEffects[0]?.texts.find(t => t.language === 'en')?.name || 'Unknown';
    
    // 3. Ambil Teammates
    const teammates = data.teammate.items.map(item => {
      return item.main?.texts.find(t => t.language === 'en')?.name || 'Unknown';
    }).filter(n => n !== 'Unknown');

    // 4. Ambil Rotasi & Deskripsi
    const rotation = roleText.skillDisplay || 'No rotation data';
    const description = stripHtml(baseText.introductionSynopsis);
    const playstyle = stripHtml(baseText.introductionDescription).slice(0, 300) + '...';

    // 5. Susun JSON Rapih
    const cleanData = {
      name,
      rarity: ${rarity}-Star,
      weapon,
      mainEcho,
      echoSet,
      teammates,
      rotation,
      description,
      playstyle
    };

    // 6. Susun Caption (Teks WA/Discord)
    const caption = 
      📖 *WUTHERING WAVES GUIDE*\n\n +
      👤 *Nama*       : ${name} (${rarity}★)\n +
      ⚔️ *Senjata*    : ${weapon}\n +
      🔮 *Echo Utama* : ${mainEcho}\n +
      🛡️ *Echo Set*   : ${echoSet}\n +
      🤝 *Tim Rekom*  : ${teammates.join(' / ')}\n\n +
      🔄 *Rotasi Skill*:\n${rotation}\n\n +
      📝 *Sinopsis*:\n${description}\n\n +
      🎮 *Playstyle*:\n${playstyle};

    return {
      success: true,
      data: cleanData,
      caption
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// --- CLI ---
if (require.main === module) {
  const roleId = process.argv[2] || '1413';
  const strategyId = process.argv[3] || '14131';

  scrapeWuwaGuide(roleId, strategyId).then(res => {
    // Output berupa JSON
    console.log(JSON.stringify(res, null, 2));
  });
}
