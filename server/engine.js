// Promise wrapper around Stockfish (stockfish.js, asm/wasm build). The engine
// runs in a child process (engine-worker.js); requests are serialized through
// a queue because one engine searches one position at a time.
const path = require('path');
const { fork } = require('child_process');
const { Chess } = require('chess.js');
const { httpError } = require('./errors');

let child = null;
let onLine = null; // receives engine output for the search in progress
let onExit = null; // rejects the search in progress if the engine dies
let queue = Promise.resolve();
let waiting = 0;

// Anyone can call the analysis endpoints, so the queue is bounded: past this
// many waiting positions the server says "busy" instead of falling behind.
const MAX_WAITING = Number(process.env.ENGINE_MAX_WAITING || 60);
// How long past its time budget a search may run before the engine is
// considered stuck, killed, and replaced. Generous, because the first search
// also pays for starting the engine on a slow instance.
const WATCHDOG_GRACE = Number(process.env.ENGINE_WATCHDOG_GRACE || 20000);

function engine() {
  if (child) return child;
  const proc = fork(path.join(__dirname, 'engine-worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  proc.on('message', (line) => {
    if (proc === child && onLine) onLine(String(line));
  });
  proc.on('exit', () => {
    if (proc !== child) return;
    child = null;
    if (onExit) onExit();
  });
  proc.on('error', (e) => console.error(`engine process error: ${e.message}`));
  // An idle engine must not keep the server (or a test run) from exiting.
  proc.unref();
  proc.channel.unref();
  child = proc;
  return proc;
}

function killEngine() {
  const proc = child;
  child = null;
  if (proc) proc.kill('SIGKILL');
  if (onExit) onExit(); // fail the search that was running on it
}

function runAnalysis(fen, depth, multipv, movetime, newGame) {
  return new Promise((resolve, reject) => {
    const e = engine();
    e.channel.ref();
    const lines = {};
    const finish = (settle, value) => {
      clearTimeout(watchdog);
      onLine = null;
      onExit = null;
      if (e.channel) e.channel.unref();
      settle(value);
    };
    const watchdog = setTimeout(() => {
      onExit = null;
      killEngine(); // the next request starts a fresh one
      finish(reject, httpError(503, 'The chess engine timed out on that position. Try again.'));
    }, (movetime || 30000) + WATCHDOG_GRACE);
    onExit = () => finish(reject, httpError(503, 'The chess engine stopped unexpectedly. Try again.'));
    onLine = (line) => {
      if (line.startsWith('info') && line.includes(' pv ') && line.includes(' multipv ')) {
        const mpv = Number(line.match(/ multipv (\d+)/)[1]);
        const d = Number(line.match(/ depth (\d+)/)[1]);
        const mate = line.match(/ score mate (-?\d+)/);
        const cp = line.match(/ score cp (-?\d+)/);
        const pv = line.split(' pv ')[1].trim().split(/\s+/);
        lines[mpv] = { depth: d, mate: mate ? Number(mate[1]) : null, cp: cp ? Number(cp[1]) : null, pv };
      } else if (line.startsWith('bestmove')) {
        const sorted = Object.keys(lines).sort((a, b) => a - b).map((k) => lines[k]);
        finish(resolve, { bestmove: line.split(/\s+/)[1], lines: sorted });
      }
    };
    e.send(`setoption name MultiPV value ${multipv}`);
    if (newGame) e.send('ucinewgame');
    e.send(`position fen ${fen}`);
    // Stop at whichever comes first: the target depth or the time budget. On a
    // fast laptop depth wins; on a small cloud instance the time cap keeps
    // responses snappy.
    e.send(movetime ? `go depth ${depth} movetime ${movetime}` : `go depth ${depth}`);
  });
}

// Serialize: one engine, one search at a time.
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

module.exports = { analyze, killEngine };
