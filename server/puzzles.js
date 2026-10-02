// Puzzle selection. The pool (server/puzzle-pool.json) is built from the
// Lichess puzzle database by scripts/import-puzzles.js: a few thousand
// positions, each filed under one teaching theme and one of three levels, and
// each checked against our own engine. Every request picks a fresh one.
const THEMES = require('./themes');
const POOL = require('./puzzle-pool.json');

const LEVELS = [1, 2, 3];
const IDEAS = new Map(THEMES.map((t) => [t.name, t.idea]));
const byThemeLevel = new Map(); // "fork|2" -> [puzzle]
for (const p of POOL) {
  const key = `${p.theme}|${p.level}`;
  if (!byThemeLevel.has(key)) byThemeLevel.set(key, []);
  byThemeLevel.get(key).push(p);
}
const themeNames = THEMES.map((t) => t.name).filter((name) => LEVELS.some((l) => byThemeLevel.has(`${name}|${l}`)));

const clampLevel = (level) => Math.max(1, Math.min(3, Math.round(Number(level)) || 1));

// The theme a spoken request means: "forks" -> fork, "back rank" -> back-rank mate.
function matchTheme(text) {
  const want = String(text || '').toLowerCase().trim();
  if (!want) return null;
  const words = (t) => t.split(/[^a-z]+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length >= 3);
  const asked = words(want);
  let best = null;
  let bestScore = 0;
  for (const name of themeNames) {
    // Whole words only, so "the skewer" can't match the "the" inside "smothered".
    const own = words(name);
    const score = name === want ? 100 : asked.filter((w) => own.includes(w)).length;
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

function toPublic(p) {
  return { id: p.id, fen: p.fen, line: p.line, level: p.level, rating: p.rating, theme: p.theme, idea: IDEAS.get(p.theme) };
}

// which: "next" | "easier" | "harder" | "theme"
// level: the student's current level; seen: ids to avoid; lastTheme: avoid repeating it on "next"
// Returns { puzzle, note? } or { error }.
function nextPuzzle({ which = 'next', level, theme, lastTheme, seen } = {}, random = Math.random) {
  const current = clampLevel(level);
  let target = current;
  let note = '';
  if (which === 'easier' || which === 'harder') {
    target = clampLevel(current + (which === 'harder' ? 1 : -1));
    if (target === current) note = `This is already the ${which === 'harder' ? 'hardest' : 'easiest'} level, so here is another puzzle at the same level.`;
  }

  let name;
  if (which === 'theme') {
    name = matchTheme(theme);
    if (!name) return { error: `No puzzles with the theme "${String(theme || '').slice(0, 40)}". Available themes: ${themeNames.join(', ')}.` };
  } else {
    const options = themeNames.filter((n) => n !== lastTheme && byThemeLevel.has(`${n}|${target}`));
    name = options[Math.floor(random() * options.length)];
  }

  // The asked-for level if this theme has it, otherwise the nearest one.
  const levels = [...LEVELS].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  const bucket = byThemeLevel.get(`${name}|${levels.find((l) => byThemeLevel.has(`${name}|${l}`))}`);
  const avoid = new Set(Array.isArray(seen) ? seen.slice(0, 1000).map(String) : []);
  const fresh = bucket.filter((p) => !avoid.has(p.id));
  const from = fresh.length ? fresh : bucket; // everything seen: start over rather than run dry
  const puzzle = toPublic(from[Math.floor(random() * from.length)]);
  return note ? { puzzle, note } : { puzzle };
}

module.exports = { nextPuzzle, matchTheme, themeNames, POOL, clampLevel };
