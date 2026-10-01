// Minimal Tavus REST client. The API key only ever lives on the server.
const BASE = 'https://tavusapi.com/v2';

async function tavus(method, path, body) {
  const key = process.env.TAVUS_API_KEY;
  if (!key) throw new Error('TAVUS_API_KEY is not set');
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
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
    throw err;
  }
  return data;
}

module.exports = { tavus };
