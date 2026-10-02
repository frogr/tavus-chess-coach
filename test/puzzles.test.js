process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { nextPuzzle, matchTheme, themeNames, POOL } = require('../server/puzzles');
const THEMES = require('../server/themes');

test('the pool is large, and every puzzle is legal and ends on the student\'s move', () => {
  assert.ok(POOL.length > 2000, `only ${POOL.length} puzzles`);
  assert.equal(new Set(POOL.map((p) => p.id)).size, POOL.length, 'ids are unique');
  const names = new Set(THEMES.map((t) => t.name));
  for (const p of POOL) {
    assert.ok(names.has(p.theme), `${p.id}: unknown theme ${p.theme}`);
    assert.ok([1, 2, 3].includes(p.level), p.id);
    assert.equal(p.line.length % 2, 1, `${p.id}: the line must end on the student's move`);
    const c = new Chess(p.fen);
    for (const uci of p.line) c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  }
});

test('every theme has puzzles at every level it claims, with a real choice in each', () => {
  for (const name of themeNames) {
    const count = POOL.filter((p) => p.theme === name).length;
    assert.ok(count >= 20, `${name} has only ${count} puzzles`);
  }
  assert.ok(themeNames.length >= 15);
});

test('next: different puzzles each time, at the asked level, never repeating the last theme', () => {
  const ids = new Set();
  let lastTheme;
  for (let i = 0; i < 60; i++) {
    const { puzzle } = nextPuzzle({ which: 'next', level: 2, lastTheme, seen: [...ids] });
    assert.equal(puzzle.level, 2);
    assert.notEqual(puzzle.theme, lastTheme);
    assert.ok(!ids.has(puzzle.id), 'a seen puzzle was served again');
    assert.ok(puzzle.idea && puzzle.fen && puzzle.line.length);
    ids.add(puzzle.id);
    lastTheme = puzzle.theme;
  }
  assert.equal(ids.size, 60);
});

test('two students starting fresh do not get the same sequence', () => {
  const run = () => Array.from({ length: 8 }, () => nextPuzzle({ which: 'next', level: 1 }).puzzle.id).join(',');
  assert.notEqual(run(), run());
});

test('easier and harder move one level and say so at the ends', () => {
  assert.equal(nextPuzzle({ which: 'harder', level: 1 }).puzzle.level, 2);
  assert.equal(nextPuzzle({ which: 'easier', level: 3 }).puzzle.level, 2);
  const top = nextPuzzle({ which: 'harder', level: 3 });
  assert.equal(top.puzzle.level, 3);
  assert.match(top.note, /already the hardest level/);
  const bottom = nextPuzzle({ which: 'easier', level: 1 });
  assert.equal(bottom.puzzle.level, 1);
  assert.match(bottom.note, /already the easiest level/);
  assert.equal(nextPuzzle({ which: 'next', level: 'junk' }).puzzle.level, 1);
  assert.equal(nextPuzzle({ which: 'next', level: 99 }).puzzle.level, 3);
});

test('a theme request finds the pattern the coach meant', () => {
  assert.equal(matchTheme('smothered mate'), 'smothered mate');
  assert.equal(matchTheme('back rank'), 'back-rank mate');
  assert.equal(matchTheme('Back-Rank Mate'), 'back-rank mate');
  assert.equal(matchTheme('forks'), 'fork');
  assert.equal(matchTheme('knight fork'), 'fork');
  assert.equal(matchTheme('the skewer'), 'skewer');
  assert.equal(matchTheme('pins'), 'pin');
  assert.equal(matchTheme('discovered checks'), 'discovered check');
  assert.equal(matchTheme('removing the defender'), 'removing the defender');
  assert.equal(matchTheme('zugzwang'), null);
  for (let i = 0; i < 10; i++) assert.equal(nextPuzzle({ which: 'theme', theme: 'skewers', level: 2 }).puzzle.theme, 'skewer');
  assert.match(nextPuzzle({ which: 'theme', theme: 'zugzwang' }).error, /No puzzles with the theme "zugzwang"\. Available themes: /);
});

test('when every puzzle in a bucket has been seen, it starts over instead of running dry', () => {
  const all = POOL.filter((p) => p.theme === 'skewer').map((p) => p.id);
  assert.equal(nextPuzzle({ which: 'theme', theme: 'skewer', level: 1, seen: all }).puzzle.theme, 'skewer');
});
