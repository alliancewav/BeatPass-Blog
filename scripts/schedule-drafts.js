#!/usr/bin/env node

/**
 * Schedule all draft posts (articles + videos) in a well-mixed order.
 * 2 posts per day at 10 AM and 4 PM EST (15:00 and 21:00 UTC).
 * Starting Feb 8, 2026.
 */

const jwt = require('jsonwebtoken');
require('./load-env');

const GHOST_URL = process.env.GHOST_URL;
const KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;

function createToken() {
  return jwt.sign({}, Buffer.from(KEY_SECRET, 'hex'), {
    keyid: KEY_ID, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/'
  });
}

async function api(method, endpoint, data) {
  const token = createToken();
  const opts = { method, headers: { 'Authorization': 'Ghost ' + token, 'Content-Type': 'application/json' } };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(GHOST_URL + '/ghost/api/admin/' + endpoint, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`${res.status}: ${e.errors?.[0]?.message || JSON.stringify(e)}`);
  }
  return res.json();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Article ordering by content strategy phases
const ARTICLE_ORDER = {
  // Phase 1 — foundational
  '6986f1eb8676cf914e263d64': 1,  // Non-Exclusive vs Exclusive Beats
  '6986f1ed8676cf914e263d93': 2,  // How to Make Beats: Complete Beginner's Guide
  '6986f1ec8676cf914e263d77': 3,  // YouTube Content ID and Beats
  '6986f1ee8676cf914e263d9c': 4,  // Best Beat Making Software
  '6986f2508676cf914e263e5a': 5,  // Where to Find Free Beats
  '6986f1f18676cf914e263dbf': 6,  // How to Record a Song at Home
  '6986f2508676cf914e263e63': 7,  // How to Release a Song
  '6986f1f28676cf914e263dc8': 8,  // How to Write Rap Lyrics
  '6986f2508676cf914e263e6c': 9,  // Royalty-Free Music vs Licensed Beats

  // Phase 2 — intermediate
  '6986f1ef8676cf914e263da5': 10, // How to Make a Type Beat
  '6986f1ef8676cf914e263dae': 11, // Mixing and Mastering Beats
  '6986f1f68676cf914e263e06': 12, // How to Promote Your Music
  '6986f1f68676cf914e263e0f': 13, // How to Get on Spotify Playlists
  '6986f1f98676cf914e263e33': 14, // What Are Type Beats
  '6986f1f98676cf914e263e3d': 15, // AI Music and Beat Making
  '6986f1fa8676cf914e263e46': 16, // Music Copyright Basics

  // Phase 3 — advanced/niche
  '6986f1eb8676cf914e263d6d': 17, // What Is a Beat Lease
  '6986f1ec8676cf914e263d80': 18, // Can You Release a Song With Non-Exclusive Beat
  '6986f1ed8676cf914e263d89': 19, // Sample Clearance Explained
  '6986f1f08676cf914e263db7': 20, // How to Make Beats on Your Phone
  '6986f1f38676cf914e263dd1': 21, // How to Find the Right Beat
  '6986f1f38676cf914e263dd9': 22, // How to Price Your Beats
  '6986f1f48676cf914e263de2': 23, // How Much Do Music Producers Make
  '6986f1f48676cf914e263deb': 24, // How to Build a Beat Catalog
  '6986f1f58676cf914e263df4': 25, // Passive Income for Music Producers
  '6986f1f58676cf914e263dfd': 26, // How to Get Your First Beat Sale
  '6986f1f78676cf914e263e18': 27, // TikTok Music Promotion
  '6986f1f88676cf914e263e21': 28, // How to Brand Yourself
  '6986f1f88676cf914e263e2a': 29, // Is Selling Beats Still Profitable
  '6986f1fb8676cf914e263e4f': 30, // Hip-Hop Production Trends 2026

  // Extra articles
  '691aae9eef19aade99dab7fd': 31, // BeatStars vs Airbit vs Traktrain vs BeatPass
  '691b8198ef19aade99dab8a8': 32, // How to Sell Beats Online
  '6924f11d714f57b37dec986e': 33, // The Future of Beat Licensing
  '6938938aabdf3994e94f6ad1': 34, // Custom Beats: Subscription Platforms
  '696eb4b2c88d3a0b4e25fb13': 35, // This Week in Hip-Hop Production
  '69765d7bc88d3a0b4e25fb45': 36, // Music Licensing for Content Creators
};

async function main() {
  const DRY = process.argv.includes('--dry');
  console.log(DRY ? '═══ DRY RUN (no changes) ═══\n' : '');

  console.log('Fetching all draft posts...');
  const drafts = await api('GET', 'posts/?status=draft&limit=all&fields=id,title,slug,mobiledoc,updated_at&include=tags');
  const posts = drafts.posts || [];
  console.log(`Total drafts: ${posts.length}`);

  const videos = [];
  const articles = [];

  for (const p of posts) {
    const tagNames = (p.tags || []).map(t => t.name);
    const isVideo = tagNames.includes('Videos') || tagNames.includes('#video');
    const hasYT = (p.mobiledoc || '').includes('youtube.com/watch');

    if (isVideo && hasYT) {
      videos.push({ id: p.id, title: p.title, updated_at: p.updated_at });
    } else {
      articles.push({ id: p.id, title: p.title, updated_at: p.updated_at });
    }
  }

  // Sort articles by plan phase order
  articles.sort((a, b) => {
    const oa = ARTICLE_ORDER[a.id] || 99;
    const ob = ARTICLE_ORDER[b.id] || 99;
    return oa - ob;
  });

  // Videos: reverse so oldest first (Ghost returns newest first)
  videos.reverse();

  console.log(`Articles: ${articles.length} | Videos: ${videos.length}`);

  // ── Build interleaved schedule ───────────────────────────────────────────
  const schedule = [];
  let ai = 0, vi = 0;

  while (ai < articles.length || vi < videos.length) {
    const artRemain = articles.length - ai;
    const vidRemain = videos.length - vi;

    if (artRemain === 0) {
      schedule.push({ ...videos[vi++], type: 'VID' });
    } else if (vidRemain === 0) {
      schedule.push({ ...articles[ai++], type: 'ART' });
    } else {
      // Pick whichever is further behind its target ratio
      const artRatio = ai / articles.length;
      const vidRatio = vi / videos.length;
      if (artRatio <= vidRatio) {
        schedule.push({ ...articles[ai++], type: 'ART' });
      } else {
        schedule.push({ ...videos[vi++], type: 'VID' });
      }
    }
  }

  // ── Assign dates: 2/day at 10AM and 4PM EST ─────────────────────────────
  const START = new Date('2026-02-08T15:00:00.000Z'); // Feb 8, 10 AM EST
  const SLOT_HOURS = [15, 21]; // UTC hours

  for (let i = 0; i < schedule.length; i++) {
    const dayOffset = Math.floor(i / 2);
    const slotIdx = i % 2;
    const date = new Date(START);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    date.setUTCHours(SLOT_HOURS[slotIdx], 0, 0, 0);
    schedule[i].publishAt = date.toISOString();
  }

  const totalDays = Math.ceil(schedule.length / 2);
  console.log(`\nSchedule: ${schedule.length} posts over ${totalDays} days`);
  console.log(`First: ${schedule[0].publishAt} | Last: ${schedule[schedule.length - 1].publishAt}\n`);

  // Preview
  let currentDay = '';
  for (const s of schedule) {
    const day = s.publishAt.substring(0, 10);
    const time = s.publishAt.substring(11, 16);
    if (day !== currentDay) { currentDay = day; console.log(`\n  ${day}`); }
    const label = s.type === 'ART' ? '📝' : '🎬';
    console.log(`    ${time} ${label} ${s.title.substring(0, 75)}`);
  }

  if (DRY) { console.log('\n--- Dry run complete. Run without --dry to apply. ---'); return; }

  // ── Apply schedule ───────────────────────────────────────────────────────
  console.log('\n\n═══ APPLYING SCHEDULE ═══\n');

  let success = 0, fail = 0;
  for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    const num = `[${i + 1}/${schedule.length}]`;
    try {
      const fresh = await api('GET', `posts/${s.id}/?fields=id,updated_at`);
      await api('PUT', `posts/${s.id}/`, {
        posts: [{ status: 'scheduled', published_at: s.publishAt, updated_at: fresh.posts[0].updated_at }]
      });
      console.log(`${num} ✓ ${s.publishAt.substring(5, 16)} ${s.type} | ${s.title.substring(0, 60)}`);
      success++;
      await delay(200);
    } catch (e) {
      console.log(`${num} ✗ ${s.title.substring(0, 50)} — ${e.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${success} scheduled, ${fail} failed`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
