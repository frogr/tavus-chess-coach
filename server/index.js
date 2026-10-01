// Coach Rook server: static frontend, Stockfish analysis API, and the
// Tavus conversation lifecycle (the API key never reaches the browser).
require('./env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require('chess.js');
const { analyze } = require('./engine');
const { describePosition, summarizeAnalysis, scoreWords } = require('./chessText');
const { tavus } = require('./tavus');
const PUZZLES = require('./puzzles');
const { reviewGame, reviewContext, judgeMove } = require('./review');
const { cleanName, participantTag, getMemory, recordSession } = require('./memory');
const { httpError } = require('./errors');
const { createLimiter } = require('./limits');
const audit = require('./audit');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const MODULES = path.join(__dirname, '..', 'node_modules');
const CONFIG_PATH = process.env.TAVUS_CONFIG_PATH || path.join(__dirname, '..', '.tavus.json');
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MAX_BODY = 100000; // bytes; a long PGN is a few KB
// The admin dashboard is off unless a token is configured.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Where Tavus can reach this server with conversation callbacks (transcript,
// perception analysis, shutdown). Render provides RENDER_EXTERNAL_URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK_TOKEN = audit.webhookToken(ADMIN_TOKEN || process.env.TAVUS_API_KEY || 'no-secret');

// Browser libraries are served from the installed packages, so the versions
// are pinned by package-lock.json and nothing loads from a CDN at runtime.
const VENDOR = {
  '/vendor/chess.js': path.join(MODULES, 'chess.js', 'dist', 'esm', 'chess.js'),
  '/vendor/daily.js': path.join(MODULES, '@daily-co', 'daily-js', 'dist', 'daily.js'),
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    // Daily's call engine is fetched from Daily's CDN and evaluated by its SDK,
    // which is why 'unsafe-eval' is here. Nothing in this app evaluates strings.
    "script-src 'self' 'unsafe-eval' https://c.daily.co",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self' https://*.daily.co wss://*.daily.co https://*.pluot.blue wss://*.pluot.blue", // Daily signalling and media servers
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// Per-client budgets. The engine endpoints are open to anyone with the URL.
const num = (name, fallback) => Number(process.env[name] || fallback);
const limits = {
  api: createLimiter({ windowMs: 60000, max: num('LIMIT_API_PER_MIN', 300) }),
  engine: createLimiter({ windowMs: 60000, max: num('LIMIT_ENGINE_PER_MIN', 60) }),
  review: createLimiter({ windowMs: 60000, max: num('LIMIT_REVIEW_PER_MIN', 6) }),
  session: createLimiter({ windowMs: 600000, max: num('LIMIT_SESSIONS_PER_10MIN', 10) }),
  badCode: createLimiter({ windowMs: 600000, max: num('LIMIT_BAD_CODES_PER_10MIN', 10) }),
  events: createLimiter({ windowMs: 60000, max: num('LIMIT_EVENT_POSTS_PER_MIN', 120) }),
};

function budget(limiter, ip, what) {
  if (!limiter.take(ip)) throw httpError(429, `Too many ${what} from your network. Wait a minute and try again.`);
}

// ---------------------------------------------------------------- PAL config
let bootPalId = null; // set by auto-setup when there's no .tavus.json (fresh deploys)
let setupRunning = null;
let lastSetupAttempt = 0;

function tavusConfig() {
  if (bootPalId && !process.env.TAVUS_PAL_ID) return { pal_id: bootPalId };
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...cfg, pal_id: process.env.TAVUS_PAL_ID || cfg.pal_id };
  } catch {
    return { pal_id: process.env.TAVUS_PAL_ID || null };
  }
}

// On a fresh deploy the server registers the PAL itself. Requests that need
// the PAL wait for a setup that is in flight, and a failed setup is retried
// (at most every 30s) instead of leaving the coach off until the next restart.
function ensurePal() {
  if (!process.env.TAVUS_API_KEY || process.env.AUTO_SETUP === '0' || tavusConfig().pal_id) return Promise.resolve();
  if (setupRunning) return setupRunning;
  if (Date.now() - lastSetupAttempt < 30000) return Promise.resolve();
  lastSetupAttempt = Date.now();
  console.log('  No PAL configured, running setup…');
  setupRunning = require('./setup')
    .ensureSetup()
    .then((id) => {
      bootPalId = id;
      console.log(`  PAL ready: ${id}`);
    })
    .catch((e) => console.error(`  Auto-setup failed: ${e.message}`))
    .finally(() => {
      setupRunning = null;
    });
  return setupRunning;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const palSettled = () => Promise.race([ensurePal(), sleep(25000)]);

// ---------------------------------------------------------------- helpers
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        return reject(httpError(413, 'That request is too large.'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(httpError(400, 'The request body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

// Who is calling, for rate limiting. Render sits behind Cloudflare, which sets
// CF-Connecting-IP itself and overwrites anything the caller sent, so prefer
// it: the first X-Forwarded-For entry can be forged by the caller.
function clientIp(req) {
  const h = req.headers;
  const cf = String(h['cf-connecting-ip'] || '').trim();
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return cf || fwd || req.socket.remoteAddress || 'unknown';
}

// Validates a FEN from the client and returns it in canonical form.
function cleanFen(fen) {
  try {
    if (typeof fen !== 'string' || fen.length > 100) throw new Error('bad fen');
    return new Chess(fen).fen();
  } catch {
    throw httpError(400, 'That is not a valid chess position.');
  }
}

// Accepts "Nd6", "e4d6", "e4-d6" and returns a verbose chess.js move or null.
function parseMove(fen, text) {
  if (!text) return null;
  const chess = new Chess(fen);
  const cleaned = String(text).trim().slice(0, 12).replace(/[!?]+$/, '');
  const uci = cleaned.replace(/[-\s]/g, '').toLowerCase();
  try {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    }
    return chess.move(cleaned);
  } catch {
    return null;
  }
}

function codeMatches(code) {
  const a = crypto.createHash('sha256').update(String(code ?? '')).digest();
  const b = crypto.createHash('sha256').update(ACCESS_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}

// On a public deploy, every session spends the owner's Tavus minutes. Wrong
// guesses are counted per client so the code can't be brute-forced.
function checkCode(code, ip) {
  if (!ACCESS_CODE) return;
  if (limits.badCode.blocked(ip)) throw httpError(429, 'Too many wrong access codes. Try again in a few minutes.');
  if (!codeMatches(code)) {
    limits.badCode.hit(ip);
    throw httpError(401, 'Wrong access code.');
  }
}

const secretMatches = (given, expected) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(String(given ?? '')).digest(), crypto.createHash('sha256').update(expected).digest());

// Admin routes: a bearer token, with the same lockout as the access code.
function requireAdmin(req, ip) {
  if (!ADMIN_TOKEN) throw httpError(404, 'not found');
  if (limits.badCode.blocked(ip)) throw httpError(429, 'Too many wrong tokens. Try again in a few minutes.');
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secretMatches(given, ADMIN_TOKEN)) {
    limits.badCode.hit(ip);
    throw httpError(401, 'Wrong admin token.');
  }
}

// Ask Tavus for everything it has on a conversation (status, transcript,
// perception analysis, shutdown reason) and keep it with the session.
async function pullTavusRecord(id) {
  const record = await tavus('GET', `/conversations/${id}?verbose=true`);
  await audit.session(id, { data: { tavus: record, tavus_fetched_at: new Date().toISOString() } });
  return record;
}

function requirePal() {
  const cfg = tavusConfig();
  if (!process.env.TAVUS_API_KEY || !cfg.pal_id) throw httpError(400, 'Video coach is not configured on this server.');
  return cfg;
}

const routes = {
  // Liveness for the host's health check: must answer instantly, even mid-setup.
  'GET /healthz': async () => ({ ok: true, commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || undefined }),

  'GET /api/config': async () => {
    await palSettled();
    const cfg = tavusConfig();
    return { tavusReady: Boolean(process.env.TAVUS_API_KEY && cfg.pal_id), needsCode: Boolean(ACCESS_CODE) };
  },

  'GET /api/puzzles': async () => PUZZLES,

  'POST /api/describe': async ({ fen }) => ({ text: describePosition(cleanFen(fen)) }),

  // The ground-truth service. Used by the chess_analyze_position tool and by
  // the board when it reports a wrong move to the PAL.
  'POST /api/analyze': async ({ fen: rawFen, candidate }, { ip }) => {
    const fen = cleanFen(rawFen);
    budget(limits.engine, ip, 'engine requests');
    if (new Chess(fen).isGameOver()) return summarizeAnalysis(fen, { lines: [] });
    const result = await analyze(fen, 14, { movetime: 1200 });
    const summary = summarizeAnalysis(fen, result);
    let candidateText = '';
    if (candidate) {
      const move = parseMove(fen, candidate);
      if (!move) {
        candidateText = `"${String(candidate).slice(0, 12)}" is not a legal move in this position.`;
      } else if (summary.best && move.lan === summary.best.uci) {
        candidateText = `${move.san} is the engine's top choice.`;
      } else {
        const after = new Chess(fen);
        after.move(move.san);
        if (after.isCheckmate()) {
          candidateText = `${move.san} is checkmate.`;
        } else if (after.isGameOver()) {
          candidateText = `${move.san} ends the game in a draw (stalemate or not enough material to mate). Compare with the best move ${summary.best.san[0]} (${summary.best.eval}).`;
        } else {
          const r = await analyze(after.fen(), 12, { multipv: 1, movetime: 700 });
          const reply = summarizeAnalysis(after.fen(), r);
          candidateText =
            `If ${move.san}: evaluation becomes ${scoreWords(r.lines[0], after.fen())}, ` +
            `and the opponent's best reply is ${reply.best ? reply.best.san[0] : 'none'} ` +
            `(line: ${reply.best ? reply.best.san.join(' ') : '-'}). Compare with the best move ${summary.best.san[0]} (${summary.best.eval}).`;
        }
      }
    }
    return {
      text: (candidateText ? candidateText + ' ' : '') + summary.text,
      best: summary.best,
      lines: summary.lines,
    };
  },

  // Game review: engine pass over a whole game + a compact summary for the PAL.
  'POST /api/review': async ({ pgn, side, player }, { ip }) => {
    if (typeof pgn !== 'string' || !pgn.trim()) throw httpError(400, 'Paste a PGN or a Lichess game link first.');
    budget(limits.review, ip, 'game reviews');
    const s = side === 'w' || side === 'b' ? side : null;
    const review = await reviewGame(pgn, s);
    return { ...review, context: reviewContext(review, cleanName(player)) };
  },

  'POST /api/judge': async ({ fen: rawFen, move }, { ip }) => {
    const fen = cleanFen(rawFen);
    if (typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw httpError(400, 'That is not a move.');
    budget(limits.engine, ip, 'engine requests');
    return judgeMove(fen, move);
  },

  'POST /api/session': async ({ player, key, code }, { ip, clientId }) => {
    checkCode(code, ip);
    budget(limits.session, ip, 'sessions');
    await palSettled();
    const cfg = requirePal();
    const name = cleanName(player) || null;
    const tag = participantTag(name, key);

    // Returning student? Read their session notes so the opener can pick up
    // exactly where they left off. (Tavus also gives the PAL these pinned
    // memories plus its learned memory; putting the latest notes in the
    // conversational context makes the generated greeting use them.)
    let notes = [];
    if (tag) notes = (await getMemory(cfg.pal_id, name, key).catch(() => ({ pinned: [] }))).pinned.map((m) => m.text);
    const recent = notes.filter((n) => n.startsWith('Session note')).slice(-3);
    const returning = recent.length > 0;

    const context = [
      name ? `The student's name is ${name}.` : null,
      returning
        ? `This is a RETURNING student. Notes from their recent sessions, oldest first: ${recent.join(' ')} ` +
          `Open by greeting them by name and referencing one specific thing from the most recent note (what they nailed or what tripped them up), ` +
          `then propose what to work on today, e.g. a puzzle on the theme they struggled with (use chess_load_puzzle with that theme).`
        : name
          ? 'This is their first session with you. Welcome them and get them started on the puzzle on the board.'
          : null,
    ].filter(Boolean).join(' ');

    const greeting = returning
      ? null
      : name
        ? `Hey ${name}, I'm Coach Rook. There's a puzzle on the board. Take a look and tell me what jumps out at you.`
        : undefined;
    const convo = await tavus('POST', '/conversations', {
      pal_id: cfg.pal_id,
      // Tavus posts conversation events (transcript, perception analysis, shutdown) here for the audit log.
      ...(PUBLIC_URL ? { callback_url: `${PUBLIC_URL}/api/tavus/webhook/${WEBHOOK_TOKEN}` } : {}),
      conversation_name: `Chess coaching${name ? ` with ${name}` : ''}`,
      // Same tag -> same memory store, so Coach Rook remembers this student next time.
      ...(tag ? { participant_tags: [tag] } : {}),
      conversational_context: context || undefined,
      ...(returning
        ? { dynamic_greeting: true } // generated from the context above, so it can reference last time
        : { custom_greeting: greeting }),
      properties: {
        max_call_duration: 900,
        participant_left_timeout: 20,
        participant_absent_timeout: 120,
        enable_closed_captions: true,
      },
    });
    await audit.session(convo.conversation_id, {
      data: { player: name, participant_tag: tag, pal_id: cfg.pal_id, returning, client_id: clientId, ip, context, greeting: greeting || (returning ? '(generated from context)' : '(PAL default)'), notes_sent: recent },
    });
    return { conversation_id: convo.conversation_id, conversation_url: convo.conversation_url, returning };
  },

  // End the call and write what happened on the board into the student's memory.
  // Needs the access code like starting one does: it calls Tavus with the
  // owner's key and writes to a student's memory.
  'POST /api/session/end': async ({ conversation_id, player, key, code, summary }, { ip }) => {
    checkCode(code, ip);
    const cfg = requirePal();
    const valid = typeof conversation_id === 'string' && /^[a-z0-9]{4,64}$/i.test(conversation_id);
    if (valid) await tavus('POST', `/conversations/${conversation_id}/end`).catch(() => {});
    const name = cleanName(player);
    let result = { saved: false };
    if (name && summary) {
      result = await recordSession(cfg.pal_id, name, key, summary).catch((e) => {
        if (e.expose) throw e;
        console.error(`session note not saved: ${e.message}`);
        return { saved: false, reason: 'the memory service returned an error' };
      });
    }
    if (valid) {
      await audit.session(conversation_id, { ended_at: new Date().toISOString(), data: { summary: summary || null, note: result.note || null, note_saved: result.saved } });
      // Tavus's own record of the call; the transcript arrives later by webhook.
      pullTavusRecord(conversation_id).catch(() => {});
    }
    return { ok: true, ...result };
  },

  // What Coach Rook remembers about a student (pinned notes + Tavus learned memory).
  'POST /api/memory': async ({ player, key, code }, { ip }) => {
    checkCode(code, ip);
    await palSettled();
    const cfg = requirePal();
    return getMemory(cfg.pal_id, cleanName(player), key);
  },
};

// ---------------------------------------------------------------- audit + admin
// The browser reports what happened on the board and in the call.
routes['POST /api/events'] = async ({ client, events }, { ip }) => {
  budget(limits.events, ip, 'event reports');
  const clientId = typeof client === 'string' && /^[a-z0-9-]{8,64}$/i.test(client) ? client : null;
  if (!clientId || !Array.isArray(events)) throw httpError(400, 'Malformed event report.');
  for (const e of events.slice(0, 100)) {
    if (!e || typeof e.kind !== 'string') continue;
    const t = Number(e.t);
    audit.record({
      source: 'client',
      kind: e.kind.replace(/[^\w.:→← -]/g, '').slice(0, 100) || 'unknown',
      ts: Number.isFinite(t) && Math.abs(Date.now() - t) < 3600000 ? new Date(t) : new Date(),
      client_id: clientId,
      conversation_id: typeof e.conversation_id === 'string' && /^[a-z0-9]{4,64}$/i.test(e.conversation_id) ? e.conversation_id : null,
      ip,
      data: e.data,
    });
  }
  return { ok: true };
};

routes['GET /api/admin/overview'] = async (_b, { req, ip }) => {
  requireAdmin(req, ip);
  return { stats: await audit.stats(), sessions: await audit.listSessions({ limit: 100 }), visits: await audit.listVisits({ limit: 100 }) };
};

routes['GET /api/admin/session'] = async (_b, { req, ip, query }) => {
  requireAdmin(req, ip);
  const id = String(query.get('id') || '');
  if (!/^[a-z0-9]{4,64}$/i.test(id)) throw httpError(400, 'Bad conversation id.');
  let refreshError = null;
  if (query.get('refresh') === '1' && process.env.TAVUS_API_KEY) await pullTavusRecord(id).catch((e) => (refreshError = e.message));
  const session = await audit.getSession(id);
  if (!session) throw httpError(404, 'No such session in the audit log.');
  return { session, refreshError };
};

routes['GET /api/admin/events'] = async (_b, { req, ip, query }) => {
  requireAdmin(req, ip);
  const pick = (name, max = 100) => (query.get(name) || '').slice(0, max) || undefined;
  return {
    events: await audit.listEvents({
      kind: pick('kind'),
      source: pick('source', 20),
      client: pick('client', 64),
      conversation: pick('conversation', 64),
      q: pick('q', 200),
      before: Number(query.get('before')) || undefined,
      limit: Math.min(Number(query.get('limit')) || 200, 1000),
    }),
  };
};

// Tavus conversation callbacks. The path carries a token only Tavus was given.
async function tavusWebhook(token, payload, ip) {
  if (!secretMatches(token, WEBHOOK_TOKEN)) throw httpError(404, 'not found');
  const id = typeof payload.conversation_id === 'string' && /^[a-z0-9]{4,64}$/i.test(payload.conversation_id) ? payload.conversation_id : null;
  const type = String(payload.event_type || payload.message_type || 'unknown').slice(0, 80);
  audit.record({ source: 'tavus', kind: `tavus.webhook:${type}`, conversation_id: id, ip, data: payload, whole: true });
  if (id && type === 'system.shutdown') await audit.session(id, { ended_at: new Date().toISOString(), data: { shutdown: payload.properties || {} } });
  if (id && type === 'application.transcription_ready') await audit.session(id, { data: { transcript: payload.properties?.transcript || payload.properties || null } });
  if (id && type === 'application.perception_analysis') await audit.session(id, { data: { perception_analysis: payload.properties?.analysis || payload.properties || null } });
  return { ok: true };
}

// What gets written to the audit log for one API request.
const UNLOGGED = new Set(['/healthz', '/api/events']); // liveness pings and the event reports themselves
function logRequest(req, pathname, ctx, body, status, started, result, error) {
  if (UNLOGGED.has(pathname)) return;
  const admin = pathname.startsWith('/api/admin/');
  const convo = [body?.conversation_id, result?.conversation_id].find((v) => typeof v === 'string' && /^[a-z0-9]{4,64}$/i.test(v));
  audit.record({
    kind: status >= 400 ? 'http.error' : admin ? 'http.admin' : 'http',
    client_id: ctx.clientId,
    conversation_id: convo || null,
    ip: ctx.ip,
    data: {
      method: req.method,
      path: pathname.startsWith('/api/tavus/webhook/') ? '/api/tavus/webhook/[token]' : pathname,
      status,
      ms: Date.now() - started,
      request: req.method === 'POST' ? body : undefined,
      response: admin ? undefined : result, // the dashboard reading the log is not itself worth storing
      error: error || undefined,
      agent: String(req.headers['user-agent'] || '').slice(0, 200) || undefined,
    },
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.pgn': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (rel.includes('\0')) return send(res, 400, { error: 'bad request' });
  if (rel === '/admin') rel = '/admin.html';
  const file = VENDOR[rel] || path.join(PUBLIC, rel === '/' ? 'index.html' : rel);
  if (!VENDOR[rel] && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { error: 'not found' });
    // Always revalidate, so a deploy is picked up at once; unchanged files cost a 304.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...SECURITY_HEADERS,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  const pathname = url.pathname;
  const webhook = req.method === 'POST' && pathname.startsWith('/api/tavus/webhook/');
  const handler = webhook ? (body, ctx) => tavusWebhook(pathname.split('/')[4], body, ctx.ip) : routes[`${req.method} ${pathname}`];
  if (!handler) {
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return serveStatic(req, res, pathname);
  }
  const started = Date.now();
  const clientId = /^[a-z0-9-]{8,64}$/i.test(req.headers['x-client-id'] || '') ? req.headers['x-client-id'] : null;
  const ctx = { ip: clientIp(req), clientId, query: url.searchParams, req };
  let body = {};
  try {
    budget(limits.api, ctx.ip, 'requests');
    if (req.method === 'POST') body = await readBody(req, webhook ? 4000000 : MAX_BODY); // transcripts are long
    const result = await handler(body, ctx);
    send(res, 200, result);
    logRequest(req, pathname, ctx, body, 200, started, result);
  } catch (e) {
    if (e.expose) {
      send(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
      return logRequest(req, pathname, ctx, body, e.status, started, null, e.message);
    }
    // Anything unexpected: full detail in the server log, a short message to the browser.
    console.error(`${req.method} ${pathname} failed: ${e.stack || e.message}`);
    const status = e.tavus ? 502 : 500;
    const detail = e.tavus && typeof e.data?.message === 'string' ? ` Tavus said: ${e.data.message.slice(0, 200)}` : '';
    send(res, status, { error: e.tavus ? `The video service (Tavus) returned an error.${detail}` : 'Something went wrong on the server.' });
    logRequest(req, pathname, ctx, body, status, started, null, e.stack || e.message);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`request crashed: ${e.stack || e.message}`);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
    else res.destroy();
  });
});

// A stray rejection should be logged, not take the whole service down.
process.on('unhandledRejection', (e) => {
  console.error(`unhandled rejection: ${e && (e.stack || e.message || e)}`);
  audit.record({ kind: 'server.error', data: { error: String(e && (e.stack || e.message || e)) } });
});

server.listen(PORT, async () => {
  console.log(`Coach Rook running at http://localhost:${PORT}`);
  await audit.init();
  audit.record({ kind: 'server.boot', data: { commit: process.env.RENDER_GIT_COMMIT || null, node: process.version, admin: Boolean(ADMIN_TOKEN), webhook: Boolean(PUBLIC_URL) } });
  if (ADMIN_TOKEN) console.log('  Admin dashboard at /admin');
  if (!process.env.TAVUS_API_KEY) {
    console.log('  (TAVUS_API_KEY not set: board + engine work, video coach disabled)');
  } else {
    if (ACCESS_CODE) console.log('  Sessions require ACCESS_CODE');
    else console.log('  WARNING: ACCESS_CODE is not set, so anyone who can reach this server can start video sessions on your Tavus account');
    await ensurePal();
  }
  // Pre-analyze the bundled sample games so they open instantly in a demo.
  // After setup, so a small instance isn't doing both at once while it boots.
  if (process.env.SAMPLE_WARMUP === '0') return;
  for (const [file, side] of [['legal-trap', 'b'], ['opera-game', 'b']]) {
    try {
      await reviewGame(fs.readFileSync(path.join(PUBLIC, 'samples', `${file}.pgn`), 'utf8').trim(), side);
    } catch (e) {
      console.error(`  sample warmup failed (${file}): ${e.message}`);
    }
  }
  console.log('  Sample games pre-analyzed');
});

// Render sends SIGTERM on every deploy: stop accepting, let in-flight requests finish.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    // Finish in-flight requests and write out any queued audit events first.
    server.close(() => audit.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
