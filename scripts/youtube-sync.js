#!/usr/bin/env node

/**
 * YouTube → Ghost sync for @beatpasswav landscape videos.
 *
 * Usage:
 *   node youtube-sync.js --test      → 1 draft (oldest video) for review
 *   node youtube-sync.js --backfill  → all landscape videos as drafts (oldest first)
 *   node youtube-sync.js             → cron sync: RSS, auto-publish new landscape videos
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('./load-env');

// ── Config ─────────────────────────────────────────────────────────────────────

const GHOST_URL = process.env.GHOST_URL;
const ADMIN_KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const ADMIN_KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE;
const BEATPASS_API = 'https://open.beatpass.ca/api/v1';
const STATE_FILE = path.join(__dirname, 'youtube-sync-state.json');
const LOG_PREFIX = () => `[${new Date().toISOString()}]`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJSON(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { processed: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function log(msg) { console.log(`${LOG_PREFIX()} ${msg}`); }

// ── Ghost API ──────────────────────────────────────────────────────────────────

function createToken() {
  return jwt.sign({}, Buffer.from(ADMIN_KEY_SECRET, 'hex'), {
    keyid: ADMIN_KEY_ID, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/'
  });
}

async function ghostAPI(method, endpoint, data = null) {
  const token = createToken();
  const url = `${GHOST_URL}/ghost/api/admin/${endpoint}`;
  const options = {
    method,
    headers: { 'Authorization': `Ghost ${token}`, 'Content-Type': 'application/json' },
  };
  if (data) options.body = JSON.stringify(data);
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Ghost ${method} ${endpoint}: ${res.status} — ${err.errors?.[0]?.message || JSON.stringify(err)}`);
  }
  return res.json();
}

// ── YouTube: Scrape channel tabs ───────────────────────────────────────────────

async function scrapeChannelTab(tab) {
  const url = `https://www.youtube.com/@${CHANNEL_HANDLE}/${tab}`;
  const html = await fetchText(url);
  const ids = new Set();

  for (const m of html.matchAll(/"videoId":"([^"]+)"/g)) ids.add(m[1]);

  // Pagination via innertube
  const contMatch = html.match(/"continuationCommand":\{"token":"([^"]+)"/);
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (contMatch && apiKeyMatch) {
    let token = contMatch[1];
    let page = 0;
    while (token && page < 20) {
      try {
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKeyMatch[1]}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20240101' } },
            continuation: token
          })
        });
        const json = await resp.json();
        const jsonStr = JSON.stringify(json);
        let newCount = 0;
        for (const m of jsonStr.matchAll(/"videoId":"([^"]+)"/g)) {
          if (!ids.has(m[1])) { ids.add(m[1]); newCount++; }
        }
        const next = jsonStr.match(/"continuationCommand":\{"token":"([^"]+)"/);
        token = next ? next[1] : null;
        page++;
        if (newCount === 0 && !token) break;
        await delay(300);
      } catch { break; }
    }
  }
  return ids;
}

// ── YouTube: RSS feed ──────────────────────────────────────────────────────────

async function fetchRSSVideos() {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const vidMatch = block.match(/<yt:videoId>([^<]+)/);
    const linkMatch = block.match(/<link rel="alternate" href="([^"]+)"/);
    const pubMatch = block.match(/<published>([^<]+)/);
    if (vidMatch && linkMatch) {
      const isLandscape = linkMatch[1].includes('/watch?v=');
      if (isLandscape) {
        entries.push({
          videoId: vidMatch[1],
          published: pubMatch ? pubMatch[1] : null
        });
      }
    }
  }
  return entries;
}

// ── YouTube: Get description from watch page ───────────────────────────────────

async function getVideoDescription(videoId) {
  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
  const match = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!match) return { desc: null, title: null };

  const desc = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  // Also extract video title
  const titleMatch = html.match(/"title":"((?:[^"\\]|\\.)*)"/);
  const title = titleMatch ? titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;

  return { desc, title };
}

// ── YouTube: oEmbed ────────────────────────────────────────────────────────────

async function getOEmbed(videoId) {
  return fetchJSON(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
}

// ── Parse YouTube description ──────────────────────────────────────────────────

function parseDescription(desc, videoTitle) {
  if (!desc) return {};
  const lines = desc.split('\n');

  // Track URL + ID
  const trackUrlMatch = desc.match(/https?:\/\/open\.beatpass\.ca\/track\/(\d+)\/([^\s]+)/);
  const trackUrl = trackUrlMatch ? trackUrlMatch[0] : null;
  const trackId = trackUrlMatch ? parseInt(trackUrlMatch[1]) : null;

  // BPM: try description line 1 first, then video title as fallback
  let bpm = null;
  const bpmDesc = lines[0]?.match(/(\d{2,3})\s*BPM/i);
  if (bpmDesc) {
    bpm = parseInt(bpmDesc[1]);
  } else if (videoTitle) {
    const bpmTitle = videoTitle.match(/(\d{2,3})\s*BPM/i);
    if (bpmTitle) bpm = parseInt(bpmTitle[1]);
  }

  // Producer Instagram (not beatpass.wav)
  const igMatch = desc.match(/https?:\/\/(?:www\.)?instagram\.com\/(?!beatpass\.wav)([^\s/]+)/);
  const producerInstagram = igMatch ? igMatch[0].replace(/\/$/, '') : null;

  // Producer YouTube (not beatpasswav or beatpass channel)
  const ytMatches = [...desc.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/(?!@?beatpasswav)(@[^\s/]+|channel\/[^\s/]+)/g)];
  const producerYoutube = ytMatches.length > 0 ? ytMatches[0][0].replace(/\/$/, '') : null;

  // Fallback track name + genre from line 1
  const line1Parts = lines[0]?.split(' - ') || [];
  const fallbackTrackName = line1Parts[0]?.trim() || null;
  const fallbackGenre = line1Parts.length >= 2
    ? line1Parts.slice(1).join(' - ').replace(/\d{2,3}\s*BPM/i, '').replace(/\s*-\s*$/, '').trim()
    : null;

  return { trackUrl, trackId, bpm, producerInstagram, producerYoutube, fallbackTrackName, fallbackGenre };
}

// ── BeatPass API ───────────────────────────────────────────────────────────────

async function fetchBeatPassTrack(trackId) {
  try {
    const data = await fetchJSON(`${BEATPASS_API}/tracks/${trackId}`);
    const t = data.track;
    return {
      name: t.name,
      image: t.image,
      duration: t.duration_text,
      genres: t.genres.map(g => g.display_name),
      artists: t.artists.map(a => ({ name: a.name, id: a.id }))
    };
  } catch (e) {
    log(`  ⚠ BeatPass API failed for track ${trackId}: ${e.message}`);
    return null;
  }
}

// ── Title generation ───────────────────────────────────────────────────────────

function buildNaturalTitle(trackName, producer, ytTitle) {
  // Extract genre from YouTube title prefix (before |)
  let genre = '';
  if (ytTitle) {
    const pipeIdx = ytTitle.indexOf('|');
    if (pipeIdx > 0) {
      genre = ytTitle.substring(0, pipeIdx).trim();
      // Title-case it: "AFRO HOUSE" → "Afro House"
      genre = genre.split(/\s+/).map(w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      ).join(' ');
    }
  }

  if (genre) {
    return `${trackName} — ${genre} Beat by ${producer}`;
  }
  return `${trackName} — Beat by ${producer}`;
}

// ── Article content generation ─────────────────────────────────────────────────

function buildArticleMarkdown(data) {
  const { trackName, genres, bpm, duration, producer, producerInstagram, producerYoutube, producerId, trackUrl } = data;

  const genreStr = genres.join(' / ');
  const bpmStr = bpm ? `${bpm} BPM` : null;
  const producerLibraryUrl = producerId
    ? `https://open.beatpass.ca/artist/${producerId}/${producer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}`
    : null;

  // Rotate intro templates
  const templateIdx = data.videoId.charCodeAt(0) % 6;
  const intros = [
    () => `${trackName} is a ${[bpmStr, genreStr].filter(Boolean).join(' ')} instrumental by **${producer}**${duration ? `, running ${duration}` : ''}.`,
    () => `**${producer}** brings ${trackName} — a ${genreStr} beat${bpmStr ? ` at ${bpmStr}` : ''}${duration ? ` (${duration})` : ''}.`,
    () => `Check out ${trackName}, a fresh ${genreStr} instrumental from **${producer}**${bpmStr ? ` (${bpmStr})` : ''}.`,
    () => bpmStr
      ? `At ${bpmStr}, ${trackName} is a ${genreStr} beat by **${producer}** that sets the tone.`
      : `${trackName} is a ${genreStr} beat by **${producer}** that sets the tone.`,
    () => `Producer **${producer}** delivers ${trackName} — ${[bpmStr, `pure ${genreStr} energy`].filter(Boolean).join(' of ')}.`,
    () => `Looking for a ${genreStr} beat? ${trackName} by **${producer}**${bpmStr ? ` hits at ${bpmStr}` : ' delivers'}.`,
  ];

  const intro = intros[templateIdx]();

  let md = `## ${trackName}\n\n${intro}\n\n`;
  md += `### Stream on BeatPass\n\n`;
  md += `[Listen to "${trackName}" on BeatPass](${trackUrl})\n\n`;
  md += `### About the Producer\n\n`;
  md += `**${producer}** is a featured producer on BeatPass.\n\n`;

  const socials = [];
  if (producerInstagram) socials.push(`- [Instagram](${producerInstagram})`);
  if (producerYoutube) socials.push(`- [YouTube](${producerYoutube})`);
  if (producerLibraryUrl) socials.push(`- [Browse all beats by ${producer} on BeatPass](${producerLibraryUrl})`);
  if (socials.length) md += socials.join('\n') + '\n\n';

  md += `---\n\n`;
  md += `*Interested in exclusive rights or a custom beat? [Get in touch](https://www.instagram.com/beatpass.wav/).*`;

  return md;
}

function buildMobiledoc(videoId, oembedHtml, articleMarkdown) {
  return JSON.stringify({
    version: '0.3.1',
    markups: [],
    atoms: [],
    cards: [
      ['embed', {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        html: oembedHtml,
        type: 'video'
      }],
      ['markdown', { markdown: articleMarkdown }]
    ],
    sections: [[10, 0], [10, 1]]
  });
}

// ── Process a single video ─────────────────────────────────────────────────────

async function processVideo(videoId, status, publishedAt = null) {
  // 1. oEmbed
  const oembed = await getOEmbed(videoId);
  await delay(300);

  // 2. Description + title from watch page
  const { desc, title: pageTitle } = await getVideoDescription(videoId);
  await delay(300);

  // 3. Parse description
  const parsed = parseDescription(desc, oembed?.title || pageTitle);

  // 4. BeatPass API
  let bpTrack = null;
  if (parsed.trackId) {
    bpTrack = await fetchBeatPassTrack(parsed.trackId);
    await delay(300);
  }

  // 5. Assemble final data
  const trackName = bpTrack?.name || parsed.fallbackTrackName || 'Untitled';
  const genres = bpTrack?.genres || (parsed.fallbackGenre ? [parsed.fallbackGenre] : []);
  const producer = bpTrack?.artists?.[0]?.name || 'Unknown';
  const producerId = bpTrack?.artists?.[0]?.id || null;
  const featureImage = bpTrack?.image || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  const ytTitle = oembed?.title || pageTitle || '';

  const articleData = {
    videoId,
    trackName,
    genres,
    bpm: parsed.bpm,
    duration: bpTrack?.duration || null,
    producer,
    producerId,
    producerInstagram: parsed.producerInstagram,
    producerYoutube: parsed.producerYoutube,
    trackUrl: parsed.trackUrl || `https://open.beatpass.ca/track/${parsed.trackId}`,
  };

  // 6. Build content
  const markdown = buildArticleMarkdown(articleData);
  const mobiledoc = buildMobiledoc(videoId, oembed.html, markdown);

  // 7. Create Ghost post
  const naturalTitle = buildNaturalTitle(trackName, producer, ytTitle);
  const postPayload = {
      title: naturalTitle,
      mobiledoc,
      feature_image: featureImage,
      status,
      tags: [
        { name: '#video' },
        { name: '#video-preview' },
        { name: 'Videos' }
      ]
  };
  if (publishedAt) postPayload.published_at = publishedAt;
  const postData = { posts: [postPayload] };

  const result = await ghostAPI('POST', 'posts/', postData);
  await delay(500);

  return {
    postId: result.posts[0].id,
    slug: result.posts[0].slug,
    title: result.posts[0].title,
    trackName,
    producer,
    status
  };
}

// ── Modes ──────────────────────────────────────────────────────────────────────

async function getAllLandscapeIds() {
  log('Fetching /videos tab...');
  const videoIds = await scrapeChannelTab('videos');
  log(`  Found ${videoIds.size} video IDs`);

  log('Fetching /shorts tab...');
  const shortIds = await scrapeChannelTab('shorts');
  log(`  Found ${shortIds.size} short IDs`);

  const landscape = [...videoIds].filter(id => !shortIds.has(id));
  log(`  Landscape: ${landscape.length} videos`);
  return landscape;
}

async function runTest() {
  log('═══ TEST MODE: Creating 1 draft (oldest video) ═══');

  const landscape = await getAllLandscapeIds();
  if (landscape.length === 0) { log('No landscape videos found.'); return; }

  // Oldest = last in the array (channel page returns newest first)
  const oldest = landscape[landscape.length - 1];
  log(`\nProcessing oldest video: ${oldest}`);

  const state = loadState();
  if (state.processed.includes(oldest)) {
    log(`  Already processed. Skipping.`);
    return;
  }

  const result = await processVideo(oldest, 'draft');
  log(`  ✓ Created draft: "${result.title}" → slug: ${result.slug}`);
  log(`    Track: "${result.trackName}" by ${result.producer}`);

  state.processed.push(oldest);
  saveState(state);
  log('\nDone. Review the draft in Ghost Admin.');
}

async function runBackfill() {
  log('═══ BACKFILL MODE: Publishing all landscape videos ═══');

  const landscape = await getAllLandscapeIds();
  if (landscape.length === 0) { log('No landscape videos found.'); return; }

  // Reverse for oldest-first
  const sorted = [...landscape].reverse();
  const state = loadState();

  // Also check Ghost for existing video posts
  let existingVideoIds = new Set();
  try {
    const ghostPosts = await ghostAPI('GET', 'posts/?filter=tag:youtube&limit=all&status=all&fields=mobiledoc,html,id');
    for (const p of (ghostPosts.posts || [])) {
      const content = (p.mobiledoc || '') + (p.html || '');
      for (const id of sorted) {
        if (content.includes(id)) existingVideoIds.add(id);
      }
    }
  } catch (e) {
    log(`  ⚠ Could not check Ghost for existing posts: ${e.message}`);
  }

  let created = 0, skipped = 0, failed = 0;

  for (let i = 0; i < sorted.length; i++) {
    const videoId = sorted[i];
    const num = `[${i + 1}/${sorted.length}]`;

    if (state.processed.includes(videoId) || existingVideoIds.has(videoId)) {
      log(`${num} ○ ${videoId} — already processed, skipping`);
      skipped++;
      continue;
    }

    try {
      const result = await processVideo(videoId, 'published');
      log(`${num} ✓ "${result.title}" → ${result.slug}`);
      state.processed.push(videoId);
      saveState(state);
      created++;
    } catch (e) {
      log(`${num} ✗ ${videoId} — ${e.message}`);
      failed++;
    }
  }

  log(`\nBackfill complete: ${created} published, ${skipped} skipped, ${failed} failed`);
}

async function runSync() {
  log('═══ SYNC MODE: Checking RSS for new landscape videos ═══');

  const state = loadState();
  const rssEntries = await fetchRSSVideos();
  log(`  RSS returned ${rssEntries.length} landscape videos`);

  // Check Ghost for existing posts (published, scheduled, and drafts) to avoid duplicates
  let existingVideoIds = new Set();
  let latestScheduledDate = null;
  try {
    const ghostPosts = await ghostAPI('GET', 'posts/?filter=tag:youtube&limit=all&status=all&fields=mobiledoc,html,id,status,published_at');
    for (const p of (ghostPosts.posts || [])) {
      const content = (p.mobiledoc || '') + (p.html || '');
      for (const e of rssEntries) {
        if (content.includes(e.videoId)) existingVideoIds.add(e.videoId);
      }
      // Track the latest scheduled post date so we queue after it
      if (p.status === 'scheduled' && p.published_at) {
        const d = new Date(p.published_at);
        if (!latestScheduledDate || d > latestScheduledDate) latestScheduledDate = d;
      }
    }
  } catch (e) {
    log(`  ⚠ Ghost check failed: ${e.message}`);
  }

  // Determine the first available schedule date (next day after the latest scheduled post, or tomorrow)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0); // Schedule at noon

  let nextScheduleDate;
  if (latestScheduledDate && latestScheduledDate >= tomorrow) {
    nextScheduleDate = new Date(latestScheduledDate);
    nextScheduleDate.setDate(nextScheduleDate.getDate() + 1);
    nextScheduleDate.setHours(12, 0, 0, 0);
  } else {
    nextScheduleDate = tomorrow;
  }

  let created = 0;

  for (const entry of rssEntries) {
    if (state.processed.includes(entry.videoId) || existingVideoIds.has(entry.videoId)) continue;

    try {
      const scheduleISO = nextScheduleDate.toISOString();
      const result = await processVideo(entry.videoId, 'scheduled', scheduleISO);
      log(`  ✓ Scheduled: "${result.title}" → ${result.slug} (${scheduleISO})`);
      state.processed.push(entry.videoId);
      saveState(state);
      created++;
      // Advance to the next day for subsequent videos
      nextScheduleDate.setDate(nextScheduleDate.getDate() + 1);
    } catch (e) {
      log(`  ✗ ${entry.videoId} — ${e.message}`);
    }
  }

  if (created === 0) log('  No new videos to sync.');
  else log(`  ${created} new video(s) scheduled.`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    await runTest();
  } else if (args.includes('--backfill')) {
    await runBackfill();
  } else {
    await runSync();
  }
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
