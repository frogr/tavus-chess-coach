process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reviewGame, reviewContext, judgeMove, winPct, whiteCp, classify, MAX_PLIES } = require('../server/review');

const sample = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', `${name}.pgn`), 'utf8').trim();

test('winPct is the Lichess curve: 50 at equal, symmetric, clamped', () => {
  assert.equal(winPct(0), 50);
  assert.ok(Math.abs(winPct(100) - 59.1) < 0.1);
  assert.ok(Math.abs(winPct(300) + winPct(-300) - 100) < 1e-9);
  assert.equal(winPct(5000), winPct(1000));
});

test('whiteCp converts side-to-move scores and mates to White\'s view', () => {
  const w = '8/8/8/8/8/8/8/K6k w - - 0 1';
  const b = '8/8/8/8/8/8/8/K6k b - - 0 1';
  assert.equal(whiteCp({ cp: 120, mate: null }, w), 120);
  assert.equal(whiteCp({ cp: 120, mate: null }, b), -120);
  assert.equal(whiteCp({ cp: null, mate: 2 }, b), -9980);
  assert.equal(whiteCp({ cp: null, mate: -1 }, b), 9990);
});

test('classify thresholds', () => {
  assert.equal(classify(35), 'blunder');
  assert.equal(classify(20), 'mistake');
  assert.equal(classify(10), 'inaccuracy');
  assert.equal(classify(9.9), null);
});

test('reviewGame finds the losing capture in the Legal trap and caches the result', async () => {
  const review = await reviewGame(sample('legal-trap'), 'b');
  assert.equal(review.moves.length, 13);
  assert.equal(review.headers.White, 'Teacher');
  assert.equal(review.headers.Event, "Casual game (Legal's Mate trap)");
  const bxd1 = review.moves.find((m) => m.san === 'Bxd1');
  assert.equal(bxd1.class, 'blunder');
  assert.equal(bxd1.symbol, '??');
  assert.ok(review.keyMoments.some((k) => k.ply === bxd1.ply), 'the queen grab is a key moment');
  assert.ok(review.keyMoments.every((k) => review.moves[k.ply - 1].color === 'b'), 'only the student\'s moves');
  assert.equal(review.moves.at(-1).evalAfter, 10000, 'checkmate for White');

  const context = reviewContext(review, 'Sam');
  assert.match(context, /^\[board\] Game review loaded: Teacher \(White\) vs Student \(Black\)/);
  assert.match(context, /Sam played Black/);
  assert.ok(Buffer.byteLength(context) <= 3600);

  assert.equal(await reviewGame(sample('legal-trap'), 'b'), review, 'second call is served from the cache');
});

test('reviewGame rejects junk, empty and oversized games with a 400', async () => {
  await assert.rejects(reviewGame('this is not a game', 'w'), { status: 400 });
  await assert.rejects(reviewGame('', 'w'), { status: 400 });
  await assert.rejects(reviewGame('[Event "x"]\n\n*', 'w'), { status: 400, message: 'That game has no moves.' });
  const shuffle = Array.from({ length: MAX_PLIES / 4 + 1 }, (_, i) => `${2 * i + 1}. Nf3 Nf6 ${2 * i + 2}. Ng1 Ng8`).join(' ');
  await assert.rejects(reviewGame(shuffle, 'w'), { status: 400, message: /too long/ });
});

test('PGN header text is flattened and capped before it reaches the coach', async () => {
  const pgn = `[White "${'W'.repeat(200)}"]\n[Black "B"]\n\n1. e4 e5 *`;
  const review = await reviewGame(pgn, null);
  assert.equal(review.headers.White.length, 60);
  const bare = await reviewGame('1. e4 e5 2. Nf3 *', null);
  assert.equal(bare.headers.White, 'White');
  assert.equal(bare.headers.Black, 'Black');
});

test('judgeMove accepts the winning move, rejects a weak one, and 400s on an illegal one', async () => {
  const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  const good = await judgeMove(fen, 'd1d8');
  assert.equal(good.ok, true);
  assert.equal(good.san, 'Rd8#');
  const weak = await judgeMove('4k3/1q6/8/8/4N3/8/5PPP/6K1 w - - 0 1', 'g1h1');
  assert.equal(weak.ok, false);
  assert.equal(weak.bestSan, 'Nd6+');
  await assert.rejects(judgeMove(fen, 'd1h5'), { status: 400 });
});
