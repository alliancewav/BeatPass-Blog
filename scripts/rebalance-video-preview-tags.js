#!/usr/bin/env node

const jwt = require('jsonwebtoken');
require('./load-env');

const GHOST_URL = process.env.GHOST_URL;
const KEY_ID = process.env.GHOST_ADMIN_KEY_ID;
const KEY_SECRET = process.env.GHOST_ADMIN_KEY_SECRET;

function createToken() {
  return jwt.sign({}, Buffer.from(KEY_SECRET, 'hex'), {
    keyid: KEY_ID,
    algorithm: 'HS256',
    expiresIn: '5m',
    audience: '/admin/'
  });
}

async function api(method, endpoint, data) {
  const token = createToken();
  const opts = {
    method,
    headers: {
      'Authorization': 'Ghost ' + token,
      'Content-Type': 'application/json'
    }
  };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(GHOST_URL + '/ghost/api/admin/' + endpoint, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${res.status}: ${err.errors?.[0]?.message || JSON.stringify(err)}`);
  }
  return res.json();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function isTimelineVideoPost(post) {
  return (
    ['published', 'scheduled'].includes(post.status) &&
    !!post.published_at &&
    (post.tags || []).some(isVideoTag)
  );
}

function shouldHavePreview(index) {
  return index % 3 === 0;
}

function toTagRef(tag) {
  return tag.id ? { id: tag.id } : { name: tag.name };
}

function buildUpdatedTags(post, keepPreview) {
  const tags = (post.tags || []).filter(tag => !isPreviewTag(tag)).map(toTagRef);
  if (keepPreview) {
    const previewTag = (post.tags || []).find(isPreviewTag);
    const previewRef = previewTag ? toTagRef(previewTag) : { name: '#video-preview' };
    tags.splice(Math.min(1, tags.length), 0, previewRef);
  }
  return tags;
}

async function fetchTimelineVideoPosts() {
  const data = await api(
    'GET',
    'posts/?limit=all&status=all&include=tags&fields=id,title,slug,status,published_at,updated_at'
  );
  return (data.posts || [])
    .filter(isTimelineVideoPost)
    .sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const posts = await fetchTimelineVideoPosts();

  if (posts.length === 0) {
    console.log('No published or scheduled video posts found.');
    return;
  }

  const planned = posts.map((post, index) => {
    const hasPreview = (post.tags || []).some(isPreviewTag);
    return {
      post,
      index,
      hasPreview,
      keepPreview: shouldHavePreview(index)
    };
  });

  const toUpdate = planned.filter(item => item.hasPreview !== item.keepPreview);
  const previewKeepers = planned.filter(item => item.keepPreview);

  console.log(`Video timeline posts: ${posts.length}`);
  console.log(`Preview keepers after rebalance: ${previewKeepers.length}`);
  console.log(`Posts needing tag changes: ${toUpdate.length}`);
  console.log('');

  if (toUpdate.length > 0) {
    console.log('Preview posts after rebalance:');
    for (const item of previewKeepers) {
      console.log(`  KEEP ${item.post.published_at} | ${item.post.status.padEnd(9)} | ${item.post.title}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Dry run complete. Re-run without --dry to apply.');
    return;
  }

  let updated = 0;
  for (const item of toUpdate) {
    const payload = {
      posts: [{
        updated_at: item.post.updated_at,
        tags: buildUpdatedTags(item.post, item.keepPreview)
      }]
    };

    try {
      await api('PUT', `posts/${item.post.id}/`, payload);
      console.log(`  OK ${item.keepPreview ? 'ADD ' : 'DROP'} preview | ${item.post.status.padEnd(9)} | ${item.post.title}`);
      updated++;
      await delay(150);
    } catch (err) {
      console.log(`  FAIL ${item.post.title} | ${err.message}`);
    }
  }

  console.log('');
  console.log(`Updated ${updated} posts.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
