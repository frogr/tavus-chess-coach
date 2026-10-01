// Student memory, built on Tavus Memory Stores.
//
// Two layers:
//  - Learned memory: Tavus maintains it automatically from each conversation
//    (we just pass a stable participant tag).
//  - Pinned "session notes": at the end of every session the app writes one
//    factual note from what actually happened on the board (solved first try,
//    needed hints, wrong tries, review mistakes). Pinned facts are available
//    to the PAL from the very next conversation, with no processing delay, and
//    they're ground truth rather than the model's impression of the call.
const { tavus } = require('./tavus');

const MAX_PINNED = 30; // Tavus limit per store
const NOTE_PREFIX = 'Session note';

function participantTag(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `chess-student-${slug}` : null;
}

async function findStore(palId, tag) {
  const res = await tavus('GET', `/memory-stores?pal_id=${encodeURIComponent(palId)}&participant_tag=${encodeURIComponent(tag)}`);
  const hit = (res.data || [])[0];
  return hit ? hit.memory_store_id : null;
}

async function ensureStore(palId, tag) {
  const existing = await findStore(palId, tag);
  if (existing) return existing;
  try {
    const created = await tavus('POST', '/memory-stores', { pal_id: palId, participant_tag: tag });
    return created.memory_store_id;
  } catch (e) {
    if (e.status === 409) return findStore(palId, tag);
    throw e;
  }
}

async function getMemory(palId, name) {
  const tag = participantTag(name);
  if (!tag) return { pinned: [], learned: null };
  const id = await findStore(palId, tag);
  if (!id) return { pinned: [], learned: null };
  const store = await tavus('GET', `/memory-stores/${id}`);
  const pinned = (store.pinned_memories || []).map((m) => ({ id: m.memory_id, text: m.memory, at: m.created_at }));
  pinned.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { pinned, learned: store.learned || null, memory_store_id: id };
}

// Turn the board's session log into one factual sentence-or-three (<= 500 chars).
function sessionNote(summary, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const parts = [];
  const puzzles = summary.puzzles || [];
  const clean = puzzles.filter((p) => p.solved && !p.wrong.length && !p.hints && !p.gaveUp);
  const struggled = puzzles.filter((p) => p.wrong.length || p.hints || p.gaveUp);
  if (clean.length) parts.push(`solved first try: ${clean.map((p) => p.theme).join(', ')}`);
  for (const p of struggled.slice(0, 3)) {
    const bits = [];
    if (p.wrong.length) bits.push(`tried ${p.wrong.slice(0, 3).join(', ')} first`);
    if (p.hints) bits.push(`${p.hints} hint${p.hints > 1 ? 's' : ''}`);
    bits.push(p.gaveUp ? 'gave up and saw the answer' : p.solved ? 'then solved it' : 'did not finish');
    parts.push(`${p.theme}: ${bits.join(', ')}`);
  }
  const r = summary.review;
  if (r && r.game) {
    const found = (r.tries || []).filter((t) => t.ok).length;
    parts.push(
      `reviewed their game ${r.game}; key mistakes were ${(r.mistakes || []).slice(0, 3).join('; ') || 'none found'}` +
        (r.tries && r.tries.length ? `; found the better move at ${found} of ${r.tries.length} moments tried` : '')
    );
  }
  if (!parts.length) return null;
  let note = `${NOTE_PREFIX} ${day}: ${parts.join('. ')}.`;
  if (note.length > 500) note = note.slice(0, 497) + '...';
  return note;
}

async function recordSession(palId, name, summary) {
  const tag = participantTag(name);
  if (!tag) return { saved: false, reason: 'no name' };
  const note = sessionNote(summary);
  if (!note) return { saved: false, reason: 'nothing happened on the board' };
  const id = await ensureStore(palId, tag);
  // Stay under the pinned limit: drop the oldest session notes first.
  const existing = await tavus('GET', `/memory-stores/${id}/pinned`).catch(() => ({ pinned_memories: [] }));
  const notes = (existing.pinned_memories || [])
    .filter((m) => m.memory.startsWith(NOTE_PREFIX))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const total = (existing.pinned_memories || []).length;
  for (let i = 0; i < total - (MAX_PINNED - 1) && i < notes.length; i++) {
    await tavus('DELETE', `/memory-stores/${id}/pinned/${notes[i].memory_id}`).catch(() => {});
  }
  await tavus('POST', `/memory-stores/${id}/pinned`, { memory: note });
  return { saved: true, note };
}

module.exports = { participantTag, getMemory, recordSession, sessionNote };
