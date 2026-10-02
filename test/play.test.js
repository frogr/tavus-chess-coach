process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { LEVELS, RATINGS, levelFor, chooseLine, coachMove, playTurn } = require('../server/play');
const { sessionNote, sanitizeSummary } = require('../server/memory');
const { startServer } = require('./helpers');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_ONE = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'; // Rd8#

test('six strengths from 500 to 3000, each looking harder than the last', () => {
  assert.deepEqual(RATINGS, [500, 1000, 1500, 2000, 2500, 3000]);
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].depth > LEVELS[i - 1].depth);
    assert.ok(LEVELS[i].spread < LEVELS[i - 1].spread);
  }
  assert.throws(() => levelFor(1234), /Strength must be one of/);
});

test('chooseLine: full strength takes the best line, weaker levels sometimes take a worse one', () => {
  const lines = [{ cp: 80, mate: null, pv: ['e2e4'] }, { cp: 40, mate: null, pv: ['d2d4'] }, { cp: -300, mate: null, pv: ['g2g4'] }];
  assert.equal(chooseLine(lines, levelFor(3000), () => 0.99), lines[0]);
  const picks = { e2e4: 0, d2d4: 0, g2g4: 0 };
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) picks[chooseLine(lines, levelFor(500), random).pv[0]]++;
  assert.ok(picks.e2e4 > picks.d2d4 && picks.d2d4 > picks.g2g4, JSON.stringify(picks));
  assert.ok(picks.g2g4 > 0, 'a beginner does blunder now and then');
  const strong = { e2e4: 0, d2d4: 0, g2g4: 0 };
  for (let i = 0; i < 2000; i++) strong[chooseLine(lines, levelFor(2500), random).pv[0]]++;
  assert.equal(strong.g2g4, 0);
  assert.ok(strong.e2e4 > 1900);
});

test('a forced mate outweighs any material score', () => {
  const lines = [{ cp: null, mate: 1, pv: ['d1d8'] }, { cp: 500, mate: null, pv: ['g2g3'] }];
  for (let i = 0; i < 50; i++) assert.equal(chooseLine(lines, levelFor(1000)).pv[0], 'd1d8');
});

test('the coach always plays a legal move, at every strength', async () => {
  for (const rating of RATINGS) {
    const uci = await coachMove(START, levelFor(rating));
    const c = new Chess(START);
    assert.ok(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }), `${rating}: ${uci}`);
  }
  assert.equal(await coachMove(MATE_IN_ONE, levelFor(3000)), 'd1d8');
  assert.equal(await coachMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', levelFor(3000)), null, 'stalemate: no move');
});

test('a turn judges the student\'s move and answers it', async () => {
  // 1. f3 e5 2. g4 allows Qh4#. At full strength the coach plays it.
  const turn = await playTurn('rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2', 'g2g4', 3000);
  assert.equal(turn.judge.san, 'g4');
  assert.equal(turn.judge.class, 'blunder');
  assert.equal(turn.reply.san, 'Qh4#');
  assert.match(turn.reply.words, /checkmate/);
  assert.match(turn.position, /is checkmated/);

  const first = await playTurn(START, null, 1500);
  assert.equal(first.judge, null);
  assert.ok(first.reply.san);

  const mate = await playTurn(MATE_IN_ONE, 'd1d8', 500);
  assert.equal(mate.reply, null, 'nothing to answer after checkmate');
  assert.equal(mate.judge.class, null);
});

test('the play route validates its input', async (t) => {
  const app = await startServer();
  t.after(() => app.stop());
  const post = (body) => app.post('/api/play', body);
  assert.equal((await post({ fen: START, rating: 1200 })).status, 400);
  assert.equal((await post({ fen: 'nope', rating: 1500 })).status, 400);
  assert.equal((await post({ fen: START, rating: 1500, move: 'e2e9' })).status, 400);
  assert.equal((await post({ fen: START, rating: 1500, move: 'e2e5' })).status, 400, 'illegal move');
  const ok = await post({ fen: START, rating: 500, move: 'e2e4' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.judge.san, 'e4');
  assert.match(body.reply.uci, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
});

test('games against the coach go into the session note, and junk is dropped', () => {
  const clean = sanitizeSummary({
    games: [
      { rating: 1500, color: 'w', result: 'lost', moves: 31, mistakes: ['14. Qxb7?', '<script>', '20. Nd5??', 'x', 'y'] },
      { rating: 1234, color: 'w', result: 'won', moves: 10 },
      { rating: 500, color: 'b', result: 'crushed', moves: 10 },
    ],
  });
  assert.equal(clean.games.length, 1);
  assert.equal(clean.games[0].mistakes.length, 3);
  assert.doesNotMatch(JSON.stringify(clean), /</);
  const note = sessionNote(clean, new Date('2026-10-02T00:00:00Z'));
  assert.match(note, /played the coach at strength 1500 as White: lost in 31 moves; biggest mistakes 14\. Qxb7\?/);
  assert.equal(sessionNote(sanitizeSummary({ games: [{ rating: 500, color: 'w', result: 'unfinished', moves: 1 }] })), null, 'a game of one move is not worth a note');
});
