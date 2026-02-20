#!/usr/bin/env node

/**
 * Ghost Article Export Script
 * Fetches all published/scheduled non-video articles from Ghost CMS
 * and exports them as markdown files to content/blog-drafts/ in the
 * same format used by deploy-content.js.
 *
 * Usage: node scripts/export-articles.js
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');
require('./load-env');

// ── Configuration ──────────────────────────────────────────────────────────────

const API_URL = process.env.GHOST_URL;
const ADMIN_KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const ADMIN_KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const DRAFTS_DIR = path.resolve(__dirname, '../content/blog-drafts');

// Tags that identify video/beat articles (skip these)
const VIDEO_TAGS = new Set(['hash-video', 'hash-video-preview']);

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

async function api(method, endpoint) {
  const token = createToken();
  const url = `${API_URL}/ghost/api/admin/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Ghost ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.errors?.[0]?.message || JSON.stringify(err);
    console.error(`  ✗ ${method} ${endpoint}: ${res.status} — ${msg}`);
    return null;
  }
  return res.json();
}

// ── HTML → Markdown converter ──────────────────────────────────────────────────

function createConverter() {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
  });

  // Ghost kg-image-card → markdown image
  td.addRule('kgImage', {
    filter: (node) => {
      return node.nodeName === 'FIGURE' &&
        node.classList && node.classList.contains('kg-image-card');
    },
    replacement: (content, node) => {
      const img = node.querySelector('img');
      const figcaption = node.querySelector('figcaption');
      if (!img) return content;
      const alt = img.getAttribute('alt') || '';
      const src = img.getAttribute('src') || '';
      const caption = figcaption ? figcaption.textContent.trim() : '';
      if (caption) return `\n\n![${alt}](${src})\n*${caption}*\n\n`;
      return `\n\n![${alt}](${src})\n\n`;
    }
  });

  // Ghost kg-bookmark-card → markdown link
  td.addRule('kgBookmark', {
    filter: (node) => {
      return node.nodeName === 'FIGURE' &&
        node.classList && (
          node.classList.contains('kg-bookmark-card') ||
          node.classList.contains('kg-embed-card')
        );
    },
    replacement: (content, node) => {
      const titleEl = node.querySelector('.kg-bookmark-title');
      const link = node.querySelector('a');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const href = link ? link.getAttribute('href') : '';
      if (title && href) return `\n\n[${title}](${href})\n\n`;
      if (href) return `\n\n${href}\n\n`;
      return content;
    }
  });

  // Ghost kg-callout-card → blockquote
  td.addRule('kgCallout', {
    filter: (node) => {
      return node.nodeName === 'DIV' &&
        node.classList && node.classList.contains('kg-callout-card');
    },
    replacement: (content, node) => {
      const emojiEl = node.querySelector('.kg-callout-emoji');
      const textEl = node.querySelector('.kg-callout-text');
      const emoji = emojiEl ? emojiEl.textContent.trim() : '';
      const text = textEl ? textEl.textContent.trim() : node.textContent.trim();
      return `\n\n> ${emoji ? emoji + ' ' : ''}${text}\n\n`;
    }
  });

  // Ghost kg-toggle-card → details/summary style
  td.addRule('kgToggle', {
    filter: (node) => {
      return node.classList && node.classList.contains('kg-toggle-card');
    },
    replacement: (content, node) => {
      const headingEl = node.querySelector('.kg-toggle-heading-text, .kg-toggle-heading h3, summary');
      const contentEl = node.querySelector('.kg-toggle-content');
      const heading = headingEl ? headingEl.textContent.trim() : '';
      const body = contentEl ? contentEl.textContent.trim() : '';
      if (heading) return `\n\n### ${heading}\n\n${body}\n\n`;
      return content;
    }
  });

  // Ghost table → markdown table
  td.addRule('table', {
    filter: 'table',
    replacement: (content, node) => {
      const rows = [];
      const headerCells = node.querySelectorAll('thead th, thead td');
      const bodyRows = node.querySelectorAll('tbody tr');

      if (headerCells.length > 0) {
        const headers = Array.from(headerCells).map(c => c.textContent.trim());
        rows.push('| ' + headers.join(' | ') + ' |');
        rows.push('|' + headers.map(() => '---').join('|') + '|');
      }

      bodyRows.forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent.trim());
        if (cells.length > 0) {
          if (rows.length === 0) {
            // No headers — add separator for first row
            rows.push('| ' + cells.join(' | ') + ' |');
            rows.push('|' + cells.map(() => '---').join('|') + '|');
          } else {
            rows.push('| ' + cells.join(' | ') + ' |');
          }
        }
      });

      return '\n\n' + rows.join('\n') + '\n\n';
    }
  });

  return td;
}

// ── Extract markdown from mobiledoc (if it contains a markdown card) ───────

function extractMarkdownFromMobiledoc(mobiledocStr) {
  try {
    const doc = JSON.parse(mobiledocStr);
    if (doc.cards && doc.cards.length > 0) {
      for (const card of doc.cards) {
        if (card[0] === 'markdown' && card[1] && card[1].markdown) {
          return card[1].markdown;
        }
      }
    }
  } catch { /* not valid JSON or no markdown card */ }
  return null;
}

// ── Slugify for filename ───────────────────────────────────────────────────────

function slugToFilename(slug) {
  return slug.replace(/[^a-z0-9-]/g, '');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Ghost Article Export — blog.beatpass.ca          ║');
  console.log('║  Exporting published/scheduled non-video articles ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(DRAFTS_DIR)) {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  }

  // Collect existing slugs from files already in blog-drafts
  const existingFiles = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.md'));
  const existingSlugs = new Set();
  for (const file of existingFiles) {
    const content = fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf8');
    const slugMatch = content.match(/^Slug:\s*(.+)$/m);
    if (slugMatch) existingSlugs.add(slugMatch[1].trim());
  }
  console.log(`  Found ${existingSlugs.size} existing article slugs in blog-drafts/\n`);

  // Fetch all published + scheduled posts
  const published = await api('GET', 'posts/?limit=all&status=published&include=tags&formats=mobiledoc,html');
  const scheduled = await api('GET', 'posts/?limit=all&status=scheduled&include=tags&formats=mobiledoc,html');

  const allPosts = [
    ...(published?.posts || []),
    ...(scheduled?.posts || []),
  ];

  console.log(`  Fetched ${allPosts.length} published/scheduled posts from Ghost\n`);

  const converter = createConverter();
  let exported = 0, skipped = 0, alreadyExists = 0;

  for (const post of allPosts) {
    // Skip video/beat articles
    const tagSlugs = (post.tags || []).map(t => t.slug);
    const isVideo = tagSlugs.some(s => VIDEO_TAGS.has(s));
    if (isVideo) {
      console.log(`  ○ [video] Skipping: "${post.title}"`);
      skipped++;
      continue;
    }

    // Skip if already in blog-drafts
    if (existingSlugs.has(post.slug)) {
      console.log(`  ○ [exists] Already in drafts: "${post.title}"`);
      alreadyExists++;
      continue;
    }

    // Extract markdown content
    // Priority: mobiledoc markdown card > HTML conversion
    let markdown = extractMarkdownFromMobiledoc(post.mobiledoc || '');
    if (!markdown && post.html) {
      markdown = converter.turndown(post.html);
    }
    if (!markdown) {
      console.log(`  ✗ No content for: "${post.title}"`);
      skipped++;
      continue;
    }

    // Build tag list (visible tags only, skip internal hash- tags)
    const visibleTags = (post.tags || [])
      .filter(t => !t.slug.startsWith('hash-'))
      .map(t => t.name);
    // Ensure "Articles" and "Guides" are present for consistency
    if (!visibleTags.includes('Articles')) visibleTags.push('Articles');
    if (!visibleTags.includes('Guides')) visibleTags.push('Guides');

    // Build the file content
    const title = post.title || 'Untitled';
    const metaTitle = post.meta_title || title;
    const metaDesc = post.meta_description || post.custom_excerpt || '';
    const excerpt = post.custom_excerpt || '';
    const featured = post.featured ? 'true' : 'false';

    const fileContent = `# ${title}

${markdown}

---

<!--
GHOST METADATA
Title: ${title}
Slug: ${post.slug}
Meta Title: ${metaTitle}
Meta Description: ${metaDesc}
Excerpt: ${excerpt}
Tags: ${visibleTags.join(', ')}
Featured: ${featured}
Status: ${post.status}
-->
`;

    // Determine filename — use slug as filename
    const filename = `${slugToFilename(post.slug)}.md`;
    const filepath = path.join(DRAFTS_DIR, filename);

    fs.writeFileSync(filepath, fileContent, 'utf8');
    console.log(`  ✓ Exported: "${title}" → ${filename}`);
    exported++;
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  ✓ Export complete!`);
  console.log(`  ${exported} exported, ${alreadyExists} already existed, ${skipped} skipped (video/empty)`);
  console.log('══════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n  ✗ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
