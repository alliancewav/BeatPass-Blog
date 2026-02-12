#!/usr/bin/env node

/**
 * Stress test: simulate the full data pipeline for all 52 landscape videos.
 * No Ghost posts are created — this only validates data extraction.
 */

const https = require('https');
const http = require('http');

const CHANNEL_ID = 'UCy3ohTlamVHmfcvt6LJqSJw';
const CHANNEL_HANDLE = 'beatpasswav';

// ── Helpers ────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
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

// ── Step 1: Get all video IDs from channel page (with pagination) ──────────

async function scrapeChannelTab(tab) {
  const url = `https://www.youtube.com/@${CHANNEL_HANDLE}/${tab}`;
  const html = await fetchText(url);
  const ids = new Set();

  // Extract video IDs from initial page
  const matches = html.matchAll(/"videoId":"([^"]+)"/g);
  for (const m of matches) ids.add(m[1]);

  // Try continuation token for pagination
  const contMatch = html.match(/"continuationCommand":\{"token":"([^"]+)"/);
  if (contMatch) {
    try {
      const contToken = contMatch[1];
      // Extract API key
      const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      if (apiKeyMatch) {
        const apiKey = apiKeyMatch[1];
        const browseUrl = `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`;
        
        let token = contToken;
        let page = 1;
        while (token && page < 20) { // safety limit
          const body = JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20240101' } },
            continuation: token
          });
          
          const resp = await fetchText(browseUrl + '&prettyPrint=false');
          // Use fetch for POST
          const postResp = await fetch(browseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
          });
          const json = await postResp.json();
          const jsonStr = JSON.stringify(json);
          
          const contIds = jsonStr.matchAll(/"videoId":"([^"]+)"/g);
          let newCount = 0;
          for (const m of contIds) {
            if (!ids.has(m[1])) { ids.add(m[1]); newCount++; }
          }
          
          // Find next continuation token
          const nextCont = jsonStr.match(/"continuationCommand":\{"token":"([^"]+)"/);
          token = nextCont ? nextCont[1] : null;
          page++;
          
          if (newCount === 0 && !token) break;
          await delay(300);
        }
      }
    } catch (e) {
      console.log(`  ⚠ Pagination failed for /${tab}: ${e.message}`);
    }
  }

  return ids;
}

// ── Step 2: Get video description from watch page ──────────────────────────

async function getVideoDescription(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchText(url);
  
  // Extract shortDescription from page JSON
  const match = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  
  // Unescape JSON string
  return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// ── Step 3: Parse description ──────────────────────────────────────────────

function parseDescription(desc) {
  if (!desc) return {};
  const lines = desc.split('\n');
  
  // Track URL + ID
  const trackUrlMatch = desc.match(/https?:\/\/open\.beatpass\.ca\/track\/(\d+)\/([^\s]+)/);
  const trackUrl = trackUrlMatch ? trackUrlMatch[0] : null;
  const trackId = trackUrlMatch ? parseInt(trackUrlMatch[1]) : null;
  
  // BPM from line 1
  const bpmMatch = lines[0]?.match(/(\d{2,3})\s*BPM/i);
  const bpm = bpmMatch ? parseInt(bpmMatch[1]) : null;
  
  // Producer Instagram (not beatpass.wav)
  const igMatch = desc.match(/https?:\/\/(?:www\.)?instagram\.com\/(?!beatpass\.wav)([^\s/]+)/);
  const producerInstagram = igMatch ? igMatch[0].replace(/\/$/, '') : null;
  
  // Producer YouTube (not beatpasswav)
  const ytMatch = desc.match(/https?:\/\/(?:www\.)?youtube\.com\/(?!@?beatpasswav)(@[^\s/]+|channel\/[^\s/]+|[^\s]+)/);
  const producerYoutube = ytMatch ? ytMatch[0].replace(/\/$/, '') : null;
  
  // Fallback track name from line 1
  const line1Parts = lines[0]?.split(' - ') || [];
  const fallbackTrackName = line1Parts[0]?.trim() || null;
  const fallbackGenre = line1Parts.length >= 2 ? line1Parts.slice(1).join(' - ').replace(/\d{2,3}\s*BPM/i, '').replace(/ - $/, '').trim() : null;
  
  return { trackUrl, trackId, bpm, producerInstagram, producerYoutube, fallbackTrackName, fallbackGenre };
}

// ── Step 4: Fetch BeatPass API ─────────────────────────────────────────────

async function fetchBeatPassTrack(trackId) {
  try {
    const data = await fetchJSON(`https://open.beatpass.ca/api/v1/tracks/${trackId}`);
    const t = data.track;
    return {
      name: t.name,
      image: t.image,
      duration: t.duration_text,
      genres: t.genres.map(g => g.display_name),
      artists: t.artists.map(a => ({ name: a.name, id: a.id }))
    };
  } catch (e) {
    return null;
  }
}

// ── Step 5: Fetch oEmbed ───────────────────────────────────────────────────

async function fetchOEmbed(videoId) {
  try {
    const data = await fetchJSON(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    return { title: data.title, html: data.html ? data.html.substring(0, 80) + '...' : null };
  } catch (e) {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Pipeline Stress Test — All Landscape Videos          ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  // Step 1: Get all video IDs
  console.log('═══ Step 1: Scraping channel tabs for video IDs ═══\n');
  
  console.log('  Fetching /videos tab...');
  const videoIds = await scrapeChannelTab('videos');
  console.log(`  Found ${videoIds.size} video IDs`);
  
  console.log('  Fetching /shorts tab...');
  const shortIds = await scrapeChannelTab('shorts');
  console.log(`  Found ${shortIds.size} short IDs`);
  
  // Landscape = videos - shorts
  const landscapeIds = [...videoIds].filter(id => !shortIds.has(id));
  console.log(`\n  Landscape videos: ${landscapeIds.length} (${videoIds.size} videos - ${shortIds.size} shorts overlap = ${videoIds.size - landscapeIds.length} shorts removed)\n`);

  if (landscapeIds.length === 0) {
    console.error('  ✗ No landscape videos found. Aborting.');
    return;
  }

  // Step 2-5: Process each video
  console.log('═══ Step 2: Processing each landscape video ═══\n');
  
  const results = [];
  const errors = [];
  
  for (let i = 0; i < landscapeIds.length; i++) {
    const videoId = landscapeIds[i];
    const num = `[${i + 1}/${landscapeIds.length}]`;
    
    try {
      // oEmbed
      const oembed = await fetchOEmbed(videoId);
      await delay(200);
      
      // Description
      const desc = await getVideoDescription(videoId);
      await delay(200);
      
      // Parse description
      const parsed = parseDescription(desc);
      
      // BeatPass API
      let bpTrack = null;
      if (parsed.trackId) {
        bpTrack = await fetchBeatPassTrack(parsed.trackId);
        await delay(200);
      }
      
      // Determine final values
      const trackName = bpTrack?.name || parsed.fallbackTrackName || '???';
      const genres = bpTrack?.genres || (parsed.fallbackGenre ? [parsed.fallbackGenre] : []);
      const producer = bpTrack?.artists?.[0]?.name || '???';
      const producerId = bpTrack?.artists?.[0]?.id || null;
      const image = bpTrack?.image || null;
      const duration = bpTrack?.duration || null;
      
      const result = {
        videoId,
        title: oembed?.title || '???',
        trackName,
        trackId: parsed.trackId,
        trackUrl: parsed.trackUrl,
        genres,
        bpm: parsed.bpm,
        producer,
        producerId,
        producerInstagram: parsed.producerInstagram,
        producerYoutube: parsed.producerYoutube,
        image: image ? '✓' : '✗',
        duration,
        oembedOk: !!oembed,
        descOk: !!desc,
        bpApiOk: !!bpTrack,
        source: bpTrack ? 'API' : 'FALLBACK'
      };
      
      results.push(result);
      
      // Status indicator
      const issues = [];
      if (!parsed.trackId) issues.push('no-track-id');
      if (!bpTrack) issues.push('no-api');
      if (!parsed.producerInstagram) issues.push('no-ig');
      if (!parsed.producerYoutube) issues.push('no-yt');
      if (!parsed.bpm) issues.push('no-bpm');
      
      const status = issues.length === 0 ? '✓' : `⚠ ${issues.join(', ')}`;
      console.log(`  ${num} ${status} | ${videoId} | "${trackName}" by ${producer} | ${genres.join(', ')} | ${parsed.bpm || '—'}BPM | ${duration || '—'} | ${result.source}`);
      
      if (issues.length > 0) errors.push({ videoId, title: oembed?.title, issues });
      
    } catch (e) {
      console.log(`  ${num} ✗ FAILED | ${videoId} | ${e.message}`);
      errors.push({ videoId, title: '???', issues: ['EXCEPTION: ' + e.message] });
    }
    
    await delay(100);
  }

  // Summary
  console.log('\n═══ Summary ═══\n');
  console.log(`  Total landscape videos: ${landscapeIds.length}`);
  console.log(`  Fully resolved (API):   ${results.filter(r => r.bpApiOk && r.producerInstagram && r.producerYoutube && r.bpm).length}`);
  console.log(`  Partial data:           ${results.filter(r => r.source === 'API' && (!r.producerInstagram || !r.producerYoutube || !r.bpm)).length}`);
  console.log(`  Fallback mode:          ${results.filter(r => r.source === 'FALLBACK').length}`);
  console.log(`  Failed:                 ${errors.length - results.filter(r => r.source === 'FALLBACK' || (!r.producerInstagram || !r.producerYoutube || !r.bpm)).length > 0 ? '' : ''}${landscapeIds.length - results.length}`);

  if (errors.length > 0) {
    console.log('\n═══ Issues ═══\n');
    for (const e of errors) {
      console.log(`  ${e.videoId} | ${e.title} | ${e.issues.join(', ')}`);
    }
  }
  
  // Data quality report
  console.log('\n═══ Field Coverage ═══\n');
  const total = results.length;
  const fields = {
    'Track Name (API)': results.filter(r => r.bpApiOk).length,
    'Track ID': results.filter(r => r.trackId).length,
    'Track URL': results.filter(r => r.trackUrl).length,
    'Genres (API)': results.filter(r => r.bpApiOk && r.genres.length > 0).length,
    'BPM': results.filter(r => r.bpm).length,
    'Producer (API)': results.filter(r => r.bpApiOk).length,
    'Producer Instagram': results.filter(r => r.producerInstagram).length,
    'Producer YouTube': results.filter(r => r.producerYoutube).length,
    'Track Artwork': results.filter(r => r.image === '✓').length,
    'Duration': results.filter(r => r.duration).length,
    'oEmbed': results.filter(r => r.oembedOk).length,
  };
  
  for (const [field, count] of Object.entries(fields)) {
    const pct = ((count / total) * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(count / total * 20)) + '░'.repeat(20 - Math.round(count / total * 20));
    console.log(`  ${field.padEnd(22)} ${bar} ${count}/${total} (${pct}%)`);
  }
  
  console.log('\n═══ Sample Article Data (first 3) ═══\n');
  for (const r of results.slice(0, 3)) {
    console.log(`  --- ${r.videoId} ---`);
    console.log(`  Title:    ${r.title}`);
    console.log(`  Track:    "${r.trackName}" (ID: ${r.trackId})`);
    console.log(`  Genres:   ${r.genres.join(', ')}`);
    console.log(`  BPM:      ${r.bpm || '—'}`);
    console.log(`  Duration: ${r.duration || '—'}`);
    console.log(`  Producer: ${r.producer} (ID: ${r.producerId})`);
    console.log(`  IG:       ${r.producerInstagram || '—'}`);
    console.log(`  YT:       ${r.producerYoutube || '—'}`);
    console.log(`  Track URL:${r.trackUrl || '—'}`);
    console.log(`  Artwork:  ${r.image}`);
    console.log(`  Source:   ${r.source}`);
    console.log('');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
