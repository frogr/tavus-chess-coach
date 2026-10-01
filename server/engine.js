// Thin promise wrapper around stockfish.js (asm/wasm build) for Node.
// One engine instance, requests serialized through a queue.
const path = require('path');
const createEngine = require(path.join(__dirname, '..', 'node_modules', 'stockfish', 'src', 'stockfish.js'));

let sf = null;
let queue = Promise.resolve();

function engine() {
  if (!sf) {
    sf = createEngine();
    sf.postMessage('uci');
    sf.postMessage('isready');
  }
  return sf;
}

function runAnalysis(fen, depth, multipv, movetime, newGame) {
  return new Promise((resolve) => {
    const e = engine();
    const lines = {};
    e.onmessage = (raw) => {
      const line = typeof raw === 'string' ? raw : String(raw && raw.data);
      if (line.startsWith('info') && line.includes(' pv ') && line.includes(' multipv ')) {
        const mpv = Number(line.match(/ multipv (\d+)/)[1]);
        const d = Number(line.match(/ depth (\d+)/)[1]);
        const mate = line.match(/ score mate (-?\d+)/);
        const cp = line.match(/ score cp (-?\d+)/);
        const pv = line.split(' pv ')[1].trim().split(/\s+/);
        lines[mpv] = { depth: d, mate: mate ? Number(mate[1]) : null, cp: cp ? Number(cp[1]) : null, pv };
      } else if (line.startsWith('bestmove')) {
        resolve({ bestmove: line.split(/\s+/)[1], lines: Object.keys(lines).sort().map((k) => lines[k]) });
      }
    };
    e.postMessage(`setoption name MultiPV value ${multipv}`);
    if (newGame) e.postMessage('ucinewgame');
    e.postMessage(`position fen ${fen}`);
    // Stop at whichever comes first: the target depth or the time budget. On a
    // fast laptop depth wins; on a small cloud instance the time cap keeps
    // responses snappy.
    e.postMessage(movetime ? `go depth ${depth} movetime ${movetime}` : `go depth ${depth}`);
  });
}

// Serialize: stockfish.js is single-threaded and shares one onmessage.
// multipv: how many candidate lines to return (1 is ~2x faster; game review uses 1).
// movetime: ms cap per position (ENGINE_MOVETIME env overrides the default).
// newGame: clear the hash first; game review keeps it, since consecutive
// positions share most of their search tree.
const DEFAULT_MOVETIME = Number(process.env.ENGINE_MOVETIME || 1500);
function analyze(fen, depth = 14, { multipv = 3, movetime = DEFAULT_MOVETIME, newGame = true } = {}) {
  const job = queue.then(() => runAnalysis(fen, depth, multipv, movetime, newGame));
  queue = job.catch(() => {});
  return job;
}

module.exports = { analyze };
