// Admin dashboard. Everything shown here came from the audit log; all of it is
// rendered as text (never as HTML), since the log holds what students and the
// model said.
const $ = (id) => document.getElementById(id);
const view = $('view');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let token = '';
try { token = sessionStorage.getItem('coach-rook-admin') || ''; } catch {}

async function get(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 404) {
    signOut();
    throw new Error(res.status === 404 ? 'Admin is off: ADMIN_TOKEN is not set.' : 'Wrong token.');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function signOut() {
  token = '';
  try { sessionStorage.removeItem('coach-rook-admin'); } catch {}
  $('login').hidden = false;
  view.hidden = true;
  $('nav').hidden = true;
  $('signOut').hidden = true;
  $('storeInfo').textContent = '';
}

// ---------------------------------------------------------------- formatting
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtClock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function fmtLength(a, b) {
  if (!a || !b) return '';
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
const clip = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// One line that says what an event was.
function gist(e) {
  const d = e.data || {};
  if (e.kind.startsWith('http')) return `${d.method} ${d.path} → ${d.status} in ${d.ms}ms${d.error ? ` · ${clip(d.error, 80)}` : ''}`;
  if (e.kind.startsWith('tavus.api')) return `${d.method} ${d.path} → ${d.status ?? 'failed'} in ${d.ms}ms${d.error ? ` · ${clip(d.error, 80)}` : ''}`;
  if (e.kind === 'tavus.received' || e.kind === 'tavus.sent') {
    const p = d.properties || {};
    return `${d.event_type || ''} ${clip(p.speech || p.text || p.context || p.name || p.output || '', 120)}`.trim();
  }
  if (e.kind.startsWith('tavus.webhook')) return clip(d.properties || d, 140);
  if (e.kind.startsWith('feed:')) return clip(d.text || d.detail || '', 140);
  if (e.kind === 'puzzle.move') return `${d.san} on "${d.id}" · ${d.correct ? 'correct' : 'wrong'}`;
  if (e.kind === 'play.move' || e.kind === 'play.reply') return `${e.kind === 'play.move' ? 'student' : 'coach'} ${d.san} · strength ${d.rating}`;
  if (e.kind === 'play.judge') return `${d.san} · ${d.class || 'fine'}${d.class ? ` · best ${d.best}` : ''}`;
  if (e.kind === 'review.try') return `${d.san} at moment ${d.moment} · ${d.ok ? 'accepted' : 'rejected'}`;
  return clip(d, 140);
}

const isError = (e) => e.kind.includes('error') || Number(e.data?.status) >= 500;

function eventRow(e, time = fmtTime) {
  return h(
    'details',
    { class: `event${isError(e) ? ' err' : ''}` },
    h('summary', {}, h('time', {}, time(e.ts)), h('span', { class: 'kind' }, e.kind), h('span', { class: 'gist' }, gist(e))),
    h('pre', {}, JSON.stringify({ id: e.id, source: e.source, client_id: e.client_id, conversation_id: e.conversation_id, ip: e.ip, data: e.data }, null, 2))
  );
}

// ---------------------------------------------------------------- views
const table = (heads, rows) =>
  h('table', {}, h('thead', {}, h('tr', {}, ...heads.map(([t, cls]) => h('th', { class: cls || '' }, t)))), h('tbody', {}, rows));
const row = (route, ...cells) =>
  h('tr', { class: 'link', tabindex: '0', onclick: () => go(route), onkeydown: (e) => e.key === 'Enter' && go(route) }, ...cells);

async function showOverview(which) {
  const { stats, memory, sessions, visits } = await get('/api/admin/overview');
  const drift = memory?.out_of_sync?.length || 0;
  const memoryInfo = !memory || memory.error ? 'memory ledger unavailable' : `memory: ${memory.students} students, ${memory.sessions} sessions, ${memory.games ?? 0} games, ${drift ? `${drift} coach stores out of sync` : 'in sync'}`;
  $('storeInfo').textContent = `${stats.events.toLocaleString()} events · ${stats.store} · ${stats.retention_days ? stats.retention_days + '-day retention' : 'kept forever'} · ${memoryInfo}`;
  if (which === 'visits') {
    view.replaceChildren(
      visits.length
        ? table(
            [['Last seen'], ['First seen'], ['Events', 'num'], ['Moves', 'num'], ['Session'], ['IP']],
            visits.map((v) =>
              row(
                `events?client=${v.client_id}`,
                h('td', { class: 'when' }, fmtTime(v.last)),
                h('td', { class: 'when dim' }, fmtTime(v.first)),
                h('td', { class: 'num' }, String(v.events)),
                h('td', { class: 'num' }, String(v.moves)),
                h('td', { class: 'mono dim' }, v.conversation_id || ''),
                h('td', { class: 'mono dim' }, v.ip || '')
              )
            )
          )
        : h('p', { class: 'empty' }, 'No visits')
    );
    return;
  }
  view.replaceChildren(
    sessions.length
      ? table(
          [['Started'], ['Student'], ['Coach'], ['Length'], ['Events', 'num'], ['Errors', 'num'], ['Note saved']],
          sessions.map((s) =>
            row(
              `session?id=${s.conversation_id}`,
              h('td', { class: 'when' }, fmtTime(s.started_at)),
              h('td', {}, s.data.player || '—'),
              h('td', { class: 'dim' }, s.data.coach || ''),
              h('td', { class: 'when' }, s.ended_at ? fmtLength(s.started_at, s.ended_at) : [h('span', { class: 'live-dot' }), 'live']),
              h('td', { class: 'num' }, String(s.events)),
              h('td', { class: s.errors ? 'num bad' : 'num dim' }, String(s.errors)),
              h('td', { class: 'dim' }, s.data.note_saved ? clip(s.data.note, 90) : '')
            )
          )
        )
      : h('p', { class: 'empty' }, 'No sessions')
  );
}

// The conversation as it happened: speech, what the board told the coach, and the coach's tool calls.
function transcriptLines(events) {
  const lines = [];
  let last = '';
  for (const e of events) {
    const d = e.data || {};
    const p = d.properties || {};
    if (e.kind === 'tavus.received' && d.event_type === 'conversation.utterance' && p.speech) {
      // Tavus sends each coach utterance under two role names; keep one.
      const sig = `${p.role === 'user'}:${p.speech}`;
      if (sig === last) continue;
      last = sig;
      // Board messages are echoed back as "user" speech; they are already listed as Board lines.
      if (p.role === 'user' && p.speech.startsWith('[board]')) continue;
      lines.push({ ts: e.ts, cls: p.role === 'user' ? 'student' : 'coach', who: p.role === 'user' ? 'Student' : 'Coach', text: p.speech });
    } else if (e.kind === 'tavus.received' && d.event_type === 'conversation.tool_call') {
      lines.push({ ts: e.ts, cls: 'tool', who: 'Tool', text: `${p.name}(${typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {})})` });
    } else if (e.kind === 'tavus.sent' && d.event_type === 'conversation.tool_result') {
      lines.push({ ts: e.ts, cls: 'tool', who: 'Result', text: String(p.output ?? ''), clamp: true });
    } else if (e.kind === 'tavus.sent' && (d.event_type === 'conversation.respond' || d.event_type === 'conversation.append_llm_context')) {
      lines.push({ ts: e.ts, cls: 'board', who: 'Board', text: (p.text || p.context || '').replace(/^\[board\]\s*/, ''), clamp: true });
    }
  }
  return lines;
}

// "back-rank mate: solved, 1 wrong" per puzzle, then the reviewed game.
function boardSummary(summary) {
  if (!summary) return null;
  const parts = (summary.puzzles || []).map((p) => {
    const bits = [p.solved ? 'solved' : p.gaveUp ? 'gave up' : 'unsolved'];
    if (p.wrong?.length) bits.push(`${p.wrong.length} wrong (${p.wrong.join(', ')})`);
    if (p.hints) bits.push(`${p.hints} hint${p.hints > 1 ? 's' : ''}`);
    return `${p.theme}: ${bits.join(', ')}`;
  });
  for (const g of summary.games || []) parts.push(`Game vs coach at ${g.rating} as ${g.color === 'w' ? 'White' : 'Black'}: ${g.result}, ${g.moves} moves${g.mistakes?.length ? ` (${g.mistakes.join(', ')})` : ''}`);
  if (summary.review) parts.push(`Review of ${summary.review.game}: ${summary.review.tries?.length || 0} tries`);
  return parts.join('\n');
}

// The same conversation from Tavus's own transcript (delivered by webhook after
// the call). It has no timestamps, but it does not depend on the browser
// having reported every event.
const BOARD_TEXT = /^(\[board\]|Game, move \d|New game against|The game against|At key moment|Game review loaded|New puzzle loaded|A game against you)/;
function officialLines(transcript) {
  const lines = [];
  for (const m of Array.isArray(transcript) ? transcript : []) {
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant') {
      if (text) lines.push({ cls: 'coach', who: 'Coach', text });
      for (const c of m.tool_calls || []) {
        if (!String(c.id).endsWith('_result')) lines.push({ cls: 'tool', who: 'Tool', text: `${c.function?.name}(${c.function?.arguments || ''})` });
      }
    } else if (m.role === 'tool') {
      if (!text.startsWith('dispatched, awaiting result')) lines.push({ cls: 'tool', who: 'Result', text, clamp: true });
    } else if (m.role === 'user' && text) {
      lines.push(BOARD_TEXT.test(text) ? { cls: 'board', who: 'Board', text, clamp: true } : { cls: 'student', who: 'Student', text });
    }
  }
  return lines;
}

// Long text shows three lines; a click opens it.
const clamped = (tag, text) => h(tag, { class: 'clamp', onclick: (e) => e.currentTarget.classList.toggle('open') }, text);

const GROUPS = [
  ['All', () => true],
  ['Conversation', (e) => (e.kind === 'tavus.received' || e.kind === 'tavus.sent') && !/streaming$/.test(e.data?.event_type || '')],
  ['Board', (e) => /^(puzzle|review|play)\./.test(e.kind)],
  ['Call', (e) => e.kind.startsWith('call.')],
  ['Tavus API', (e) => e.kind.startsWith('tavus.api')],
  ['Webhooks', (e) => e.kind.startsWith('tavus.webhook')],
  ['HTTP', (e) => e.kind.startsWith('http')],
  ['Errors', isError],
];

async function showSession(id, refresh) {
  const { session: s, refreshError } = await get(`/api/admin/session?id=${encodeURIComponent(id)}${refresh ? '&refresh=1' : ''}`);
  const d = s.data || {};
  const tavus = d.tavus || {};
  const lines = transcriptLines(s.events);
  const list = h('div', { class: 'in-session' });
  const filters = h('div', { class: 'filters' });
  const paint = (name) => {
    list.replaceChildren(...s.events.filter(GROUPS.find((g) => g[0] === name)[1]).map((e) => eventRow(e, fmtClock)));
    filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === name)));
  };
  for (const [name, test] of GROUPS) {
    const n = s.events.filter(test).length;
    if (n || name === 'All') filters.append(h('button', { class: 'quiet small', 'data-group': name, onclick: () => paint(name) }, name, h('span', { class: 'n' }, String(n))));
  }

  const fact = (label, value) => {
    if (value === undefined || value === null || value === '') return [];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [h('dt', {}, label), text.length > 140 ? clamped('dd', text) : h('dd', {}, text)];
  };
  const json = (label, value, open) =>
    value ? h('details', open ? { open: '' } : {}, h('summary', {}, label), h('pre', {}, typeof value === 'string' ? value : JSON.stringify(value, null, 2))) : null;
  const official = d.transcript || tavus.transcript || (tavus.events || []).find((e) => /transcription_ready/.test(e.event_type || ''))?.properties?.transcript;
  // Two sources for the transcript: what the browser reported, and Tavus's own.
  const fromTavus = officialLines(official);
  const spoken = (list) => list.filter((l) => l.cls === 'coach' || l.cls === 'student').length;
  const transcript = h('div', {});
  const sources = h('div', { class: 'filters' });
  const showLines = (which) => {
    const list = which === 'Tavus' ? fromTavus : lines;
    transcript.replaceChildren(
      ...(list.length
        ? list.map((l) => h('div', { class: `line from-${l.cls}` }, h('time', {}, l.ts ? fmtClock(l.ts) : ''), h('span', { class: 'who' }, l.who), l.clamp ? clamped('p', l.text) : h('p', {}, l.text)))
        : [h('p', { class: 'empty' }, 'Empty')])
    );
    sources.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.source === which)));
  };
  if (fromTavus.length) {
    for (const [name, list] of [['Browser', lines], ['Tavus', fromTavus]]) {
      sources.append(h('button', { class: 'quiet small', 'data-source': name, onclick: () => showLines(name) }, name, h('span', { class: 'n' }, String(list.length))));
    }
  }
  const perception = d.perception_analysis || (tavus.events || []).find((e) => /perception_analysis/.test(e.event_type || ''))?.properties;

  view.replaceChildren(
    h(
      'div',
      { class: 'crumb' },
      h('a', { href: '#sessions' }, 'Sessions /'),
      h('h1', {}, d.player || 'Unnamed'),
      h('span', { class: 'meta' }, `${fmtTime(s.started_at)} · ${s.ended_at ? fmtLength(s.started_at, s.ended_at) : 'live'}`)
    ),
    h(
      'div',
      { class: 'session' },
      h(
        'div',
        {},
        h(
          'section',
          {},
          h('h2', {}, 'Transcript'),
          sources,
          transcript
        ),
        h('section', {}, h('h2', {}, 'Timeline'), filters, list)
      ),
      h(
        'aside',
        { class: 'side' },
        h(
          'dl',
          { class: 'facts' },
          ...fact('Conversation', s.conversation_id),
          ...fact('Coach', d.coach),
          ...fact('PAL', d.pal_id),
          ...fact('Memory tag', d.participant_tag),
          ...fact('Returning', d.returning === undefined ? null : d.returning ? 'yes' : 'no'),
          ...fact('Greeting', d.greeting),
          ...fact('Context sent', d.context),
          ...fact('Memory notes sent', d.notes_sent?.length ? d.notes_sent.join(' ') : null),
          ...fact('Board summary', boardSummary(d.summary)),
          ...fact('Profile sent', d.profile_sent || null),
          ...fact('Note saved', d.note_saved ? d.note : null),
          ...fact('Note pinned', d.note_saved ? (d.note_pinned ? 'all coaches' : `not everywhere: ${(d.memory_sync || []).filter((m) => !m.ok).map((m) => `${m.pal_id} ${m.detail || ''}`).join('; ') || 'unknown'}`) : null),
          ...fact('Tavus status', tavus.status),
          ...fact('Shutdown', d.shutdown),
          ...fact('Client', d.client_id),
          ...fact('IP', d.ip)
        ),
        h('button', { class: 'quiet small refresh', onclick: () => showSession(id, true).catch(fail) }, d.tavus_fetched_at ? `Refresh from Tavus · ${fmtTime(d.tavus_fetched_at)}` : 'Fetch from Tavus'),
        refreshError ? h('p', { class: 'error' }, refreshError) : null,
        json('Tavus transcript', official),
        json('Perception analysis', perception),
        json('Tavus record', d.tavus)
      )
    )
  );
  paint('All');
  // Start on whichever source caught more of what was said.
  showLines(spoken(fromTavus) > spoken(lines) ? 'Tavus' : 'Browser');
}

async function showEvents(params) {
  const state = { kind: params.get('kind') || '', q: params.get('q') || '', client: params.get('client') || '', before: 0 };
  const list = h('div', {});
  const more = h('button', { class: 'quiet small more', onclick: () => load(false).catch(fail) }, 'Older');
  const kind = h('input', { placeholder: 'Kind prefix, e.g. tavus.api', value: state.kind, 'aria-label': 'Kind prefix' });
  const q = h('input', { placeholder: 'Search', value: state.q, 'aria-label': 'Search' });
  async function load(reset) {
    if (reset) state.before = 0;
    const query = new URLSearchParams({ limit: '200' });
    for (const k of ['kind', 'q', 'client']) if (state[k]) query.set(k, state[k]);
    if (state.before) query.set('before', String(state.before));
    const { events } = await get(`/api/admin/events?${query}`);
    if (reset) list.replaceChildren();
    // Reads of this dashboard are recorded too; they only show when asked for by kind.
    list.append(...events.filter((e) => state.kind || e.kind !== 'http.admin').map((e) => eventRow(e)));
    if (events.length) state.before = events[events.length - 1].id;
    more.hidden = events.length < 200;
    if (reset && !events.length) list.append(h('p', { class: 'empty' }, 'No events'));
  }
  const form = h(
    'form',
    {
      class: 'filters',
      onsubmit: (ev) => {
        ev.preventDefault();
        state.kind = kind.value.trim();
        state.q = q.value.trim();
        load(true).catch(fail);
      },
    },
    kind,
    q,
    h('button', { class: 'quiet small' }, 'Filter')
  );
  view.replaceChildren(
    ...(state.client ? [h('div', { class: 'crumb' }, h('a', { href: '#visits' }, 'Visits /'), h('h1', { class: 'mono' }, state.client))] : []),
    form,
    list,
    more
  );
  await load(true);
}

// ---------------------------------------------------------------- routing
function fail(e) {
  if (token) view.replaceChildren(h('p', { class: 'error' }, e.message));
  else $('loginError').textContent = e.message;
}

function go(route) {
  location.hash = route;
}

async function route() {
  if (!token) return;
  const [name, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  $('login').hidden = true;
  view.hidden = false;
  $('nav').hidden = false;
  $('signOut').hidden = false;
  const active = name === 'session' ? 'sessions' : name || 'sessions';
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === active));
  try {
    if (name === 'session') await showSession(params.get('id'));
    else if (name === 'events') await showEvents(params);
    else await showOverview(name === 'visits' ? 'visits' : 'sessions');
  } catch (e) {
    fail(e);
  }
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  $('token').value = '';
  $('loginError').textContent = '';
  try { sessionStorage.setItem('coach-rook-admin', token); } catch {}
  route();
});
$('signOut').addEventListener('click', signOut);
window.addEventListener('hashchange', route);
route();
