#!/usr/bin/env node

/**
 * Ghost Admin Content Deployment Script
 * Deploys all blog content from markdown drafts to Ghost CMS via Admin API.
 *
 * Phases:
 * 1. Create 6 topic tags
 * 2. Re-tag 7 existing articles
 * 3. Create 2 pages (Glossary, Start Here) as drafts
 * 4. Create 30 articles as drafts
 * 5. Update navigation
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
require('./load-env');

// ── Configuration ──────────────────────────────────────────────────────────────

const API_URL = process.env.GHOST_URL;
const ADMIN_KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const ADMIN_KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const DRAFTS_DIR = path.resolve(__dirname, '../content/blog-drafts');

// ── JWT Token ──────────────────────────────────────────────────────────────────

function createToken() {
  return jwt.sign({}, Buffer.from(ADMIN_KEY_SECRET, 'hex'), {
    keyid: ADMIN_KEY_ID,
    algorithm: 'HS256',
    expiresIn: '5m',
    audience: '/admin/'
  });
}

// ── API Helper ─────────────────────────────────────────────────────────────────

async function api(method, endpoint, data = null) {
  const token = createToken();
  const url = `${API_URL}/ghost/api/admin/${endpoint}`;

  const options = {
    method,
    headers: {
      'Authorization': `Ghost ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (data) options.body = JSON.stringify(data);

  const res = await fetch(url, options);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.errors?.[0]?.message || JSON.stringify(err);
    console.error(`  ✗ ${method} ${endpoint}: ${res.status} — ${msg}`);
    return null;
  }

  return res.json();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Markdown File Parser ───────────────────────────────────────────────────────

function parseMarkdownFile(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');

  // Split content from metadata comment
  const metaStart = content.lastIndexOf('<!--');
  if (metaStart === -1) return null;

  const body = content.substring(0, metaStart).trim();
  const metaBlock = content.substring(metaStart);

  // Parse metadata fields
  const meta = {};
  for (const line of metaBlock.split('\n')) {
    const match = line.match(/^(Title|Slug|Meta Title|Meta Description|Excerpt|Tags|Featured|Status):\s*(.+)$/);
    if (match) meta[match[1]] = match[2].trim();
  }

  // Strip H1 from body (Ghost uses the title field separately)
  const bodyContent = body.replace(/^#\s+.+\n*/, '').trim();

  // Create mobiledoc with markdown card
  const mobiledoc = JSON.stringify({
    version: '0.3.1',
    markups: [],
    atoms: [],
    cards: [['markdown', { markdown: bodyContent }]],
    sections: [[10, 0]]
  });

  return {
    title: meta['Title'] || '',
    slug: meta['Slug'] || '',
    meta_title: meta['Meta Title'] || '',
    meta_description: meta['Meta Description'] || '',
    custom_excerpt: meta['Excerpt'] || '',
    tags: (meta['Tags'] || '').split(',').map(t => ({ name: t.trim() })).filter(t => t.name),
    featured: meta['Featured'] === 'true',
    mobiledoc
  };
}

// ── Phase 1: Create Topic Tags ─────────────────────────────────────────────────

async function createTags() {
  console.log('\n═══ Phase 1: Creating Topic Tags ═══\n');

  const tags = [
    {
      name: 'Beat Licensing', slug: 'beat-licensing',
      description: 'Non-exclusive and exclusive licenses, beat leases, Content ID, contracts, sample clearance, and everything about the legal side of using beats.',
      meta_title: 'Beat Licensing Guides & Resources | BeatPass Blog',
      meta_description: 'Learn about beat licensing — non-exclusive vs exclusive, Content ID, beat leases, sample clearance, and how to protect your rights as an artist or producer.'
    },
    {
      name: 'Music Production', slug: 'music-production',
      description: 'Making beats, DAWs, mixing, mastering, sound design, arrangement, and production craft for beginners and intermediates.',
      meta_title: 'Music Production Guides & Tutorials | BeatPass Blog',
      meta_description: 'Learn how to make beats, choose the right DAW, mix and master your tracks, and develop your production skills with practical, step-by-step guides.'
    },
    {
      name: 'Selling Beats', slug: 'selling-beats',
      description: 'Producer business — pricing beats, choosing platforms, building a catalog, marketing your beats, and maximizing income as an independent producer.',
      meta_title: 'How to Sell Beats Online: Guides for Producers | BeatPass Blog',
      meta_description: 'Guides for producers on selling beats online — pricing, platforms (BeatStars, Airbit, BeatPass), catalog strategy, marketing, and building a sustainable beat-selling business.'
    },
    {
      name: 'Artist Guide', slug: 'artist-guide',
      description: 'Content specifically for recording artists — finding beats, writing lyrics, recording, releasing music, distribution, and navigating the independent artist journey.',
      meta_title: 'Artist Guides: Beats, Recording & Releasing Music | BeatPass Blog',
      meta_description: 'Guides for independent artists — find beats, write lyrics, record at home, release on Spotify and Apple Music, and build your music career step by step.'
    },
    {
      name: 'Music Industry', slug: 'music-industry',
      description: 'Trends, news, data, market analysis, and the bigger picture of the music and beat-licensing ecosystem.',
      meta_title: 'Music Industry News & Analysis | BeatPass Blog',
      meta_description: 'Music industry trends, beat market analysis, production news, and data-driven insights for artists and producers navigating the independent music landscape.'
    },
    {
      name: 'Music Marketing', slug: 'music-marketing',
      description: 'Promotion strategy, social media, playlist pitching, branding, and everything about getting your music heard after you release it.',
      meta_title: 'Music Marketing & Promotion Guides | BeatPass Blog',
      meta_description: 'Learn how to promote your music — Spotify playlists, TikTok strategy, social media marketing, branding, and realistic promotion guides for independent artists and producers.'
    }
  ];

  const existing = await api('GET', 'tags/?limit=all');
  const existingSlugs = new Set((existing?.tags || []).map(t => t.slug));

  for (const tag of tags) {
    if (existingSlugs.has(tag.slug)) {
      console.log(`  ○ Tag "${tag.name}" already exists, skipping`);
      continue;
    }
    const result = await api('POST', 'tags/', { tags: [tag] });
    if (result) console.log(`  ✓ Created tag: ${tag.name}`);
    await delay(200);
  }
}

// ── Phase 2: Re-tag Existing Articles ──────────────────────────────────────────

async function retagExisting() {
  console.log('\n═══ Phase 2: Re-tagging Existing Articles ═══\n');

  const retagRules = [
    { match: 'BeatStars vs Airbit', addTags: ['Selling Beats'] },
    { match: 'How to Sell Beats Online', addTags: ['Selling Beats'] },
    { match: 'Future of Beat Licensing', addTags: ['Beat Licensing', 'Music Industry'] },
    { match: 'Custom Beats', addTags: ['Beat Licensing', 'Artist Guide'] },
    { match: 'This Week in Hip-Hop', addTags: ['Music Industry'] },
    { match: 'How to Buy Beats Online', addTags: ['Beat Licensing', 'Artist Guide'] },
    { match: 'Music Licensing for Content Creators', addTags: ['Beat Licensing', 'Artist Guide'] },
  ];

  const postsData = await api('GET', 'posts/?limit=all&include=tags');
  if (!postsData?.posts) { console.log('  ✗ Could not fetch posts'); return; }

  const tagsData = await api('GET', 'tags/?limit=all');
  const tagByName = {};
  for (const t of (tagsData?.tags || [])) tagByName[t.name] = t;

  for (const rule of retagRules) {
    const post = postsData.posts.find(p => p.title.includes(rule.match));
    if (!post) {
      console.log(`  ○ No post matching "${rule.match}", skipping`);
      continue;
    }

    const existingTagNames = new Set(post.tags.map(t => t.name));
    const allNeeded = rule.addTags.filter(n => !existingTagNames.has(n));
    if (allNeeded.length === 0) {
      console.log(`  ○ "${post.title}" already has [${rule.addTags.join(', ')}]`);
      continue;
    }

    const newTags = [
      ...post.tags.map(t => ({ id: t.id })),
      ...allNeeded.map(name => tagByName[name] ? { id: tagByName[name].id } : { name })
    ];

    const result = await api('PUT', `posts/${post.id}/`, {
      posts: [{ tags: newTags, updated_at: post.updated_at }]
    });

    if (result) console.log(`  ✓ Re-tagged: "${post.title}" → +[${allNeeded.join(', ')}]`);
    await delay(200);
  }
}

// ── Phase 3: Create Pages ──────────────────────────────────────────────────────

async function createPages() {
  console.log('\n═══ Phase 3: Creating Pages (as drafts) ═══\n');

  const pageFiles = ['page-glossary.md', 'page-start-here.md'];

  const existing = await api('GET', 'pages/?limit=all&status=all');
  const existingSlugs = new Set((existing?.pages || []).map(p => p.slug));

  for (const file of pageFiles) {
    const filepath = path.join(DRAFTS_DIR, file);
    if (!fs.existsSync(filepath)) { console.log(`  ✗ File not found: ${file}`); continue; }

    const parsed = parseMarkdownFile(filepath);
    if (!parsed) { console.log(`  ✗ Could not parse: ${file}`); continue; }

    if (existingSlugs.has(parsed.slug)) {
      console.log(`  ○ Page "${parsed.title}" already exists (/${parsed.slug}/), skipping`);
      continue;
    }

    const result = await api('POST', 'pages/', {
      pages: [{
        title: parsed.title,
        slug: parsed.slug,
        mobiledoc: parsed.mobiledoc,
        meta_title: parsed.meta_title,
        meta_description: parsed.meta_description,
        custom_excerpt: parsed.custom_excerpt,
        status: 'draft'
      }]
    });

    if (result) console.log(`  ✓ Created page: "${parsed.title}" (/${parsed.slug}/)`);
    await delay(300);
  }
}

// ── Phase 4–7: Create All 30 Articles as Drafts ───────────────────────────────

async function createArticles() {
  console.log('\n═══ Phase 4–7: Creating 30 Articles as Drafts ═══\n');

  const files = fs.readdirSync(DRAFTS_DIR)
    .filter(f => /^\d{2}-.*\.md$/.test(f))
    .sort();

  console.log(`  Found ${files.length} article files\n`);

  const existing = await api('GET', 'posts/?limit=all&status=all');
  const existingSlugs = new Set((existing?.posts || []).map(p => p.slug));

  let created = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const filepath = path.join(DRAFTS_DIR, file);
    const parsed = parseMarkdownFile(filepath);

    if (!parsed) {
      console.log(`  ✗ Could not parse: ${file}`);
      failed++;
      continue;
    }

    if (existingSlugs.has(parsed.slug)) {
      console.log(`  ○ [${file}] Already exists, skipping`);
      skipped++;
      continue;
    }

    const result = await api('POST', 'posts/', {
      posts: [{
        title: parsed.title,
        slug: parsed.slug,
        mobiledoc: parsed.mobiledoc,
        meta_title: parsed.meta_title,
        meta_description: parsed.meta_description,
        custom_excerpt: parsed.custom_excerpt,
        tags: parsed.tags,
        featured: parsed.featured,
        status: 'draft'
      }]
    });

    if (result) {
      console.log(`  ✓ [${file}] Draft created: "${parsed.title}"`);
      created++;
    } else {
      failed++;
    }

    await delay(300);
  }

  console.log(`\n  Summary: ${created} created, ${skipped} skipped, ${failed} failed`);
}

// ── Phase 5: Update Navigation ─────────────────────────────────────────────────

async function updateNavigation() {
  console.log('\n═══ Phase 5: Updating Navigation ═══\n');

  const settings = await api('GET', 'settings/');
  if (!settings?.settings) { console.log('  ✗ Could not fetch settings'); return; }

  const navSetting = settings.settings.find(s => s.key === 'navigation');
  const secNavSetting = settings.settings.find(s => s.key === 'secondary_navigation');

  let primaryNav = navSetting ? JSON.parse(navSetting.value) : [];
  let secondaryNav = secNavSetting ? JSON.parse(secNavSetting.value) : [];

  // Add Start Here + Glossary to primary nav
  const primaryUrls = new Set(primaryNav.map(n => n.url));
  let navChanged = false;

  if (!primaryUrls.has('/start-here/')) {
    primaryNav.unshift({ label: 'Start Here', url: '/start-here/' });
    console.log('  ✓ Added "Start Here" to primary navigation');
    navChanged = true;
  } else {
    console.log('  ○ "Start Here" already in primary navigation');
  }

  if (!primaryUrls.has('/glossary/')) {
    const idx = primaryNav.findIndex(n => n.url === '/start-here/');
    primaryNav.splice(idx + 1, 0, { label: 'Glossary', url: '/glossary/' });
    console.log('  ✓ Added "Glossary" to primary navigation');
    navChanged = true;
  } else {
    console.log('  ○ "Glossary" already in primary navigation');
  }

  // Ensure secondary nav items
  const secondaryUrls = new Set(secondaryNav.map(n => n.url));
  for (const item of [
    { label: 'Tags', url: '/tags/' },
    { label: 'Archive', url: '/archive/' },
    { label: 'About', url: '/about/' },
  ]) {
    if (!secondaryUrls.has(item.url)) {
      secondaryNav.push(item);
      console.log(`  ✓ Added "${item.label}" to secondary navigation`);
      navChanged = true;
    }
  }

  if (!navChanged) {
    console.log('  ○ Navigation already up to date');
    return;
  }

  const result = await api('PUT', 'settings/', {
    settings: [
      { key: 'navigation', value: JSON.stringify(primaryNav) },
      { key: 'secondary_navigation', value: JSON.stringify(secondaryNav) }
    ]
  });

  if (result) console.log('  ✓ Navigation saved');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Ghost Content Deployment — blog.beatpass.ca     ║');
  console.log('║  All articles will be created as DRAFTS          ║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    await createTags();
    await retagExisting();
    await createPages();
    await createArticles();
    await updateNavigation();

    console.log('\n══════════════════════════════════════════════════');
    console.log('  ✓ All phases complete!');
    console.log('  All new content created as DRAFTS — nothing published.');
    console.log('  Review in Ghost Admin → https://blog.beatpass.ca/ghost/');
    console.log('══════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n  ✗ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
