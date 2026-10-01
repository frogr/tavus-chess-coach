// Turn engine output and board state into plain English the PAL can speak.
// LLMs are unreliable at reading FEN or UCI, so the PAL never sees raw notation
// on its own: every position and engine line arrives already described.
const { Chess } = require('chess.js');

const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];

function describePosition(fen) {
  const chess = new Chess(fen);
  const sides = { w: {}, b: {} };
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      (sides[sq.color][sq.type] ||= []).push(sq.square);
    }
  }
  const side = (c) =>
    ORDER.filter((t) => sides[c][t])
      .map((t) => {
        const squares = sides[c][t].sort();
        const name = NAMES[t] + (squares.length > 1 ? 's' : '');
        return `${name} on ${squares.join(', ')}`;
      })
      .join('; ');
  const toMove = chess.turn() === 'w' ? 'White' : 'Black';
  let status = `${toMove} to move.`;
  if (chess.isCheckmate()) status = `${toMove} is checkmated.`;
  else if (chess.inCheck()) status = `${toMove} to move, and ${toMove}'s king is in check.`;
  return `White: ${side('w')}. Black: ${side('b')}. ${status}`;
}

// Convert a UCI line to SAN, starting from fen. Stops at the first illegal move.
function uciLineToSan(fen, uciMoves, max = 6) {
  const chess = new Chess(fen);
  const out = [];
  for (const uci of uciMoves.slice(0, max)) {
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}

function describeMove(fen, uci) {
  const chess = new Chess(fen);
  const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  const who = m.color === 'w' ? 'White' : 'Black';
  let text = `${who} ${NAMES[m.piece]} from ${m.from} to ${m.to}`;
  if (m.captured) text += `, capturing the ${NAMES[m.captured]}`;
  if (chess.isCheckmate()) text += ', checkmate';
  else if (chess.inCheck()) text += ', with check';
  return { san: m.san, text };
}

// Score from the point of view of the side to move -> from White's view, in words.
function scoreWords(line, fen) {
  const whiteToMove = fen.split(' ')[1] === 'w';
  const sign = whiteToMove ? 1 : -1;
  if (line.mate !== null && line.mate !== undefined) {
    const m = line.mate * sign;
    if (m === 0) return 'checkmate on the board';
    return m > 0 ? `White mates in ${Math.abs(m)}` : `Black mates in ${Math.abs(m)}`;
  }
  const pawns = (line.cp * sign) / 100;
  const abs = Math.abs(pawns);
  const who = pawns > 0 ? 'White' : 'Black';
  if (abs < 0.4) return `roughly equal (${pawns.toFixed(1)})`;
  if (abs < 1.5) return `${who} is slightly better (${pawns > 0 ? '+' : ''}${pawns.toFixed(1)})`;
  if (abs < 4) return `${who} is clearly winning (${pawns > 0 ? '+' : ''}${pawns.toFixed(1)})`;
  return `${who} is completely winning (${pawns > 0 ? '+' : ''}${pawns.toFixed(1)})`;
}

function summarizeAnalysis(fen, result) {
  const chess = new Chess(fen);
  if (chess.isGameOver()) {
    return { text: `The game is over in this position. ${describePosition(fen)}`, best: null, lines: [] };
  }
  const lines = result.lines.map((l) => ({
    san: uciLineToSan(fen, l.pv),
    first: describeMove(fen, l.pv[0]),
    eval: scoreWords(l, fen),
    uci: l.pv[0],
  }));
  const best = lines[0];
  const others = lines.slice(1).map((l) => `${l.san[0]} (${l.eval})`).join(', ');
  const text =
    `Engine (Stockfish, depth ${result.lines[0]?.depth ?? '?'}): best move is ${best.san[0]}, i.e. ${best.first.text}. ` +
    `Evaluation after it: ${best.eval}. Expected line: ${best.san.join(' ')}. ` +
    (others ? `Other candidates: ${others}.` : '');
  return { text, best, lines };
}

module.exports = { describePosition, describeMove, summarizeAnalysis, uciLineToSan, scoreWords };
