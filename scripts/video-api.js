#!/usr/bin/env node

/**
 * Video Export API — Downloads YouTube videos with yt-dlp, composites
 * slide overlay PNG with ffmpeg, and serves the result from same-origin.
 *
 * Endpoints:
 *   GET  /status          → health check
 *   POST /export          → start a video export job
 *   GET  /status/:jobId   → poll job progress
 *
 * Zero npm dependencies — uses only Node.js built-ins.
 */

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = 3100;
const BASE_DIR = path.resolve(__dirname, '..');
const YT_DLP = path.join(__dirname, 'bin', 'yt-dlp');
const FFMPEG = '/usr/bin/ffmpeg';
const CACHE_DIR = path.join(__dirname, 'video-cache');
const OUTPUT_DIR = path.join(BASE_DIR, 'content', 'themes', 'aspect', 'assets', 'content-designer', 'videos');
const TEMP_DIR = path.join(__dirname, 'video-tmp');
const MAX_CACHED_RAW = 5;
const MAX_OUTPUT_AGE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TEMP_AGE_MS = 5 * 60 * 1000; // 5 minutes
const ALLOWED_ORIGINS = [
  'https://blog.beatpass.ca',
  'http://localhost:5173',
  'http://localhost:4173',
];

// ── Ensure directories ──────────────────────────────────────────────────────

[CACHE_DIR, OUTPUT_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Job store (in-memory) ───────────────────────────────────────────────────

const jobs = new Map();

function createJob(videoId, opts) {
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = {
    id: jobId,
    videoId,
    status: 'downloading', // downloading → compositing → ready | error
    progress: 0,
    url: null,
    error: null,
    createdAt: Date.now(),
    opts,
  };
  jobs.set(jobId, job);
  return job;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 15 * 1024 * 1024) { // 15 MB limit (overlay PNG can be large)
        reject(new Error('Body too large'));
        req.destroy();
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function setCORS(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── yt-dlp download ─────────────────────────────────────────────────────────

function downloadYouTube(videoId, withAudio) {
  // Always download full video (trimming done later by ffmpeg)
  const suffix = withAudio ? '' : '_noaudio';
  const cached = path.join(CACHE_DIR, `${videoId}${suffix}.mp4`);

  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) {
    log(`  Cache hit: ${cached}`);
    return Promise.resolve(cached);
  }

  // Clean up any corrupt partial download
  try { fs.unlinkSync(cached); } catch {}

  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--no-playlist',
      '--no-warnings',
      '-f', withAudio ? 'bv*[height<=1080]+ba/b[height<=1080]' : 'bv*[height<=1080]/b[height<=1080]',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-o', cached,
      url,
    ];

    log(`  yt-dlp: downloading ${videoId} (audio=${withAudio})`);
    execFile(YT_DLP, args, { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        log(`  yt-dlp error: ${err.message}\n${stderr}`);
        // Clean up corrupt file
        try { fs.unlinkSync(cached); } catch {}
        reject(new Error(`yt-dlp failed: ${err.message}`));
      } else {
        log(`  yt-dlp: done → ${cached} (${(fs.statSync(cached).size / 1024 / 1024).toFixed(1)} MB)`);
        resolve(cached);
      }
    });
  });
}

// ── ffmpeg composite ────────────────────────────────────────────────────────

function compositeVideo(videoPath, overlayPath, outputPath, { width, height, duration, withAudio, progressBar, timerInfo, accentColor }) {
  return new Promise((resolve, reject) => {
    // Scale video to fill portrait frame (cover mode) then crop, then overlay transparent PNG
    let filterComplex;

    // Find a monospace font for drawtext (DejaVu Sans Mono is standard on Ubuntu/Debian)
    const MONO_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
    const fontAvailable = fs.existsSync(MONO_FONT);

    if (progressBar && accentColor) {
      // Animated progress bar: color source → scale width with time expression → overlay at track pos
      const { x, y, w, h } = progressBar;
      const ffColor = accentColor.replace('#', '0x');
      const dur = String(duration);

      const filters = [
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[vid]`,
        `[vid][1:v]overlay=0:0[comp]`,
        `color=c=${ffColor}:s=${w}x${h}:d=${dur}:r=30[barsrc]`,
        `[barsrc]scale=w='max(2\,trunc(${w}*t/${dur}/2)*2)':h=${h}:eval=frame:flags=fast_bilinear[bar]`,
        `[comp][bar]overlay=${x}:${y}:eval=frame:shortest=1[barout]`,
      ];

      // Animated elapsed timer via drawtext (requires monospace font)
      if (timerInfo && fontAvailable) {
        const tc = timerInfo.color || '#FFFFFF';
        // Parse CSS rgb(r,g,b) or hex color to ffmpeg format
        let ffTimerColor = 'white';
        const rgbMatch = tc.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (rgbMatch) {
          ffTimerColor = `0x${Number(rgbMatch[1]).toString(16).padStart(2,'0')}${Number(rgbMatch[2]).toString(16).padStart(2,'0')}${Number(rgbMatch[3]).toString(16).padStart(2,'0')}`;
        } else if (tc.startsWith('#')) {
          ffTimerColor = tc.replace('#', '0x');
        }
        const timerOpacity = timerInfo.opacity != null ? timerInfo.opacity : 0.5;
        // ffmpeg drawtext expression for m:ss elapsed time
        // Within single-quoted text value, \: escapes colons from filter separator parsing
        const timeExpr = `%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;
        filters.push(
          `[barout]drawtext=fontfile='${MONO_FONT}':text='${timeExpr}':fontsize=${timerInfo.fontSize || 27}:fontcolor=${ffTimerColor}@${timerOpacity}:x=${timerInfo.x || 0}:y=${timerInfo.y || 0}[out]`
        );
      } else {
        filters.push(`[barout]null[out]`);
      }

      filterComplex = filters.join(';');
    } else {
      filterComplex = [
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[vid]`,
        `[vid][1:v]overlay=0:0[out]`,
      ].join(';');
    }

    const args = [
      '-y',
      '-i', videoPath,
      '-i', overlayPath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      ...(withAudio ? ['-map', '0:a?', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-t', String(duration),
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ];

    log(`  ffmpeg: compositing → ${path.basename(outputPath)}${progressBar ? ` (animated bar at ${progressBar.x},${progressBar.y} ${progressBar.w}x${progressBar.h})` : ''}${timerInfo ? ` (timer at ${timerInfo.x},${timerInfo.y})` : ''}`);
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        log(`  ffmpeg: done`);
        resolve(outputPath);
      } else {
        log(`  ffmpeg error (code ${code}):\n${stderr.slice(-500)}`);
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// ── Process export job ──────────────────────────────────────────────────────

async function processJob(job) {
  const { videoId, opts } = job;
  const { overlayPng, duration, withAudio, width, height, progressBar, accentColor } = opts;
  const overlayPath = path.join(TEMP_DIR, `${job.id}_overlay.png`);
  const outputPath = path.join(OUTPUT_DIR, `${job.id}.mp4`);

  try {
    // 1. Decode overlay PNG data URL → temp file
    job.status = 'downloading';
    job.progress = 0.05;
    const base64Match = overlayPng.match(/^data:image\/png;base64,(.+)$/);
    if (!base64Match) throw new Error('Invalid overlay PNG data URL');
    fs.writeFileSync(overlayPath, Buffer.from(base64Match[1], 'base64'));
    log(`  Overlay saved: ${overlayPath} (${fs.statSync(overlayPath).size} bytes)`);

    // 2. Download YouTube video
    job.progress = 0.1;
    const videoPath = await downloadYouTube(videoId, withAudio);
    job.progress = 0.6;

    // 3. Composite with ffmpeg (ensure output dir exists — cleanup may have removed files)
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    job.status = 'compositing';
    job.progress = 0.65;
    await compositeVideo(videoPath, overlayPath, outputPath, { width, height, duration, withAudio, progressBar, timerInfo, accentColor });
    job.progress = 0.95;

    // 4. Done — set URL
    const relUrl = `/assets/content-designer/videos/${job.id}.mp4`;
    job.status = 'ready';
    job.progress = 1;
    job.url = relUrl;
    log(`  Job ${job.id} ready: ${relUrl}`);

    // Cleanup temp overlay
    fs.unlink(overlayPath, () => {});
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    log(`  Job ${job.id} FAILED: ${err.message}`);
    fs.unlink(overlayPath, () => {});
  }
}

// ── Housekeeping ────────────────────────────────────────────────────────────

function cleanup() {
  const now = Date.now();

  // Remove old output files (composited MP4s)
  try {
    const files = fs.readdirSync(OUTPUT_DIR);
    for (const f of files) {
      const fp = path.join(OUTPUT_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_OUTPUT_AGE_MS) {
          fs.unlinkSync(fp);
          log(`  Cleanup: removed output ${f}`);
        }
      } catch {}
    }
  } catch {}

  // Clean stale temp files (overlay PNGs from failed/abandoned jobs)
  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_TEMP_AGE_MS) {
          fs.unlinkSync(fp);
          log(`  Cleanup: removed temp ${f}`);
        }
      } catch {}
    }
  } catch {}

  // Limit cached raw YouTube downloads (full videos can be large)
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .map(f => {
        try {
          return { name: f, mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs, size: fs.statSync(path.join(CACHE_DIR, f)).size };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    // Remove excess cached files
    if (files.length > MAX_CACHED_RAW) {
      for (const f of files.slice(MAX_CACHED_RAW)) {
        fs.unlinkSync(path.join(CACHE_DIR, f.name));
        log(`  Cleanup: removed cached ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }

    // Also log total cache size
    const totalMB = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
    if (totalMB > 100) log(`  Cache size: ${totalMB.toFixed(0)} MB (${files.length} files)`);
  } catch {}

  // Purge old jobs from memory
  for (const [id, job] of jobs) {
    if (now - job.createdAt > MAX_OUTPUT_AGE_MS) jobs.delete(id);
  }
}

// Run cleanup on startup and every 2 minutes
cleanup();
setInterval(cleanup, 2 * 60 * 1000);

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCORS(req, res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /status
  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJSON(res, 200, { ok: true, jobs: jobs.size });
  }

  // GET /status/:jobId
  if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
    const jobId = url.pathname.split('/status/')[1];
    const job = jobs.get(jobId);
    if (!job) return sendJSON(res, 404, { error: 'Job not found' });
    return sendJSON(res, 200, {
      status: job.status,
      progress: job.progress,
      url: job.url,
      error: job.error,
    });
  }

  // POST /export
  if (req.method === 'POST' && url.pathname === '/export') {
    try {
      const body = await parseBody(req);
      const { videoId, overlayPng, duration = 10, withAudio = false, width = 1080, height = 1350, progressBar, timerInfo, accentColor } = body;

      if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        return sendJSON(res, 400, { error: 'Invalid videoId' });
      }
      if (!overlayPng || !overlayPng.startsWith('data:image/png;base64,')) {
        return sendJSON(res, 400, { error: 'Invalid overlayPng (must be PNG data URL)' });
      }

      const opts = {
        overlayPng,
        duration: Math.min(Number(duration) || 10, 120),
        withAudio: !!withAudio,
        width: Number(width) || 1080,
        height: Number(height) || 1350,
      };
      // Pass progress bar geometry + accent color for animated bar in ffmpeg
      if (progressBar && typeof progressBar === 'object' && accentColor) {
        opts.progressBar = {
          x: Math.round(Number(progressBar.x) || 0),
          y: Math.round(Number(progressBar.y) || 0),
          w: Math.round(Number(progressBar.w) || 0),
          h: Math.round(Number(progressBar.h) || 0),
        };
        opts.accentColor = String(accentColor);
      }
      if (timerInfo && typeof timerInfo === 'object') {
        opts.timerInfo = {
          x: Math.round(Number(timerInfo.x) || 0),
          y: Math.round(Number(timerInfo.y) || 0),
          fontSize: Math.round(Number(timerInfo.fontSize) || 27),
          color: String(timerInfo.color || '#FFFFFF'),
          opacity: Number(timerInfo.opacity) || 0.5,
        };
      }

      const job = createJob(videoId, opts);

      log(`Job ${job.id} created for video ${videoId} (${job.opts.duration}s, audio=${job.opts.withAudio}, progressBar=${opts.progressBar ? JSON.stringify(opts.progressBar) : 'none'}, accent=${opts.accentColor || 'none'})`);

      // Process async — don't await
      processJob(job).catch(err => log(`Unhandled job error: ${err.message}`));

      return sendJSON(res, 202, { jobId: job.id });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Video Export API listening on http://127.0.0.1:${PORT}`);
  log(`  yt-dlp: ${YT_DLP}`);
  log(`  ffmpeg: ${FFMPEG}`);
  log(`  cache:  ${CACHE_DIR}`);
  log(`  output: ${OUTPUT_DIR}`);
});
