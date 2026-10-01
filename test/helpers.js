// Starts the real server as a child process on a free port, and (optionally) a
// fake Tavus API for it to talk to. NODE_ENV=test keeps the child from reading
// a developer's .env, so tests can never reach the real Tavus account.
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-rook-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      SAMPLE_WARMUP: '0',
      TAVUS_CONFIG_PATH: path.join(dir, 'tavus.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (!output.includes('running at')) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    port,
    child,
    output: () => output,
    get: (p, headers) => fetch(base + p, { headers }),
    post: (p, body, headers = {}) =>
      fetch(base + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
      }),
  };
}

// A stand-in for tavusapi.com/v2 that records every request. `state` starts
// with whatever PALs/tools the test wants to exist already.
async function startFakeTavus(state = {}) {
  const db = { pals: [], tools: [], stores: [], conversations: [], requests: [], failPalPatch: false, ...state };
  let seq = 0;
  const id = (prefix) => `${prefix}${(++seq).toString(16).padStart(8, '0')}`;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      db.requests.push({ method: req.method, path: url.pathname, query: url.search, body, key: req.headers['x-api-key'] });
      const reply = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const route = `${req.method} ${url.pathname.replace(/^\/v2/, '')}`;
      let m;
      if (route === 'GET /tools') {
        const name = url.searchParams.get('name_or_uuid');
        return reply(200, { data: db.tools.filter((t) => t.name === name) });
      }
      if (route === 'POST /tools') {
        const tool = { ...body, tool_id: id('t') };
        db.tools.push(tool);
        return reply(200, tool);
      }
      if ((m = route.match(/^PATCH \/tools\/(\w+)$/))) return reply(200, {});
      if (route === 'GET /pals') return reply(200, { data: db.pals, total_count: db.pals.length });
      if (route === 'POST /pals') {
        // Like the real API: punctuation is stripped from the stored name.
        const pal = { pal_id: id('p'), pal_name: body.pal_name.replace(/[()]/g, ''), created_at: new Date().toISOString(), tools: [] };
        db.pals.push(pal);
        return reply(200, pal);
      }
      if ((m = route.match(/^PATCH \/pals\/(\w+)$/))) {
        if (db.failPalPatch) return reply(500, { message: 'temporary failure' });
        const pal = db.pals.find((p) => p.pal_id === m[1]);
        if (!pal) return reply(404, { message: 'not found' });
        // Like the real API: a patch that changes nothing is a bodyless 304.
        if (pal.lastPatch === raw) {
          res.writeHead(304);
          return res.end();
        }
        pal.lastPatch = raw;
        return reply(200, {});
      }
      if ((m = route.match(/^GET \/pals\/(\w+)\/tools$/))) return reply(200, { data: [] });
      if ((m = route.match(/^POST \/pals\/(\w+)\/tools$/))) return reply(200, {});
      if (route === 'GET /memory-stores') {
        const hits = db.stores.filter(
          (s) => s.pal_id === url.searchParams.get('pal_id') && s.participant_tag === url.searchParams.get('participant_tag')
        );
        return reply(200, { data: hits });
      }
      if (route === 'POST /memory-stores') {
        const store = { memory_store_id: id('m'), ...body, pinned_memories: [] };
        db.stores.push(store);
        return reply(200, store);
      }
      if ((m = route.match(/^GET \/memory-stores\/(\w+)(\/pinned)?$/))) {
        const store = db.stores.find((s) => s.memory_store_id === m[1]);
        return store ? reply(200, { ...store, learned: null }) : reply(404, {});
      }
      if ((m = route.match(/^POST \/memory-stores\/(\w+)\/pinned$/))) {
        const store = db.stores.find((s) => s.memory_store_id === m[1]);
        store.pinned_memories.push({ memory_id: id('n'), memory: body.memory, created_at: new Date().toISOString() });
        return reply(200, {});
      }
      if (route === 'POST /conversations') {
        const convo = { conversation_id: id('c'), conversation_url: 'https://tavus.daily.co/fake', request: body, ended: false };
        db.conversations.push(convo);
        return reply(200, convo);
      }
      if ((m = route.match(/^GET \/conversations\/(\w+)$/))) {
        const convo = db.conversations.find((c) => c.conversation_id === m[1]);
        return convo ? reply(200, { conversation_id: convo.conversation_id, status: convo.ended ? 'ended' : 'active' }) : reply(404, {});
      }
      if ((m = route.match(/^POST \/conversations\/(\w+)\/end$/))) {
        const convo = db.conversations.find((c) => c.conversation_id === m[1]);
        if (convo) convo.ended = true;
        return reply(200, {});
      }
      reply(404, { message: `fake Tavus has no route for ${route}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    db,
    base: `http://127.0.0.1:${server.address().port}/v2`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startServer, startFakeTavus };
