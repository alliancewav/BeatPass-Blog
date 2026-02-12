// Minimal .env loader — no dependencies required.
// Reads the root .env file and populates process.env for any keys not already set.

const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
