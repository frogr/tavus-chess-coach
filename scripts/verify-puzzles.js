// Spot-checks the puzzle pool against Stockfish: for a random sample, the
// solution's first move must be the engine's top choice and the line must be
// legal. (Every puzzle was checked this way when the pool was built; this
// guards against the pool and the engine settings drifting apart.)
const { Chess } = require('chess.js');
const { analyze } = require('../server/engine');
const { POOL } = require('../server/puzzles');

const SAMPLE = Number(process.argv[2] || 40);

(async () => {
  const sample = [...POOL].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
  let failed = 0;
  for (const p of sample) {
    const r = await analyze(p.fen, 14, { multipv: 1, movetime: 1200 });
    const c = new Chess(p.fen);
    let legal = true;
    for (const uci of p.line) {
      try { c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch { legal = false; }
    }
    const ok = legal && r.bestmove === p.line[0];
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.id}  ${p.theme.padEnd(22)} level ${p.level}  engine=${r.bestmove} expected=${p.line[0]}`);
  }
  console.log(`${sample.length - failed} of ${sample.length} agree`);
  // A slower machine can disagree on the odd close call; more than a couple means something drifted.
  process.exit(failed > Math.ceil(sample.length * 0.05) ? 1 : 0);
})();
