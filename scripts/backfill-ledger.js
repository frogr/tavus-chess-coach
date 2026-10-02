// One-off: copy sessions that ended before the student ledger existed out of
// the audit log and into the ledger, so their profile counts them.
// Safe to run again: a session already in the ledger is replaced by the same row.
//   node scripts/backfill-ledger.js          (uses DATABASE_URL from .env)
require('../server/env');
const audit = require('../server/audit');
const ledger = require('../server/ledger');
const { sanitizeSummary, sessionNote } = require('../server/memory');

(async () => {
  const sessions = await audit.listSessions({ limit: 100000 });
  let copied = 0;
  for (const s of sessions) {
    const tag = s.data?.participant_tag;
    if (!tag || !s.data.summary || !s.ended_at) continue;
    const at = new Date(s.ended_at);
    const clean = sanitizeSummary(s.data.summary);
    const note = sessionNote(clean, at);
    if (!note) continue;
    await ledger.saveSession(tag, s.conversation_id, clean, note, at);
    copied += 1;
  }
  console.log(`${copied} of ${sessions.length} audited sessions copied into the ledger (${ledger.storeName()}).`);
  await audit.close();
  await ledger.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
