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
    sf.postMessage('setoption name MultiPV value 3');
    sf.postMessage('isready');
  }
  return sf;
}

function runAnalysis(fen, depth) {
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
    e.postMessage('ucinewgame');
    e.postMessage(`position fen ${fen}`);
    e.postMessage(`go depth ${depth}`);
  });
}

// Serialize: stockfish.js is single-threaded and shares one onmessage.
function analyze(fen, depth = 14) {
  const job = queue.then(() => runAnalysis(fen, depth));
  queue = job.catch(() => {});
  return job;
}

module.exports = { analyze };
