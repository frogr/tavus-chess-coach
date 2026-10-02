// Playing a game against the coach. The coach's moves come from Stockfish,
// weakened to roughly the chosen rating the way Lichess's and chess.com's
// computer levels are: a shallower search, and a choice among the engine's
// top candidates that prefers good moves less strictly the lower the level.
const { Chess } = require('chess.js');
const { analyze } = require('./engine');
const { describeMove, describePosition } = require('./chessText');
const { judgeMove, classify } = require('./review');
const { httpError } = require('./errors');

// depth / movetime: how hard the engine looks. candidates: how many of its top
// moves are considered. spread: how many centipawns worse a move can be and
// still be picked fairly often (0 = always the best move). slip: chance of a
// move played without looking, which is where a beginner's blunders come from.
const LEVELS = [
  { rating: 500, depth: 3, movetime: 300, candidates: 8, spread: 220, slip: 0.12 },
  { rating: 1000, depth: 5, movetime: 400, candidates: 6, spread: 110, slip: 0.03 },
  { rating: 1500, depth: 7, movetime: 500, candidates: 5, spread: 55, slip: 0 },
  { rating: 2000, depth: 10, movetime: 700, candidates: 4, spread: 22, slip: 0 },
  { rating: 2500, depth: 13, movetime: 1000, candidates: 2, spread: 7, slip: 0 },
  { rating: 3000, depth: 18, movetime: 1500, candidates: 1, spread: 0, slip: 0 },
];
const RATINGS = LEVELS.map((l) => l.rating);

function levelFor(rating) {
  const level = LEVELS.find((l) => l.rating === Number(rating));
  if (!level) throw httpError(400, `Strength must be one of ${RATINGS.join(', ')}.`);
  return level;
}

// A line's score for the side to move, in centipawns. Mates sit beyond any material score.
function lineScore(line) {
  if (line.mate !== null && line.mate !== undefined) return line.mate > 0 ? 10000 - line.mate * 10 : -10000 - line.mate * 10;
  return line.cp ?? 0;
}

// Pick from the engine's candidates (best first). Each is weighted by how much
// worse than the best it is: exp(-loss / spread).
function chooseLine(lines, level, random = Math.random) {
  if (!level.spread || lines.length < 2) return lines[0];
  const best = lineScore(lines[0]);
  const weights = lines.map((l) => Math.exp(-(best - lineScore(l)) / level.spread));
  let roll = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lines.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return lines[i];
  }
  return lines[0];
}

// The coach's move in `fen` at this level, as UCI.
async function coachMove(fen, level, random = Math.random) {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  if (!legal.length) return null;
  if (level.slip && random() < level.slip) return legal[Math.floor(random() * legal.length)].lan;
  const result = await analyze(fen, level.depth, { multipv: Math.min(level.candidates, legal.length), movetime: level.movetime });
  const line = chooseLine(result.lines, level, random);
  return line ? line.pv[0] : result.bestmove;
}

// One turn of the game: judge the student's move (if they made one), then
// answer it. `fen` is the position before the student's move.
async function playTurn(fen, move, rating, random = Math.random) {
  const level = levelFor(rating);
  let judge = null;
  let after = fen;
  if (move) {
    judge = await judgeMove(fen, move);
    judge.class = judge.ok ? null : classify(judge.lossPct);
    const c = new Chess(fen);
    c.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] || 'q' });
    after = c.fen();
  }
  const uci = await coachMove(after, level, random);
  if (!uci) return { judge, reply: null, position: describePosition(after) };
  const { san, text } = describeMove(after, uci);
  const c = new Chess(after);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  return { judge, reply: { uci, san, words: text }, position: describePosition(c.fen()) };
}

module.exports = { LEVELS, RATINGS, levelFor, chooseLine, coachMove, playTurn };
