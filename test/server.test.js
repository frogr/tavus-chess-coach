// HTTP behaviour of the real server, started without a Tavus key.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer } = require('./helpers');

let app;
test.before(async () => {
  app = await startServer({ LIMIT_ENGINE_PER_MIN: '8' });
});
test.after(() => app.stop());

const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

// Sends a request line exactly as written (fetch would normalize the path).
function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('serves the app with security headers and revalidation', async () => {
  const res = await app.get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self' 'unsafe-eval' https:\/\/c\.daily\.co;/);
  assert.match(await res.text(), /Coach Rook/);

  const again = await app.get('/', { 'If-None-Match': res.headers.get('etag') });
  assert.equal(again.status, 304);
});

test('every file the page loads is served from this server', async () => {
  const html = await (await app.get('/')).text();
  const appJs = await (await app.get('/app.js')).text();
  assert.doesNotMatch(html, /<script[^>]+src="https?:/, 'no third-party scripts');
  assert.doesNotMatch(appJs, /from 'https?:/, 'no third-party imports');
  for (const p of ['/app.js', '/puzzle-logic.mjs', '/styles.css', '/vendor/chess.js', '/vendor/daily.js', '/pieces/wK.svg', '/pieces/bN.svg', '/samples/opera-game.pgn']) {
    const res = await app.get(p);
    assert.equal(res.status, 200, p);
    assert.ok(Number(res.headers.get('content-length')) > 100, p);
  }
  assert.match((await app.get('/vendor/chess.js')).headers.get('content-type'), /javascript/);
  assert.match((await app.get('/pieces/wK.svg')).headers.get('content-type'), /svg/);
});

test('healthz answers immediately; config reports the coach as off without a key', async () => {
  assert.equal((await (await app.get('/healthz')).json()).ok, true);
  assert.deepEqual(await (await app.get('/api/config')).json(), { tavusReady: false, needsCode: false });
});

test('cannot read files outside public/', async () => {
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/../server/index.js', '/.%2e/.env']) {
    const raw = await rawRequest(app.port, `GET ${p} HTTP/1.1`);
    assert.match(raw, /^HTTP\/1\.1 (403|404)/, p);
    assert.doesNotMatch(raw, /"dependencies"|TAVUS_API_KEY|require\(/, p);
  }
});

test('malformed request targets get a 400 and do not crash the server', async () => {
  assert.match(await rawRequest(app.port, 'GET // HTTP/1.1'), /^HTTP\/1\.1 400/);
  assert.match(await rawRequest(app.port, 'GET /%E0%A4%A HTTP/1.1'), /^HTTP\/1\.1 400/);
  assert.equal((await app.get('/healthz')).status, 200, 'still alive');
});

test('unknown routes and wrong methods', async () => {
  assert.equal((await app.get('/api/nope')).status, 404);
  assert.equal((await app.get('/missing.js')).status, 404);
  assert.equal((await app.post('/index.html', {})).status, 405);
  assert.equal((await app.get('/api/analyze')).status, 404, 'analyze is POST only');
});

test('bad request bodies are 400s with a readable message, never 500s', async () => {
  for (const body of ['{not json', 'null', '[]', '"text"']) {
    const res = await app.post('/api/describe', body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error, 'The request body must be a JSON object.');
  }
  for (const fen of [undefined, 42, 'not a fen', '8/8/8/8/8/8/8/8 w - - 0 1', `${BACK_RANK}\nsetoption name Hash value 99999`, 'x'.repeat(500)]) {
    for (const route of ['/api/describe', '/api/analyze', '/api/judge']) {
      const res = await app.post(route, { fen, move: 'd1d8' });
      assert.equal(res.status, 400, `${route} ${fen}`);
    }
  }
  assert.equal((await app.post('/api/judge', { fen: BACK_RANK, move: 'Rd8' })).status, 400);
  assert.equal((await app.post('/api/judge', { fen: BACK_RANK, move: 'd1h5' })).status, 400);
  assert.equal((await app.post('/api/review', { pgn: 12 })).status, 400);
  assert.equal((await app.post('/api/review', { pgn: 'garbage' })).status, 400);
});

test('oversized bodies are refused', async () => {
  const res = await app.post('/api/review', { pgn: 'x'.repeat(200000) });
  assert.equal(res.status, 413);
});

test('describe puts a position into words', async () => {
  const { text } = await (await app.post('/api/describe', { fen: BACK_RANK })).json();
  assert.match(text, /^White: king on g1; rook on d1/);
});

test('analyze finds the mate and judges a candidate move', async () => {
  const best = await (await app.post('/api/analyze', { fen: BACK_RANK })).json();
  assert.equal(best.best.uci, 'd1d8');
  assert.match(best.text, /best move is Rd8#/);
  const top = await (await app.post('/api/analyze', { fen: BACK_RANK, candidate: 'Rd8' })).json();
  assert.match(top.text, /^Rd8# is the engine's top choice\./);
  const other = await (await app.post('/api/analyze', { fen: BACK_RANK, candidate: 'h2-h3' })).json();
  assert.match(other.text, /^If h3: evaluation becomes/);
  const illegal = await (await app.post('/api/analyze', { fen: BACK_RANK, candidate: 'Qh5' })).json();
  assert.match(illegal.text, /^"Qh5" is not a legal move/);
});

test('analyze copes with finished positions and drawing candidates', async () => {
  const mated = await app.post('/api/analyze', { fen: '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1' });
  assert.equal(mated.status, 200);
  assert.match((await mated.json()).text, /game is over/);
  // Qf7 here is stalemate: the candidate ends the game without mate.
  const stalemate = await app.post('/api/analyze', { fen: '7k/8/5QK1/8/8/8/8/8 w - - 0 1', candidate: 'Qf7' });
  assert.equal(stalemate.status, 200);
  assert.match((await stalemate.json()).text, /^Qf7 ends the game in a draw/);
});

test('session routes say the coach is not configured rather than failing', async () => {
  const res = await app.post('/api/session', { player: 'Sam' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Video coach is not configured on this server.');
});

test('the browser code parses as an ES module', async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-rook-app-')), 'app.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'app.js'), copy);
  execFileSync(process.execPath, ['--check', copy]);
});

test('a forged X-Forwarded-For does not dodge the limit when the proxy reports the real address', async () => {
  const real = '203.0.113.77';
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    const headers = { 'CF-Connecting-IP': real, 'X-Forwarded-For': `10.0.0.${i}` };
    statuses.push((await app.post('/api/analyze', { fen: '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1' }, headers)).status);
  }
  assert.deepEqual(statuses, [...Array(8).fill(200), 429, 429]);
});

test('engine endpoints are rate limited per client', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await app.post('/api/analyze', { fen: '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1' }, { 'X-Forwarded-For': '203.0.113.9' })).status);
  }
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(200));
  assert.deepEqual(statuses.slice(8), Array(4).fill(429));
  // A different client is unaffected.
  assert.equal((await app.post('/api/analyze', { fen: BACK_RANK }, { 'X-Forwarded-For': '198.51.100.7' })).status, 200);
});
