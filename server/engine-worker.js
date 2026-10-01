// Runs Stockfish in its own process (forked by engine.js). UCI commands come
// in as IPC messages and every line the engine prints goes back the same way.
// Keeping the engine out of the web server's process means a search can never
// stall HTTP requests, and a stuck engine can simply be killed and replaced.
const path = require('path');
const createEngine = require(path.join(__dirname, '..', 'node_modules', 'stockfish', 'src', 'stockfish.js'));

const sf = createEngine();
sf.onmessage = (raw) => {
  const line = typeof raw === 'string' ? raw : String(raw && raw.data);
  if (process.connected) process.send(line);
};
process.on('message', (command) => sf.postMessage(String(command)));
process.on('disconnect', () => process.exit(0)); // the server went away
sf.postMessage('uci');
