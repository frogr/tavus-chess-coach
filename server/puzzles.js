// Hand-picked teaching positions. Every solution line below was checked with
// Stockfish (depth 14-16) before it went in: the first move is the engine's
// top choice and the line is clearly winning (forced mate or decisive material).
// `line` alternates player move / opponent reply, in UCI.
module.exports = [
  {
    id: 'back-rank',
    title: 'The Back Rank',
    theme: 'back-rank mate',
    level: 1,
    fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    line: ['d1d8'],
    idea: "Black's king is boxed in by its own pawns on f7, g7 and h7, so a rook check on the 8th rank is mate.",
  },
  {
    id: 'discovered',
    title: 'Peekaboo',
    theme: 'discovered check',
    level: 1,
    fen: '4k3/8/8/1q6/8/8/4B3/4R1K1 w - - 0 1',
    line: ['e2b5'],
    idea: 'The bishop is blocking the rook on the e-file. Moving it uncovers check on the king, so the bishop can grab the queen on b5 with check. Any other bishop move lets the queen block on the e-file.',
  },
  {
    id: 'knight-fork',
    title: 'Royal Fork',
    theme: 'knight fork',
    level: 2,
    fen: '4k3/1q6/8/8/4N3/8/5PPP/6K1 w - - 0 1',
    line: ['e4d6', 'e8d7', 'd6b7'],
    idea: 'From d6 the knight checks the king on e8 and attacks the queen on b7 at the same time. The king has to move, and the queen falls.',
  },
  {
    id: 'skewer',
    title: 'Shish Kebab',
    theme: 'skewer',
    level: 2,
    fen: '4q3/8/8/8/4k3/8/P6K/R7 w - - 0 1',
    line: ['a1e1', 'e4d3', 'e1e8'],
    idea: 'The king and queen are lined up on the e-file. A rook check on e1 forces the king to step aside, exposing the queen behind it.',
  },
  {
    id: 'smothered',
    title: 'Smothered',
    theme: 'smothered mate',
    level: 3,
    fen: '6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1',
    line: ['g5f7'],
    idea: "Black's king on h8 is completely surrounded by its own rook and pawns. A single knight check from f7 is mate because nothing can block a knight and the king has no squares.",
  },
  {
    id: 'deflection',
    title: 'Look Away',
    theme: 'deflection, back-rank mate',
    level: 3,
    fen: 'r5k1/5ppp/8/8/8/8/1Q3PPP/1R4K1 w - - 0 1',
    line: ['b2b8', 'a8b8', 'b1b8'],
    idea: "The rook on a8 is the only thing guarding Black's back rank. Sacrifice the queen on b8 to drag the rook away, then the white rook mates on b8.",
  },
];
