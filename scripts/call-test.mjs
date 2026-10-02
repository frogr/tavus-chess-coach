// Drives a real call and checks that the coach does what it is asked.
//
// Opens the app in headless Chrome, starts a session, and stands in for the
// student: it plays moves on the board and sends four requests as typed lines
// (the ?typed hook delivers them to the coach as speech would arrive). After
// each request it checks the app itself changed, which only happens if the
// coach called the right tool.
//
//   ACCESS_CODE=… node scripts/call-test.mjs [coach name] [base url]
//   ACCESS_CODE=… node scripts/call-test.mjs Helen http://localhost:3000
//
// Uses real Tavus minutes: about two per run. Exits 1 if any request failed.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const COACH = process.argv[2] || 'Anna';
const BASE = (process.argv[3] || 'http://localhost:3000').replace(/\/$/, '');
const CODE = process.env.ACCESS_CODE || '';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(14, 19), ...a);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), `coach-rook-call-test-${PORT}`)}`,
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
let exitCode = 1;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  if (!target) throw new Error('Chrome did not start. Set CHROME_PATH.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const bodies = { puzzle: [], play: [] };
  const watch = new Map();
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = async (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || {}); pending.delete(d.id); return; }
    if (d.method === 'Network.responseReceived') {
      if (d.params.response.url.endsWith('/api/puzzle')) watch.set(d.params.requestId, 'puzzle');
      if (d.params.response.url.endsWith('/api/play')) watch.set(d.params.requestId, 'play');
    } else if (d.method === 'Network.loadingFinished' && watch.has(d.params.requestId)) {
      const r = await send('Network.getResponseBody', { requestId: d.params.requestId });
      try { bodies[watch.get(d.params.requestId)].push(JSON.parse(r.body)); } catch {}
    }
  };
  const js = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(300); } return false; };
  async function click(selector) {
    const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) throw new Error(`nothing matches ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r[0], y: r[1] });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r[0], y: r[1], button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r[0], y: r[1], button: 'left', clickCount: 1 });
    await sleep(350);
  }
  const move = async (uci) => { await click(`.sq[data-sq="${uci.slice(0, 2)}"]`); await click(`.sq[data-sq="${uci.slice(2, 4)}"]`); };
  // Waits until the coach has spoken and then been silent for 1.6 s. Captions
  // arrive ahead of the voice, so this listens to the sound itself.
  async function coachFinishes(max = 40000) {
    const t0 = await js('performance.now()');
    const start = Date.now();
    let spoke = false;
    while (Date.now() - start < max) {
      await sleep(250);
      const [now, lastLoud] = JSON.parse(await js('JSON.stringify([performance.now(), window.__lastLoud || 0])'));
      if (lastLoud > t0) spoke = true;
      if (spoke && now - lastLoud > 1600) break;
      if (!spoke && Date.now() - start > 15000) break;
    }
    log(`${COACH}:`, await js(`document.getElementById('caption').textContent`));
  }
  const say = async (text) => { log('student:', text); await js(`studentSays(${JSON.stringify(text)})`); };

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: `${BASE}/?nomedia&typed` });
  await sleep(3000);
  await js(`[...document.querySelectorAll('.coach')].find((b) => b.textContent.includes(${JSON.stringify(COACH)}))?.click()`);
  await js(`(() => { document.getElementById('player').value = 'Call test'; const c = document.getElementById('code'); c.value = ${JSON.stringify(CODE)}; c.dispatchEvent(new Event('change')); })()`);
  await click('#start');
  if (!(await waitFor(`document.getElementById('stage').dataset.state === 'live'`, 50000))) throw new Error('The call did not connect: ' + (await js(`document.getElementById('lobbyError').textContent`)));
  await waitFor(`Boolean(document.getElementById('coachAudio').srcObject)`, 20000);
  await js(`(() => { const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 2048;
    ctx.createMediaStreamSource(document.getElementById('coachAudio').srcObject).connect(an); ctx.resume();
    const buf = new Float32Array(2048); window.__lastLoud = 0;
    setInterval(() => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; if (Math.sqrt(s / buf.length) > 0.008) window.__lastLoud = performance.now(); }, 40); })()`);
  await coachFinishes();

  const results = {};
  await say("Let's play a game. You at strength 1000, I'll take White.");
  results['starts a game when asked'] = await waitFor(`document.body.dataset.mode === 'play' && document.querySelectorAll('.piece').length === 32`, 25000);
  await coachFinishes();
  if (results['starts a game when asked']) {
    const g = new Chess();
    for (let n = 0; n < 4; n++) {
      const legal = g.moves({ verbose: true });
      const want = ['e2e4', 'g1f3', 'f1c4'][n];
      const m = legal.find((x) => x.lan === want) || legal[0];
      const before = bodies.play.length;
      g.move(m.san);
      await move(m.lan);
      const end = Date.now() + 15000;
      while (bodies.play.length === before && Date.now() < end) await sleep(200);
      const reply = bodies.play.at(-1)?.reply;
      if (bodies.play.length > before && reply) g.move({ from: reply.uci.slice(0, 2), to: reply.uci.slice(2, 4), promotion: reply.uci[4] || 'q' });
      await sleep(1200);
    }
    await coachFinishes();
  }
  await say('Can we review the game we just played?');
  results['opens the review when asked'] = await waitFor(`document.body.dataset.mode === 'review' && !document.getElementById('reviewResult').hidden`, 40000);
  await coachFinishes();
  await say('Show me the first key moment.');
  results['goes to a key moment when asked'] = await waitFor(`document.querySelectorAll('#board svg.arrows path').length > 0 || document.querySelectorAll('#moments .chip').length === 0`, 25000);
  await coachFinishes();
  await say("Let's go back to puzzles.");
  results['returns to puzzles when asked'] = await waitFor(`document.body.dataset.mode === 'puzzle'`, 25000);
  await coachFinishes();
  await click('#stop');
  await sleep(2500);

  console.log('');
  for (const [name, ok] of Object.entries(results)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${COACH} ${name}`);
  exitCode = Object.values(results).every(Boolean) ? 0 : 1;
} catch (e) {
  console.error(e.message);
} finally {
  chrome.kill();
}
process.exit(exitCode);
