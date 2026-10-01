// Minimal Tavus REST client. The API key only ever lives on the server.
// TAVUS_API_BASE exists so the tests can point this at a local fake.
const BASE = process.env.TAVUS_API_BASE || 'https://tavusapi.com/v2';
const TIMEOUT_MS = 15000;

async function tavus(method, path, body) {
  const key = process.env.TAVUS_API_KEY;
  if (!key) throw new Error('TAVUS_API_KEY is not set');
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
    throw err;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Tavus ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.data = data;
    err.tavus = true;
    throw err;
  }
  return data;
}

module.exports = { tavus };
