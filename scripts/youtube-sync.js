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
const TRACK_LINK_RE = /https?:\/\/open\.beatpass\.ca\/track\/(\d+)(?:\/[^\s)\]]+)?/i;
const BLOG_LINK_RE = /https?:\/\/blog\.beatpass\.ca\/[\S)\]]+/i;
const PODCAST_MARKER_RE = /(?:^|\s)#(?:podcast|beatpasspodcast|bp_podcast)\b/i;
const PODCAST_KEYWORD_RE = /\bpodcast\b|\bepisode\b|\bep\.?\s*\d+\b/i;

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

function createSkipError(reason) {
  const err = new Error(reason);
  err.code = 'SKIP_VIDEO';
  return err;
}

function getSkipReason(desc, title) {
  const safeDesc = desc || '';
  const safeTitle = title || '';
  const text = `${safeTitle}\n${safeDesc}`;

  const hasTrackLink = TRACK_LINK_RE.test(safeDesc);
  const hasBlogLink = BLOG_LINK_RE.test(safeDesc);
  const hasPodcastMarker = PODCAST_MARKER_RE.test(text);
  const hasPodcastKeyword = PODCAST_KEYWORD_RE.test(text);

  if (hasPodcastMarker) {
    return 'Podcast marker detected (#podcast / #beatpasspodcast)';
  }
  if (!hasTrackLink && hasBlogLink) {
    return 'Blog link present but no BeatPass track link';
  }
  if (!hasTrackLink && hasPodcastKeyword) {
    return 'Podcast-style title/description and no BeatPass track link';
  }
  if (!hasTrackLink) {
    return 'No BeatPass track link found (open.beatpass.ca/track/...)';
  }
  return null;
}

function tagMatches(tag, { name, slug }) {
  return (!!name && tag?.name === name) || (!!slug && tag?.slug === slug);
}

function isVideoTag(tag) {
  return (
    tagMatches(tag, { name: '#video', slug: 'hash-video' }) ||
    tagMatches(tag, { name: 'Videos', slug: 'youtube' }) ||
    tagMatches(tag, { slug: 'videos' })
  );
}

function isPreviewTag(tag) {
  return tagMatches(tag, { name: '#video-preview', slug: 'hash-video-preview' });
}

function isVideoPost(post) {
  return (post.tags || []).some(isVideoTag);
}

function isTimelineVideoPost(post) {
  return isVideoPost(post) && !!post.published_at && ['published', 'scheduled'].includes(post.status);
}

function buildVideoTags(includePreviewTag) {
  const tags = [
    { name: '#video' },
    { name: 'Videos' }
  ];
  if (includePreviewTag) tags.splice(1, 0, { name: '#video-preview' });
  return tags;
}

function shouldUsePreviewTag(videoTimelineCount) {
  // Keep preview tags on every third video in chronological order.
  return videoTimelineCount % 3 === 0;
}

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

async function fetchGhostVideoPosts(fields = 'id,status,published_at,updated_at,mobiledoc,html') {
  const ghostPosts = await ghostAPI('GET', `posts/?limit=all&status=all&include=tags&fields=${fields}`);
  return (ghostPosts.posts || []).filter(isVideoPost);
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
  // Also extract video title
  const titleMatch = html.match(/"title":"((?:[^"\\]|\\.)*)"/);
  const title = titleMatch ? titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;

  const match = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  const uploadDateMatch = html.match(/<meta itemprop="uploadDate" content="([^"<]+)"/i);
  const uploadDate = uploadDateMatch ? uploadDateMatch[1] : null;
  const durationSeconds = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1]);
  const youtubeDuration = Number.isFinite(durationSeconds)
    ? `PT${Math.floor(durationSeconds / 3600) ? `${Math.floor(durationSeconds / 3600)}H` : ''}${Math.floor((durationSeconds % 3600) / 60) ? `${Math.floor((durationSeconds % 3600) / 60)}M` : ''}${durationSeconds % 60}S`
    : null;
  if (!match) return { desc: '', title, uploadDate, youtubeDuration };

  const desc = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  return { desc, title, uploadDate, youtubeDuration };
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
  const trackUrlMatch = desc.match(TRACK_LINK_RE);
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
  md += `## License this beat cleanly\n\n`;
  md += `On BeatPass, eligible downloads include [standardized license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive) and access to [license proof](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates) inside your library.\n\n`;
  md += `If you are releasing a song, keep your license certificate with the project so you can show proof later if a distributor, platform, collaborator, or rights team asks.\n\n`;
  md += `Useful guides:\n\n`;
  md += `- [How BeatPass licenses work](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive)\n`;
  md += `- [How to verify BeatPass licenses](https://blog.beatpass.ca/how-to-verify-beat-licenses/)\n`;
  md += `- [Beat licensing explained](https://blog.beatpass.ca/beat-licensing-explained/)\n\n`;
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

function buildVideoSchema(data, title, featureImage, uploadDate, youtubeDuration) {
  const schema = {
    '@context': 'https://schema.org', '@type': 'VideoObject', name: title,
    description: `Watch ${title} and listen on BeatPass.`,
    thumbnailUrl: [featureImage || `https://i.ytimg.com/vi/${data.videoId}/maxresdefault.jpg`],
    uploadDate: uploadDate || new Date().toISOString(),
    embedUrl: `https://www.youtube.com/embed/${data.videoId}`,
    url: `https://www.youtube.com/watch?v=${data.videoId}`,
    ...(youtubeDuration ? { duration: youtubeDuration } : {}),
    relatedLink: data.trackUrl
  };
  return `<!-- beatpass-video-schema:start -->\n<script type="application/ld+json">${JSON.stringify(schema)}</script>\n<!-- beatpass-video-schema:end -->`;
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

async function processVideo(videoId, status, publishedAt = null, includePreviewTag = true) {
  // 1. Description + title from watch page (also used for skip filtering)
  const { desc, title: pageTitle, uploadDate, youtubeDuration } = await getVideoDescription(videoId);
  await delay(300);

  const skipReason = getSkipReason(desc, pageTitle);
  if (skipReason) throw createSkipError(skipReason);

  // 2. oEmbed
  const oembed = await getOEmbed(videoId);
  await delay(300);

  const ytTitle = oembed?.title || pageTitle || '';

  // 3. Parse description
  const parsed = parseDescription(desc, ytTitle);
  if (!parsed.trackId || !parsed.trackUrl) {
    throw createSkipError('Could not parse BeatPass track link from description');
  }

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
    trackUrl: parsed.trackUrl,
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
      codeinjection_head: buildVideoSchema(articleData, naturalTitle, featureImage, uploadDate || publishedAt, youtubeDuration),
      status,
      tags: buildVideoTags(includePreviewTag)
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
    status,
    hasPreviewTag: includePreviewTag
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

  const state = loadState();
  const oldestFirst = [...landscape].reverse();
  let timelineVideoCount = 0;

  try {
    const ghostPosts = await fetchGhostVideoPosts('id,status,published_at');
    timelineVideoCount = ghostPosts.filter(isTimelineVideoPost).length;
  } catch (e) {
    log(`  ⚠ Could not inspect current video cadence: ${e.message}`);
  }

  for (const videoId of oldestFirst) {
    if (state.processed.includes(videoId)) {
      log(`  ○ ${videoId} — already processed`);
      continue;
    }

    log(`\nProcessing candidate video: ${videoId}`);
    try {
      const result = await processVideo(videoId, 'draft', null, shouldUsePreviewTag(timelineVideoCount));
      log(`  ✓ Created draft: "${result.title}" → slug: ${result.slug} [preview ${result.hasPreviewTag ? 'on' : 'off'}]`);
      log(`    Track: "${result.trackName}" by ${result.producer}`);
      state.processed.push(videoId);
      saveState(state);
      log('\nDone. Review the draft in Ghost Admin.');
      return;
    } catch (e) {
      if (e.code === 'SKIP_VIDEO') {
        log(`  ○ ${videoId} — skipped (${e.message})`);
        continue;
      }
      throw e;
    }
  }

  log('\nNo eligible unprocessed landscape videos found.');
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
  let timelineVideoCount = 0;
  try {
    const ghostPosts = await fetchGhostVideoPosts('id,status,published_at,mobiledoc,html');
    timelineVideoCount = ghostPosts.filter(isTimelineVideoPost).length;
    for (const p of ghostPosts) {
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
      const result = await processVideo(videoId, 'published', null, shouldUsePreviewTag(timelineVideoCount));
      log(`${num} ✓ "${result.title}" → ${result.slug} [preview ${result.hasPreviewTag ? 'on' : 'off'}]`);
      state.processed.push(videoId);
      saveState(state);
      created++;
      timelineVideoCount++;
    } catch (e) {
      if (e.code === 'SKIP_VIDEO') {
        log(`${num} ○ ${videoId} — skipped (${e.message})`);
        skipped++;
        continue;
      }
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
  let timelineVideoCount = 0;
  try {
    const ghostPosts = await fetchGhostVideoPosts('id,status,published_at,mobiledoc,html');
    timelineVideoCount = ghostPosts.filter(isTimelineVideoPost).length;
    for (const p of ghostPosts) {
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
  let skipped = 0;

  for (const entry of rssEntries) {
    if (state.processed.includes(entry.videoId) || existingVideoIds.has(entry.videoId)) continue;

    try {
      const scheduleISO = nextScheduleDate.toISOString();
      const result = await processVideo(
        entry.videoId,
        'scheduled',
        scheduleISO,
        shouldUsePreviewTag(timelineVideoCount)
      );
      log(`  ✓ Scheduled: "${result.title}" → ${result.slug} (${scheduleISO}) [preview ${result.hasPreviewTag ? 'on' : 'off'}]`);
      state.processed.push(entry.videoId);
      saveState(state);
      created++;
      timelineVideoCount++;
      // Advance to the next day for subsequent videos
      nextScheduleDate.setDate(nextScheduleDate.getDate() + 1);
    } catch (e) {
      if (e.code === 'SKIP_VIDEO') {
        log(`  ○ ${entry.videoId} — skipped (${e.message})`);
        skipped++;
        continue;
      }
      log(`  ✗ ${entry.videoId} — ${e.message}`);
    }
  }

  if (created === 0 && skipped === 0) log('  No new videos to sync.');
  else if (created === 0) log(`  No eligible new videos to sync. Skipped ${skipped} podcast/non-track video(s).`);
  else log(`  ${created} new video(s) scheduled. Skipped ${skipped} podcast/non-track video(s).`);
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
