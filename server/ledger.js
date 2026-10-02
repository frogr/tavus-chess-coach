// The student ledger: this app's own permanent record of every session a
// student has had. It is the source of truth for memory. What the coach sees
// (Tavus pinned memories) is rebuilt from it, so a failed or lost write to
// Tavus can always be repaired. See docs/MEMORY.md.
//
// With DATABASE_URL set, rows live in Postgres and are never pruned. Without
// it they are kept in this process only (local development, tests).
const SCHEMA = `
create table if not exists student_sessions (
  tag text not null,
  conversation_id text not null,
  ended_at timestamptz not null default now(),
  summary jsonb not null,
  note text not null,
  primary key (tag, conversation_id)
);
create index if not exists student_sessions_tag_ended on student_sessions (tag, ended_at);
create table if not exists student_sync (
  tag text not null,
  pal_id text not null,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  pinned int not null default 0,
  detail text,
  primary key (tag, pal_id)
);
`;

const iso = (d) => (d instanceof Date ? d.toISOString() : String(d));

function memoryLedger() {
  const sessions = new Map(); // tag -> Map(conversation_id -> row)
  const syncs = new Map();
  return {
    name: 'memory (not persisted: set DATABASE_URL)',
    durable: false,
    async init() {},
    async saveSession(tag, conversationId, summary, note, at = new Date()) {
      if (!sessions.has(tag)) sessions.set(tag, new Map());
      sessions.get(tag).set(conversationId, { conversation_id: conversationId, ended_at: iso(at), summary, note });
    },
    async sessionsFor(tag) {
      return [...(sessions.get(tag)?.values() || [])].sort((a, b) => a.ended_at.localeCompare(b.ended_at));
    },
    async saveSync(tag, palId, result) {
      syncs.set(`${tag}\n${palId}`, { pal_id: palId, checked_at: new Date().toISOString(), ok: result.ok, pinned: result.pinned, detail: result.detail || null });
    },
    async syncsFor(tag) {
      return [...syncs.entries()].filter(([k]) => k.startsWith(`${tag}\n`)).map(([, v]) => v);
    },
    async stats() {
      return {
        students: sessions.size,
        sessions: [...sessions.values()].reduce((n, m) => n + m.size, 0),
        out_of_sync: [...syncs.entries()].filter(([, v]) => !v.ok).map(([k, v]) => ({ tag: k.split('\n')[0], ...v })),
      };
    },
    async close() {},
  };
}

function postgresLedger(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error(`ledger database error: ${e.message}`));
  return {
    name: 'postgres',
    durable: true,
    async init() {
      await pool.query(SCHEMA);
    },
    // One row per session. Saving the same session again (a checkpoint, then
    // the end of the call, or the end reported twice) replaces the row.
    async saveSession(tag, conversationId, summary, note, at = new Date()) {
      await pool.query(
        `insert into student_sessions (tag, conversation_id, ended_at, summary, note) values ($1, $2, $3, $4::jsonb, $5)
         on conflict (tag, conversation_id) do update set ended_at = excluded.ended_at, summary = excluded.summary, note = excluded.note`,
        [tag, conversationId, iso(at), JSON.stringify(summary), note]
      );
    },
    async sessionsFor(tag) {
      const { rows } = await pool.query('select conversation_id, ended_at, summary, note from student_sessions where tag = $1 order by ended_at, conversation_id', [tag]);
      return rows.map((r) => ({ ...r, ended_at: iso(r.ended_at) }));
    },
    async saveSync(tag, palId, result) {
      await pool.query(
        `insert into student_sync (tag, pal_id, checked_at, ok, pinned, detail) values ($1, $2, now(), $3, $4, $5)
         on conflict (tag, pal_id) do update set checked_at = now(), ok = excluded.ok, pinned = excluded.pinned, detail = excluded.detail`,
        [tag, palId, result.ok, result.pinned, result.detail || null]
      );
    },
    async syncsFor(tag) {
      const { rows } = await pool.query('select pal_id, checked_at, ok, pinned, detail from student_sync where tag = $1', [tag]);
      return rows;
    },
    async stats() {
      const totals = await pool.query('select count(distinct tag)::int as students, count(*)::int as sessions from student_sessions');
      const bad = await pool.query('select tag, pal_id, checked_at, pinned, detail from student_sync where not ok order by checked_at desc limit 50');
      return { ...totals.rows[0], out_of_sync: bad.rows };
    },
    async close() {
      await pool.end();
    },
  };
}

let store = process.env.DATABASE_URL ? postgresLedger(process.env.DATABASE_URL) : memoryLedger();
let ready = null;

// Unlike the audit log, the ledger does not quietly fall back to memory when
// the database is down: a note that only exists in this process would be lost
// on the next deploy. Callers get the error and report the note as not saved.
function init() {
  ready ||= store.init().then(() => console.log(`  Student ledger: ${store.name}`));
  ready.catch(() => {
    ready = null; // try again on the next call
  });
  return ready;
}

const call = (fn) => async (...args) => {
  await init();
  return store[fn](...args);
};

module.exports = {
  init,
  saveSession: call('saveSession'),
  sessionsFor: call('sessionsFor'),
  saveSync: call('saveSync'),
  syncsFor: call('syncsFor'),
  stats: async () => ({ store: store.name, ...(await call('stats')()) }),
  durable: () => store.durable,
  storeName: () => store.name,
  close: () => store.close(),
  // Tests swap in a fresh in-process ledger.
  useMemory: () => {
    store = memoryLedger();
    ready = null;
  },
};
