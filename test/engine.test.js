process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, killEngine } = require('../server/engine');

const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

test('analyze returns the best move and ranked lines', async () => {
  const r = await analyze(BACK_RANK, 10, { multipv: 2, movetime: 1000 });
  assert.equal(r.bestmove, 'd1d8');
  assert.equal(r.lines[0].mate, 1);
  assert.equal(r.lines[0].pv[0], 'd1d8');
  assert.equal(r.lines.length, 2);
});

test('a finished position resolves with no lines instead of hanging', async () => {
  const r = await analyze('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 10, { movetime: 500 });
  assert.deepEqual(r, { bestmove: '(none)', lines: [] });
});

test('an invalid FEN is rejected before it reaches the engine', () => {
  assert.throws(() => analyze('not a fen'));
  assert.throws(() => analyze(`${BACK_RANK}\nquit`));
});

test('concurrent requests are answered in order, each with its own position', async () => {
  const [a, b] = await Promise.all([
    analyze(BACK_RANK, 8, { multipv: 1, movetime: 500 }),
    analyze('6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1', 8, { multipv: 1, movetime: 500 }),
  ]);
  assert.equal(a.bestmove, 'd1d8');
  assert.equal(b.bestmove, 'g5f7');
});

test('if the engine process dies mid-search the request fails cleanly and the next one works', async () => {
  const doomed = analyze('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 30, { movetime: 20000 });
  setTimeout(killEngine, 300);
  await assert.rejects(doomed, { status: 503 });
  const r = await analyze(BACK_RANK, 8, { multipv: 1, movetime: 500 });
  assert.equal(r.bestmove, 'd1d8');
});
