/**
 * Name Scrape : RobloxStalk
 * Owner       : Kersio
 * Base Web    : users.roblox.com, friends.roblox.com, groups.roblox.com,
                games.roblox.com, badges.roblox.com, presence.roblox.com,
                premiumfeatures.roblox.com, thumbnails.roblox.com
 * Type        : scraper
 * Function    : Cek profil Roblox lengkap: umur akun, avatar HD, friends,
                followers, following, grup, games, badges, premium, presence,
                riwayat username, verified, banned.
 * Input       : Username Roblox
 * Output      : JSON + caption rapi
 * saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (tanpa library tambahan)
 * Note        : Pakai API publik resmi Roblox. Tanpa login, tanpa API key.
                (erorr fix sendiri ya)
 */

// Fix encoding CMD Windows
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

const SOURCE = 'https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================================================
// HELPER: FETCH JSON
// ============================================================
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return await res.json();
}

// ============================================================
// HELPER: FORMAT & HITUNG
// ============================================================
function formatDate(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function calculateAge(createdDate) {
  const now = new Date();
  const created = new Date(createdDate);
  let years = now.getFullYear() - created.getFullYear();
  let months = now.getMonth() - created.getMonth();
  let days = now.getDate() - created.getDate();
  if (days < 0) {
    months--;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) { years--; months += 12; }
  const totalDays = Math.floor((now - created) / 86400000);
  return { years, months, days, totalDays };
}

function fmt(n) {
  n = parseInt(n, 10) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ============================================================
// 1. CARI USER ID
// ============================================================
async function getUserIdByUsername(username) {
  const data = await api('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  if (!data.data || !data.data.length) throw new Error(`Username "${username}" tidak ditemukan.`);
  return data.data[0];
}

// ============================================================
// 2. DETAIL USER
// ============================================================
async function getUserDetail(userId) {
  return await api(`https://users.roblox.com/v1/users/${userId}`);
}

// ============================================================
// 3. AVATAR 3D (HD)
// ============================================================
async function getAvatar(userId) {
  try {
    const data = await api(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=Png&isCircular=false`
    );
    return data.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

async function getAvatarHeadshot(userId) {
  try {
    const data = await api(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
    );
    return data.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

async function getAvatarBust(userId) {
  try {
    const data = await api(
      `https://thumbnails.roblox.com/v1/users/avatar-bust?userIds=${userId}&size=420x420&format=Png&isCircular=false`
    );
    return data.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

// ============================================================
// 4. FRIENDS / FOLLOWERS / FOLLOWING
// ============================================================
async function getFriendsCount(userId) {
  try {
    const d = await api(`https://friends.roblox.com/v1/users/${userId}/friends/count`);
    return d.count || 0;
  } catch { return null; }
}

async function getFollowersCount(userId) {
  try {
    const d = await api(`https://friends.roblox.com/v1/users/${userId}/followers/count`);
    return d.count || 0;
  } catch { return null; }
}

async function getFollowingsCount(userId) {
  try {
    const d = await api(`https://friends.roblox.com/v1/users/${userId}/followings/count`);
    return d.count || 0;
  } catch { return null; }
}

// ============================================================
// 5. GROUPS
// ============================================================
async function getGroups(userId) {
  try {
    const d = await api(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
    return (d.data || []).map(g => ({
      id: g.group?.id,
      name: g.group?.name,
      role: g.role?.name,
      rank: g.role?.rank,
      memberCount: g.group?.memberCount
    }));
  } catch { return []; }
}

// ============================================================
// 6. GAMES
// ============================================================
async function getGames(userId) {
  try {
    const d = await api(`https://games.roblox.com/v2/users/${userId}/games?limit=10&sortOrder=Desc`);
    return (d.data || []).map(g => ({
      id: g.id,
      name: g.name,
      visits: g.placeVisits || 0,
      created: g.created,
      updated: g.updated,
      creator: g.creator?.name
    }));
  } catch { return []; }
}

// ============================================================
// 7. BADGES
// ============================================================
async function getBadges(userId) {
  try {
    const d = await api(`https://badges.roblox.com/v1/users/${userId}/badges?limit=10&sortOrder=Desc`);
    return {
      total: d.data?.length || 0,
      latest: (d.data || []).map(b => ({
        id: b.id,
        name: b.name,
        description: b.description,
        awarded: b.awardedDate
      }))
    };
  } catch { return { total: 0, latest: [] }; }
}

// ============================================================
// 8. PREMIUM STATUS
// ============================================================
async function getPremium(userId) {
  try {
    const d = await api(`https://premiumfeatures.roblox.com/v1/users/${userId}/validate-membership`);
    return d.isPremium === true;
  } catch { return false; }
}

// ============================================================
// 9. PRESENCE (ONLINE/OFFLINE)
// ============================================================
async function getPresence(userId) {
  try {
    const d = await api('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      body: JSON.stringify({ userIds: [userId] })
    });
    const p = d.userPresences?.[0];
    if (!p) return null;
    const types = ['Offline', 'Online', 'InGame', 'InStudio'];
    return {
      type: types[p.userPresenceType] || 'Unknown',
      lastOnline: p.lastOnline,
      lastLocation: p.lastLocation,
      placeId: p.placeId,
      universeId: p.universeId,
      gameId: p.gameId
    };
  } catch { return null; }
}

// ============================================================
// 10. USERNAME HISTORY
// ============================================================
async function getUsernameHistory(userId) {
  try {
    const d = await api(`https://users.roblox.com/v1/users/${userId}/username-history?limit=10&sortOrder=Desc`);
    return (d.data || []).map(h => h.name);
  } catch { return []; }
}

// ============================================================
// 11. BIRTHDATE (kalau publik)
// ============================================================
async function getBirthdate(userId) {
  try {
    const d = await api(`https://users.roblox.com/v1/users/${userId}`);
    // Roblox API jarang expose birthdate. Coba endpoint alternatif
    const b = await api(`https://accountinformation.roblox.com/v1/users/${userId}/birthdate`);
    return b.birthMonth && b.birthDay ? { month: b.birthMonth, day: b.birthDay, year: b.birthYear || null } : null;
  } catch { return null; }
}

// ============================================================
// MAIN
// ============================================================
async function checkRobloxProfile(username, options = {}) {
  try {
    if (!username || typeof username !== 'string') {
      return { success: false, error: 'INVALID_INPUT', message: 'Username tidak boleh kosong.', source: SOURCE };
    }

    // Cari user ID
    const userSearch = await getUserIdByUsername(username);
    const userId = userSearch.id;

    // Fetch paralel (lebih cepat)
    const [
      userDetail,
      avatar,
      avatarHeadshot,
      avatarBust,
      friendsCount,
      followersCount,
      followingsCount,
      groups,
      games,
      badges,
      premium,
      presence,
      usernameHistory,
      birthdate
    ] = await Promise.all([
      getUserDetail(userId),
      getAvatar(userId),
      getAvatarHeadshot(userId),
      getAvatarBust(userId),
      getFriendsCount(userId),
      getFollowersCount(userId),
      getFollowingsCount(userId),
      getGroups(userId),
      getGames(userId),
      getBadges(userId),
      getPremium(userId),
      getPresence(userId),
      getUsernameHistory(userId),
      getBirthdate(userId)
    ]);

    const age = calculateAge(userDetail.created);

    const out = {
      success: true,
      id: userDetail.id,
      username: userDetail.name,
      displayName: userDetail.displayName,
      description: userDetail.description,
      created: userDetail.created,
      createdFormatted: formatDate(userDetail.created),
      isBanned: userDetail.isBanned || false,
      hasVerifiedBadge: userDetail.hasVerifiedBadge || false,
      age,
      avatar,
      avatarHeadshot,
      avatarBust,
      stats: {
        friends: friendsCount,
        followers: followersCount,
        following: followingsCount
      },
      groups: groups.slice(0, 20),
      groupCount: groups.length,
      games: games.slice(0, 10),
      gameCount: games.length,
      badges,
      premium,
      presence,
      usernameHistory,
      birthdate,
      source: SOURCE
    };

    out.caption = buildCaption(out);
    return out;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, error: 'TIMEOUT', message: 'Request terlalu lama.', source: SOURCE };
    }
    return { success: false, error: 'EXCEPTION', message: err.message || String(err), source: SOURCE };
  }
}

// ============================================================
// CAPTION
// ============================================================
function buildCaption(out) {
  const L = [];
  const line = '─'.repeat(28);

  L.push('🎮 *ROBLOX PROFILE CHECKER*');
  L.push('');

  L.push('📋 *AKUN*');
  L.push(line);
  L.push(`👤 Username    : @${out.username}`);
  L.push(`📛 Display     : ${out.displayName || '-'}`);
  L.push(`🆔 User ID     : ${out.id}`);
  L.push(`✅ Verified    : ${out.hasVerifiedBadge ? 'Ya' : 'Tidak'}`);
  L.push(`🚫 Banned      : ${out.isBanned ? 'Ya' : 'Tidak'}`);
  L.push(`⭐ Premium     : ${out.premium ? 'Ya' : 'Tidak'}`);
  if (out.presence) {
    L.push(`🟢 Status      : ${out.presence.type}`);
    if (out.presence.lastOnline) L.push(`⏰ Terakhir     : ${formatDate(out.presence.lastOnline)}`);
  }
  if (out.description) L.push(`📝 Bio         : ${out.description.slice(0, 100)}`);
  L.push('');

  L.push('⏱️ *UMUR AKUN*');
  L.push(line);
  L.push(`📅 Dibuat      : ${out.createdFormatted}`);
  L.push(`🎂 Umur        : ${out.age.years} thn, ${out.age.months} bln, ${out.age.days} hari`);
  L.push(`📆 Total Hari  : ${out.age.totalDays.toLocaleString()}`);
  L.push('');

  L.push('👥 *SOSIAL*');
  L.push(line);
  L.push(`👫 Friends     : ${fmt(out.stats.friends)}`);
  L.push(`⭐ Followers   : ${fmt(out.stats.followers)}`);
  L.push(`➡️  Following  : ${fmt(out.stats.following)}`);
  L.push('');

  if (out.usernameHistory.length) {
    L.push('📜 *RIWAYAT USERNAME*');
    L.push(line);
    out.usernameHistory.slice(0, 5).forEach(n => L.push(`   • ${n}`));
    L.push('');
  }

  if (out.groupCount > 0) {
    L.push(`🏰 *GRUP (${out.groupCount})*`);
    L.push(line);
    out.groups.slice(0, 5).forEach(g => L.push(`   • ${g.name} — ${g.role}`));
    if (out.groupCount > 5) L.push(`   ... (+${out.groupCount - 5} lagi)`);
    L.push('');
  }

  if (out.gameCount > 0) {
    L.push(`🎮 *GAME (${out.gameCount})*`);
    L.push(line);
    out.games.slice(0, 5).forEach(g => L.push(`   • ${g.name} — ${fmt(g.visits)} visits`));
    if (out.gameCount > 5) L.push(`   ... (+${out.gameCount - 5} lagi)`);
    L.push('');
  }

  if (out.badges.total > 0) {
    L.push(`🏅 *BADGE (${out.badges.total})*`);
    L.push(line);
    out.badges.latest.slice(0, 3).forEach(b => L.push(`   • ${b.name}`));
    L.push('');
  }

  L.push(`🌐 Sumber : ${SOURCE}`);
  return L.join('\n');
}

module.exports = { checkRobloxProfile };

// ============================================================
// CLI
// ============================================================
if (require.main === module) {
  const username = process.argv[2];
  if (!username) {
    console.log('Cara pakai: node robloxstalk.js <username>');
    console.log('Contoh:    node robloxstalk.js builderman');
    process.exit(1);
  }
  checkRobloxProfile(username).then(r => {
    console.log(JSON.stringify(r, null, 2));
    console.log('');
    console.log(`Sumber: ${SOURCE}`);
    if (!r.success) process.exitCode = 1;
  });
}
