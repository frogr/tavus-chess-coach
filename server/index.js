// Coach Rook server: static frontend, Stockfish analysis API, and the
// Tavus conversation lifecycle (the API key never reaches the browser).
require('./env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const { analyze } = require('./engine');
const { describePosition, summarizeAnalysis, scoreWords } = require('./chessText');
const { tavus } = require('./tavus');
const PUZZLES = require('./puzzles');
const { reviewGame, reviewContext, judgeMove } = require('./review');
const { participantTag, getMemory, recordSession } = require('./memory');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const CONFIG_PATH = path.join(__dirname, '..', '.tavus.json');

let bootPalId = null; // set by auto-setup when there's no .tavus.json (fresh deploys)
const ACCESS_CODE = process.env.ACCESS_CODE || '';

function tavusConfig() {
  if (bootPalId && !process.env.TAVUS_PAL_ID) return { pal_id: bootPalId };
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...cfg, pal_id: process.env.TAVUS_PAL_ID || cfg.pal_id };
  } catch {
    return { pal_id: process.env.TAVUS_PAL_ID || null };
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Accepts "Nd6", "e4d6", "e4-d6" and returns a verbose chess.js move or null.
function parseMove(fen, text) {
  if (!text) return null;
  const chess = new Chess(fen);
  const cleaned = String(text).trim().replace(/[!?]+$/, '');
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

function checkCode(code) {
  // On a public deploy, every session spends the owner's Tavus minutes.
  if (ACCESS_CODE && code !== ACCESS_CODE) throw Object.assign(new Error('Wrong access code.'), { status: 401 });
}

function requirePal() {
  const cfg = tavusConfig();
  if (!process.env.TAVUS_API_KEY || !cfg.pal_id) {
    throw Object.assign(new Error('Video coach is not configured on this server.'), { status: 400 });
  }
  return cfg;
}

const routes = {
  'GET /api/config': async () => {
    const cfg = tavusConfig();
    return { tavusReady: Boolean(process.env.TAVUS_API_KEY && cfg.pal_id), needsCode: Boolean(ACCESS_CODE) };
  },

  'GET /api/puzzles': async () => PUZZLES,

  'POST /api/describe': async ({ fen }) => ({ text: describePosition(fen) }),

  // The ground-truth service. Used by the chess_analyze_position tool and by
  // the board when it reports a wrong move to the PAL.
  'POST /api/analyze': async ({ fen, candidate }) => {
    new Chess(fen); // throws on a bad FEN
    const result = await analyze(fen, 14, { movetime: 1200 });
    const summary = summarizeAnalysis(fen, result);
    let candidateText = '';
    if (candidate) {
      const move = parseMove(fen, candidate);
      if (!move) {
        candidateText = `"${candidate}" is not a legal move in this position.`;
      } else if (summary.best && move.lan === summary.best.uci) {
        candidateText = `${move.san} is the engine's top choice.`;
      } else {
        const after = new Chess(fen);
        after.move(move.san);
        if (after.isCheckmate()) {
          candidateText = `${move.san} is checkmate.`;
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
  'POST /api/review': async ({ pgn, side, player }) => {
    const s = side === 'w' || side === 'b' ? side : null;
    const review = await reviewGame(pgn, s);
    return { ...review, context: reviewContext(review, player) };
  },

  'POST /api/judge': async ({ fen, move }) => {
    new Chess(fen);
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move || '')) throw Object.assign(new Error('bad move'), { status: 400 });
    return judgeMove(fen, move);
  },

  'POST /api/session': async ({ player, code }) => {
    checkCode(code);
    const cfg = requirePal();
    const name = String(player || '').trim().slice(0, 40) || null;
    const tag = participantTag(name);

    // Returning student? Read their session notes so the opener can pick up
    // exactly where they left off. (Tavus also gives the PAL these pinned
    // memories plus its learned memory; putting the latest notes in the
    // conversational context makes the generated greeting use them.)
    let notes = [];
    if (tag) notes = (await getMemory(cfg.pal_id, name).catch(() => ({ pinned: [] }))).pinned.map((m) => m.text);
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

    const convo = await tavus('POST', '/conversations', {
      pal_id: cfg.pal_id,
      conversation_name: `Chess coaching${name ? ` with ${name}` : ''}`,
      // Same tag -> same memory store, so Coach Rook remembers this student next time.
      ...(tag ? { participant_tags: [tag] } : {}),
      conversational_context: context || undefined,
      ...(returning
        ? { dynamic_greeting: true } // generated from the context above, so it can reference last time
        : {
            custom_greeting: name
              ? `Hey ${name}, I'm Coach Rook. There's a puzzle on the board. Take a look and tell me what jumps out at you.`
              : undefined,
          }),
      properties: {
        max_call_duration: 900,
        participant_left_timeout: 20,
        participant_absent_timeout: 120,
        enable_closed_captions: true,
      },
    });
    return { conversation_id: convo.conversation_id, conversation_url: convo.conversation_url, returning };
  },

  // End the call and write what happened on the board into the student's memory.
  'POST /api/session/end': async ({ conversation_id, player, code, summary }) => {
    if (/^[a-z0-9]+$/i.test(conversation_id || '')) {
      await tavus('POST', `/conversations/${conversation_id}/end`).catch(() => {});
    }
    if (!player || !summary || (ACCESS_CODE && code !== ACCESS_CODE)) return { ok: true, saved: false };
    const cfg = tavusConfig();
    if (!cfg.pal_id) return { ok: true, saved: false };
    const result = await recordSession(cfg.pal_id, player, summary).catch((e) => ({ saved: false, reason: e.message }));
    return { ok: true, ...result };
  },

  // What Coach Rook remembers about a student (pinned notes + Tavus learned memory).
  'POST /api/memory': async ({ player, code }) => {
    checkCode(code);
    const cfg = requirePal();
    return getMemory(cfg.pal_id, player);
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await handler(body));
    } catch (e) {
      console.error(e.message);
      send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
    }
    return;
  }
  // Static files
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, async () => {
  console.log(`Coach Rook running at http://localhost:${PORT}`);
  // Pre-analyze the bundled sample games so they open instantly in a demo.
  setTimeout(async () => {
    for (const [file, side] of [['legal-trap', 'b'], ['opera-game', 'b']]) {
      try {
        await reviewGame(fs.readFileSync(path.join(PUBLIC, 'samples', `${file}.pgn`), 'utf8').trim(), side);
      } catch (e) {
        console.error(`  sample warmup failed (${file}): ${e.message}`);
      }
    }
    console.log('  Sample games pre-analyzed');
  }, 2000);
  if (!process.env.TAVUS_API_KEY) {
    console.log('  (TAVUS_API_KEY not set: board + engine work, video coach disabled)');
    return;
  }
  if (!tavusConfig().pal_id && process.env.AUTO_SETUP !== '0') {
    console.log('  No PAL configured, running setup…');
    try {
      bootPalId = await require('./setup').ensureSetup();
      console.log(`  PAL ready: ${bootPalId}`);
    } catch (e) {
      console.error(`  Auto-setup failed: ${e.message}`);
    }
  }
  if (ACCESS_CODE) console.log('  Sessions require ACCESS_CODE');
});
