// Builds server/puzzle-pool.json from the Lichess puzzle database (CC0):
//   curl -sL https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -dc | head -n 600001 > puzzles.csv
//   node scripts/import-puzzles.js select puzzles.csv candidates.json
//   node scripts/import-puzzles.js verify candidates.json verified-0.json 0 6   (run one per shard, in parallel)
//   node scripts/import-puzzles.js build verified-*.json
//
// select: well-played, well-liked puzzles, filed under one teaching theme and
//         one of three levels by rating.
// verify: keeps a puzzle only if our own Stockfish, at the strength the app
//         uses, also picks the solution's first move. The coach checks claims
//         with that engine, so the two must agree.
// build:  writes an evenly spread pool.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Chess } = require('chess.js');
const THEMES = require('../server/themes');

const LEVELS = [
  { level: 1, min: 500, max: 1000, maxPlies: 3 },
  { level: 2, min: 1000, max: 1400, maxPlies: 5 },
  { level: 3, min: 1400, max: 1900, maxPlies: 7 },
];
const CANDIDATES_PER_BUCKET = 90;
const POOL_PER_BUCKET = 90;

const move = (c, uci) => c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });

async function select(csv, out) {
  const buckets = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(csv) });
  for await (const row of rl) {
    const [id, fen, moves, rating, deviation, popularity, plays, tags] = row.split(',');
    if (id === 'PuzzleId') continue;
    if (Number(deviation) > 90 || Number(popularity) < 88 || Number(plays) < 800) continue;
    const band = LEVELS.find((l) => Number(rating) >= l.min && Number(rating) < l.max);
    const theme = THEMES.find((t) => tags.split(' ').includes(t.tag));
    if (!band || !theme) continue;
    const key = `${theme.name}|${band.level}`;
    const bucket = buckets.get(key) || [];
    if (bucket.length >= CANDIDATES_PER_BUCKET) continue;
    // The database gives the position before the opponent's move; ours starts after it.
    const all = moves.split(' ');
    const line = all.slice(1);
    if (line.length % 2 !== 1 || line.length > band.maxPlies) continue;
    try {
      const c = new Chess(fen);
      move(c, all[0]);
      const start = c.fen();
      for (const uci of line) move(c, uci);
      bucket.push({ id, fen: start, line, rating: Number(rating), theme: theme.name, level: band.level });
      buckets.set(key, bucket);
    } catch {
      // an illegal line in the source: skip it
    }
  }
  const all = [...buckets.values()].flat();
  fs.writeFileSync(out, JSON.stringify(all));
  console.log(`${all.length} candidates in ${buckets.size} theme/level buckets`);
}

async function verify(input, out, shard, shards) {
  const { analyze } = require('../server/engine');
  const mine = JSON.parse(fs.readFileSync(input, 'utf8')).filter((_, i) => i % shards === shard);
  const kept = [];
  for (const p of mine) {
    const r = await analyze(p.fen, 14, { multipv: 1, movetime: 1200 });
    if (r.bestmove === p.line[0]) kept.push(p);
  }
  fs.writeFileSync(out, JSON.stringify(kept));
  console.log(`shard ${shard}: kept ${kept.length} of ${mine.length}`);
  process.exit(0);
}

function build(files) {
  const buckets = new Map();
  for (const f of files) {
    for (const p of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const key = `${p.theme}|${p.level}`;
      const bucket = buckets.get(key) || [];
      if (bucket.length < POOL_PER_BUCKET) bucket.push(p);
      buckets.set(key, bucket);
    }
  }
  const pool = [...buckets.values()].flat().sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(__dirname, '..', 'server', 'puzzle-pool.json'), JSON.stringify(pool));
  for (const [key, b] of [...buckets].sort()) console.log(key.padEnd(28), b.length);
  console.log(`${pool.length} puzzles written`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'select') select(args[0], args[1]);
else if (mode === 'verify') verify(args[0], args[1], Number(args[2]), Number(args[3]));
else if (mode === 'build') build(args);
else console.log('usage: import-puzzles.js select|verify|build (see the comment at the top of this file)');
