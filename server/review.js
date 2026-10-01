// Game review: run Stockfish over every position of a finished game, score each
// move by how much winning chance it cost, and pick the key moments a coach
// would actually talk about.
const crypto = require('crypto');
const { Chess } = require('chess.js');
const { analyze } = require('./engine');
const { describeMove, scoreWords, uciLineToSan } = require('./chessText');

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
const cache = new Map();

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
    const res = await fetch(`https://lichess.org/game/export/${lichess[1]}?clocks=false&evals=false`, {
      headers: { Accept: 'application/x-chess-pgn' },
    });
    if (!res.ok) throw Object.assign(new Error(`Lichess returned ${res.status} for that game`), { status: 400 });
    return res.text();
  }
  return text;
}

async function evalPosition(fen, depth, movetime, newGame = false) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: c.turn() === 'w' ? -10000 : 10000, best: null, pv: [] };
  if (c.isGameOver()) return { cp: 0, best: null, pv: [] };
  const r = await analyze(fen, depth, { multipv: 1, movetime, newGame });
  return { cp: whiteCp(r.lines[0], fen), best: r.bestmove, pv: r.lines[0].pv };
}

async function reviewGame(input, side) {
  const pgn = await loadPgn(input);
  const key = crypto.createHash('sha1').update(pgn + '|' + side).digest('hex');
  if (cache.has(key)) return cache.get(key);

  const game = new Chess();
  try {
    game.loadPgn(pgn);
  } catch (e) {
    throw Object.assign(new Error(`Couldn't read that PGN: ${e.message}`), { status: 400 });
  }
  const headers = game.header();
  const history = game.history({ verbose: true });
  if (!history.length) throw Object.assign(new Error('That game has no moves.'), { status: 400 });

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
      White: headers.White || 'White',
      Black: headers.Black || 'Black',
      Result: headers.Result || '*',
      Event: headers.Event || '',
      Date: headers.Date || '',
    },
    side: side || null,
    startFen: fens[0],
    moves,
    keyMoments,
  };
  cache.set(key, result);
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
  if (Buffer.byteLength(text) > 3500) text = text.slice(0, 3400) + '…';
  return text;
}

// Try-mode: the student proposes a different move at a key moment. Accept it
// if it keeps (almost) all of the winning chances the best move keeps.
async function judgeMove(fen, uci) {
  const c = new Chess(fen);
  const mover = c.turn();
  const move = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  const sign = mover === 'w' ? 1 : -1;
  const before = await analyze(fen, 14, { multipv: 1, movetime: 1000 });
  const bestCp = whiteCp(before.lines[0], fen);
  let afterCp;
  if (c.isCheckmate()) afterCp = mover === 'w' ? 10000 : -10000;
  else if (c.isGameOver()) afterCp = 0;
  else afterCp = whiteCp((await analyze(c.fen(), 14, { multipv: 1, movetime: 1000 })).lines[0], c.fen());
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

module.exports = { judgeMove, reviewGame, reviewContext, winPct, whiteCp, moveLabel };
