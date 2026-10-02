// Audit trail: every API request, every call to Tavus, every webhook, and
// every event the browser reports (moves, tool calls, what the coach said) is
// recorded here, so a session can be reconstructed after the fact.
//
// With DATABASE_URL set, events go to Postgres and survive restarts and
// deploys. Without it they are kept in memory only (local development, tests).
//
// Recording never blocks or fails a request: events are queued and written in
// batches. A batch that fails to write is kept and retried.
const crypto = require('crypto');

const MAX_DATA_BYTES = 256000; // per event; larger payloads are truncated (a full game review is about 60 KB)
const MAX_RECORD_BYTES = 2000000; // transcripts and Tavus's own conversation records are kept whole
const FLUSH_MS = 1000;
const MAX_BACKLOG = 50000; // events held while the database is unreachable
// 0 keeps everything. Set a number of days to prune older events on boot.
const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 0);

const SCHEMA = `
create table if not exists audit_events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  source text not null,
  kind text not null,
  client_id text,
  conversation_id text,
  ip text,
  data jsonb not null default '{}'::jsonb
);
create index if not exists audit_events_conversation on audit_events (conversation_id, id);
create index if not exists audit_events_client on audit_events (client_id, id);
create index if not exists audit_events_kind on audit_events (kind, id);
create index if not exists audit_events_ts on audit_events (ts);
create table if not exists audit_sessions (
  conversation_id text primary key,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  data jsonb not null default '{}'::jsonb
);
`;

// Secrets never go into the log: the access code, notebook keys, tokens.
const SECRET_FIELDS = new Set(['code', 'key', 'token', 'authorization', 'x-api-key', 'api_key', 'password']);
function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[too deep]';
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.has(k.toLowerCase()) && v ? '[redacted]' : redact(v, depth + 1);
  return out;
}

// Keep one event to a sane size without losing that it happened.
function fit(data, max = MAX_DATA_BYTES) {
  const clean = redact(data === undefined ? {} : data);
  const json = JSON.stringify(clean);
  if (json === undefined) return {};
  if (json.length <= max) return clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : { value: clean };
  return { truncated: true, bytes: json.length, preview: json.slice(0, max) };
}

const text = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

function normalize(e) {
  return {
    ts: e.ts instanceof Date ? e.ts.toISOString() : typeof e.ts === 'string' ? e.ts : new Date().toISOString(),
    source: text(e.source, 20) || 'server',
    kind: text(e.kind, 100) || 'unknown',
    client_id: text(e.client_id, 64),
    conversation_id: text(e.conversation_id, 64),
    ip: text(e.ip, 64),
    data: fit(e.data, e.whole ? MAX_RECORD_BYTES : MAX_DATA_BYTES),
  };
}

// ---------------------------------------------------------------- memory store
function memoryStore() {
  const events = [];
  const sessions = new Map();
  let nextId = 1;
  const matches = (e, f) =>
    (!f.kind || e.kind.startsWith(f.kind)) &&
    (!f.source || e.source === f.source) &&
    (!f.client || e.client_id === f.client) &&
    (!f.conversation || e.conversation_id === f.conversation) &&
    (!f.before || e.id < f.before) &&
    (!f.q || JSON.stringify(e).toLowerCase().includes(f.q.toLowerCase()));
  return {
    name: 'memory (not persisted: set DATABASE_URL)',
    async init() {},
    async addEvents(batch) {
      for (const e of batch) events.push({ id: nextId++, ...e });
      if (events.length > 20000) events.splice(0, events.length - 20000);
    },
    async upsertSession(id, fields) {
      const cur = sessions.get(id) || { conversation_id: id, started_at: new Date().toISOString(), ended_at: null, data: {} };
      if (fields.ended_at) cur.ended_at = fields.ended_at;
      cur.data = { ...cur.data, ...(fields.data || {}) };
      sessions.set(id, cur);
    },
    async listSessions({ limit = 50 } = {}) {
      return [...sessions.values()]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, limit)
        .map((s) => ({
          ...s,
          events: events.filter((e) => e.conversation_id === s.conversation_id).length,
          errors: events.filter((e) => e.conversation_id === s.conversation_id && isError(e)).length,
        }));
    },
    async getSession(id) {
      const s = sessions.get(id);
      return s ? { ...s, events: events.filter((e) => e.conversation_id === id) } : null;
    },
    async listEvents(f = {}) {
      return events.filter((e) => matches(e, f)).slice(-(f.limit || 200)).reverse();
    },
    async listVisits({ limit = 100 } = {}) {
      const visits = new Map();
      for (const e of events) {
        if (!e.client_id) continue;
        const v = visits.get(e.client_id) || { client_id: e.client_id, first: e.ts, last: e.ts, events: 0, moves: 0, conversation_id: null, ip: null };
        v.last = e.ts;
        v.events++;
        if (e.kind === 'puzzle.move' || e.kind === 'review.try' || e.kind === 'play.move') v.moves++;
        v.conversation_id = e.conversation_id || v.conversation_id;
        v.ip = e.ip || v.ip;
        visits.set(e.client_id, v);
      }
      return [...visits.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
    },
    async stats() {
      return { events: events.length, sessions: sessions.size };
    },
    async prune() {},
    async close() {},
  };
}

const isError = (e) => e.kind.includes('error') || (e.data && Number(e.data.status) >= 500);

// ---------------------------------------------------------------- postgres store
function postgresStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error(`audit database error: ${e.message}`));
  const ERR = `(kind like '%error%' or (data ? 'status' and (data->>'status') ~ '^5\\d\\d$'))`;
  return {
    name: 'postgres',
    async init() {
      await pool.query(SCHEMA);
    },
    async addEvents(batch) {
      await pool.query(
        `insert into audit_events (ts, source, kind, client_id, conversation_id, ip, data)
         select (e->>'ts')::timestamptz, e->>'source', e->>'kind', e->>'client_id', e->>'conversation_id', e->>'ip', e->'data'
         from jsonb_array_elements($1::jsonb) e`,
        [JSON.stringify(batch)]
      );
    },
    async upsertSession(id, fields) {
      await pool.query(
        `insert into audit_sessions (conversation_id, ended_at, data) values ($1, $2, $3::jsonb)
         on conflict (conversation_id) do update set
           ended_at = coalesce(excluded.ended_at, audit_sessions.ended_at),
           data = audit_sessions.data || excluded.data`,
        [id, fields.ended_at || null, JSON.stringify(fields.data || {})]
      );
    },
    async listSessions({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        `select s.conversation_id, s.started_at, s.ended_at, s.data - 'tavus' as data,
                (select count(*)::int from audit_events e where e.conversation_id = s.conversation_id) as events,
                (select count(*)::int from audit_events e where e.conversation_id = s.conversation_id and ${ERR}) as errors
         from audit_sessions s order by s.started_at desc limit $1`,
        [limit]
      );
      return rows;
    },
    async getSession(id) {
      const s = await pool.query('select * from audit_sessions where conversation_id = $1', [id]);
      if (!s.rows[0]) return null;
      const e = await pool.query('select * from audit_events where conversation_id = $1 order by id limit 10000', [id]);
      return { ...s.rows[0], events: e.rows };
    },
    async listEvents(f = {}) {
      const where = [];
      const args = [];
      const add = (sql, v) => {
        args.push(v);
        where.push(sql.replace('?', `$${args.length}`));
      };
      if (f.kind) add(`kind like ? || '%'`, f.kind);
      if (f.source) add('source = ?', f.source);
      if (f.client) add('client_id = ?', f.client);
      if (f.conversation) add('conversation_id = ?', f.conversation);
      if (f.before) add('id < ?', f.before);
      if (f.q) add(`(kind || ' ' || data::text) ilike '%' || ? || '%'`, f.q);
      args.push(Math.min(f.limit || 200, 1000));
      const { rows } = await pool.query(
        `select * from audit_events ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit $${args.length}`,
        args
      );
      return rows;
    },
    async listVisits({ limit = 100 } = {}) {
      const { rows } = await pool.query(
        `select client_id, min(ts) as first, max(ts) as last, count(*)::int as events,
                count(*) filter (where kind in ('puzzle.move', 'review.try', 'play.move'))::int as moves,
                max(conversation_id) as conversation_id, max(ip) as ip
         from audit_events where client_id is not null
         group by client_id order by max(id) desc limit $1`,
        [limit]
      );
      return rows;
    },
    async stats() {
      const { rows } = await pool.query(
        `select (select count(*)::int from audit_events) as events, (select count(*)::int from audit_sessions) as sessions,
                (select min(ts) from audit_events) as oldest`
      );
      return rows[0];
    },
    async prune(days) {
      await pool.query(`delete from audit_events where ts < now() - make_interval(days => $1)`, [days]);
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------- recorder
let store = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : memoryStore();
let ready = null;
let queue = [];
let timer = null;

function init() {
  ready ||= store
    .init()
    .then(() => (RETENTION_DAYS > 0 ? store.prune(RETENTION_DAYS) : null))
    .then(() => console.log(`  Audit log: ${store.name}`))
    .catch((e) => {
      // A database that can't be reached must not take the app down with it.
      console.error(`  Audit log: database unavailable (${e.message}); keeping events in memory`);
      store = memoryStore();
    });
  return ready;
}

async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    await init();
    await store.addEvents(batch);
  } catch (e) {
    // Keep the batch and try again with the next flush. Only when the backlog
    // passes MAX_BACKLOG are the oldest events given up, and that is logged.
    queue = batch.concat(queue);
    if (queue.length > MAX_BACKLOG) {
      console.error(`audit backlog full: ${queue.length - MAX_BACKLOG} oldest events dropped`);
      queue = queue.slice(queue.length - MAX_BACKLOG);
    }
    console.error(`audit write failed, ${batch.length} events kept for retry: ${e.message}`);
    if (!timer) {
      timer = setTimeout(flush, 5000);
      timer.unref();
    }
  }
}

function record(event) {
  queue.push(normalize(event));
  if (queue.length >= 200) flush();
  else if (!timer) {
    timer = setTimeout(flush, FLUSH_MS);
    timer.unref();
  }
}

async function session(id, fields) {
  if (!id) return;
  try {
    await init();
    await store.upsertSession(String(id).slice(0, 64), { ended_at: fields.ended_at, data: fit(fields.data, MAX_RECORD_BYTES) });
  } catch (e) {
    console.error(`audit session write failed: ${e.message}`);
  }
}

// Reads flush first so the dashboard always sees what just happened.
const read = (fn) => async (...args) => {
  await flush();
  await init();
  return store[fn](...args);
};

module.exports = {
  init,
  record,
  session,
  flush,
  redact,
  listSessions: read('listSessions'),
  getSession: read('getSession'),
  listEvents: read('listEvents'),
  listVisits: read('listVisits'),
  stats: async () => ({ store: store.name, retention_days: RETENTION_DAYS, ...(await read('stats')()) }),
  close: async () => {
    await flush();
    await store.close();
  },
  // The webhook URL carries this, so only Tavus (who we gave the URL to) can post to it.
  webhookToken: (secret) => crypto.createHmac('sha256', String(secret)).update('tavus-webhook').digest('hex').slice(0, 32),
};
