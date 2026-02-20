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
const MAX_PODCAST_OUTPUT_AGE_MS = 15 * 60 * 1000; // 15 minutes (auto-deleted after download anyway)
const MAX_TEMP_AGE_MS = 30 * 60 * 1000; // 30 minutes (podcast renders can take 10+ min)
const ABANDON_TIMEOUT_MS = 2 * 60 * 1000; // 2 min no poll = abandoned job
const PODCAST_DOWNLOADED_DELETE_DELAY_MS = 2 * 60 * 1000; // grace period so browser can fetch file
const MAX_PODCAST_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB limit for podcast audio uploads
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
      if (size > 30 * 1024 * 1024) { // 30 MB limit (two PNGs for podcast waveform)
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
  const { overlayPng, duration, withAudio, width, height, progressBar, timerInfo, accentColor } = opts;
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

// ── Podcast chunk upload sessions (in-memory tracker) ───────────────────────

const podcastSessions = new Map(); // sessionId → { audioPath, received: Set, totalChunks, ext, createdAt }

function collectRawBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Chunk too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Podcast video composite ─────────────────────────────────────────────────

function compositePodcast(audioPath, framePath, outputPath, { width, height, duration, progressBar, timerInfo, waveformRegion, accentColor, frameLitPath, onProgress, job }) {
  return new Promise((resolve, reject) => {
    const MONO_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
    const fontAvailable = fs.existsSync(MONO_FONT);
    const dur = String(Math.round(duration));
    const hasAnimatedProgressBar = progressBar
      && Number.isFinite(progressBar.x)
      && Number.isFinite(progressBar.y)
      && Number.isFinite(progressBar.w)
      && Number.isFinite(progressBar.h)
      && progressBar.w > 0
      && progressBar.h > 0
      && typeof accentColor === 'string'
      && accentColor.length > 0;

    // Detect if audio is already AAC/M4A — skip re-encoding
    const audioExt = path.extname(audioPath).toLowerCase();
    const canCopyAudio = ['.m4a', '.aac', '.mp4'].includes(audioExt);

    // Build timer color for drawtext
    let ffTimerColor = 'white';
    let timerOpacity = 0.35;
    if (timerInfo && fontAvailable) {
      const tc = timerInfo.color || 'rgba(255,255,255,0.35)';
      const rgbaMatch = tc.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (rgbaMatch) {
        ffTimerColor = `0x${Number(rgbaMatch[1]).toString(16).padStart(2,'0')}${Number(rgbaMatch[2]).toString(16).padStart(2,'0')}${Number(rgbaMatch[3]).toString(16).padStart(2,'0')}`;
      } else if (tc.startsWith('#')) {
        ffTimerColor = tc.replace('#', '0x');
      }
      timerOpacity = timerInfo.opacity != null ? timerInfo.opacity : 0.35;
    }

    const hasLitFrame = !!frameLitPath;
    let waveformBlendMode = hasLitFrame ? 'full' : 'none';
    const args = ['-y'];

    if (hasLitFrame) {
      // Two-frame approach: blend dim→lit for progressive waveform highlighting
      // Input 0: dim frame (looped), Input 1: lit frame (looped), Input 2: audio
      args.push(
        '-loop', '1', '-framerate', '24', '-i', framePath,
        '-loop', '1', '-framerate', '24', '-i', frameLitPath,
        '-i', audioPath,
      );

      // filter_complex: blend dim→lit based on time, then drawbox + drawtext
      const filters = [];
      const frameW = Number(width) || 1920;
      const frameH = Number(height) || 1080;
      const hasWaveformRegion = waveformRegion
        && Number.isFinite(waveformRegion.x)
        && Number.isFinite(waveformRegion.y)
        && Number.isFinite(waveformRegion.w)
        && Number.isFinite(waveformRegion.h)
        && waveformRegion.w > 0
        && waveformRegion.h > 0;

      if (hasWaveformRegion) {
        const wx = Math.max(0, Math.min(frameW - 1, Math.round(Number(waveformRegion.x) || 0)));
        const wy = Math.max(0, Math.min(frameH - 1, Math.round(Number(waveformRegion.y) || 0)));
        const ww = Math.max(1, Math.min(frameW - wx, Math.round(Number(waveformRegion.w) || 0)));
        const wh = Math.max(1, Math.min(frameH - wy, Math.round(Number(waveformRegion.h) || 0)));

        // Faster path: only blend inside waveform strip, then overlay back onto base frame.
        filters.push('[0:v]split=2[base][dimsrc]');
        filters.push(`[dimsrc]crop=${ww}:${wh}:${wx}:${wy}[dimcrop]`);
        filters.push(`[1:v]crop=${ww}:${wh}:${wx}:${wy}[litcrop]`);
        filters.push(`[dimcrop][litcrop]blend=all_expr='if(lt(X\\,W*T/${dur})\\,B\\,A)'[waveblend]`);
        filters.push(`[base][waveblend]overlay=${wx}:${wy}[blended]`);
        waveformBlendMode = 'region';
      } else {
        // Fallback: blend entire frame.
        // Note: T (uppercase) is the timestamp variable in blend expressions.
        filters.push(`[0:v][1:v]blend=all_expr='if(lt(X\\,W*T/${dur})\\,B\\,A)'[blended]`);
      }

      let currentLabel = 'blended';

      // Animated progress bar via generated color source + scale + overlay.
      // NOTE: Avoid drawbox w=...*t... here — drawbox's `t` option is thickness,
      // which can force the bar to appear fully filled.
      if (hasAnimatedProgressBar) {
        const barX = Math.max(0, Math.round(Number(progressBar.x) || 0));
        const barY = Math.max(0, Math.round(Number(progressBar.y) || 0));
        const barW = Math.max(1, Math.round(Number(progressBar.w) || 1));
        const barH = Math.max(1, Math.round(Number(progressBar.h) || 1));
        const ffColor = accentColor.startsWith('#') ? accentColor.replace('#', '0x') : accentColor;
        filters.push(`color=c=${ffColor}:s=${barW}x${barH}:d=${dur}:r=24[barsrc]`);
        filters.push(`[barsrc]scale=w='max(2\\,trunc(${barW}*t/${dur}/2)*2)':h=${barH}:eval=frame:flags=fast_bilinear[bar]`);
        filters.push(`[${currentLabel}][bar]overlay=${barX}:${barY}:eval=frame:shortest=1[withbar]`);
        currentLabel = 'withbar';
      }

      // Animated elapsed timer
      if (timerInfo && fontAvailable) {
        const timeExpr = `%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;
        filters.push(`[${currentLabel}]drawtext=fontfile='${MONO_FONT}':text='${timeExpr}':fontsize=${timerInfo.fontSize || 22}:fontcolor=${ffTimerColor}@${timerOpacity}:x=${timerInfo.x || 0}:y=${timerInfo.y || 0}[out]`);
        currentLabel = 'out';
      }

      // Slight sharpening improves text readability on fullscreen playback.
      filters.push(`[${currentLabel}]unsharp=5:5:0.45:3:3:0.0[final]`);
      currentLabel = 'final';

      args.push('-filter_complex', filters.join(';'));
      args.push('-map', `[${currentLabel}]`, '-map', '2:a');

    } else {
      // Single-frame fallback: simple vf chain
      args.push(
        '-loop', '1', '-framerate', '24', '-i', framePath,
        '-i', audioPath,
      );

      const filters = [];
      let currentLabel = '0:v';

      if (hasAnimatedProgressBar) {
        const barX = Math.max(0, Math.round(Number(progressBar.x) || 0));
        const barY = Math.max(0, Math.round(Number(progressBar.y) || 0));
        const barW = Math.max(1, Math.round(Number(progressBar.w) || 1));
        const barH = Math.max(1, Math.round(Number(progressBar.h) || 1));
        const ffColor = accentColor.startsWith('#') ? accentColor.replace('#', '0x') : accentColor;
        filters.push(`color=c=${ffColor}:s=${barW}x${barH}:d=${dur}:r=24[barsrc]`);
        filters.push(`[barsrc]scale=w='max(2\\,trunc(${barW}*t/${dur}/2)*2)':h=${barH}:eval=frame:flags=fast_bilinear[bar]`);
        filters.push(`[${currentLabel}][bar]overlay=${barX}:${barY}:eval=frame:shortest=1[withbar]`);
        currentLabel = 'withbar';
      }

      if (timerInfo && fontAvailable) {
        const timeExpr = `%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;
        filters.push(`[${currentLabel}]drawtext=fontfile='${MONO_FONT}':text='${timeExpr}':fontsize=${timerInfo.fontSize || 22}:fontcolor=${ffTimerColor}@${timerOpacity}:x=${timerInfo.x || 0}:y=${timerInfo.y || 0}[withtimer]`);
        currentLabel = 'withtimer';
      }

      filters.push(`[${currentLabel}]unsharp=5:5:0.45:3:3:0.0[out]`);

      args.push('-filter_complex', filters.join(';'));
      args.push('-map', '[out]', '-map', '1:a');
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-tune', 'stillimage',
      '-crf', '22',
      '-c:a', canCopyAudio ? 'copy' : 'aac',
    );
    if (!canCopyAudio) args.push('-b:a', '192k');
    args.push(
      '-t', dur,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-threads', '0',
      '-shortest',
      outputPath,
    );

    log(`  ffmpeg podcast: compositing → ${path.basename(outputPath)} (${dur}s, crf=22, copyAudio=${canCopyAudio}, waveformBlend=${waveformBlendMode})`);
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Store PID on job for cancellation
    if (job) job._ffmpegProc = proc;

    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      if (onProgress && duration > 0) {
        const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (timeMatch) {
          const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
          onProgress(Math.min(0.99, secs / duration));
        }
      }
    });
    proc.on('close', code => {
      if (job) job._ffmpegProc = null;
      if (code === 0) {
        log(`  ffmpeg podcast: done → ${path.basename(outputPath)} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB)`);
        resolve(outputPath);
      } else {
        log(`  ffmpeg podcast error (code ${code}):\n${stderr.slice(-800)}`);
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// ── Process podcast export job ──────────────────────────────────────────────

let podcastRenderActive = false;

async function processPodcastJob(job) {
  const { opts } = job;
  const { audioPath, framePng, frameLitPng, duration, width, height, progressBar, timerInfo, waveformRegion, accentColor } = opts;
  const framePath = path.join(TEMP_DIR, `${job.id}_frame.png`);
  const frameLitPath = frameLitPng ? path.join(TEMP_DIR, `${job.id}_frame_lit.png`) : null;
  const outputPath = path.join(OUTPUT_DIR, `${job.id}.mp4`);

  try {
    // 1. Decode full-frame PNG data URL(s) → temp file(s)
    job.status = 'rendering';
    job.progress = 0.05;
    const base64Match = framePng.match(/^data:image\/png;base64,(.+)$/);
    if (!base64Match) throw new Error('Invalid frame PNG data URL');
    fs.writeFileSync(framePath, Buffer.from(base64Match[1], 'base64'));
    log(`  Podcast frame saved: ${framePath} (${(fs.statSync(framePath).size / 1024).toFixed(0)} KB)`);

    if (frameLitPng && frameLitPath) {
      const litMatch = frameLitPng.match(/^data:image\/png;base64,(.+)$/);
      if (litMatch) {
        fs.writeFileSync(frameLitPath, Buffer.from(litMatch[1], 'base64'));
        log(`  Podcast frame (lit) saved: ${frameLitPath} (${(fs.statSync(frameLitPath).size / 1024).toFixed(0)} KB)`);
      }
    }

    // 2. Composite with ffmpeg
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    await compositePodcast(audioPath, framePath, outputPath, {
      width, height, duration, progressBar, timerInfo, waveformRegion, accentColor,
      frameLitPath: frameLitPath && fs.existsSync(frameLitPath) ? frameLitPath : null,
      onProgress: (pct) => { job.progress = Math.max(job.progress, 0.05 + pct * 0.9); },
      job,
    });

    job.progress = 0.97;

    // 3. Done — set URL
    const relUrl = `/assets/content-designer/videos/${job.id}.mp4`;
    job.status = 'ready';
    job.progress = 1;
    job.url = relUrl;
    log(`  Podcast job ${job.id} ready: ${relUrl} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB)`);

    // Cleanup temp files (keep output MP4 for download)
    fs.unlink(framePath, () => {});
    if (frameLitPath) fs.unlink(frameLitPath, () => {});
    fs.unlink(audioPath, () => {});
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    log(`  Podcast job ${job.id} FAILED: ${err.message}`);
    fs.unlink(framePath, () => {});
    if (frameLitPath) fs.unlink(frameLitPath, () => {});
    fs.unlink(audioPath, () => {});
    // Clean up partial output
    fs.unlink(outputPath, () => {});
  } finally {
    podcastRenderActive = false;
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

  // Purge old jobs from memory (skip jobs still rendering — they have their own lifecycle)
  for (const [id, job] of jobs) {
    if (job.status === 'rendering' || job.status === 'downloading' || job.status === 'compositing') continue;
    const ttl = job.videoId === 'podcast' ? MAX_PODCAST_OUTPUT_AGE_MS : MAX_OUTPUT_AGE_MS;
    if (now - job.createdAt > ttl) {
      jobs.delete(id);
    }
  }

  // Auto-cancel abandoned podcast jobs (no poll for ABANDON_TIMEOUT_MS)
  for (const [id, job] of jobs) {
    if (job.videoId === 'podcast' && job.status === 'rendering' && job.lastPolled) {
      if (now - job.lastPolled > ABANDON_TIMEOUT_MS) {
        log(`  Cleanup: auto-cancelling abandoned podcast job ${id} (no poll for ${Math.round((now - job.lastPolled) / 1000)}s)`);
        if (job._ffmpegProc) { try { job._ffmpegProc.kill('SIGKILL'); } catch {} }
        job.status = 'error';
        job.error = 'Cancelled (abandoned)';
        podcastRenderActive = false;
        // Cleanup temp files
        const framePath = path.join(TEMP_DIR, `${id}_frame.png`);
        const frameLitPath = path.join(TEMP_DIR, `${id}_frame_lit.png`);
        const outputPath = path.join(OUTPUT_DIR, `${id}.mp4`);
        fs.unlink(framePath, () => {});
        fs.unlink(frameLitPath, () => {});
        fs.unlink(outputPath, () => {});
        if (job.opts?.audioPath) fs.unlink(job.opts.audioPath, () => {});
      }
    }
  }

  // Purge stale podcast upload sessions (abandoned uploads)
  for (const [sid, session] of podcastSessions) {
    if (now - session.createdAt > MAX_TEMP_AGE_MS) {
      fs.unlink(session.audioPath, () => {});
      podcastSessions.delete(sid);
      log(`  Cleanup: removed stale podcast session ${sid}`);
    }
  }
}

// Startup cleanup: wipe stale temp files and old output MP4s
function startupCleanup() {
  log('Startup cleanup...');
  try {
    const tmpFiles = fs.readdirSync(TEMP_DIR);
    for (const f of tmpFiles) { fs.unlinkSync(path.join(TEMP_DIR, f)); }
    if (tmpFiles.length > 0) log(`  Removed ${tmpFiles.length} stale temp files`);
  } catch {}
  try {
    const outFiles = fs.readdirSync(OUTPUT_DIR);
    for (const f of outFiles) { fs.unlinkSync(path.join(OUTPUT_DIR, f)); }
    if (outFiles.length > 0) log(`  Removed ${outFiles.length} stale output files`);
  } catch {}
}

startupCleanup();
cleanup();
setInterval(cleanup, 60 * 1000); // every 60s

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
    job.lastPolled = Date.now();
    return sendJSON(res, 200, {
      status: job.status,
      progress: job.progress,
      url: job.url,
      error: job.error,
    });
  }

  // GET /image-proxy?url=... — fetch external images server-side to bypass CORS
  if (req.method === 'GET' && url.pathname === '/image-proxy') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return sendJSON(res, 400, { error: 'Missing ?url= parameter' });

    try {
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return sendJSON(res, 400, { error: 'Only http/https URLs allowed' });
      }

      const proto = parsed.protocol === 'https:' ? require('https') : http;
      proto.get(targetUrl, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          // Follow one redirect
          const rProto = upstream.headers.location.startsWith('https') ? require('https') : http;
          rProto.get(upstream.headers.location, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
            const ct = r2.headers['content-type'] || 'application/octet-stream';
            res.writeHead(r2.statusCode, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
            r2.pipe(res);
          }).on('error', () => sendJSON(res, 502, { error: 'Redirect fetch failed' }));
          return;
        }
        const ct = upstream.headers['content-type'] || 'application/octet-stream';
        res.writeHead(upstream.statusCode, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
        upstream.pipe(res);
      }).on('error', (err) => {
        sendJSON(res, 502, { error: `Upstream fetch failed: ${err.message}` });
      });
    } catch (err) {
      return sendJSON(res, 400, { error: `Invalid URL: ${err.message}` });
    }
    return;
  }

  // POST /gif-export — convert GIF URL + overlay PNG → MP4 (preserves GIF animation)
  if (req.method === 'POST' && url.pathname === '/gif-export') {
    try {
      const body = await parseBody(req);
      const { gifUrl, overlayPng, width = 1080, height = 1350, duration = 10 } = body;

      if (!gifUrl || typeof gifUrl !== 'string') {
        return sendJSON(res, 400, { error: 'Missing gifUrl' });
      }
      if (!overlayPng || !overlayPng.startsWith('data:image/png;base64,')) {
        return sendJSON(res, 400, { error: 'Invalid overlayPng (must be PNG data URL)' });
      }

      const jobId = crypto.randomBytes(8).toString('hex');
      const gifPath = path.join(TEMP_DIR, `${jobId}_gif.gif`);
      const overlayPath = path.join(TEMP_DIR, `${jobId}_overlay.png`);
      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

      // Save overlay PNG
      const base64Match = overlayPng.match(/^data:image\/png;base64,(.+)$/);
      if (!base64Match) return sendJSON(res, 400, { error: 'Invalid overlay data' });
      fs.writeFileSync(overlayPath, Buffer.from(base64Match[1], 'base64'));

      // Download GIF
      log(`GIF export ${jobId}: downloading ${gifUrl}`);
      const downloadGif = (downloadUrl, redirectCount = 0) => new Promise((resolve, reject) => {
        if (redirectCount > 3) return reject(new Error('Too many redirects'));
        const proto = downloadUrl.startsWith('https') ? require('https') : http;
        proto.get(downloadUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            return downloadGif(resp.headers.location, redirectCount + 1).then(resolve, reject);
          }
          if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
          const ws = fs.createWriteStream(gifPath);
          resp.pipe(ws);
          ws.on('finish', () => resolve());
          ws.on('error', reject);
        }).on('error', reject);
      });

      await downloadGif(gifUrl);
      log(`GIF export ${jobId}: GIF downloaded (${(fs.statSync(gifPath).size / 1024).toFixed(0)} KB)`);

      // ffmpeg: GIF → scale/pad to target size → loop to fill duration → overlay text PNG → MP4
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const w = Number(width) || 1080;
      const h = Number(height) || 1350;
      const dur = Math.min(Number(duration) || 10, 30);

      await new Promise((resolve, reject) => {
        const args = [
          '-y',
          '-ignore_loop', '0',         // loop the GIF indefinitely as input
          '-i', gifPath,
          '-i', overlayPath,
          '-filter_complex', [
            `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[gif]`,
            `[gif][1:v]overlay=0:0:shortest=0[out]`,
          ].join(';'),
          '-map', '[out]',
          '-an',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-t', String(dur),
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-r', '24',
          outputPath,
        ];

        log(`GIF export ${jobId}: ffmpeg compositing...`);
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) {
            log(`GIF export ${jobId}: done → ${path.basename(outputPath)}`);
            resolve();
          } else {
            log(`GIF export ${jobId}: ffmpeg error (code ${code}):\n${stderr.slice(-500)}`);
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });
        proc.on('error', reject);
      });

      // Cleanup temp files
      fs.unlink(gifPath, () => {});
      fs.unlink(overlayPath, () => {});

      const relUrl = `/assets/content-designer/videos/${jobId}.mp4`;
      return sendJSON(res, 200, { url: relUrl });
    } catch (err) {
      log(`GIF export failed: ${err.message}`);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // POST /podcast-upload-chunk — receive one chunk of audio binary (≤4 MB each)
  // Body: raw binary. Headers: x-session-id, x-chunk-index, x-total-chunks, x-file-ext
  if (req.method === 'POST' && url.pathname === '/podcast-upload-chunk') {
    try {
      const sessionId = req.headers['x-session-id'];
      const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
      const fileExt = (req.headers['x-file-ext'] || '.m4a').replace(/[^a-z0-9.]/gi, '');

      if (!sessionId || !(/^[a-f0-9]{16}$/.test(sessionId))) {
        return sendJSON(res, 400, { error: 'Invalid x-session-id' });
      }
      if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks < 1) {
        return sendJSON(res, 400, { error: 'Invalid chunk headers' });
      }

      // Collect raw binary body (max 5 MB per chunk)
      const chunkData = await collectRawBody(req, 5 * 1024 * 1024);

      // Initialize session on first chunk
      if (!podcastSessions.has(sessionId)) {
        const audioPath = path.join(TEMP_DIR, `${sessionId}_audio${fileExt}`);
        podcastSessions.set(sessionId, {
          audioPath,
          received: new Set(),
          totalChunks,
          ext: fileExt,
          createdAt: Date.now(),
        });
        // Pre-allocate empty file
        fs.writeFileSync(audioPath, Buffer.alloc(0));
        log(`Podcast upload session ${sessionId}: started (${totalChunks} chunks, ext=${fileExt})`);
      }

      const session = podcastSessions.get(sessionId);

      // Append chunk to file (frontend sends chunks sequentially)
      fs.appendFileSync(session.audioPath, chunkData);
      session.received.add(chunkIndex);

      const complete = session.received.size >= session.totalChunks;
      if (complete) {
        const fileSize = fs.statSync(session.audioPath).size;
        log(`Podcast upload session ${sessionId}: complete (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
      }

      return sendJSON(res, 200, {
        ok: true,
        received: session.received.size,
        totalChunks: session.totalChunks,
        complete,
      });
    } catch (err) {
      log(`Podcast chunk upload error: ${err.message}`);
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // POST /podcast-downloaded — client confirms download started; delete after short grace period
  if (req.method === 'POST' && url.pathname === '/podcast-downloaded') {
    try {
      const body = await parseBody(req);
      const { jobId } = body;
      if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });
      const job = jobs.get(jobId);
      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
      setTimeout(() => {
        fs.unlink(outputPath, (err) => {
          if (!err) log(`Podcast job ${jobId}: MP4 deleted after download grace period`);
        });
        if (job) jobs.delete(jobId);
      }, PODCAST_DOWNLOADED_DELETE_DELAY_MS);
      return sendJSON(res, 200, { ok: true, queued: true });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // POST /podcast-cancel — cancel a running podcast render
  if (req.method === 'POST' && url.pathname === '/podcast-cancel') {
    try {
      const body = await parseBody(req);
      const { jobId } = body;
      if (!jobId) return sendJSON(res, 400, { error: 'Missing jobId' });
      const job = jobs.get(jobId);
      if (!job) return sendJSON(res, 404, { error: 'Job not found' });
      if (job._ffmpegProc) {
        try { job._ffmpegProc.kill('SIGKILL'); } catch {}
        log(`Podcast job ${jobId}: cancelled (ffmpeg killed)`);
      }
      job.status = 'error';
      job.error = 'Cancelled by user';
      // Cleanup temp files
      const framePath = path.join(TEMP_DIR, `${jobId}_frame.png`);
      const frameLitPath = path.join(TEMP_DIR, `${jobId}_frame_lit.png`);
      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
      fs.unlink(framePath, () => {});
      fs.unlink(frameLitPath, () => {});
      fs.unlink(outputPath, () => {});
      if (job.opts?.audioPath) fs.unlink(job.opts.audioPath, () => {});
      podcastRenderActive = false;
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // POST /podcast-export — JSON body with sessionId + full-frame PNG + metadata → composited podcast MP4
  if (req.method === 'POST' && url.pathname === '/podcast-export') {
    try {
      if (podcastRenderActive) {
        return sendJSON(res, 429, { error: 'A podcast render is already in progress. Please wait.' });
      }

      const body = await parseBody(req);
      const { sessionId, framePng, frameLitPng, duration: rawDuration, width: rawWidth, height: rawHeight, accentColor: rawAccent, progressBar: rawPb, timerInfo: rawTi, waveformRegion: rawWr } = body;

      // Validate session — audio must be fully uploaded
      if (!sessionId || !podcastSessions.has(sessionId)) {
        return sendJSON(res, 400, { error: 'Invalid or expired sessionId. Upload audio chunks first.' });
      }
      const session = podcastSessions.get(sessionId);
      if (session.received.size < session.totalChunks) {
        return sendJSON(res, 400, { error: `Audio upload incomplete: ${session.received.size}/${session.totalChunks} chunks received.` });
      }
      const audioPath = session.audioPath;
      if (!fs.existsSync(audioPath)) {
        podcastSessions.delete(sessionId);
        return sendJSON(res, 400, { error: 'Audio file not found. Please re-upload.' });
      }

      if (!framePng || !framePng.startsWith('data:image/png;base64,')) {
        return sendJSON(res, 400, { error: 'Invalid framePng (must be PNG data URL)' });
      }

      const duration = Math.min(Number(rawDuration) || 900, 7200);
      const width = Number(rawWidth) || 1920;
      const height = Number(rawHeight) || 1080;
      const accentColor = rawAccent || null;

      let progressBar = null;
      if (rawPb && typeof rawPb === 'object') {
        progressBar = {
          x: Math.round(Number(rawPb.x) || 0),
          y: Math.round(Number(rawPb.y) || 0),
          w: Math.round(Number(rawPb.w) || 0),
          h: Math.round(Number(rawPb.h) || 0),
        };
      }

      let timerInfo = null;
      if (rawTi && typeof rawTi === 'object') {
        timerInfo = {
          x: Math.round(Number(rawTi.x) || 0),
          y: Math.round(Number(rawTi.y) || 0),
          fontSize: Math.round(Number(rawTi.fontSize) || 24),
          color: String(rawTi.color || '#FFFFFF'),
          opacity: Number(rawTi.opacity) || 0.5,
        };
      }

      let waveformRegion = null;
      if (rawWr && typeof rawWr === 'object') {
        const x = Math.max(0, Math.min(width - 1, Math.round(Number(rawWr.x) || 0)));
        const y = Math.max(0, Math.min(height - 1, Math.round(Number(rawWr.y) || 0)));
        const maxW = Math.max(0, width - x);
        const maxH = Math.max(0, height - y);
        const w = Math.max(0, Math.min(maxW, Math.round(Number(rawWr.w) || 0)));
        const h = Math.max(0, Math.min(maxH, Math.round(Number(rawWr.h) || 0)));
        if (w > 0 && h > 0) {
          waveformRegion = { x, y, w, h };
        }
      }

      const job = createJob('podcast', {
        audioPath,
        framePng,
        frameLitPng: frameLitPng || null,
        duration,
        width,
        height,
        progressBar,
        timerInfo,
        waveformRegion,
        accentColor,
      });
      job.lastPolled = Date.now();

      podcastRenderActive = true;
      podcastSessions.delete(sessionId); // session consumed
      log(`Podcast job ${job.id} created (${duration}s, ${width}x${height}, audio=${(fs.statSync(audioPath).size / 1024 / 1024).toFixed(1)} MB)`);

      // Process async — don't await
      processPodcastJob(job).catch(err => log(`Unhandled podcast job error: ${err.message}`));

      return sendJSON(res, 202, { jobId: job.id });
    } catch (err) {
      log(`Podcast export request error: ${err.message}`);
      return sendJSON(res, 400, { error: err.message });
    }
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
