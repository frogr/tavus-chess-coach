// Student memory. docs/MEMORY.md is the full description; in short:
//
//  - The ledger (ledger.js) keeps every session a student has had, forever.
//    It is the source of truth.
//  - Tavus pinned memories are what the coach reads. They are rebuilt from the
//    ledger: one "Student profile" note with lifetime totals, plus the most
//    recent "Session note"s. A sync compares what should be pinned with what
//    is, repairs the difference and reads it back.
//  - Tavus learned memory is maintained by Tavus from the conversation itself
//    (we just pass a stable participant tag). The app does not control it.
const crypto = require('crypto');
const { tavus } = require('./tavus');
const audit = require('./audit');
const { httpError } = require('./errors');
const { themeNames } = require('./puzzles');
const { RATINGS } = require('./play');

const ledger = require('./ledger');

const MAX_PINNED = 30; // Tavus limit per store (the 31st is refused with a 400)
const MAX_NOTE_CHARS = 500; // Tavus limit per pinned memory (longer is refused with a 400)
const KEEP_NOTES = 12; // session notes kept pinned; older ones live on in the ledger and the profile
const RECENT_SESSIONS = 30; // the profile's "lately" window
const NOTE_PREFIX = 'Session note';
const PROFILE_PREFIX = 'Student profile';

// Names are typed by the student and end up in the PAL's context.
function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// A notebook key is a random secret the student's browser generates and keeps.
// It is accepted with or without the dashes it is displayed with.
function cleanKey(key) {
  const k = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return k.length >= 16 && k.length <= 64 ? k : null;
}

// The memory store a student's notes live in. The tag depends on the name AND
// the notebook key, so typing someone else's name does not open their
// notebook: you would also need the key from their browser.
// Returns null when no name was given (a session without memory).
function participantTag(name, key) {
  const clean = cleanName(name).toLowerCase();
  if (!clean) return null;
  const k = cleanKey(key);
  if (!k) throw httpError(400, 'Your notebook key is missing or not valid. Reload the page and try again.');
  const slug = clean.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'student';
  const digest = crypto.createHash('sha256').update(`${clean}\n${k}`).digest('hex').slice(0, 16);
  return `chess-student-${slug}-${digest}`;
}

// Games are kept per browser key, whether or not a name was typed.
function gameOwner(key) {
  const k = cleanKey(key);
  if (!k) throw httpError(400, 'Your notebook key is missing or not valid. Reload the page and try again.');
  return `browser-${crypto.createHash('sha256').update(`games\n${k}`).digest('hex').slice(0, 24)}`;
}

// The session summary comes from the browser and is written into long-lived
// memory that the PAL reads, so keep only what the board can actually produce:
// known puzzle themes, moves in chess notation, short plain-text labels.
const THEMES = new Set(themeNames);
const SAN = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/;
const label = (v, max) => String(v ?? '').replace(/[^\p{L}\p{N} .,;:?!'()+#=\/-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const RESULTS = ['won', 'lost', 'drew', 'unfinished'];

function sanitizeSummary(summary) {
  const src = summary && typeof summary === 'object' ? summary : {};
  const puzzles = (Array.isArray(src.puzzles) ? src.puzzles : [])
    .filter((p) => p && typeof p === 'object' && THEMES.has(p.theme))
    .slice(0, 40)
    .map((p) => ({
      theme: p.theme,
      wrong: (Array.isArray(p.wrong) ? p.wrong : []).filter((m) => typeof m === 'string' && SAN.test(m)).slice(0, 10),
      hints: Math.max(0, Math.min(50, Math.floor(Number(p.hints) || 0))),
      solved: p.solved === true,
      gaveUp: p.gaveUp === true,
    }));
  let review = null;
  const r = src.review;
  if (r && typeof r === 'object' && label(r.game, 80)) {
    review = {
      game: label(r.game, 80),
      mistakes: (Array.isArray(r.mistakes) ? r.mistakes : []).map((m) => label(m, 80)).filter(Boolean).slice(0, 4),
      tries: (Array.isArray(r.tries) ? r.tries : []).slice(0, 40).map((t) => ({ ok: Boolean(t && t.ok === true) })),
    };
  }
  const games = (Array.isArray(src.games) ? src.games : [])
    .filter((g) => g && typeof g === 'object' && RATINGS.includes(g.rating) && ['w', 'b'].includes(g.color) && RESULTS.includes(g.result))
    .slice(0, 6)
    .map((g) => ({
      rating: g.rating,
      color: g.color,
      result: g.result,
      moves: Math.max(0, Math.min(300, Math.floor(Number(g.moves) || 0))),
      mistakes: (Array.isArray(g.mistakes) ? g.mistakes : []).map((m) => label(m, 24)).filter(Boolean).slice(0, 3),
    }));
  return { puzzles, review, games };
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

// What the notebook panel shows: the pinned notes and learned memory in the
// coach's store, plus how many sessions the ledger holds for this student.
async function getMemory(palId, name, key) {
  const tag = participantTag(name, key);
  if (!tag) return { pinned: [], learned: null, sessions: 0 };
  const sessions = (await ledger.sessionsFor(tag).catch(() => [])).length;
  const id = await findStore(palId, tag);
  if (!id) return { pinned: [], learned: null, sessions };
  const store = await tavus('GET', `/memory-stores/${id}`);
  const pinned = (store.pinned_memories || []).map((m) => ({ id: m.memory_id, text: m.memory, at: m.created_at }));
  pinned.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { pinned, learned: store.learned || null, memory_store_id: id, sessions };
}

// Turn the board's session log into one factual note. Whole clauses are
// dropped from the end until it fits; a note is never cut mid-sentence.
function sessionNote(summary, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const parts = [];
  const puzzles = summary.puzzles || [];
  const clean = puzzles.filter((p) => p.solved && !p.wrong.length && !p.hints && !p.gaveUp);
  const struggled = puzzles.filter((p) => p.wrong.length || p.hints || p.gaveUp);
  if (clean.length) parts.push(`solved first try: ${[...new Set(clean.map((p) => p.theme))].join(', ')}`);
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
  for (const g of (summary.games || []).filter((g) => g.moves >= 3).slice(-2)) {
    const outcome = g.result === 'unfinished' ? `stopped after ${g.moves} moves` : `${g.result} in ${g.moves} moves`;
    parts.push(
      `played the coach at strength ${g.rating} as ${g.color === 'w' ? 'White' : 'Black'}: ${outcome}` +
        (g.mistakes.length ? `; biggest mistakes ${g.mistakes.join(', ')}` : '')
    );
  }
  if (!parts.length) return null;
  return fit(`${NOTE_PREFIX} ${day}: `, parts, '. ');
}

// prefix + parts joined, with parts dropped from the end until it fits Tavus's limit.
function fit(prefix, parts, joiner) {
  const kept = [...parts];
  while (kept.length > 1 && (prefix + kept.join(joiner) + '.').length > MAX_NOTE_CHARS) kept.pop();
  const note = prefix + kept.join(joiner) + '.';
  return note.length > MAX_NOTE_CHARS ? note.slice(0, MAX_NOTE_CHARS - 3) + '...' : note;
}

// ---------------------------------------------------------------- profile
// Everything the ledger knows about a student, folded into counts. Session
// notes fall off the pinned list after KEEP_NOTES sessions; the profile is how
// session 1 still counts at session 10,000.
function buildProfile(rows) {
  const profile = { sessions: rows.length, since: rows.length ? String(rows[0].ended_at).slice(0, 10) : null, tried: 0, clean: 0, themes: {}, recent: {}, games: {}, reviews: 0 };
  const count = (table, theme, isClean) => {
    table[theme] ||= { tried: 0, clean: 0 };
    table[theme].tried += 1;
    if (isClean) table[theme].clean += 1;
  };
  rows.forEach((row, i) => {
    const s = sanitizeSummary(row.summary);
    const lately = i >= rows.length - RECENT_SESSIONS;
    for (const p of s.puzzles) {
      const isClean = p.solved && !p.wrong.length && !p.hints && !p.gaveUp;
      profile.tried += 1;
      if (isClean) profile.clean += 1;
      count(profile.themes, p.theme, isClean);
      if (lately) count(profile.recent, p.theme, isClean);
    }
    if (s.review) profile.reviews += 1;
    for (const g of s.games) {
      if (g.moves < 3 || g.result === 'unfinished') continue;
      profile.games[g.rating] ||= { won: 0, lost: 0, drew: 0 };
      profile.games[g.rating][g.result] += 1;
    }
  });
  return profile;
}

// The profile as one pinned note, or null until there are two sessions to sum up.
function profileNote(profile) {
  if (profile.sessions < 2) return null;
  const parts = [];
  if (profile.tried) parts.push(`Puzzles: ${profile.tried} tried, ${profile.clean} solved first try`);
  // A theme needs three recent attempts before it says anything about the student.
  const rated = Object.entries(profile.recent)
    .filter(([, t]) => t.tried >= 3)
    .map(([theme, t]) => ({ theme, ...t, rate: t.clean / t.tried }));
  const show = (t) => `${t.theme} (${t.clean} of ${t.tried} first try)`;
  const strong = rated.filter((t) => t.rate >= 0.7).sort((a, b) => b.rate - a.rate || b.tried - a.tried).slice(0, 3);
  const weak = rated.filter((t) => t.rate <= 0.5).sort((a, b) => a.rate - b.rate || b.tried - a.tried).slice(0, 3);
  if (weak.length) parts.push(`Lately needs work on ${weak.map(show).join(', ')}`);
  if (strong.length) parts.push(`Lately strong at ${strong.map(show).join(', ')}`);
  const games = Object.entries(profile.games).map(([rating, g]) => {
    const bits = [g.won && `won ${g.won}`, g.lost && `lost ${g.lost}`, g.drew && `drew ${g.drew}`].filter(Boolean);
    return `at ${rating} ${bits.join(', ')}`;
  });
  if (games.length) parts.push(`Games against the coach: ${games.join('; ')}`);
  if (profile.reviews) parts.push(`Reviewed ${profile.reviews} of their own games`);
  if (!parts.length) return null;
  return fit(`${PROFILE_PREFIX}, ${profile.sessions} sessions since ${profile.since}. `, parts, '. ');
}

// ---------------------------------------------------------------- sync
const noteDay = (text) => (text.match(/^Session note (\d{4}-\d\d-\d\d)/) || [])[1] || '';

// What should be pinned for this student, from the ledger alone.
function desiredPins(rows) {
  // Two sessions on one day can produce the same sentence; it is pinned once, at its latest position.
  const all = rows.map((r) => r.note);
  const notes = all.filter((note, i) => all.lastIndexOf(note) === i).slice(-KEEP_NOTES);
  return { notes, profile: profileNote(buildProfile(rows)) };
}

// Make one coach's store match the ledger, then read it back.
//  - the profile note is replaced when the numbers change
//  - session notes the ledger has and the store lacks are added (this is what
//    repairs a write that failed last time)
//  - session notes beyond KEEP_NOTES are removed, oldest first
//  - duplicates are removed; anything this app did not write is left alone
// Resolves to { ok, pinned, notes, profile, detail }. Never throws.
async function syncStore(palId, tag) {
  const result = { pal_id: palId, ok: false, pinned: 0, notes: [], profile: null, detail: null };
  try {
    const rows = await ledger.sessionsFor(tag);
    const want = desiredPins(rows);
    let id = await findStore(palId, tag);
    if (!id && !want.notes.length) return { ...result, ok: true };
    id ||= await ensureStore(palId, tag);
    const read = async () => (await tavus('GET', `/memory-stores/${id}/pinned`)).pinned_memories || [];
    const pinned = await read();

    const remove = [];
    const seen = new Set();
    const legacy = []; // session notes in the store that the ledger does not ask for
    let others = 0;
    for (const m of pinned) {
      const isNote = m.memory.startsWith(NOTE_PREFIX);
      const isProfile = m.memory.startsWith(PROFILE_PREFIX);
      if (!isNote && !isProfile) others += 1;
      else if (seen.has(m.memory) || (isProfile && m.memory !== want.profile)) remove.push(m);
      else if (isNote && !want.notes.includes(m.memory)) legacy.push(m);
      seen.add(m.memory);
    }
    // Notes from before the ledger existed stay while there is room for them.
    const room = Math.max(0, Math.min(KEEP_NOTES, MAX_PINNED - others - 1) - want.notes.length);
    legacy.sort((a, b) => noteDay(b.memory).localeCompare(noteDay(a.memory)) || String(b.created_at).localeCompare(String(a.created_at)));
    remove.push(...legacy.slice(room));
    const removed = new Set(remove.map((m) => m.memory_id));
    const present = new Set(pinned.filter((m) => !removed.has(m.memory_id)).map((m) => m.memory));
    const add = [...want.notes, want.profile].filter((text) => text && !present.has(text));

    for (const m of remove) {
      await tavus('DELETE', `/memory-stores/${id}/pinned/${m.memory_id}`).catch((e) => {
        if (e.status !== 404) throw e; // already gone is fine
      });
    }
    for (const memory of add) await tavus('POST', `/memory-stores/${id}/pinned`, { memory });

    // Trust nothing: read the store back and compare.
    const after = remove.length || add.length ? await read() : pinned;
    const texts = after.map((m) => m.memory);
    const missing = [...want.notes, want.profile].filter((text) => text && !texts.includes(text));
    result.pinned = after.length;
    result.notes = texts.filter((t) => t.startsWith(NOTE_PREFIX)).sort((a, b) => noteDay(a).localeCompare(noteDay(b)));
    result.profile = texts.find((t) => t.startsWith(PROFILE_PREFIX)) || null;
    result.ok = !missing.length && after.length <= MAX_PINNED;
    if (!result.ok) result.detail = `${missing.length} note(s) missing after sync, ${after.length} pinned`;
  } catch (e) {
    result.detail = e.message.slice(0, 300);
  }
  await ledger.saveSync(tag, palId, result).catch(() => {});
  audit.record({ kind: result.ok ? 'memory.sync' : 'memory.sync.error', data: { tag, pal_id: palId, ok: result.ok, pinned: result.pinned, detail: result.detail } });
  return result;
}

// Two syncs of the same store never run at once (a session ending while the
// next one starts, or the end reported by both the button and the unload beacon).
const running = new Map();
function sync(palId, tag) {
  const key = `${palId}\n${tag}`;
  const next = (running.get(key) || Promise.resolve()).then(() => syncStore(palId, tag));
  running.set(key, next);
  next.finally(() => running.get(key) === next && running.delete(key));
  return next;
}

// Write a session into the ledger. With palIds, also bring those coaches'
// stores up to date. Saving the same conversation again replaces its row, so
// checkpoints during a call and a doubled end-of-call report are harmless.
async function recordSession(palIds, name, key, conversationId, summary) {
  const tag = participantTag(name, key);
  if (!tag) return { saved: false, reason: 'no name' };
  const clean = sanitizeSummary(summary);
  const note = sessionNote(clean);
  if (!note) return { saved: false, reason: 'nothing happened on the board' };
  try {
    await ledger.saveSession(tag, conversationId, clean, note);
  } catch (e) {
    console.error(`session not stored in the ledger: ${e.message}`);
    audit.record({ kind: 'memory.ledger.error', conversation_id: conversationId, data: { tag, error: e.message.slice(0, 300) } });
    return { saved: false, reason: 'the session record could not be stored' };
  }
  if (!palIds.length) return { saved: true, note };
  const synced = await Promise.all(palIds.map((palId) => sync(palId, tag)));
  return { saved: true, note, pinned: synced.every((s) => s.ok), sync: synced.map(({ pal_id, ok, pinned, detail }) => ({ pal_id, ok, pinned, detail })) };
}

// What the coach should be told at the start of a session. Runs a sync first,
// so anything that failed to reach this coach's store earlier is repaired
// before the call begins. The notes come from the ledger when it has any, and
// from the store otherwise (students from before the ledger existed).
async function studentContext(palId, name, key) {
  const tag = participantTag(name, key);
  if (!tag) return { tag: null, notes: [], profile: null, sync: null };
  const [state, rows] = await Promise.all([sync(palId, tag), ledger.sessionsFor(tag).catch(() => [])]);
  const want = desiredPins(rows);
  return { tag, notes: (want.notes.length ? want.notes : state.notes).slice(-3), profile: want.profile || state.profile, sync: state };
}

module.exports = {
  cleanName,
  cleanKey,
  participantTag,
  gameOwner,
  getMemory,
  recordSession,
  studentContext,
  sync,
  sessionNote,
  sanitizeSummary,
  buildProfile,
  profileNote,
  desiredPins,
  KEEP_NOTES,
  MAX_PINNED,
  MAX_NOTE_CHARS,
};
