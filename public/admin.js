// Audit dashboard. Everything shown here came from the audit log; all of it is
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
    throw new Error(res.status === 404 ? 'The admin dashboard is not enabled on this server (set ADMIN_TOKEN).' : 'Wrong admin token.');
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
}

// ---------------------------------------------------------------- formatting
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtClock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
  if (e.kind === 'review.try') return `${d.san} at moment ${d.moment} · ${d.ok ? 'accepted' : 'rejected'}`;
  return clip(d, 140);
}

const isError = (e) => e.kind.includes('error') || Number(e.data?.status) >= 500;

function eventRow(e) {
  return h(
    'details',
    { class: `event${isError(e) ? ' err' : ''}` },
    h('summary', {}, h('time', {}, fmtTime(e.ts)), h('span', { class: 'src' }, e.source), h('span', { class: 'kind' }, e.kind), h('span', { class: 'gist' }, gist(e))),
    h('pre', {}, JSON.stringify({ id: e.id, client_id: e.client_id, conversation_id: e.conversation_id, ip: e.ip, data: e.data }, null, 2))
  );
}

// ---------------------------------------------------------------- views
async function showOverview(which) {
  const { stats, sessions, visits } = await get('/api/admin/overview');
  $('storeInfo').textContent = `${stats.events} events · stored in ${stats.store} · kept ${stats.retention_days} days`;
  if (which === 'visits') {
    view.replaceChildren(
      h('h1', {}, 'Visits'),
      h('p', { class: 'lede' }, 'Every page load, with or without a coach session: puzzles played, games reviewed, moves made.'),
      visits.length
        ? h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...['Last seen', 'First seen', 'Events', 'Moves', 'Coach session', 'Network'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, t)))),
            h(
              'tbody',
              {},
              visits.map((v) =>
                h(
                  'tr',
                  { class: 'link', onclick: () => go(`events?client=${v.client_id}`) },
                  h('td', {}, fmtTime(v.last)),
                  h('td', {}, fmtTime(v.first)),
                  h('td', { class: 'num' }, String(v.events)),
                  h('td', { class: 'num' }, String(v.moves)),
                  h('td', { class: 'mono' }, v.conversation_id || ''),
                  h('td', { class: 'mono' }, v.ip || '')
                )
              )
            )
          )
        : h('p', { class: 'empty' }, 'No visits recorded yet.')
    );
    return;
  }
  view.replaceChildren(
    h('h1', {}, 'Coach sessions'),
    h('p', { class: 'lede' }, 'Each video conversation with the coach. Open one for its transcript, tool calls, board events and every API call behind it.'),
    sessions.length
      ? h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...['Started', 'Student', 'Length', 'Status', 'Events', 'Errors', 'Memory note'].map((t, i) => h('th', { class: i === 4 || i === 5 ? 'num' : '' }, t)))),
          h(
            'tbody',
            {},
            sessions.map((s) =>
              h(
                'tr',
                { class: 'link', onclick: () => go(`session?id=${s.conversation_id}`) },
                h('td', {}, fmtTime(s.started_at)),
                h('td', {}, s.data.player || h('span', { class: 'muted' }, 'no name'), s.data.returning ? h('span', { class: 'pill' }, 'returning') : null),
                h('td', {}, fmtLength(s.started_at, s.ended_at)),
                h('td', {}, s.ended_at ? h('span', { class: 'pill' }, 'ended') : h('span', { class: 'pill live' }, 'open')),
                h('td', { class: 'num' }, String(s.events)),
                h('td', { class: 'num' }, s.errors ? h('span', { class: 'pill bad' }, String(s.errors)) : '0'),
                h('td', {}, s.data.note_saved ? clip(s.data.note, 70) : h('span', { class: 'muted' }, s.ended_at ? 'none' : ''))
              )
            )
          )
        )
      : h('p', { class: 'empty' }, 'No coach sessions recorded yet.')
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
      lines.push({ ts: e.ts, cls: 'tool', who: 'Tool call', text: `${p.name}(${typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {})})` });
    } else if (e.kind === 'tavus.sent' && d.event_type === 'conversation.tool_result') {
      lines.push({ ts: e.ts, cls: 'tool', who: 'Tool result', text: String(p.output ?? '') });
    } else if (e.kind === 'tavus.sent' && (d.event_type === 'conversation.respond' || d.event_type === 'conversation.append_llm_context')) {
      lines.push({ ts: e.ts, cls: 'board', who: d.event_type === 'conversation.respond' ? 'Board' : 'Board (context)', text: p.text || p.context || '' });
    }
  }
  return lines;
}

const GROUPS = [
  ['All', () => true],
  ['Conversation', (e) => (e.kind === 'tavus.received' || e.kind === 'tavus.sent') && !/streaming$/.test(e.data?.event_type || '')],
  ['Board', (e) => /^(puzzle|review)\./.test(e.kind)],
  ['Call', (e) => e.kind.startsWith('call.')],
  ['Tavus API', (e) => e.kind.startsWith('tavus.api')],
  ['Webhooks', (e) => e.kind.startsWith('tavus.webhook')],
  ['Our API', (e) => e.kind.startsWith('http')],
  ['Errors', isError],
];

async function showSession(id, refresh) {
  const { session: s, refreshError } = await get(`/api/admin/session?id=${encodeURIComponent(id)}${refresh ? '&refresh=1' : ''}`);
  const d = s.data || {};
  const tavus = d.tavus || {};
  const lines = transcriptLines(s.events);
  const list = h('div', { class: 'events' });
  const filters = h('div', { class: 'filters' });
  const paint = (name) => {
    const test = GROUPS.find((g) => g[0] === name)[1];
    list.replaceChildren(...s.events.filter(test).map(eventRow));
    filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent.startsWith(name))));
  };
  for (const [name, test] of GROUPS) filters.append(h('button', { class: 'quiet small', onclick: () => paint(name) }, `${name} ${s.events.filter(test).length}`));

  const fact = (label, value) => (value === undefined || value === null || value === '' ? [] : [h('dt', {}, label), h('dd', {}, typeof value === 'string' ? value : JSON.stringify(value))]);
  const official = d.transcript || tavus.transcript || (tavus.events || []).find((e) => /transcription_ready/.test(e.event_type || ''))?.properties?.transcript;
  const perception = d.perception_analysis || (tavus.events || []).find((e) => /perception_analysis/.test(e.event_type || ''))?.properties;

  view.replaceChildren(
    ...[
    h('button', { class: 'quiet small back', onclick: () => go('sessions') }, '← All sessions'),
    h('h1', {}, d.player ? `${d.player}'s session` : 'Session without a name'),
    h('p', { class: 'lede' }, `${fmtTime(s.started_at)}${s.ended_at ? ` · ${fmtLength(s.started_at, s.ended_at)}` : ' · still open'} · ${s.events.length} events`),
    refreshError ? h('p', { class: 'error' }, `Couldn't refresh from Tavus: ${refreshError}`) : null,
    h(
      'dl',
      { class: 'facts' },
      ...fact('Conversation', s.conversation_id),
      ...fact('PAL', d.pal_id),
      ...fact('Memory tag', d.participant_tag),
      ...fact('Returning student', d.returning === undefined ? null : d.returning ? 'yes' : 'no'),
      ...fact('Greeting', d.greeting),
      ...fact('Context sent to the coach', d.context),
      ...fact('Notes sent from memory', d.notes_sent?.length ? d.notes_sent.join(' ') : null),
      ...fact('Board summary at the end', d.summary),
      ...fact('Note saved to memory', d.note_saved ? d.note : d.ended_at || s.ended_at ? 'none' : null),
      ...fact('Tavus status', tavus.status),
      ...fact('Shutdown', d.shutdown),
      ...fact('Browser visit', d.client_id),
      ...fact('Network', d.ip)
    ),
    h('h2', {}, 'What was said and done'),
    lines.length
      ? h('div', { class: 'transcript' }, lines.map((l) => h('div', { class: `line from-${l.cls}` }, h('time', {}, fmtClock(l.ts)), h('span', { class: 'who' }, l.who), h('p', {}, l.text))))
      : h('p', { class: 'muted' }, 'Nothing was reported from the browser for this session.'),
    h('h2', {}, "Tavus's own record"),
    h('p', { class: 'muted small' }, d.tavus_fetched_at ? `Fetched ${fmtTime(d.tavus_fetched_at)}. The transcript and perception analysis arrive a little after a call ends.` : 'Not fetched yet.'),
    h('div', { class: 'filters' }, h('button', { class: 'quiet small', onclick: () => showSession(id, true).catch(fail) }, 'Fetch again from Tavus')),
    official ? h('details', { open: '' }, h('summary', {}, 'Transcript from Tavus'), h('pre', { class: 'json' }, JSON.stringify(official, null, 2))) : null,
    perception ? h('details', {}, h('summary', {}, 'Perception analysis'), h('pre', { class: 'json' }, typeof perception === 'string' ? perception : JSON.stringify(perception, null, 2))) : null,
    d.tavus ? h('details', {}, h('summary', {}, 'Full conversation record'), h('pre', { class: 'json' }, JSON.stringify(d.tavus, null, 2))) : null,
    h('h2', {}, 'Timeline'),
    filters,
    list,
    ].filter(Boolean)
  );
  paint('All');
}

async function showEvents(params) {
  const state = { kind: params.get('kind') || '', q: params.get('q') || '', client: params.get('client') || '', before: 0 };
  const list = h('div', { class: 'events' });
  const more = h('button', { class: 'quiet small', onclick: () => load(false) }, 'Load older');
  const kind = h('input', { placeholder: 'Kind starts with (http, tavus.api, puzzle…)', value: state.kind });
  const q = h('input', { placeholder: 'Search inside events', value: state.q });
  async function load(reset) {
    if (reset) state.before = 0;
    const query = new URLSearchParams({ limit: '200' });
    for (const k of ['kind', 'q', 'client']) if (state[k]) query.set(k, state[k]);
    if (state.before) query.set('before', String(state.before));
    const { events } = await get(`/api/admin/events?${query}`);
    if (reset) list.replaceChildren();
    list.append(...events.map(eventRow));
    if (events.length) state.before = events[events.length - 1].id;
    more.hidden = events.length < 200;
    if (reset && !events.length) list.append(h('p', { class: 'empty' }, 'No events match.'));
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
    h('h1', {}, state.client ? 'One visit' : 'All events'),
    h('p', { class: 'lede' }, state.client ? `Everything from browser visit ${state.client}, newest first.` : 'Every recorded event, newest first: API requests, calls to Tavus, webhooks, board and call events.'),
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
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
window.addEventListener('hashchange', route);
route();
