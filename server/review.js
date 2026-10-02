// Game review: run Stockfish over every position of a finished game, score each
// move by how much winning chance it cost, and pick the key moments a coach
// would actually talk about.
const crypto = require('crypto');
const { Chess } = require('chess.js');
const { analyze } = require('./engine');
const { describeMove, scoreWords, uciLineToSan } = require('./chessText');
const { httpError } = require('./errors');

// Two passes: a fast scan of every position, then a deep re-check of only the
// positions around moves the scan flagged. Deep everywhere is ~4x slower on a
// small server; fast everywhere produces false "blunders" from horizon effects.
const FAST_DEPTH = Number(process.env.REVIEW_FAST_DEPTH || 10);
const DEEP_DEPTH = Number(process.env.REVIEW_DEEP_DEPTH || 15);
const FLAG_THRESHOLD = 8; // win% lost in the fast pass that earns a deep re-check
// Per-position time caps (ms). Depth is reached well inside these on a laptop;
// on a free-tier instance (~8x slower) the caps keep a full review near 20s.
const FAST_MOVETIME = Number(process.env.REVIEW_FAST_MOVETIME || 250);
const DEEP_MOVETIME = Number(process.env.REVIEW_DEEP_MOVETIME || 1200);
// Reviews are the expensive endpoint and it is open to anyone, so bound it:
// game length, simultaneous reviews, and the size of the result cache.
const MAX_PLIES = 400;
const MAX_ACTIVE = 2;
const MAX_CACHED = 50;
const MAX_PGN_BYTES = 100000;
const cache = new Map(); // key -> Promise of a review, oldest first
let active = 0;

// PGN headers are free text that ends up in the PAL's context and on screen.
function cleanHeader(value, fallback) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return text && !/^\?+$/.test(text) ? text : fallback; // chess.js fills missing names with "?"
}

// Engine line -> centipawns from White's point of view (mates mapped to +-10000).
function whiteCp(line, fen) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (line.mate !== null && line.mate !== undefined) {
    if (line.mate === 0) return 0;
    return sign * Math.sign(line.mate) * (10000 - Math.abs(line.mate) * 10);
  }
  return sign * line.cp;
}

// Lichess's win-probability curve. Comparing win% instead of raw centipawns
// means going from +9 to +6 (still winning) isn't flagged, but +1 to -2 is.
function winPct(cpWhite) {
  const cp = Math.max(-1000, Math.min(1000, cpWhite));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function classify(loss) {
  if (loss >= 30) return 'blunder';
  if (loss >= 20) return 'mistake';
  if (loss >= 10) return 'inaccuracy';
  return null;
}
const SYMBOL = { blunder: '??', mistake: '?', inaccuracy: '?!' };

function evalWordsWhite(cpWhite) {
  // scoreWords expects side-to-move POV; feed it as if White to move.
  if (Math.abs(cpWhite) >= 9000) {
    const n = Math.round((10000 - Math.abs(cpWhite)) / 10);
    return `${cpWhite > 0 ? 'White' : 'Black'} mates in ${n}`;
  }
  return scoreWords({ cp: cpWhite, mate: null }, '8/8/8/8/8/8/8/8 w - - 0 1');
}

async function loadPgn(input) {
  const text = String(input || '').trim();
  const lichess = text.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  if (lichess) {
    let res;
    try {
      res = await fetch(`https://lichess.org/game/export/${lichess[1]}?clocks=false&evals=false`, {
        headers: { Accept: 'application/x-chess-pgn' },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw httpError(502, "Couldn't reach Lichess to download that game. Paste the PGN instead.");
    }
    if (!res.ok) throw httpError(400, `Lichess returned ${res.status} for that game`);
    return (await res.text()).slice(0, MAX_PGN_BYTES).trim();
  }
  return text;
}

async function evalPosition(fen, depth, movetime, newGame = false) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: c.turn() === 'w' ? -10000 : 10000, best: null, pv: [] };
  if (c.isGameOver()) return { cp: 0, best: null, pv: [] };
  const r = await analyze(fen, depth, { multipv: 1, movetime, newGame });
  if (!r.lines[0]) return { cp: 0, best: null, pv: [] };
  return { cp: whiteCp(r.lines[0], fen), best: r.bestmove, pv: r.lines[0].pv };
}

async function reviewGame(input, side) {
  const pgn = await loadPgn(input);
  if (!pgn) throw httpError(400, 'Paste a PGN or a Lichess game link first.');
  const key = crypto.createHash('sha1').update(pgn + '|' + side).digest('hex');
  // The cache holds promises, so two people loading the same game share one engine pass.
  if (cache.has(key)) return cache.get(key);

  const game = new Chess();
  try {
    game.loadPgn(pgn);
  } catch (e) {
    throw httpError(400, `Couldn't read that PGN: ${String(e.message).slice(0, 200)}`);
  }
  const history = game.history({ verbose: true });
  if (!history.length) throw httpError(400, 'That game has no moves.');
  if (history.length > MAX_PLIES) throw httpError(400, `That game is too long to review (limit: ${MAX_PLIES / 2} moves).`);
  if (active >= MAX_ACTIVE) throw httpError(503, 'The server is reviewing other games right now. Try again in a minute.');

  active++;
  const job = runReview(game, history, side).finally(() => active--);
  cache.set(key, job);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  job.catch(() => cache.delete(key));
  return job;
}

async function runReview(game, history, side) {
  const headers = game.header();

  // Positions: before move 1 through after the last move.
  const fens = [history[0].before, ...history.map((m) => m.after)];
  const evals = [];
  for (const [i, fen] of fens.entries()) evals.push(await evalPosition(fen, FAST_DEPTH, FAST_MOVETIME, i === 0));

  // Deep re-check around every move the fast pass thinks lost something.
  const recheck = new Set();
  history.forEach((m, i) => {
    const sign = m.color === 'w' ? 1 : -1;
    const loss = winPct(sign * evals[i].cp) - winPct(sign * evals[i + 1].cp);
    if (loss >= FLAG_THRESHOLD) {
      recheck.add(i);
      recheck.add(i + 1);
    }
  });
  for (const i of recheck) evals[i] = await evalPosition(fens[i], DEEP_DEPTH, DEEP_MOVETIME);

  const moves = history.map((m, i) => {
    const mover = m.color;
    const before = evals[i];
    const after = evals[i + 1];
    const sign = mover === 'w' ? 1 : -1;
    const loss = Math.max(0, winPct(sign * before.cp) - winPct(sign * after.cp));
    const playedBest = before.best === m.lan;
    const cls = playedBest ? null : classify(loss);
    return {
      ply: i + 1,
      moveNumber: Math.ceil((i + 1) / 2),
      color: mover,
      san: m.san,
      uci: m.lan,
      fenBefore: m.before,
      fenAfter: m.after,
      evalBefore: before.cp,
      evalAfter: after.cp,
      loss: Math.round(loss * 10) / 10,
      class: cls,
      symbol: cls ? SYMBOL[cls] : '',
      best: before.best,
      bestSan: before.best ? uciLineToSan(m.before, [before.best])[0] : null,
      bestLine: before.best ? uciLineToSan(m.before, before.pv, 6) : [],
    };
  });

  // Key moments: the student's costliest moves (both sides if no side chosen).
  const mine = moves.filter((m) => (!side || m.color === side) && m.class);
  const ranked = [...mine].sort((a, b) => b.loss - a.loss).slice(0, 4).sort((a, b) => a.ply - b.ply);
  const keyMoments = ranked.map((m, i) => ({ index: i + 1, ply: m.ply, text: describeMoment(m, i + 1) }));

  const result = {
    headers: {
      White: cleanHeader(headers.White, 'White'),
      Black: cleanHeader(headers.Black, 'Black'),
      Result: cleanHeader(headers.Result, '*'),
      Event: cleanHeader(headers.Event, ''),
      Date: cleanHeader(headers.Date, ''),
    },
    side: side || null,
    startFen: fens[0],
    moves,
    keyMoments,
  };
  return result;
}

function moveLabel(m) {
  return `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}`;
}

function describeMoment(m, n) {
  const played = describeMove(m.fenBefore, m.uci).text;
  const best = m.best ? describeMove(m.fenBefore, m.best).text : null;
  return (
    `Moment ${n}, move ${moveLabel(m)} (${m.class}): ${played}. ` +
    `Before it: ${evalWordsWhite(m.evalBefore)}. After it: ${evalWordsWhite(m.evalAfter)}. ` +
    (best ? `Engine preferred ${m.bestSan} (${best}), line: ${m.bestLine.join(' ')}.` : '')
  );
}

// Compact summary for the PAL. Interaction messages are capped at 4 KB, so
// this carries the key moments, not the whole game.
function reviewContext(review, studentName) {
  const who = studentName || 'The student';
  const sideText = review.side ? `${who} played ${review.side === 'w' ? 'White' : 'Black'}` : `${who} did not say which side they played`;
  const h = review.headers;
  const opening = review.moves.slice(0, 8).map(moveLabel).join(' ');
  let text =
    `[board] Game review loaded: ${h.White} (White) vs ${h.Black} (Black), result ${h.Result}${h.Event ? `, ${h.Event}` : ''}. ` +
    `${sideText}. ${review.moves.length} half-moves. Opening: ${opening}. ` +
    (review.keyMoments.length
      ? `Engine-found key moments (call chess_goto_moment to show one): ${review.keyMoments.map((k) => k.text).join(' ')}`
      : 'The engine found no real mistakes by the student in this game.');
  while (Buffer.byteLength(text) > 3500) text = text.slice(0, Math.floor(text.length * 0.95)) + '…';
  return text;
}

// Try-mode: the student proposes a different move at a key moment. Accept it
// if it keeps (almost) all of the winning chances the best move keeps.
async function judgeMove(fen, uci, { movetime = 1000 } = {}) {
  const c = new Chess(fen);
  const mover = c.turn();
  let move;
  try {
    move = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  } catch {
    throw httpError(400, 'That move is not legal in this position.');
  }
  const sign = mover === 'w' ? 1 : -1;
  const before = await analyze(fen, 14, { multipv: 1, movetime });
  const bestCp = whiteCp(before.lines[0], fen);
  let afterCp;
  if (c.isCheckmate()) afterCp = mover === 'w' ? 10000 : -10000;
  else if (c.isGameOver()) afterCp = 0;
  else afterCp = whiteCp((await analyze(c.fen(), 14, { multipv: 1, movetime, newGame: false })).lines[0], c.fen());
  const loss = Math.max(0, winPct(sign * bestCp) - winPct(sign * afterCp));
  const bestSan = uciLineToSan(fen, [before.bestmove])[0];
  return {
    ok: move.lan === before.bestmove || loss < 5,
    san: move.san,
    words: describeMove(fen, uci).text,
    bestSan,
    bestWords: describeMove(fen, before.bestmove).text,
    lossPct: Math.round(loss),
    evalAfter: evalWordsWhite(afterCp),
    evalBest: evalWordsWhite(bestCp),
    bestLine: uciLineToSan(fen, before.lines[0].pv, 6),
  };
}

module.exports = { judgeMove, reviewGame, reviewContext, winPct, whiteCp, classify, moveLabel, MAX_PLIES };
