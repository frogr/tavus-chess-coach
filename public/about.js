// The boards on this page are the app's own board component, showing fixed positions.
import { Board } from '/board.js';

const never = () => false;

// A puzzle from the pool, with the hint the coach gives second: the key piece highlighted.
const puzzle = new Board(document.getElementById('puzzleBoard'), { canMove: never });
puzzle.setPosition('r4rk1/b1pb1pp1/p2p3p/1p6/1n1PN2q/3QB3/PPB2PPP/2R2RK1 w - - 2 17', { animate: false });
puzzle.setHighlights(['e4']);
puzzle.refresh();

// The sample game after 10... cxb5, as the review shows it: the mistake marked, the engine's move as an arrow.
const review = new Board(document.getElementById('reviewBoard'), { canMove: never });
review.setOrientation('b');
review.setPosition('rn2kb1r/p3qppp/5n2/1p2p1B1/2B1P3/1Q6/PPP2PPP/R3K2R w KQkq - 0 11', { lastMove: { from: 'c6', to: 'b5' }, animate: false });
review.setArrows([{ from: 'e7', to: 'b4' }], false);
review.setBadge('b5', 'mistake');
review.refresh();
