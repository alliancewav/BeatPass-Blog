#!/usr/bin/env node

/**
 * Update Meta Titles (≤60 chars) and Meta Descriptions (≤145 chars)
 * for all blog draft files + Ghost drafts via Admin API.
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
require('./load-env');

const API_URL = process.env.GHOST_URL;
const ADMIN_KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const ADMIN_KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const DRAFTS_DIR = path.resolve(__dirname, '../content/blog-drafts');

// ── New metadata values ────────────────────────────────────────────────────────
// Only entries that need changing are listed. null = keep current value.

const META_UPDATES = {
  '01-non-exclusive-vs-exclusive-beats.md': {
    mt: 'Non-Exclusive vs Exclusive Beats Explained (2026)',
    md: 'Understand non-exclusive vs exclusive beat licenses — what each grants, pricing, stream caps, and when to upgrade.'
  },
  '02-what-is-a-beat-lease.md': {
    mt: null,
    md: 'What a beat lease is, how tiers work, what the terms mean, and when to upgrade. Covers stream caps, rights, and credit rules.'
  },
  '03-youtube-content-id-and-beats.md': {
    mt: 'YouTube Content ID & Beats: Avoid Claims (2026)',
    md: 'How YouTube Content ID works with beats, why claims happen, how to dispute them, and how to set up releases to avoid issues.'
  },
  '04-non-exclusive-beat-on-spotify.md': {
    mt: 'Can You Release a Non-Exclusive Beat on Spotify?',
    md: 'Yes — you can release a non-exclusive beat on Spotify. Learn the proper way: license terms, Content ID, and when to upgrade.'
  },
  '05-sample-clearance-explained.md': {
    mt: 'Sample Clearance: How to Legally Use Samples (2026)',
    md: 'How to clear samples — who to contact, costs, the step-by-step process, and what happens if you release uncleared samples.'
  },
  '06-how-to-make-beats.md': {
    mt: null,
    md: 'Learn how to make beats from scratch — drums, melody, arrangement, and mixing. Covers free and paid DAWs and essential tools.'
  },
  '07-best-beat-making-software.md': {
    mt: null,
    md: 'Compare the best beat making software in 2026 — FL Studio, Ableton, Logic Pro, GarageBand, and more. Free and paid options.'
  },
  '08-how-to-make-a-type-beat.md': {
    mt: 'How to Make a Type Beat: Step-by-Step Guide (2026)',
    md: 'Make type beats step by step — analyze an artist\'s sound, build drums and melody, mix for the format, and optimize for discovery.'
  },
  '09-mixing-and-mastering-beats.md': {
    mt: null,
    md: 'Mix and master beats — EQ, compression, reverb, limiting, and loudness targeting. A practical guide for producers at any level.'
  },
  '10-how-to-make-beats-on-your-phone.md': {
    mt: null,
    md: 'Make beats on your phone — GarageBand, FL Studio Mobile, BandLab, and Koala Sampler compared. Setup, workflow, and transfer tips.'
  },
  '11-where-to-find-free-beats.md': {
    mt: 'Where to Find Free Beats for Rap & YouTube (2026)',
    md: 'Find free beats for rap, YouTube, and content creation. Covers type beats, SoundCloud, BeatStars, and royalty-free options.'
  },
  '12-how-to-record-a-song-at-home.md': {
    mt: null,
    md: 'Record a song at home — equipment, room setup, recording techniques, vocal processing, and common mistakes. Beginner-friendly.'
  },
  '13-how-to-release-a-song.md': {
    mt: 'How to Release a Song on Spotify & All Platforms',
    md: 'Release music on Spotify, Apple Music, and all platforms. Covers distributors, metadata, cover art, playlist pitching, and promotion.'
  },
  '14-how-to-write-rap-lyrics.md': {
    mt: 'How to Write Rap Lyrics: Techniques That Work (2026)',
    md: 'Write better rap lyrics — rhyme schemes, flow, verse structure, imagery, and editing. A practical guide for all skill levels.'
  },
  '15-how-to-find-the-right-beat.md': {
    mt: null,
    md: 'Find the right beat for your song — define your parameters, search efficiently, evaluate against your voice, and stop scrolling.'
  },
  '16-how-to-price-your-beats.md': {
    mt: 'How to Price Your Beats: A Producer\'s Guide (2026)',
    md: 'Price your beats right — market rates, pricing psychology, tier structure, when to raise prices, and common mistakes to avoid.'
  },
  '17-how-much-do-music-producers-make.md': {
    mt: null,
    md: 'Realistic income breakdown for music producers in 2026 — beat sales, streaming, sync, YouTube, and more. Ranges by career level.'
  },
  '18-how-to-build-a-beat-catalog.md': {
    mt: null,
    md: 'Build a beat catalog that sells — lane selection, production cadence, multi-platform distribution, and metadata optimization.'
  },
  '19-passive-income-for-music-producers.md': {
    mt: null,
    md: 'How producers build passive income in 2026 — beat sales, streaming royalties, YouTube, sample packs, sync, and subscriptions.'
  },
  '20-how-to-get-your-first-beat-sale.md': {
    mt: null,
    md: 'A 30-day plan for your first beat sale — store setup, YouTube optimization, artist outreach, and what to do after the sale.'
  },
  '21-how-to-promote-your-music.md': {
    mt: 'How to Promote Your Music: A Realistic Guide (2026)',
    md: 'Promote your music as an independent artist — Spotify playlists, TikTok, Instagram, YouTube, paid ads, and a 90-day plan.'
  },
  '22-how-to-get-on-spotify-playlists.md': {
    mt: null,
    md: 'Get on Spotify editorial, algorithmic, and independent playlists. Covers pitching, Discover Weekly, Release Radar, and more.'
  },
  '23-tiktok-music-promotion.md': {
    mt: 'TikTok Music Promotion: How to Go Viral (2026)',
    md: 'Promote your music on TikTok — algorithm mechanics, content formats, posting strategy, and converting views to Spotify streams.'
  },
  '24-how-to-brand-yourself-as-a-music-producer.md': {
    mt: null,
    md: 'Build your producer brand — sonic identity, producer tag, visual system, online presence, and the phases of brand growth.'
  },
  '25-is-selling-beats-still-profitable.md': {
    mt: 'Is Selling Beats Profitable in 2026? Honest Review',
    md: 'Honest look at beat selling in 2026 — market data, the impact of AI, who\'s making money, and whether you should start or continue.'
  },
  '26-royalty-free-music-vs-licensed-beats.md': {
    mt: 'Royalty-Free Music vs Licensed Beats Explained',
    md: 'Royalty-free music vs licensed beats — what each means, when to use which, and how subscription platforms fit in.'
  },
  '27-what-are-type-beats.md': {
    mt: null,
    md: 'What type beats are, why the naming convention exists, how to use them, and whether it\'s legal to use artist names in titles.'
  },
  '28-ai-music-and-beat-making.md': {
    mt: 'AI Music & Beat Making: What to Know in 2026',
    md: 'How AI is changing beat making in 2026 — the tools, copyright implications, and how producers and artists are affected.'
  },
  '29-music-copyright-basics.md': {
    mt: 'Music Copyright Basics for Artists & Producers',
    md: 'Copyright fundamentals — the two copyrights in every song, splits, PRO registration, mechanical royalties, sampling, and Content ID.'
  },
  '30-hip-hop-production-trends-2026.md': {
    mt: null,
    md: 'Hip-hop production trends in 2026 — rage, drill evolution, lo-fi renaissance, AI tools, vocal production, and what\'s coming next.'
  },
  'page-glossary.md': {
    mt: null,
    md: 'A\u2013Z definitions of beat licensing, music production, and industry terms in plain language. Content ID, licenses, DAWs, and more.'
  },
  'page-start-here.md': {
    mt: null,
    md: 'Not sure where to start? Whether you\'re an artist, producer, or content creator — find the right guide for you here.'
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function createToken() {
  return jwt.sign({}, Buffer.from(ADMIN_KEY_SECRET, 'hex'), {
    keyid: ADMIN_KEY_ID, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/'
  });
}

async function api(method, endpoint, data = null) {
  const token = createToken();
  const url = `${API_URL}/ghost/api/admin/${endpoint}`;
  const options = {
    method,
    headers: { 'Authorization': `Ghost ${token}`, 'Content-Type': 'application/json' },
  };
  if (data) options.body = JSON.stringify(data);
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`  ✗ API ${method} ${endpoint}: ${res.status} — ${err.errors?.[0]?.message || JSON.stringify(err)}`);
    return null;
  }
  return res.json();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Phase 1: Validate all new values ───────────────────────────────────────────

function validateUpdates() {
  console.log('\n═══ Validating new metadata values ═══\n');
  let valid = true;
  for (const [file, updates] of Object.entries(META_UPDATES)) {
    if (updates.mt && updates.mt.length > 60) {
      console.error(`  ✗ ${file} MT too long: ${updates.mt.length} chars → "${updates.mt}"`);
      valid = false;
    }
    if (updates.md && updates.md.length > 145) {
      console.error(`  ✗ ${file} MD too long: ${updates.md.length} chars → "${updates.md}"`);
      valid = false;
    }
  }
  if (valid) console.log('  ✓ All values within limits (MT≤60, MD≤145)');
  return valid;
}

// ── Phase 2: Update markdown files ─────────────────────────────────────────────

function updateMarkdownFiles() {
  console.log('\n═══ Updating markdown files ═══\n');
  let updated = 0;

  for (const [file, updates] of Object.entries(META_UPDATES)) {
    const filepath = path.join(DRAFTS_DIR, file);
    if (!fs.existsSync(filepath)) { console.log(`  ✗ ${file} not found`); continue; }

    let content = fs.readFileSync(filepath, 'utf8');
    let changed = false;

    if (updates.mt) {
      const oldMatch = content.match(/^Meta Title:\s*(.+)$/m);
      if (oldMatch) {
        content = content.replace(/^Meta Title:\s*.+$/m, `Meta Title: ${updates.mt}`);
        changed = true;
      }
    }

    if (updates.md) {
      const oldMatch = content.match(/^Meta Description:\s*(.+)$/m);
      if (oldMatch) {
        content = content.replace(/^Meta Description:\s*.+$/m, `Meta Description: ${updates.md}`);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filepath, content, 'utf8');
      console.log(`  ✓ ${file} updated`);
      updated++;
    }
  }

  console.log(`\n  ${updated} files updated`);
}

// ── Phase 3: Update Ghost drafts via API ───────────────────────────────────────

async function updateGhostDrafts() {
  console.log('\n═══ Updating Ghost drafts via API ═══\n');

  // Fetch all draft posts
  const drafts = await api('GET', 'posts/?limit=all&status=draft');
  const published = await api('GET', 'posts/?limit=all&status=published');
  const pages = await api('GET', 'pages/?limit=all&status=all');

  const allPosts = [...(drafts?.posts || []), ...(published?.posts || [])];
  const allPages = pages?.pages || [];

  // Build slug → post map
  const postBySlug = {};
  for (const p of allPosts) postBySlug[p.slug] = p;
  for (const p of allPages) postBySlug[p.slug] = { ...p, _isPage: true };

  // For each file, find its slug and update
  let updated = 0;

  for (const [file, updates] of Object.entries(META_UPDATES)) {
    // Read slug from file metadata
    const filepath = path.join(DRAFTS_DIR, file);
    if (!fs.existsSync(filepath)) continue;
    const content = fs.readFileSync(filepath, 'utf8');
    const slugMatch = content.match(/^Slug:\s*(.+)$/m);
    if (!slugMatch) { console.log(`  ✗ ${file} — no slug found`); continue; }
    const slug = slugMatch[1].trim();

    const post = postBySlug[slug];
    if (!post) { console.log(`  ○ ${file} (${slug}) — not found in Ghost, skipping`); continue; }

    // Build update payload
    const payload = { updated_at: post.updated_at };
    if (updates.mt) payload.meta_title = updates.mt;
    if (updates.md) payload.meta_description = updates.md;

    const endpoint = post._isPage ? `pages/${post.id}/` : `posts/${post.id}/`;
    const key = post._isPage ? 'pages' : 'posts';

    const result = await api('PUT', endpoint, { [key]: [payload] });
    if (result) {
      console.log(`  ✓ ${slug}`);
      updated++;
    }
    await delay(150);
  }

  console.log(`\n  ${updated} Ghost entries updated`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Metadata Update — MT≤60, MD≤145                 ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (!validateUpdates()) {
    console.error('\n✗ Validation failed. Fix values above and retry.');
    process.exit(1);
  }

  updateMarkdownFiles();
  await updateGhostDrafts();

  console.log('\n══════════════════════════════════════════════════');
  console.log('  ✓ All metadata updated (files + Ghost)');
  console.log('══════════════════════════════════════════════════\n');
}

main();
