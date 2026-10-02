// The audit trail: what gets recorded, what is kept out, and who may read it.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, startFakeTavus } = require('./helpers');

const CODE = 'open-sesame';
const KEY = 'abcde-fghjk-mnpqr-stuvw';
const ADMIN = 'admin-token-for-tests';
const CLIENT = '0b0e7a52-1111-4222-8333-444455556666';

test('audit log end to end', async (t) => {
  const tavus = await startFakeTavus();
  const app = await startServer({ TAVUS_API_KEY: 'test-key', TAVUS_API_BASE: tavus.base, ACCESS_CODE: CODE, ADMIN_TOKEN: ADMIN, PUBLIC_URL: 'https://coach.example' });
  t.after(() => Promise.all([app.stop(), tavus.stop()]));
  await app.get('/api/config');
  const admin = (path, token = ADMIN) => app.get(path, { Authorization: `Bearer ${token}` });
  const events = async (query = '') => (await (await admin(`/api/admin/events?${query}`)).json()).events;

  await t.test('the dashboard needs the admin token', async () => {
    assert.equal((await app.get('/api/admin/overview')).status, 401);
    assert.equal((await admin('/api/admin/overview', 'wrong')).status, 401);
    assert.equal((await admin('/api/admin/overview', CODE)).status, 401, 'the access code is not an admin token');
    assert.equal((await admin('/api/admin/overview')).status, 200);
    assert.equal((await app.get('/admin')).status, 200, 'the page itself is public; the data is not');
  });

  let conversationId;
  await t.test('a session is recorded with its context, and Tavus is given a callback URL', async () => {
    const res = await app.post('/api/session', { player: 'Sam', key: KEY, code: CODE }, { 'X-Client-Id': CLIENT });
    conversationId = (await res.json()).conversation_id;
    const sent = tavus.db.conversations[0].request;
    assert.match(sent.callback_url, /^https:\/\/coach\.example\/api\/tavus\/webhook\/[0-9a-f]{32}$/);

    const { sessions } = await (await admin('/api/admin/overview')).json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].conversation_id, conversationId);
    assert.equal(sessions[0].data.player, 'Sam');
    assert.equal(sessions[0].data.client_id, CLIENT);
    assert.match(sessions[0].data.context, /The student's name is Sam/);
    assert.equal(sessions[0].ended_at, null);
  });

  await t.test('every request and every Tavus call is logged, with secrets removed', async () => {
    const http = (await events('kind=http')).find((e) => e.data.path === '/api/session');
    assert.equal(http.data.status, 200);
    assert.equal(http.data.request.player, 'Sam');
    assert.equal(http.data.request.code, '[redacted]');
    assert.equal(http.data.request.key, '[redacted]');
    assert.equal(http.client_id, CLIENT);
    assert.equal(http.conversation_id, conversationId);

    const call = (await events('kind=tavus.api')).find((e) => e.data.method === 'POST' && e.data.path === '/conversations');
    assert.equal(call.conversation_id, conversationId);
    assert.equal(call.data.request.conversation_name, 'Chess coaching with Sam');
    assert.equal(call.data.response.conversation_id, conversationId);
    assert.equal(typeof call.data.ms, 'number');

    const everything = JSON.stringify(await events('limit=1000'));
    for (const secret of [CODE, KEY, KEY.replace(/-/g, ''), 'test-key', ADMIN]) assert.ok(!everything.includes(secret), `"${secret}" must not appear in the log`);
  });

  await t.test('rejected requests are logged too', async () => {
    await app.post('/api/session', { player: 'Mallory', key: KEY, code: 'guess' });
    const denied = (await events('kind=http.error')).find((e) => e.data.request?.player === 'Mallory');
    assert.equal(denied.data.status, 401);
    assert.equal(denied.data.error, 'Wrong access code.');
  });

  await t.test('the browser reports board and conversation events', async () => {
    const res = await app.post('/api/events', {
      client: CLIENT,
      events: [
        { t: Date.now(), kind: 'puzzle.move', conversation_id: conversationId, data: { id: 'back-rank', san: 'Rd8#', correct: true } },
        { t: Date.now(), kind: 'tavus.received', conversation_id: conversationId, data: { event_type: 'conversation.utterance', properties: { role: 'replica', speech: 'Nice, that is a back-rank mate.' } } },
        { t: Date.now(), kind: 'tavus.sent', conversation_id: conversationId, data: { event_type: 'conversation.respond', properties: { text: '[board] Sam played Rd8#.' } } },
        { kind: 42 },
        'junk',
      ],
    });
    assert.equal(res.status, 200);
    const mine = await events(`client=${CLIENT}&kind=puzzle`);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].source, 'client');
    assert.equal(mine[0].data.san, 'Rd8#');
    assert.equal((await events('q=Nice,%20that%20is%20a')).length, 1, 'events are searchable by content');
    assert.equal((await app.post('/api/events', { client: 'x', events: [] })).status, 400);
    assert.equal((await app.post('/api/events', { client: CLIENT, events: 'nope' })).status, 400);
  });

  await t.test('Tavus callbacks are accepted only with the token, and the transcript is kept with the session', async () => {
    const token = tavus.db.conversations[0].request.callback_url.split('/').pop();
    const transcript = [{ role: 'assistant', content: 'Nice, that is a back-rank mate.' }, { role: 'user', content: 'Thanks!' }];
    const payload = { conversation_id: conversationId, event_type: 'application.transcription_ready', properties: { transcript } };
    assert.equal((await app.post('/api/tavus/webhook/not-the-token', payload)).status, 404);
    assert.equal((await app.post(`/api/tavus/webhook/${token}`, payload)).status, 200);
    assert.equal((await app.post(`/api/tavus/webhook/${token}`, { conversation_id: conversationId, event_type: 'system.shutdown', properties: { shutdown_reason: 'participant_left_timeout' } })).status, 200);

    const { session } = await (await admin(`/api/admin/session?id=${conversationId}`)).json();
    assert.deepEqual(session.data.transcript, transcript);
    assert.equal(session.data.shutdown.shutdown_reason, 'participant_left_timeout');
    assert.ok(session.ended_at);
    const kinds = session.events.map((e) => e.kind);
    for (const kind of ['http', 'tavus.api', 'puzzle.move', 'tavus.received', 'tavus.sent', 'tavus.webhook:application.transcription_ready', 'tavus.webhook:system.shutdown']) {
      assert.ok(kinds.includes(kind), `session timeline includes ${kind}`);
    }
  });

  await t.test('ending the session records the board summary and the note', async () => {
    await app.post('/api/session/end', {
      conversation_id: conversationId,
      player: 'Sam',
      key: KEY,
      code: CODE,
      summary: { puzzles: [{ theme: 'back-rank mate', wrong: [], hints: 0, solved: true, gaveUp: false }], review: null },
    });
    const { session } = await (await admin(`/api/admin/session?id=${conversationId}`)).json();
    assert.equal(session.data.note_saved, true);
    assert.match(session.data.note, /solved first try: back-rank mate/);
    assert.equal(session.data.summary.puzzles[0].theme, 'back-rank mate');
    // What the coach's memory held when the call began, and what every coach's holds now.
    assert.deepEqual(session.data.memory_before, { pinned: [], learned: null, sessions: 0 });
    assert.deepEqual(Object.keys(session.data.memory_after).sort(), ['anna', 'darius', 'helen', 'victor']);
    assert.match(session.data.memory_after.anna.pinned[0].text, /solved first try: back-rank mate/);
  });

  await t.test('visits group everything one page load did', async () => {
    const { visits, stats } = await (await admin('/api/admin/overview')).json();
    const visit = visits.find((v) => v.client_id === CLIENT);
    assert.equal(visit.moves, 1);
    assert.equal(visit.conversation_id, conversationId);
    assert.ok(stats.events > 10);
  });
});

test('without ADMIN_TOKEN the admin API does not exist', async (t) => {
  const app = await startServer();
  t.after(() => app.stop());
  assert.equal((await app.get('/api/admin/overview', { Authorization: 'Bearer anything' })).status, 404);
  // Events are still accepted and requests still work.
  assert.equal((await app.post('/api/events', { client: crypto.randomUUID(), events: [{ kind: 'visit', data: {} }] })).status, 200);
});
