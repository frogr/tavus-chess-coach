// Minimal Tavus REST client. The API key only ever lives on the server.
// TAVUS_API_BASE exists so the tests can point this at a local fake.
// Every call, with its request and response, goes to the audit log.
const audit = require('./audit');
const BASE = process.env.TAVUS_API_BASE || 'https://tavusapi.com/v2';
const TIMEOUT_MS = 15000;

function logCall(method, path, body, started, outcome) {
  const id = (path.match(/^\/conversations\/([a-z0-9]+)/i) || [])[1] || outcome.response?.conversation_id || null;
  audit.record({
    kind: outcome.error || outcome.status >= 400 ? 'tavus.api.error' : 'tavus.api',
    conversation_id: typeof id === 'string' ? id : null,
    data: { method, path, request: body || undefined, ms: Date.now() - started, ...outcome },
  });
}

async function tavus(method, path, body) {
  const key = process.env.TAVUS_API_KEY;
  if (!key) throw new Error('TAVUS_API_KEY is not set');
  const started = Date.now();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Tavus ${method} ${path} failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    err.tavus = true;
    logCall(method, path, body, started, { error: err.message });
    throw err;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  logCall(method, path, body, started, { status: res.status, response: data });
  // Tavus answers a PATCH that changes nothing with 304 Not Modified: that is a success.
  if (!res.ok && res.status !== 304) {
    const err = new Error(`Tavus ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.data = data;
    err.tavus = true;
    throw err;
  }
  return data;
}

module.exports = { tavus };
