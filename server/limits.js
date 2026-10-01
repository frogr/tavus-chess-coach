// Fixed-window counters kept in memory. Enough for a single small instance:
// they protect the engine's CPU and make guessing the access code impractical.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  function entry(key) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    return h;
  }

  return {
    // Count one use; false once the key is over its budget for this window.
    take: (key) => ++entry(key).count <= max,
    // Check without counting (used with hit() to count only failures).
    blocked: (key) => entry(key).count >= max,
    hit: (key) => void entry(key).count++,
  };
}

module.exports = { createLimiter };
