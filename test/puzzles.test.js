process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const PUZZLES = require('../server/puzzles');

test('every puzzle line is legal and ends decisively for the student', () => {
  for (const p of PUZZLES) {
    const c = new Chess(p.fen);
    const student = c.turn();
    for (const uci of p.line) c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    assert.equal(p.line.length % 2, 1, `${p.id}: the line must end on the student's move`);
    assert.notEqual(c.turn(), student, p.id);
    assert.ok([1, 2, 3].includes(p.level), p.id);
  }
  assert.equal(new Set(PUZZLES.map((p) => p.id)).size, PUZZLES.length);
});

test('pickPuzzle: next wraps, retry stays', async () => {
  const { pickPuzzle } = await import('../public/puzzle-logic.mjs');
  assert.deepEqual(pickPuzzle(PUZZLES, 0, 'next'), { index: 1 });
  assert.deepEqual(pickPuzzle(PUZZLES, PUZZLES.length - 1, 'next'), { index: 0 });
  assert.deepEqual(pickPuzzle(PUZZLES, 3, 'retry'), { index: 3 });
});

test('pickPuzzle: a theme request finds the right pattern, not the first partial match', async () => {
  const { pickPuzzle } = await import('../public/puzzle-logic.mjs');
  const themeOf = (theme) => PUZZLES[pickPuzzle(PUZZLES, 0, 'theme', theme).index].id;
  assert.equal(themeOf('smothered mate'), 'smothered');
  assert.equal(themeOf('back-rank mate'), 'back-rank');
  assert.equal(themeOf('Knight Fork'), 'knight-fork');
  assert.equal(themeOf('forks'), 'knight-fork');
  assert.equal(themeOf('the skewer'), 'skewer');
  assert.equal(themeOf('deflection'), 'deflection');
  assert.equal(themeOf('discovered checks'), 'discovered');
  assert.match(pickPuzzle(PUZZLES, 0, 'theme', 'zugzwang').error, /No puzzle with the theme "zugzwang"\. Available: back-rank mate/);
  assert.ok(pickPuzzle(PUZZLES, 0, 'theme', '').error);
});

test('pickPuzzle: harder and easier move one level and never wrap around', async () => {
  const { pickPuzzle } = await import('../public/puzzle-logic.mjs');
  const level = (r) => PUZZLES[r.index].level;
  const first = (l) => PUZZLES.findIndex((p) => p.level === l);
  assert.equal(level(pickPuzzle(PUZZLES, first(1), 'harder')), 2);
  assert.equal(level(pickPuzzle(PUZZLES, first(2), 'harder')), 3);
  assert.equal(level(pickPuzzle(PUZZLES, first(3), 'easier')), 2);
  const easiest = pickPuzzle(PUZZLES, first(1), 'easier');
  assert.equal(level(easiest), 1);
  assert.notEqual(easiest.index, first(1));
  assert.match(easiest.note, /no easier puzzle/);
  const hardest = pickPuzzle(PUZZLES, first(3), 'harder');
  assert.equal(level(hardest), 3);
  assert.match(hardest.note, /no harder puzzle/);
});
