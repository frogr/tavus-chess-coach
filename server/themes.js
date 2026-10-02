// The tactical patterns Coach Rook teaches. `tag` is the Lichess puzzle theme
// it comes from; `idea` is what the coach is told about the pattern.
// Order matters when a puzzle carries several tags: the first match is the
// pattern it is filed under, so the specific ones come first.
module.exports = [
  { tag: 'smotheredMate', name: 'smothered mate', idea: 'The king is hemmed in by its own pieces, so a knight check is mate: nothing can block a knight and the king has no squares.' },
  { tag: 'backRankMate', name: 'back-rank mate', idea: 'The king is stuck on its back rank behind its own pawns, so a rook or queen landing on that rank gives mate.' },
  { tag: 'doubleCheck', name: 'double check', idea: 'Two pieces give check at once, so the king must move: a double check cannot be blocked or answered by a capture.' },
  { tag: 'discoveredCheck', name: 'discovered check', idea: 'Moving one piece uncovers a check from the piece behind it, so the piece that moved gets a free move with tempo.' },
  { tag: 'discoveredAttack', name: 'discovered attack', idea: 'Moving one piece uncovers an attack from the piece behind it, creating two threats at once.' },
  { tag: 'skewer', name: 'skewer', idea: 'Two pieces are lined up; attacking the more valuable one in front forces it to move and exposes the one behind it.' },
  { tag: 'pin', name: 'pin', idea: 'A piece cannot or should not move because it shields something more valuable behind it; a pinned piece is a poor defender and an easy target.' },
  { tag: 'fork', name: 'fork', idea: 'One piece attacks two targets at once, and the opponent can only save one of them.' },
  { tag: 'deflection', name: 'deflection', idea: 'A defender is forced or lured away from the square or piece it was guarding.' },
  { tag: 'attraction', name: 'attraction', idea: 'A piece, often the king, is lured onto a bad square, usually by a sacrifice, to set up the follow-up tactic.' },
  { tag: 'capturingDefender', name: 'removing the defender', idea: 'Capture the piece that defends the real target, and the target falls.' },
  { tag: 'trappedPiece', name: 'trapped piece', idea: 'A piece has no safe square to go to, so attacking it wins it.' },
  { tag: 'intermezzo', name: 'in-between move', idea: 'Instead of the expected recapture, a stronger move (often a check or a bigger threat) is played first.' },
  { tag: 'clearance', name: 'clearance', idea: 'A piece moves out of the way, often with a threat, to open a square or line for another piece.' },
  { tag: 'interference', name: 'interference', idea: 'A piece is placed between an enemy piece and what it defends, cutting the defense.' },
  { tag: 'xRayAttack', name: 'x-ray', idea: 'A piece attacks or defends through another piece on the same line.' },
  { tag: 'promotion', name: 'promotion', idea: 'A pawn gets to the last rank, or the threat of it decides the game.' },
  { tag: 'hangingPiece', name: 'hanging piece', idea: 'A piece is undefended or under-defended and can simply be taken.' },
  { tag: 'mateIn1', name: 'mate in one', idea: 'There is a checkmate available right now.' },
  { tag: 'mateIn2', name: 'mate in two', idea: 'A forcing move leads to checkmate on the next move, whatever the reply.' },
];
