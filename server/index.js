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

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const CONFIG_PATH = path.join(__dirname, '..', '.tavus.json');

function tavusConfig() {
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

const routes = {
  'GET /api/config': async () => {
    const cfg = tavusConfig();
    return { tavusReady: Boolean(process.env.TAVUS_API_KEY && cfg.pal_id) };
  },

  'GET /api/puzzles': async () => PUZZLES,

  'POST /api/describe': async ({ fen }) => ({ text: describePosition(fen) }),

  // The ground-truth service. Used by the chess_analyze_position tool and by
  // the board when it reports a wrong move to the PAL.
  'POST /api/analyze': async ({ fen, candidate }) => {
    new Chess(fen); // throws on a bad FEN
    const result = await analyze(fen, 14);
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
          const r = await analyze(after.fen(), 12);
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

  'POST /api/session': async ({ player }) => {
    const cfg = tavusConfig();
    if (!cfg.pal_id) throw Object.assign(new Error('No PAL configured. Run `npm run setup` first.'), { status: 400 });
    const name = String(player || '').trim().slice(0, 40) || null;
    const tag = name ? `chess-student-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null;
    const convo = await tavus('POST', '/conversations', {
      pal_id: cfg.pal_id,
      conversation_name: `Chess coaching${name ? ` with ${name}` : ''}`,
      // Same tag -> same memory store, so Coach Rook remembers this student next time.
      ...(tag ? { participant_tags: [tag] } : {}),
      conversational_context: name ? `The student's name is ${name}.` : undefined,
      custom_greeting: name
        ? `Hey ${name}, I'm Coach Rook. There's a puzzle on the board. Take a look and tell me what jumps out at you.`
        : undefined,
      properties: {
        max_call_duration: 900,
        participant_left_timeout: 20,
        participant_absent_timeout: 120,
        enable_closed_captions: true,
      },
    });
    return { conversation_id: convo.conversation_id, conversation_url: convo.conversation_url };
  },

  'POST /api/session/end': async ({ conversation_id }) => {
    if (!/^[a-z0-9]+$/i.test(conversation_id || '')) return { ok: false };
    await tavus('POST', `/conversations/${conversation_id}/end`).catch(() => {});
    return { ok: true };
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

server.listen(PORT, () => {
  const cfg = tavusConfig();
  console.log(`Coach Rook running at http://localhost:${PORT}`);
  if (!process.env.TAVUS_API_KEY) console.log('  (TAVUS_API_KEY not set: board + engine work, video coach disabled)');
  else if (!cfg.pal_id) console.log('  (no PAL yet: run `npm run setup`)');
});
