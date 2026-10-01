process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describePosition, describeMove, uciLineToSan, scoreWords, summarizeAnalysis } = require('../server/chessText');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('describePosition lists every piece by side and says who moves', () => {
  const text = describePosition('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  assert.equal(text, 'White: king on g1; rook on d1; pawns on f2, g2, h2. Black: king on g8; pawns on f7, g7, h7. White to move.');
});

test('describePosition reports check and checkmate', () => {
  assert.match(describePosition('3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1'), /Black is checkmated\.$/);
  assert.match(describePosition('4k3/8/8/8/8/8/8/4R1K1 b - - 0 1'), /Black's king is in check\.$/);
});

test('describeMove puts captures, check and mate into words', () => {
  assert.deepEqual(describeMove('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8'), {
    san: 'Rd8#',
    text: 'White rook from d1 to d8, checkmate',
  });
  assert.equal(describeMove('4k3/8/8/1q6/8/8/4B3/4R1K1 w - - 0 1', 'e2b5').text, 'White bishop from e2 to b5, capturing the queen, with check');
});

test('uciLineToSan converts a line and stops at the first illegal move', () => {
  assert.deepEqual(uciLineToSan(START, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
  assert.deepEqual(uciLineToSan(START, ['e2e4', 'e2e4', 'g1f3']), ['e4']);
  assert.equal(uciLineToSan(START, ['e2e4', 'e7e5', 'g1f3'], 2).length, 2);
});

test('scoreWords always speaks from White\'s point of view', () => {
  const blackToMove = START.replace(' w ', ' b ');
  assert.equal(scoreWords({ cp: 20, mate: null }, START), 'roughly equal (0.2)');
  assert.equal(scoreWords({ cp: 250, mate: null }, START), 'White is clearly winning (+2.5)');
  assert.equal(scoreWords({ cp: 250, mate: null }, blackToMove), 'Black is clearly winning (-2.5)');
  assert.equal(scoreWords({ cp: null, mate: 3 }, blackToMove), 'Black mates in 3');
  assert.equal(scoreWords({ cp: null, mate: -2 }, blackToMove), 'White mates in 2');
});

test('summarizeAnalysis handles a finished game without engine lines', () => {
  const s = summarizeAnalysis('3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1', { lines: [] });
  assert.equal(s.best, null);
  assert.match(s.text, /game is over/);
});
