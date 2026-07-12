#!/usr/bin/env node

/**
 * Adds valid VideoObject schema to existing Ghost video posts without touching
 * their editorial content, tags, or publication dates.
 *
 * Usage:
 *   node scripts/backfill-video-schema.js --dry-run
 *   node scripts/backfill-video-schema.js --apply
 */

const jwt = require('jsonwebtoken');
require('./load-env');

const BASE = process.env.GHOST_URL;
const ID = process.env.GHOST_ADMIN_KEY_ID;
const SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const START = '<!-- beatpass-video-schema:start -->';
const END = '<!-- beatpass-video-schema:end -->';

function token() {
  return jwt.sign({}, Buffer.from(SECRET, 'hex'), {
    keyid: ID,
    algorithm: 'HS256',
    expiresIn: '5m',
    audience: '/admin/'
  });
}

async function api(method, endpoint, data = null) {
  const options = {
    method,
    headers: {
      Authorization: `Ghost ${token()}`,
      'Content-Type': 'application/json'
    }
  };
  if (data) options.body = JSON.stringify(data);
  const response = await fetch(`${BASE}/ghost/api/admin/${endpoint}`, options);
  if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${await response.text()}`);
  return response.json();
}

function isVideoPost(post) {
  return (post.tags || []).some((tag) => tag.slug === 'hash-video' || tag.name === '#video');
}

function sourceText(post) {
  return [post.lexical || '', typeof post.mobiledoc === 'string' ? post.mobiledoc : JSON.stringify(post.mobiledoc || {})].join(' ');
}

function youtubeId(value) {
  return value.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] || null;
}

function trackUrl(value) {
  return value.match(/https:\/\/open\.beatpass\.ca\/track\/[^\s)"']+/)?.[0] || null;
}

function isoDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${secs}S`;
}

async function youtubeMeta(id) {
  const response = await fetch(`https://www.youtube.com/watch?v=${id}`);
  if (!response.ok) throw new Error(`YouTube ${id}: HTTP ${response.status}`);
  const html = await response.text();
  const uploadDate = html.match(/<meta itemprop="uploadDate" content="([^"<]+)"/i)?.[1] || null;
  const seconds = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1]);
  return { uploadDate, duration: isoDuration(seconds) };
}

function videoSchema(post, id, track, meta) {
  const value = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: post.title,
    description: post.custom_excerpt || `Watch ${post.title} and listen on BeatPass.`,
    thumbnailUrl: [post.feature_image || `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`],
    uploadDate: meta.uploadDate || post.published_at,
    embedUrl: `https://www.youtube.com/embed/${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    ...(meta.duration ? { duration: meta.duration } : {}),
    ...(track ? { relatedLink: track } : {})
  };
  return `${START}\n<script type="application/ld+json">${JSON.stringify(value)}</script>\n${END}`;
}

function replaceSchema(existing, next) {
  const stripped = (existing || '').replace(new RegExp(`${START}[\\s\\S]*?${END}\\n?`, 'g'), '').trim();
  return [stripped, next].filter(Boolean).join('\n');
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fields = 'id,title,slug,status,published_at,updated_at,lexical,mobiledoc,feature_image,custom_excerpt,codeinjection_head';
  const data = await api('GET', `posts/?limit=all&status=all&include=tags&fields=${fields}`);
  const videos = (data.posts || []).filter(isVideoPost);
  const candidates = videos.map((post) => ({ post, source: sourceText(post) })).map((item) => ({ ...item, id: youtubeId(item.source), track: trackUrl(item.source) }));
  const eligible = candidates.filter((item) => item.id);
  const skipped = candidates.filter((item) => !item.id);
  const alreadySchema = eligible.filter((item) => (item.post.codeinjection_head || '').includes(START));
  const needsSchema = eligible.filter((item) => !(item.post.codeinjection_head || '').includes(START));
  const prepared = await mapLimit(needsSchema, 3, async (item) => {
    try {
      const meta = await youtubeMeta(item.id);
      const next = replaceSchema(item.post.codeinjection_head, videoSchema(item.post, item.id, item.track, meta));
      return { ...item, next, changed: next !== item.post.codeinjection_head };
    } catch (error) {
      return { ...item, error: error.message };
    }
  });

  const updates = prepared.filter((item) => item.changed);
  const unchanged = [...alreadySchema, ...prepared.filter((item) => !item.changed && !item.error)];
  const failed = prepared.filter((item) => item.error);
  console.log(apply ? '═══ APPLYING VIDEO SCHEMA BACKFILL ═══' : '═══ DRY RUN — NO GHOST CHANGES ═══');
  console.log(JSON.stringify({ videos: videos.length, eligible: eligible.length, updates: updates.length, unchanged: unchanged.length, no_youtube_id: skipped.length, metadata_failed: failed.length }, null, 2));
  for (const item of [...skipped, ...failed]) console.log(`SKIP ${item.post.slug}: ${item.error || 'no YouTube ID'}`);
  if (!apply) return;

  for (const item of updates) {
    await api('PUT', `posts/${item.post.id}/`, { posts: [{ updated_at: item.post.updated_at, codeinjection_head: item.next }] });
    console.log(`✓ ${item.post.slug}`);
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
