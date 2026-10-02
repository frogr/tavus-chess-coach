// The boards on this page are the app's own board component, showing fixed positions.
import { Board } from '/board.js';

function show(id, fen, { orientation = 'w', lastMove = null, highlights = [], arrows = [], badge = null } = {}) {
  const board = new Board(document.getElementById(id), { canMove: () => false });
  board.setOrientation(orientation);
  board.setPosition(fen, { lastMove, animate: false });
  board.setHighlights(highlights);
  board.setArrows(arrows, false);
  if (badge) board.setBadge(badge.square, badge.cls);
  board.refresh();
}

// A puzzle from the pool, at the second hint: the key piece highlighted.
show('puzzleBoard', 'r4rk1/b1pb1pp1/p2p3p/1p6/1n1PN2q/3QB3/PPB2PPP/2R2RK1 w - - 2 17', { highlights: ['e4'] });

// A key moment in review: the position before the mistake, with the move that was played drawn on it.
show('reviewBoard', 'rn2kb1r/p3qppp/2p2n2/1N2p1B1/2B1P3/1Q6/PPP2PPP/R3K2R b KQkq - 0 10', {
  orientation: 'b',
  lastMove: { from: 'c3', to: 'b5' },
  arrows: [{ from: 'c6', to: 'b5' }],
});
