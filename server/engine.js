// Thin promise wrapper around stockfish.js (asm/wasm build) for Node.
// One engine instance, requests serialized through a queue.
const path = require('path');
const { Chess } = require('chess.js');
const { httpError } = require('./errors');
const createEngine = require(path.join(__dirname, '..', 'node_modules', 'stockfish', 'src', 'stockfish.js'));

let sf = null;
let queue = Promise.resolve();
let waiting = 0;

// Anyone can call the analysis endpoints, so the queue is bounded: past this
// many waiting positions the server says "busy" instead of falling behind.
const MAX_WAITING = Number(process.env.ENGINE_MAX_WAITING || 60);
// How long past its time budget a search may run before the engine is
// considered stuck and replaced.
const WATCHDOG_GRACE = 15000;

function engine() {
  if (!sf) {
    sf = createEngine();
    sf.postMessage('uci');
    sf.postMessage('isready');
  }
  return sf;
}

function runAnalysis(fen, depth, multipv, movetime, newGame) {
  return new Promise((resolve, reject) => {
    const e = engine();
    const lines = {};
    const watchdog = setTimeout(() => {
      // Drop the stuck instance; the next request starts a fresh one.
      e.onmessage = null;
      if (sf === e) sf = null;
      reject(httpError(503, 'The chess engine timed out on that position. Try again.'));
    }, (movetime || 30000) + WATCHDOG_GRACE);
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
        clearTimeout(watchdog);
        const sorted = Object.keys(lines).sort((a, b) => a - b).map((k) => lines[k]);
        resolve({ bestmove: line.split(/\s+/)[1], lines: sorted });
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
// A finished position (mate, stalemate) resolves with bestmove "(none)" and no lines.
const DEFAULT_MOVETIME = Number(process.env.ENGINE_MOVETIME || 1500);
function analyze(fen, depth = 14, { multipv = 3, movetime = DEFAULT_MOVETIME, newGame = true } = {}) {
  // Re-serialize through chess.js so only a validated, single-line FEN is ever
  // written into the engine's command stream.
  const clean = new Chess(fen).fen();
  if (waiting >= MAX_WAITING) {
    return Promise.reject(httpError(503, 'The chess engine is busy right now. Try again in a moment.'));
  }
  waiting++;
  const job = queue.then(() => runAnalysis(clean, depth, multipv, movetime, newGame)).finally(() => waiting--);
  queue = job.catch(() => {});
  return job;
}

module.exports = { analyze };
