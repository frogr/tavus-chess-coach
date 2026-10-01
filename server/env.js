// Tiny .env loader so there are no extra dependencies.
const fs = require('fs');
const path = require('path');

try {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // no .env file; rely on the real environment
}
