// The guarantees in docs/MEMORY.md, run against a fake Tavus that enforces the
// real API's limits (30 pinned memories per store, 500 characters each).
process.env.NODE_ENV = 'test';
process.env.TAVUS_API_KEY = 'test-key';
delete process.env.DATABASE_URL;
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeTavus } = require('./helpers');

const KEY = 'abcde-fghjk-mnpqr-stuvw';
const PAL = 'p1';
const THEMES = ['fork', 'pin', 'skewer'];

// Session i for a student who always solves forks, never solves skewers
// cleanly, and wins every third game at 1500.
const summaryFor = (i) => ({
  puzzles: [
    { theme: 'fork', wrong: [], hints: 0, solved: true, gaveUp: false },
    { theme: 'skewer', wrong: ['Qd5'], hints: 1 + (i % 40), solved: true, gaveUp: false },
    { theme: THEMES[i % 3], wrong: [], hints: 0, solved: true, gaveUp: false },
  ],
  review: i % 10 === 0 ? { game: `Game ${i}`, mistakes: ['14. Qd6?'], tries: [{ ok: true }] } : null,
  games: [{ rating: 1500, color: 'w', result: i % 3 === 0 ? 'won' : 'lost', moves: 30 + (i % 7), mistakes: ['14. Qd6?'] }],
});

async function setup(t) {
  const tavus = await startFakeTavus();
  process.env.TAVUS_API_BASE = tavus.base;
  for (const m of ['../server/tavus', '../server/memory', '../server/ledger']) delete require.cache[require.resolve(m)];
  const memory = require('../server/memory');
  const ledger = require('../server/ledger');
  ledger.useMemory();
  t.after(() => tavus.stop());
  const tag = memory.participantTag('Sam', KEY);
  const pins = () => (tavus.db.stores[0]?.pinned_memories || []).map((p) => p.memory);
  return { tavus, memory, ledger, tag, pins };
}

test('every session, synced: the store never passes its limits and always matches the ledger', async (t) => {
  const { memory, ledger, tag, pins } = await setup(t);
  for (let i = 0; i < 120; i++) {
    const r = await memory.recordSession([PAL], 'Sam', KEY, `c${i}`, summaryFor(i));
    assert.equal(r.saved && r.pinned, true, `session ${i}: ${JSON.stringify(r.sync)}`);
    const now = pins();
    assert.ok(now.length <= memory.KEEP_NOTES + 1, `session ${i}: ${now.length} pinned`);
    assert.ok(now.every((x) => x.length <= memory.MAX_NOTE_CHARS));
    assert.ok(now.includes(r.note), 'the newest note is pinned');
    assert.equal(now.filter((x) => x.startsWith('Student profile')).length, i ? 1 : 0, 'exactly one profile, replaced in place');
  }
  assert.equal((await ledger.sessionsFor(tag)).length, 120, 'nothing is ever dropped from the ledger');
  assert.match(pins().find((x) => x.startsWith('Student profile')), /^Student profile, 120 sessions since \d{4}-\d\d-\d\d\. Puzzles: 360 tried, 240 solved first try\./);
});

test('10,000 sessions: the profile still counts the first one, and what is pinned stays small', async (t) => {
  const { memory, ledger, tag, pins } = await setup(t);
  for (let i = 0; i < 10000; i++) {
    const clean = memory.sanitizeSummary(summaryFor(i));
    await ledger.saveSession(tag, `c${i}`, clean, memory.sessionNote(clean, new Date(Date.UTC(2026, 0, 1 + (i % 365)))), new Date(Date.UTC(2026, 0, 1) + i * 60000));
  }
  const started = Date.now();
  const state = await memory.sync(PAL, tag);
  assert.equal(state.ok, true, state.detail);
  assert.ok(Date.now() - started < 3000, 'a sync over 10,000 sessions takes well under a few seconds');

  const profile = memory.buildProfile(await ledger.sessionsFor(tag));
  assert.equal(profile.sessions, 10000);
  assert.equal(profile.tried, 30000);
  assert.equal(profile.clean, 20000);
  assert.deepEqual(profile.games[1500], { won: 3334, lost: 6666, drew: 0 });
  assert.equal(profile.reviews, 1000);
  // "Lately" covers the last 30 sessions only: 30 forks + 10 as the rotating theme.
  assert.deepEqual(profile.recent.fork, { tried: 40, clean: 40 });
  assert.deepEqual(profile.recent.skewer, { tried: 40, clean: 10 });

  const now = pins();
  assert.equal(now.length, memory.KEEP_NOTES + 1);
  const note = now.find((x) => x.startsWith('Student profile'));
  assert.ok(note.length <= 500, note);
  assert.match(note, /10000 sessions since 2026-01-01/);
  assert.match(note, /Puzzles: 30000 tried, 20000 solved first try/);
  assert.match(note, /Lately needs work on skewer \(10 of 40 first try\)/);
  assert.match(note, /Lately strong at fork \(40 of 40 first try\)/);
  assert.match(note, /at 1500 won 3334, lost 6666/);
  assert.match(note, /Reviewed 1000 of their own games/);
});

test('a write Tavus refuses is reported, kept in the ledger, and repaired by the next sync', async (t) => {
  const { tavus, memory, ledger, tag, pins } = await setup(t);
  await memory.recordSession([PAL], 'Sam', KEY, 'c0', summaryFor(0));
  tavus.db.failPinned = 5;
  const failed = await memory.recordSession([PAL], 'Sam', KEY, 'c1', summaryFor(1));
  assert.equal(failed.saved, true, 'the ledger has it');
  assert.equal(failed.pinned, false, 'and the caller is told the coach does not, yet');
  assert.equal((await ledger.syncsFor(tag))[0].ok, false);
  assert.ok(!pins().includes(failed.note));

  tavus.db.failPinned = 0;
  const context = await memory.studentContext(PAL, 'Sam', KEY); // what starting the next session does
  assert.equal(context.sync.ok, true);
  assert.ok(pins().includes(failed.note));
  assert.equal(context.notes.at(-1), failed.note);
  assert.match(context.profile, /^Student profile, 2 sessions/);
  assert.equal((await ledger.syncsFor(tag))[0].ok, true);
});

test('sync leaves alone what it did not write, removes duplicates, and keeps pre-ledger notes while there is room', async (t) => {
  const { tavus, memory, pins } = await setup(t);
  await memory.recordSession([PAL], 'Sam', KEY, 'c0', summaryFor(0));
  const store = tavus.db.stores[0];
  const pin = (memory_id, text) => store.pinned_memories.push({ memory_id, memory: text, created_at: new Date().toISOString() });
  pin('x1', 'Prefers the London System.'); // pinned by hand in the Tavus dashboard
  pin('x2', 'Session note 2025-01-01: solved first try: pin.'); // from before the ledger
  pin('x3', store.pinned_memories[0].memory); // a duplicate
  pin('x4', 'Student profile, 99 sessions since 2020-01-01. Stale.');
  await memory.recordSession([PAL], 'Sam', KEY, 'c1', summaryFor(1));
  const now = pins();
  assert.ok(now.includes('Prefers the London System.'));
  assert.ok(now.includes('Session note 2025-01-01: solved first try: pin.'));
  assert.equal(new Set(now).size, now.length, 'no duplicates');
  assert.deepEqual(now.filter((x) => x.startsWith('Student profile')).map((x) => x.slice(0, 27)), ['Student profile, 2 sessions']);

  // Once the ledger alone fills the list, the pre-ledger note makes way.
  for (let i = 2; i < 14; i++) await memory.recordSession([PAL], 'Sam', KEY, `c${i}`, { puzzles: [{ theme: THEMES[i % 3], wrong: [], hints: i, solved: true, gaveUp: false }] });
  assert.ok(!pins().includes('Session note 2025-01-01: solved first try: pin.'));
  assert.ok(pins().includes('Prefers the London System.'));
});

test('notes and profiles are cut at clause boundaries, never mid-sentence, and fit the limit', async (t) => {
  const { memory } = await setup(t);
  const long = memory.sanitizeSummary({
    puzzles: THEMES.map((theme) => ({ theme, wrong: ['Qd5', 'Nxe5', 'Rxa8+'], hints: 3, solved: false, gaveUp: true })),
    review: { game: 'g'.repeat(80), mistakes: Array(4).fill('m'.repeat(80)), tries: [] },
    games: Array(2).fill({ rating: 1500, color: 'w', result: 'lost', moves: 40, mistakes: ['14. Qd6?', '20. Nd5??', '31. Kh1?'] }),
  });
  const note = memory.sessionNote(long);
  assert.ok(note.length <= 500);
  assert.ok(!note.endsWith('...'), note);
  assert.match(note, /\.$/);
});
