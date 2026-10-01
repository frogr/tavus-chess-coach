// Pure helpers for choosing a puzzle. Kept free of DOM and network code so the
// same file runs in the browser and under `npm test`.

// Which puzzle a chess_load_puzzle call should put on the board.
// Returns { index } to load, optionally with a `note` for the coach, or
// { error } when the request can't be met.
export function pickPuzzle(puzzles, current, which, theme) {
  const n = puzzles.length;
  if (which === 'retry') return { index: current };

  if (which === 'theme') {
    const want = String(theme || '').toLowerCase().trim();
    // Words of the request, with a plural "s" dropped so "forks" finds "knight fork".
    const words = want.split(/[^a-z]+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length >= 3);
    // Score by how many of the requested words a theme contains, so
    // "smothered mate" picks the smothered mate and not the first "... mate".
    let best = -1;
    let bestScore = 0;
    puzzles.forEach((p, i) => {
      const t = p.theme.toLowerCase();
      const score = want && t.includes(want) ? 100 : words.filter((w) => t.includes(w)).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (best >= 0) return { index: best };
    return { error: `No puzzle with the theme "${String(theme || '').slice(0, 40)}". Available: ${puzzles.map((p) => p.theme).join(', ')}.` };
  }

  if (which === 'harder' || which === 'easier') {
    const dir = which === 'harder' ? 1 : -1;
    const level = puzzles[current].level;
    // Nearest level in the requested direction; never wrap from hardest to easiest.
    const levels = [...new Set(puzzles.map((p) => p.level))].filter((l) => (l - level) * dir > 0).sort((a, b) => (a - b) * dir);
    if (!levels.length) {
      const other = puzzles.findIndex((p, i) => i !== current && p.level === level);
      return {
        index: other >= 0 ? other : current,
        note: `There is no ${which} puzzle than this level, so this is ${other >= 0 ? 'another puzzle at the same level' : 'the same puzzle again'}.`,
      };
    }
    return { index: puzzles.findIndex((p) => p.level === levels[0]) };
  }

  return { index: (current + 1) % n }; // "next"
}
