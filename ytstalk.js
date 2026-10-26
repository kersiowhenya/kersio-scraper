/*
 * Name Scrape : YouTube Stalk
 * Owner       : Kersio
 * Base Web    : https://www.youtube.com
 * Type        : Scraper (Node.js, Innertube internal API YouTube, tanpa API key)
 * Function    : Mengambil profil channel (nama, @handle, foto, deskripsi, tanggal dibuat),
 *               statistik (subscribers, total views, total video), engagement (rata-rata
 *               likes & komentar, engagement rate, rasio per 1.000), analisis hingga 50
 *               video terbaru, dan perbandingan Shorts vs Long Form
 * Input       : URL channel / @handle / channel ID (UCxxxx) / nama handle
 *               CLI: node ytstalk.js <channel> [--limit 50] [--out hasil.json] [--debug]
 * Output      : JSON { channel, stats, engagement, shortsVsLong, videos, warnings }
 * Saluran     : https://whatsapp.com/channel/0029VbDecTzElah1uM12wK2G
 * Require     : Node.js 18+ (fetch bawaan), tanpa dependency
 * Note        : Tanpa login, captcha, maupun Cloudflare. Subscribers dibulatkan YouTube
 *               (mis. 1.23M). Likes/komentar angka besar bisa berupa pembulatan (mis. 12K).
 *               null = tidak tersedia (komentar dimatikan / likes disembunyikan).
 *               Shorts dibedakan lewat tab Shorts. Gunakan --debug jika ada field kosong.
 */

'use strict';

const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const FALLBACK = { key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', version: '2.20250101.00.00', visitorData: '' };
const FALLBACK_TABS = { videos: 'EgZ2aWRlb3PyBgQKAjoA', shorts: 'EgZzaG9ydHPyBgUKA5oBAA==' };
const MAX_LIMIT = 50;

let DEBUG = false;
let dbgCount = 0;
let CFG = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * Math.pow(10, d)) / Math.pow(10, d));

/* ---------- helper umum ---------- */

function* walk(o) {
  if (o && typeof o === 'object') {
    yield o;
    for (const k of Object.keys(o)) yield* walk(o[k]);
  }
}

function findKey(o, key) {
  for (const n of walk(o)) {
    if (n && typeof n === 'object' && !Array.isArray(n) && key in n) return n[key];
  }
  return undefined;
}

function findAllKey(o, key) {
  const out = [];
  for (const n of walk(o)) {
    if (n && typeof n === 'object' && !Array.isArray(n) && key in n) out.push(n[key]);
  }
  return out;
}

function txt(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (x.simpleText) return x.simpleText;
  if (x.content) return x.content;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text).join('');
  return '';
}

function toNum(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  s = String(s).replace(/\u00a0/g, ' ').trim();
  if (/^(no|tidak ada)\b/i.test(s)) return 0;
  const m = s.match(/(\d[\d.,]*)\s*(juta|jt|ribu|rb|[kmb])?\b/i);
  if (!m) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf) {
    const mult = /^(k|rb|ribu)$/.test(suf) ? 1e3 : /^(m|jt|juta)$/.test(suf) ? 1e6 : 1e9;
    return Math.round(parseFloat(m[1].replace(/,/g, '.')) * mult);
  }
  return parseInt(m[1].replace(/[.,]/g, ''), 10);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, agt: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };

// kembalikan 'YYYY-MM-DD' tanpa lewat Date (hindari geser zona waktu)
function parseDate(s) {
  if (!s) return null;
  let m, y, mo, d;
  if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
    mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3];
  } else if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/))) {
    d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3];
  } else if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else return null;
  if (!mo) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const daysSince = (iso) => Math.max(1, Math.floor((Date.now() - Date.parse(iso + 'T00:00:00Z')) / 864e5));
const lastThumb = (arr) => (arr && arr.length ? arr[arr.length - 1].url : null);

async function pool(items, size, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k], k).catch((e) => ({ error: e.message }));
      }
    })
  );
  return res;
}

/* ---------- koneksi ke YouTube ---------- */

async function bootstrap() {
  if (CFG) return CFG;
  CFG = { ...FALLBACK };
  try {
    const r = await fetch('https://www.youtube.com/?hl=en&gl=US', {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI; CONSENT=YES+1' },
    });
    const h = await r.text();
    const key = h.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const ver = h.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
    const vis = h.match(/"VISITOR_DATA":"([^"]+)"/);
    if (key) CFG.key = key[1];
    if (ver) CFG.version = ver[1];
    if (vis) CFG.visitorData = vis[1];
  } catch (_) { /* pakai fallback */ }
  return CFG;
}

async function yt(endpoint, body, tries = 3) {
  const c = await bootstrap();
  const payload = {
    context: {
      client: {
        hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: c.version,
        visitorData: c.visitorData || undefined, timeZone: 'Asia/Jakarta',
      },
    },
    ...body,
  };
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?key=${c.key}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://www.youtube.com',
          referer: 'https://www.youtube.com/',
          'x-youtube-client-name': '1',
          'x-youtube-client-version': c.version,
          cookie: 'SOCS=CAI; CONSENT=YES+1',
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} pada ${endpoint}`);
      const j = await r.json();
      if (DEBUG && (endpoint !== 'next' || dbgCount < 1)) {
        fs.writeFileSync(`debug-${String(++dbgCount).padStart(2, '0')}-${endpoint.replace(/\W/g, '_')}.json`, JSON.stringify(j, null, 2));
      }
      return j;
    } catch (e) {
      err = e;
      await sleep(700 * (i + 1));
    }
  }
  throw err;
}

/* ---------- channel ---------- */

async function resolveChannelId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Input channel kosong');
  const idm = s.match(/(UC[\w-]{22})/);
  if (idm && (/^UC[\w-]{22}$/.test(s) || /\/channel\//.test(s))) return idm[1];

  let url;
  if (/^https?:\/\//i.test(s)) url = s;
  else if (/^(www\.|m\.)?youtube\.com/i.test(s)) url = 'https://' + s;
  else if (s.startsWith('@')) url = 'https://www.youtube.com/' + s;
  else url = 'https://www.youtube.com/@' + s.replace(/\s+/g, '');
  url = url.replace('://m.youtube.com', '://www.youtube.com');

  const r = await yt('navigation/resolve_url', { url });
  const id = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId;
  if (!id) throw new Error('Channel tidak ditemukan: ' + input);
  return id;
}

async function getChannel(channelId, warnings) {
  const data = await yt('browse', { browseId: channelId });
  const meta = findKey(data, 'channelMetadataRenderer') || {};
  const info = {
    id: meta.externalId || channelId,
    name: meta.title || null,
    handle: null,
    url: meta.channelUrl || `https://www.youtube.com/channel/${channelId}`,
    avatar: lastThumb(meta.avatar && meta.avatar.thumbnails),
    description: meta.description || null,
    createdAt: null,
    country: null,
    subscribers: null,
    subscribersText: null,
    totalViews: null,
    totalVideos: null,
    links: [],
  };

  const hm = (meta.vanityChannelUrl || '').match(/@[\w.\-%]+/);
  if (hm) info.handle = decodeURIComponent(hm[0]);

  // header (layout baru + layout lama)
  const parts = [];
  const cmv = findKey(data, 'contentMetadataViewModel');
  for (const row of (cmv && cmv.metadataRows) || []) {
    for (const p of row.metadataParts || []) parts.push(txt(p.text));
  }
  const legacy = findKey(data, 'c4TabbedHeaderRenderer');
  if (legacy) parts.push(txt(legacy.subscriberCountText), txt(legacy.videosCountText));
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('@')) info.handle = info.handle || p;
    else if (/subscriber/i.test(p)) { info.subscribersText = p; info.subscribers = toNum(p); }
    else if (/video/i.test(p)) info.totalVideos = toNum(p);
  }

  // tab About: tanggal dibuat, total views, negara, link
  try {
    let token;
    for (const ep of findAllKey(data, 'showEngagementPanelEndpoint')) {
      const t = findKey(ep, 'token');
      if (t) { token = t; break; }
    }
    if (!token) throw new Error('token about tidak ditemukan');
    const ab = await yt('browse', { continuation: token });
    const av = findKey(ab, 'aboutChannelViewModel');
    if (!av) throw new Error('aboutChannelViewModel kosong');
    info.createdAt = parseDate(txt(av.joinedDateText));
    info.totalViews = toNum(txt(av.viewCountText));
    info.country = av.country || null;
    const vc = toNum(txt(av.videoCountText));
    if (vc != null) info.totalVideos = vc;
    if (!info.description && av.description) info.description = av.description;
    const sc = txt(av.subscriberCountText);
    if (sc && info.subscribers == null) { info.subscribersText = sc; info.subscribers = toNum(sc); }
    info.links = (av.links || [])
      .map((l) => {
        const v = l.channelExternalLinkViewModel;
        return v ? { title: txt(v.title), url: txt(v.link) } : null;
      })
      .filter(Boolean);
  } catch (e) {
    warnings.push('Data About (tanggal dibuat / total views) gagal diambil: ' + e.message);
  }

  return { info, data };
}

/* ---------- daftar video ---------- */

function collectVideos(json) {
  const out = [];
  for (const n of walk(json)) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
    if (n.videoRenderer && n.videoRenderer.videoId) {
      out.push({ id: n.videoRenderer.videoId, duration: txt(n.videoRenderer.lengthText) || null });
    }
    if (n.lockupViewModel && /^[\w-]{11}$/.test(n.lockupViewModel.contentId || '')) {
      const badge = findKey(n.lockupViewModel, 'thumbnailBadgeViewModel');
      out.push({ id: n.lockupViewModel.contentId, duration: (badge && badge.text) || null });
    }
    if (n.reelItemRenderer && n.reelItemRenderer.videoId) {
      out.push({ id: n.reelItemRenderer.videoId, duration: null });
    }
    if (n.shortsLockupViewModel) {
      const s = n.shortsLockupViewModel;
      const rw = s.onTap && s.onTap.innertubeCommand && s.onTap.innertubeCommand.reelWatchEndpoint;
      const id = (rw && rw.videoId) || String(s.entityId || '').replace(/^shorts-shelf-item-/, '');
      if (/^[\w-]{11}$/.test(id)) out.push({ id, duration: null });
    }
  }
  return out;
}

function uniq(list) {
  const seen = new Set();
  return list.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
}

function nextToken(json) {
  const items = findAllKey(json, 'continuationItemRenderer');
  for (let i = items.length - 1; i >= 0; i--) {
    const t = findKey(items[i], 'token');
    if (t) return t;
  }
  return null;
}

function tabParams(channelData, name) {
  for (const t of findAllKey(channelData, 'tabRenderer')) {
    if (String(t.title || '').toLowerCase() === name) {
      const p = t.endpoint && t.endpoint.browseEndpoint && t.endpoint.browseEndpoint.params;
      if (p) return p;
    }
  }
  return FALLBACK_TABS[name === 'videos' ? 'videos' : 'shorts'];
}

async function listTab(channelId, params, limit) {
  let data = await yt('browse', { browseId: channelId, params });
  let items = collectVideos(data);
  let guard = 0;
  while (uniq(items).length < limit && guard++ < 6) {
    const token = nextToken(data);
    if (!token) break;
    data = await yt('browse', { continuation: token });
    items = items.concat(collectVideos(data));
  }
  return uniq(items).slice(0, limit);
}

/* ---------- detail per video ---------- */

async function getVideo(v) {
  const d = await yt('next', { videoId: v.id });
  const raw = JSON.stringify(d);
  const pri = findKey(d, 'videoPrimaryInfoRenderer') || {};
  const vvr = (pri.viewCount && pri.viewCount.videoViewCountRenderer) || {};

  let views = Number(vvr.originalViewCount);
  if (!views) views = toNum(txt(vvr.viewCount));
  if (views == null || isNaN(views)) views = null;

  const dm = raw.match(/"dateText":\{"simpleText":"([^"]+)"/);
  const pm = raw.match(/"(?:publishDate|uploadDate)":"(\d{4}-\d{2}-\d{2})/);
  const publishedAt = parseDate(txt(pri.dateText)) || parseDate(dm && dm[1]) || (pm && pm[1]) || null;

  let likes = null;
  const pats = [
    /"expandedLikeCountIfIndifferent":\{"content":"([^"]+)"/,
    /"likeCountIfIndifferent":\{"content":"([^"]+)"/,
    /along with ([\d.,]+[KMB]?) other people/i,
  ];
  for (const p of pats) {
    const m = raw.match(p);
    if (m) {
      likes = toNum(m[1]);
      if (likes != null) break;
    }
  }

  let comments = null;
  const ce = findKey(d, 'commentsEntryPointHeaderRenderer');
  if (ce) comments = toNum(txt(ce.commentCount));
  if (comments == null) {
    const cp = findAllKey(d, 'engagementPanelSectionListRenderer').find((p) => p.panelIdentifier === 'engagement-panel-comments-section');
    const ci = txt(cp && cp.header && cp.header.engagementPanelTitleHeaderRenderer && cp.header.engagementPanelTitleHeaderRenderer.contextualInfo);
    if (ci) comments = toNum(ci);
  }

  const eng = views > 0 ? round((((likes || 0) + (comments || 0)) / views) * 100) : null;
  return {
    id: v.id,
    url: v.type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
    type: v.type,
    title: txt(pri.title) || null,
    publishedAt,
    duration: v.duration || null,
    views,
    likes,
    comments,
    engagementRate: eng,
    viewsPerDay: publishedAt && views != null ? round(views / daysSince(publishedAt), 1) : null,
  };
}

/* ---------- statistik ---------- */

function summarize(list, subs) {
  const n = list.length;
  if (!n) return null;
  const sum = (k) => list.reduce((a, v) => a + (v[k] || 0), 0);
  const hasL = list.filter((v) => v.likes != null).length;
  const hasC = list.filter((v) => v.comments != null).length;
  const views = sum('views');
  const likes = sum('likes');
  const comments = sum('comments');
  const inter = likes + comments;
  return {
    videos: n,
    totalViews: views,
    avgViews: round(views / n, 0),
    avgLikes: hasL ? round(likes / hasL, 0) : null,
    avgComments: hasC ? round(comments / hasC, 0) : null,
    engagementRate: views > 0 ? round((inter / views) * 100) : null,
    likesPer1000Views: views > 0 ? round((likes / views) * 1000) : null,
    commentsPer1000Views: views > 0 ? round((comments / views) * 1000) : null,
    interactionPer1000Views: views > 0 ? round((inter / views) * 1000) : null,
    viewsPer1000Subscribers: subs ? round((views / n / subs) * 1000) : null,
    engagementRateBySubscribers: subs ? round((inter / n / subs) * 100) : null,
  };
}

/* ---------- utama ---------- */

async function ytstalk(input, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || MAX_LIMIT, 1), MAX_LIMIT);
  if (opts.debug) DEBUG = true;
  const warnings = [];

  log('[1/4] Mencari channel...');
  const channelId = await resolveChannelId(input);
  const { info, data } = await getChannel(channelId, warnings);

  log('[2/4] Mengambil daftar video & Shorts...');
  const [longList, shortList] = await Promise.all([
    listTab(channelId, tabParams(data, 'videos'), limit).catch((e) => (warnings.push('Tab Videos gagal: ' + e.message), [])),
    listTab(channelId, tabParams(data, 'shorts'), limit).catch((e) => (warnings.push('Tab Shorts gagal: ' + e.message), [])),
  ]);
  const cand = uniq([
    ...longList.map((v) => ({ ...v, type: 'video' })),
    ...shortList.map((v) => ({ ...v, type: 'short' })),
  ]);

  log(`[3/4] Mengambil detail ${cand.length} video...`);
  const detail = await pool(cand, 6, getVideo);
  const failed = detail.filter((d) => d && d.error).length;
  if (failed) warnings.push(`${failed} video gagal diambil detailnya`);

  const videos = detail
    .filter((d) => d && !d.error)
    .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
    .slice(0, limit);

  log('[4/4] Menghitung statistik...');
  const subs = info.subscribers;
  const longV = videos.filter((v) => v.type === 'video');
  const shortV = videos.filter((v) => v.type === 'short');
  const sl = summarize(shortV, subs);
  const lf = summarize(longV, subs);

  return {
    status: true,
    fetchedAt: new Date().toISOString(),
    channel: info,
    stats: {
      subscribers: info.subscribers,
      totalViews: info.totalViews,
      totalVideos: info.totalVideos,
      analyzedVideos: videos.length,
    },
    engagement: summarize(videos, subs),
    shortsVsLong: {
      longForm: lf,
      shorts: sl,
      higherAvgViews: lf && sl ? (sl.avgViews > lf.avgViews ? 'shorts' : 'longForm') : null,
      higherEngagement: lf && sl && lf.engagementRate != null && sl.engagementRate != null ? (sl.engagementRate > lf.engagementRate ? 'shorts' : 'longForm') : null,
    },
    videos,
    warnings,
  };
}

module.exports = ytstalk;
ytstalk._internal = { toNum, parseDate, collectVideos, summarize, nextToken };

if (require.main === module) {
  const argv = process.argv.slice(2);
  let input;
  let limit = MAX_LIMIT;
  let out;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') limit = parseInt(argv[++i], 10) || MAX_LIMIT;
    else if (a === '--out') out = argv[++i];
    else if (a === '--debug') DEBUG = true;
    else if (!input) input = a;
  }
  if (!input) {
    console.log('Pemakaian: node ytstalk.js <url|@handle|channelId> [--limit 50] [--out hasil.json] [--debug]');
    process.exit(1);
  }
  ytstalk(input, { limit })
    .then((res) => {
      const json = JSON.stringify(res, null, 2);
      if (out) fs.writeFileSync(out, json);
      console.log(json);
    })
    .catch((e) => {
      console.error(JSON.stringify({ status: false, error: e.message }, null, 2));
      process.exit(1);
    });
}
