// Re-checks every puzzle against Stockfish: the first move must be the engine's
// top choice, and the line must be legal and end in mate or a decisive edge.
const { Chess } = require('chess.js');
const { analyze } = require('../server/engine');
const PUZZLES = require('../server/puzzles');

(async () => {
  let failed = 0;
  for (const p of PUZZLES) {
    const r = await analyze(p.fen, 16);
    const top = r.lines[0];
    const c = new Chess(p.fen);
    let legal = true;
    for (const uci of p.line) {
      try { c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch { legal = false; }
    }
    const decisive = top.mate !== null ? top.mate > 0 : top.cp >= 300;
    const ok = legal && r.bestmove === p.line[0] && decisive;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.id.padEnd(12)} engine=${r.bestmove} expected=${p.line[0]} ${top.mate !== null ? 'mate ' + top.mate : 'cp ' + top.cp}`);
  }
  process.exit(failed ? 1 : 0);
})();
