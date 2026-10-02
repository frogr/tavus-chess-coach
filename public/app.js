// Coach Rook frontend.
// The board is the source of truth. The PAL is told about every board event
// over the Tavus interaction protocol, and it acts on the board through tool
// calls (app-message delivery) that this file handles.
// chess.js and the Daily SDK are served by our own server from the installed
// npm packages (see VENDOR in server/index.js), so nothing loads from a CDN.
import { Chess } from '/vendor/chess.js';
import { Board } from '/board.js';
import * as sounds from '/sounds.js';

const $ = (id) => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');
// ?nomedia joins a call without asking for the microphone or camera (watch-only; used for testing).
const NO_MEDIA = new URLSearchParams(location.search).has('nomedia');
const JOIN_TIMEOUT_MS = 45000;

const state = {
  puzzles: [],
  index: 0,
  chess: null,
  ply: 0, // index into the puzzle's solution line
  solved: false,
  selected: null,
  lastMove: null,
  highlights: [],
  arrows: [],
  busy: false, // true while the opponent reply / solution animation runs
  sanLog: [],
  call: null,
  conversationId: null,
  player: '',
  mode: 'puzzle', // 'puzzle' | 'review'
  orientation: 'w', // which side is at the bottom
  review: null, // result of /api/review
  reviewPly: 0, // half-moves shown on the board in review mode
  moment: null, // key moment being worked on (1-based), or null
  trying: false, // student may move pieces to try a better move
  // What actually happened on the board this session. Written to the
  // student's Tavus memory store when the session ends.
  sessionLog: null,
};

function newSessionLog() {
  return { puzzles: {}, review: null };
}
function puzzleLog() {
  if (!state.sessionLog || state.mode !== 'puzzle') return null;
  const p = puzzle();
  return (state.sessionLog.puzzles[p.id] ||= { theme: p.theme, wrong: [], hints: 0, solved: false, gaveUp: false });
}

const puzzle = () => state.puzzle;

// How the current puzzle is going. Kept for every puzzle (the session log
// above only exists during a call) so the next one can be pitched right.
function tally(update) {
  for (const t of [puzzleLog(), state.current]) if (t) update(t);
}

// Puzzles already seen on this device are not served again.
const SEEN_KEY = 'coach-rook-seen';
function seenPuzzles() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; }
}
function markSeen(id) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenPuzzles().filter((x) => x !== id), id].slice(-500))); } catch {}
}
function storedLevel() {
  try { return Math.max(1, Math.min(3, Number(localStorage.getItem('coach-rook-level')) || 1)); } catch { return 1; }
}

// Difficulty follows the student: two clean solves in a row moves up a level,
// giving up or two wrong tries moves down.
function adaptLevel() {
  const c = state.current;
  if (!c) return;
  if (c.gaveUp || c.wrong.length >= 2) {
    state.level = Math.max(1, state.level - 1);
    state.streak = 0;
  } else if (c.solved && !c.wrong.length && !c.hints) {
    state.streak = (state.streak || 0) + 1;
    if (state.streak >= 2) {
      state.level = Math.min(3, state.level + 1);
      state.streak = 0;
    }
  } else state.streak = 0;
}

// Every time the board is pointed at a new position (puzzle, review ply, key
// moment) the generation changes. Animations and delayed take-backs remember
// the generation they started in and stop if it has moved on, so switching
// puzzles mid-animation can never play stale moves or leave the board locked.
let generation = 0;
function newPosition() {
  state.busy = false;
  state.snap = true; // next render places pieces without sliding them across the board
  return ++generation;
}

// ---------------------------------------------------------------- API helpers
async function api(path, body) {
  const headers = { 'X-Client-Id': CLIENT_ID };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------------------------------------------------------- audit trail
// Everything that happens here (moves, puzzle loads, tool calls, every message
// to and from the coach, call lifecycle) is reported to the server's audit
// log, so a session can be replayed later when the coach misbehaves.
const CLIENT_ID = crypto.randomUUID(); // one per page load
const auditQueue = [];
let auditTimer = null;

function audit(kind, data) {
  auditQueue.push({ t: Date.now(), kind, conversation_id: state.conversationId || undefined, data });
  if (auditQueue.length >= 40) flushAudit();
  else auditTimer ||= setTimeout(flushAudit, 1500);
}

function flushAudit(beacon = false) {
  clearTimeout(auditTimer);
  auditTimer = null;
  if (!auditQueue.length) return;
  const body = JSON.stringify({ client: CLIENT_ID, events: auditQueue.splice(0) });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
  else fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

// ---------------------------------------------------------------- notebook key
// A random secret generated in this browser. The server derives the student's
// memory store from name + key, so someone else typing the same name gets a
// different (empty) notebook. To use a notebook on another device, the
// student copies the key across.
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/o, 1/l/i)
const normalizeKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const validKey = (k) => k.length >= 16 && k.length <= 64;
const formatKey = (k) => k.match(/.{1,5}/g).join('-');
let memoryKey = null;

function notebookKey() {
  if (memoryKey) return memoryKey;
  try {
    const stored = normalizeKey(localStorage.getItem('coach-rook-key'));
    if (validKey(stored)) return (memoryKey = stored);
  } catch {}
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  memoryKey = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  try { localStorage.setItem('coach-rook-key', memoryKey); } catch {}
  return memoryKey;
}

function useNotebookKey(text) {
  const k = normalizeKey(text);
  if (!validKey(k)) return false;
  memoryKey = k;
  try { localStorage.setItem('coach-rook-key', k); } catch {}
  return true;
}

// ---------------------------------------------------------------- feed log
function log(kind, cls, text, detail) {
  audit(`feed:${kind}`, { text, detail });
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<span class="kind"></span><span class="text"></span>`;
  li.querySelector('.kind').textContent = kind;
  li.querySelector('.text').textContent = text;
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    li.appendChild(pre);
  }
  $('log').prepend(li);
}

// ---------------------------------------------------------------- board render
const canMove = () => !state.busy && (state.mode === 'review' ? state.trying : !state.solved);
const board = new Board($('board'), {
  canMove,
  onMove: (from, to, promotion) => (state.mode === 'review' ? reviewTry(from, to, promotion || 'q') : playerMove(from, to, promotion || 'q')),
});
let shownArrows = '';

// Push the app state onto the board. Pieces slide when the position changes by
// a move, and snap when a different position is loaded.
function render() {
  board.setOrientation(state.orientation);
  board.setPosition(state.chess.fen(), { lastMove: state.lastMove, animate: !state.snap });
  state.snap = false;
  board.setHighlights(state.highlights);
  const arrows = JSON.stringify(state.arrows);
  board.setArrows(state.arrows.map(([from, to]) => ({ from, to })), arrows !== shownArrows);
  shownArrows = arrows;
  board.setBadge(state.badge?.square, state.badge?.cls);
  board.refresh();
  $('moves').textContent = state.mode === 'puzzle' ? state.sanLog.join(' ') : '';
}

// The sound a move makes, from its notation.
function moveSound(san) {
  if (san.includes('#')) return sounds.play('end');
  if (san.includes('+')) return sounds.play('check');
  if (san.includes('=')) return sounds.play('promote');
  if (san.startsWith('O-O')) return sounds.play('castle');
  sounds.play(san.includes('x') ? 'capture' : 'move');
}

function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${cls}`;
}

// ---------------------------------------------------------------- puzzle flow
function solutionSan(p) {
  const c = new Chess(p.fen);
  return p.line.map((uci) => c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }).san);
}

function sideName(color) {
  return color === 'w' ? 'White' : 'Black';
}

// request.which: "next" (new pattern, difficulty follows the student), "easier",
// "harder", "theme" (with request.theme), or "retry" (the same puzzle again).
// Returns the context for the coach, or { error } when the request can't be met.
async function loadPuzzle(request = { which: 'next' }, { announce = true } = {}) {
  let note = '';
  if (request.which !== 'retry' || !state.puzzle) {
    if (request.which === 'next') adaptLevel();
    const res = await api('/api/puzzle', { which: request.which, theme: request.theme, level: state.level, lastTheme: state.puzzle?.theme, seen: seenPuzzles() });
    if (res.error) return { error: res.error };
    note = res.note || '';
    state.puzzle = res.puzzle;
    state.level = res.puzzle.level;
    state.count = (state.count || 0) + 1;
    state.current = { wrong: [], hints: 0, solved: false, gaveUp: false };
    markSeen(res.puzzle.id);
    try { localStorage.setItem('coach-rook-level', String(state.level)); } catch {}
  }
  setMode('puzzle');
  newPosition();
  const p = puzzle();
  state.chess = new Chess(p.fen);
  state.orientation = state.chess.turn(); // the student's side at the bottom
  state.ply = 0;
  state.solved = false;
  state.selected = null;
  state.lastMove = null;
  state.highlights = [];
  state.arrows = [];
  state.sanLog = [];
  state.badge = null;
  audit('puzzle.load', { id: p.id, theme: p.theme, level: p.level, rating: p.rating, fen: p.fen, which: request.which });
  // The theme stays hidden until it's solved: naming it would give the answer away.
  $('pTitle').textContent = `${sideName(state.chess.turn())} to move`;
  $('pLevel').textContent = `Puzzle ${state.count} · difficulty ${'●'.repeat(p.level)}${'○'.repeat(3 - p.level)}`;
  setStatus('Find the best move');
  render();
  const context = (note ? note + ' ' : '') + (await puzzleContext(p));
  // When the student changes the puzzle themselves, let the coach react to it.
  if (announce && state.conversationId) sendRespond(context + ' The student loaded this themselves. Introduce it in one sentence.');
  return context;
}

// What the PAL needs to know about a freshly loaded puzzle. The solution is
// included (marked secret) so it can give graded hints without guessing.
async function puzzleContext(p) {
  // If the description can't be fetched the puzzle still loads; the coach
  // just gets the solution and idea without the piece list.
  const { text } = await api('/api/describe', { fen: p.fen }).catch(() => ({ text: '(piece list unavailable)' }));
  return (
    `[board] New puzzle loaded: difficulty ${p.level} of 3 (rated ${p.rating}). ` +
    `Position: ${text} The student plays ${sideName(new Chess(p.fen).turn())}, and the goal is to find the winning move. ` +
    `FOR THE COACH ONLY, do not reveal unless the student gives up: the solution is ${solutionSan(p).join(' ')}. ` +
    `Theme: ${p.theme}. Idea: ${p.idea}`
  );
}

async function playerMove(from, to, promotion = 'q') {
  const p = puzzle();
  const fenBefore = state.chess.fen();
  const move = state.chess.move({ from, to, promotion });
  state.lastMove = move;
  state.highlights = [];
  state.arrows = [];
  const expected = p.line[state.ply];
  const correct = move.lan === expected || state.chess.isCheckmate();
  const who = state.player || 'The student';
  const moveWords = describeMoveWords(move, state.chess);
  audit('puzzle.move', { id: p.id, fen: fenBefore, san: move.san, uci: move.lan, expected, correct });
  moveSound(move.san);

  if (!correct) {
    render();
    setStatus(`${move.san} isn't it. Try again.`, 'bad');
    tally((t) => t.wrong.push(move.san));
    board.flash(to);
    setTimeout(() => sounds.play('mistake'), 220);
    // Take the move back on a fixed timer, independent of the engine call, so
    // a slow server never leaves the board locked.
    state.busy = true;
    const gen = generation;
    setTimeout(() => {
      if (gen !== generation) return;
      state.chess.undo();
      state.lastMove = null;
      state.busy = false;
      render();
    }, 900);
    // Ask the engine what the move actually allows, so the coach's feedback is grounded.
    let facts = '';
    try {
      const a = await api('/api/analyze', { fen: fenBefore, candidate: move.lan });
      facts = ` Engine facts: ${a.text}`;
    } catch {}
    sendRespond(
      `[board] ${who} played ${move.san} (${moveWords}). That is NOT the solution, so the board took it back and it is ${who}'s turn again.${facts} ` +
        `React briefly and encouragingly, say what the move allowed in plain words, and nudge without giving the answer away.`
    );
    return;
  }

  state.sanLog.push(move.san);
  state.ply += 1;
  render();

  if (state.chess.isCheckmate() || state.ply >= p.line.length) {
    state.solved = true;
    tally((t) => (t.solved = true));
    setStatus(`Solved · ${p.theme}`, 'good');
    audit('puzzle.solved', { id: p.id, theme: p.theme, wrong: state.current?.wrong, hints: state.current?.hints });
    setTimeout(() => sounds.play('great'), 260);
    sendRespond(
      `[board] ${who} played ${move.san} (${moveWords}). Correct, and that SOLVES the puzzle (theme: ${p.theme}). ` +
        `Celebrate specifically, name the pattern so it sticks, then offer the next puzzle.`
    );
    return;
  }

  // Correct but not finished: play the opponent's reply from the solution line.
  setStatus('Good move…', 'good');
  state.busy = true;
  board.refresh();
  const gen = generation;
  await sleep(650);
  if (gen !== generation) return;
  const replyUci = p.line[state.ply];
  const reply = state.chess.move({ from: replyUci.slice(0, 2), to: replyUci.slice(2, 4), promotion: replyUci[4] || 'q' });
  state.ply += 1;
  state.sanLog.push(reply.san);
  state.lastMove = reply;
  state.busy = false;
  moveSound(reply.san);
  setStatus(`${sideName(state.chess.turn())} to move: finish it`, '');
  render();
  sendRespond(
    `[board] ${who} played ${move.san} (${moveWords}). Correct! The opponent replied ${reply.san} (${describeMoveWords(reply, state.chess)}). ` +
      `The puzzle is not finished: it's ${who}'s move again. Encourage them to find the follow-up without saying it.`
  );
}

const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
function describeMoveWords(m, chessAfter) {
  let t = `${NAMES[m.piece]} from ${m.from} to ${m.to}`;
  if (m.captured) t += `, capturing the ${NAMES[m.captured]}`;
  if (chessAfter.isCheckmate()) t += ', checkmate';
  else if (chessAfter.inCheck()) t += ', with check';
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playSolution() {
  const p = puzzle();
  tally((t) => !t.solved && (t.gaveUp = true));
  const gen = newPosition();
  state.busy = true;
  state.selected = null;
  state.chess = new Chess(p.fen);
  state.sanLog = [];
  state.highlights = [];
  state.arrows = [];
  render();
  for (const uci of p.line) {
    await sleep(800);
    if (gen !== generation) return 'The student moved on to something else before the solution finished playing.';
    const m = state.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    state.sanLog.push(m.san);
    state.lastMove = m;
    moveSound(m.san);
    render();
  }
  state.ply = p.line.length;
  state.solved = true;
  state.busy = false;
  board.refresh();
  audit('puzzle.solution_shown', { id: p.id });
  setStatus('Solution shown', '');
  return `The board is now animating the full solution: ${state.sanLog.join(' ')}. Idea: ${p.idea} Walk the student through why it works in one or two sentences, then offer the next puzzle.`;
}

// ---------------------------------------------------------------- game review
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
}

function moveLabel(m) {
  return `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${m.san}${m.symbol || ''}`;
}

function evalText(cp) {
  if (Math.abs(cp) >= 9000) {
    const n = Math.round((10000 - Math.abs(cp)) / 10);
    return n === 0 ? 'checkmate' : `${cp > 0 ? '+' : '-'}M${n}`;
  }
  return `${cp > 0 ? '+' : ''}${(cp / 100).toFixed(1)}`;
}

async function loadReview(pgn, side) {
  setMode('review');
  $('reviewGo').disabled = true;
  $('reviewGo').textContent = 'Analyzing…';
  $('pTitle').textContent = 'Analyzing your game…';
  $('pLevel').textContent = 'Game review';
  setStatus('Stockfish is checking every move (up to ~30s on the free server)', '');
  try {
    const review = await api('/api/review', { pgn, side, player: state.player || $('player').value.trim() });
    state.review = review;
    state.orientation = side === 'b' ? 'b' : 'w';
    const h = review.headers;
    $('pTitle').textContent = `${h.White} vs ${h.Black}`;
    $('pLevel').textContent = `Game review · ${h.Result}${h.Event ? ' · ' + h.Event : ''}`;
    renderReviewPanel();
    gotoPly(0);
    log('review', 'in', `Analyzed ${review.moves.length} half-moves, ${review.keyMoments.length} key moments`);
    audit('review.load', { pgn, side, headers: h, keyMoments: review.keyMoments, moves: review.moves.map((m) => `${m.san}${m.symbol}`) });
    if (state.sessionLog) {
      state.sessionLog.review = {
        game: `${h.White} vs ${h.Black}`,
        mistakes: review.keyMoments.map((k) => {
          const m = review.moves[k.ply - 1];
          return `${moveLabel(m)} (${m.class}, engine wanted ${m.bestSan})`;
        }),
        tries: [],
      };
    }
    if (state.conversationId) {
      sendRespond(review.context + ' The student just loaded this game. In one or two sentences, give your overall impression and offer to start with the first key moment.');
    }
  } catch (e) {
    setStatus(e.message, 'bad');
    log('error', 'err', e.message);
  } finally {
    $('reviewGo').disabled = false;
    $('reviewGo').textContent = 'Analyze game';
  }
}

function renderReviewPanel() {
  const r = state.review;
  const list = $('gameMoves');
  list.innerHTML = '';
  const keyPlies = new Set(r.keyMoments.map((k) => k.ply));
  r.moves.forEach((m) => {
    const b = document.createElement('button');
    b.className = `mv ${m.class || ''} ${keyPlies.has(m.ply) ? 'key' : ''}`;
    b.textContent = m.color === 'w' ? `${m.moveNumber}. ${m.san}${m.symbol}` : `${m.san}${m.symbol}`;
    b.dataset.ply = m.ply;
    b.addEventListener('click', () => gotoPly(m.ply));
    list.appendChild(b);
  });
  const chips = $('moments');
  chips.innerHTML = '';
  if (!r.keyMoments.length) chips.innerHTML = '<span class="muted small">No real mistakes found for your side. Nice game.</span>';
  r.keyMoments.forEach((k) => {
    const m = r.moves[k.ply - 1];
    const b = document.createElement('button');
    b.className = `chip ${m.class}`;
    b.textContent = `${k.index}. ${moveLabel(m)}`;
    b.title = k.text;
    b.addEventListener('click', () => {
      const text = gotoMoment(k.index);
      if (state.conversationId) sendRespond(`[board] The student opened key moment ${k.index} themselves. ${text}`);
    });
    chips.appendChild(b);
  });
  $('reviewResult').hidden = false;
}

function gotoPly(ply) {
  const r = state.review;
  if (!r) return;
  ply = Math.max(0, Math.min(r.moves.length, ply));
  const step = ply - state.reviewPly;
  const wasBrowsing = !state.moment;
  newPosition();
  // Stepping one move forward or back slides the piece and plays its sound.
  if (wasBrowsing && Math.abs(step) === 1) {
    state.snap = false;
    moveSound(r.moves[step === 1 ? ply - 1 : ply].san);
  }
  state.reviewPly = ply;
  state.moment = null;
  state.trying = false;
  state.selected = null;
  state.highlights = [];
  state.arrows = [];
  const m = r.moves[ply - 1];
  state.chess = new Chess(m ? m.fenAfter : r.startFen);
  state.lastMove = m ? { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4) } : null;
  state.badge = m && m.class ? { square: m.uci.slice(2, 4), cls: m.class } : null;
  if (m) {
    const cls = m.class ? ` · ${m.class}` : '';
    setStatus(`${moveLabel(m)} · eval ${evalText(m.evalAfter)}${cls}`, m.class === 'blunder' || m.class === 'mistake' ? 'bad' : '');
    if (m.class && m.bestSan) {
      state.arrows = [[m.best.slice(0, 2), m.best.slice(2, 4)]];
    }
  } else {
    setStatus('Start of game', '');
  }
  document.querySelectorAll('.mv').forEach((b) => b.classList.toggle('cur', Number(b.dataset.ply) === ply));
  document.querySelector('.mv.cur')?.scrollIntoView({ block: 'nearest' });
  render();
}

// Put the board just BEFORE the key move and let the student look for better.
function gotoMoment(n) {
  const r = state.review;
  if (!r) return 'No game is loaded for review.';
  const k = r.keyMoments[Math.max(0, Math.min(r.keyMoments.length - 1, n - 1))];
  if (!k) return 'This game has no key moments for the student.';
  const m = r.moves[k.ply - 1];
  const prev = r.moves[k.ply - 2];
  newPosition();
  state.reviewPly = k.ply - 1;
  state.moment = k.index;
  state.trying = true;
  state.selected = null;
  state.highlights = [];
  state.arrows = [];
  state.badge = null;
  audit('review.moment', { moment: k.index, ply: k.ply, played: m.san });
  state.chess = new Chess(m.fenBefore);
  state.lastMove = prev ? { from: prev.uci.slice(0, 2), to: prev.uci.slice(2, 4) } : null;
  setStatus(`Moment ${k.index}: you played ${m.san}. Find something better.`, '');
  document.querySelectorAll('.mv').forEach((b) => b.classList.toggle('cur', Number(b.dataset.ply) === k.ply - 1));
  render();
  return (
    `Board now shows key moment ${k.index}, the position BEFORE the student's move ${moveLabel(m)}. ` +
    `${k.text} The student can now move pieces to try a better move. Ask what they were thinking, then let them look; ` +
    `don't say the engine's move unless they give up.`
  );
}

async function reviewTry(from, to, promotion = 'q') {
  const fen = state.chess.fen();
  const move = state.chess.move({ from, to, promotion });
  state.lastMove = move;
  state.busy = true;
  state.badge = null;
  const gen = generation;
  moveSound(move.san);
  render();
  setStatus('Checking with the engine…', '');
  const who = state.player || 'The student';
  const takeBack = () => {
    if (gen !== generation) return;
    state.chess.undo();
    state.lastMove = null;
    state.busy = false;
    render();
  };
  let j;
  try {
    j = await api('/api/judge', { fen, move: move.lan });
  } catch (e) {
    if (gen !== generation) return;
    takeBack();
    setStatus(e.message, 'bad');
    return;
  }
  if (gen !== generation) return; // the student navigated away while the engine was thinking
  state.sessionLog?.review?.tries.push({ moment: state.moment, move: j.san, ok: j.ok });
  audit('review.try', { moment: state.moment, fen, san: j.san, ok: j.ok, best: j.bestSan, lossPct: j.lossPct });
  sounds.play(j.ok ? 'great' : 'mistake');
  if (!j.ok) board.flash(to);
  if (j.ok) {
    state.trying = false;
    state.busy = false;
    setStatus(`${j.san} works`, 'good');
    render();
    sendRespond(
      `[board] At key moment ${state.moment}, ${who} tried ${j.san} (${j.words}). The engine approves: evaluation after it is ${j.evalAfter}` +
        `${j.san === j.bestSan ? ", and it is the engine's top choice" : `, about as good as the engine's top choice ${j.bestSan}`}. ` +
        `Praise what they found, explain the idea in a sentence, and offer the next key moment.`
    );
  } else {
    setStatus(`${j.san} isn't better. Try again.`, 'bad');
    setTimeout(takeBack, 900); // the board stays locked until the move is taken back
    sendRespond(
      `[board] At key moment ${state.moment}, ${who} tried ${j.san} (${j.words}). Not good enough: evaluation after it is ${j.evalAfter}, ` +
        `while the best move keeps ${j.evalBest}. The board took it back. Engine's best (secret unless they give up): ${j.bestSan}, line ${j.bestLine.join(' ')}. ` +
        `Say briefly what their try allows and nudge them toward the idea.`
    );
  }
}

// Plays a line from `fen` on the board. Returns the moves that were shown, and
// leaves the board locked: the caller decides what position to return to.
async function animateLine(fen, sans) {
  const gen = newPosition();
  state.busy = true;
  state.trying = false;
  state.selected = null;
  state.highlights = [];
  state.arrows = [];
  state.badge = null;
  state.chess = new Chess(fen);
  render();
  const played = [];
  for (const san of sans) {
    await sleep(850);
    if (gen !== generation) break;
    try {
      const m = state.chess.move(san);
      played.push(m.san);
      state.lastMove = m;
      moveSound(m.san);
      render();
    } catch {
      break;
    }
  }
  return played;
}

async function showEngineLine() {
  const r = state.review;
  if (!r) return 'No game is loaded for review. The student can paste one in the "Review a game" tab.';
  const k = state.moment ? r.keyMoments[state.moment - 1] : null;
  const m = k ? r.moves[k.ply - 1] : r.moves[state.reviewPly];
  if (!m || !m.bestLine.length) return 'There is no engine line to show here.';
  const line = m.bestLine.slice(0, 5);
  const ply = state.reviewPly;
  setStatus(`Engine line: ${line.join(' ')}`, '');
  const played = await animateLine(m.fenBefore, line);
  // Leave the line on the board for a beat, then return to where we were.
  const gen = generation;
  setTimeout(() => {
    if (gen !== generation) return;
    if (k) gotoMoment(k.index);
    else gotoPly(ply);
  }, 4000);
  return `The board animated the engine's line instead of ${m.san}: ${played.join(' ')}. It returns to the position in a few seconds. Explain the key idea of the line in one or two sentences.`;
}

// Puzzle mode: show the engine's line from the position on the board, then put
// the position back exactly as it was.
async function showPuzzleEngineLine() {
  const a = await api('/api/analyze', { fen: state.chess.fen() });
  const line = a.best ? a.best.san.slice(0, 4) : [];
  if (!line.length) return 'There is no engine line to show here: the position on the board is already finished.';
  tally((t) => !t.solved && (t.gaveUp = true)); // the engine's line from here is the answer
  const before = { chess: state.chess, lastMove: state.lastMove };
  setStatus(`Engine line: ${line.join(' ')}`, '');
  const played = await animateLine(before.chess.fen(), line);
  const gen = generation;
  setTimeout(() => {
    if (gen !== generation) return;
    state.chess = before.chess;
    state.lastMove = before.lastMove;
    state.busy = false;
    state.snap = true;
    setStatus(state.solved ? `Solved · ${puzzle().theme}` : 'Find the best move', state.solved ? 'good' : '');
    render();
  }, 4000);
  return `The board animated the engine's line from the current position: ${played.join(' ')}. It returns to the position in a few seconds. Explain the key idea of the line in one or two sentences.`;
}

// ---------------------------------------------------------------- tool calls
// Each handler runs a PAL tool call against the real board / engine and returns
// the string Tavus feeds back to the LLM (conversation.tool_result).
const TOOL_HANDLERS = {
  async chess_analyze_position(args) {
    const a = await api('/api/analyze', { fen: state.chess.fen(), candidate: args.candidate_move });
    return a.text;
  },

  async chess_show_on_board(args) {
    if (state.mode === 'puzzle') tally((t) => !t.solved && (t.hints += 1));
    const squares = (args.squares || []).filter((s) => /^[a-h][1-8]$/.test(s));
    const arrows = (args.arrows || [])
      .map((a) => String(a).toLowerCase().match(/([a-h][1-8]).*?([a-h][1-8])/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]);
    state.highlights = squares;
    state.arrows = arrows;
    sounds.play('click');
    render();
    const pieces = squares.map((s) => {
      const pc = state.chess.get(s);
      return pc ? `${s} (${sideName(pc.color)} ${NAMES[pc.type]})` : `${s} (empty)`;
    });
    return `Now showing on the board: ${pieces.length ? 'highlighted ' + pieces.join(', ') : 'no highlights'}${arrows.length ? '; arrows ' + arrows.map((a) => a.join('→')).join(', ') : ''}.`;
  },

  async chess_load_puzzle(args) {
    const which = ['next', 'retry', 'easier', 'harder', 'theme'].includes(args.which) ? args.which : 'next';
    const context = await loadPuzzle({ which, theme: args.theme }, { announce: false });
    if (context.error) return context.error;
    return `${context} Introduce the puzzle in one sentence and ask the student what they notice.`;
  },

  async chess_play_solution() {
    if (state.mode === 'review') return showEngineLine();
    return playSolution();
  },

  async chess_goto_moment(args) {
    if (state.mode !== 'review' || !state.review) return 'No game is loaded for review. The student can paste one in the "Review a game" tab.';
    return gotoMoment(Number(args.moment) || 1);
  },

  async chess_show_engine_line() {
    if (state.mode === 'review') return showEngineLine();
    return showPuzzleEngineLine();
  },
};

async function handleToolCall(props) {
  const { name, tool_call_id } = props;
  let args = {};
  try {
    args = typeof props.arguments === 'string' ? JSON.parse(props.arguments || '{}') : props.arguments || {};
  } catch {}
  log(`tool_call → ${name}`, 'in', '', args);
  const handler = TOOL_HANDLERS[name];
  let output;
  let status = 'success';
  try {
    if (!handler) throw new Error(`Unknown tool ${name}`);
    output = await handler(args);
  } catch (e) {
    status = 'error';
    output = `Tool failed: ${e.message}`;
  }
  log(`tool_result ← ${name}`, status === 'success' ? 'out' : 'err', '', output);
  sendProtocol('conversation.tool_result', { tool_call_id, output, status });
}

// ---------------------------------------------------------------- protocol
function sendProtocol(event_type, properties) {
  const msg = { message_type: 'conversation', event_type, conversation_id: state.conversationId, properties };
  audit('tavus.sent', msg);
  if (state.call && state.conversationId) state.call.sendAppMessage(msg, '*');
  return msg;
}

// Board events the PAL should react to out loud.
function sendRespond(text) {
  log('board → conversation.respond', 'out', text);
  sendProtocol('conversation.respond', { text });
}

// Silent background facts (e.g. a puzzle the student loaded themselves).
function sendContext(context) {
  log('board → conversation.append_llm_context', 'out', context);
  sendProtocol('conversation.append_llm_context', { context });
}

function onAppMessage(ev) {
  const msg = ev.data || ev;
  // Every interaction event goes to the audit log, including the ones the UI
  // ignores. The once-a-second "still here" heartbeats are the one exception.
  if (!/^system\.(replica|pal)_present$/.test(msg?.event_type || '')) audit('tavus.received', msg);
  if (!msg || msg.message_type !== 'conversation') return;
  const p = msg.properties || {};
  // Tavus sends each coach utterance twice (role "replica" and role "pal"); show it once.
  if (msg.event_type === 'conversation.utterance') {
    const sig = `${p.role === 'user' ? 'user' : 'coach'}:${p.speech}`;
    if (sig === state.lastUtterance) return;
    state.lastUtterance = sig;
  }
  switch (msg.event_type) {
    case 'conversation.tool_call':
      handleToolCall(p);
      break;
    case 'conversation.utterance': {
      const role = p.role === 'user' ? 'You' : 'Coach Rook';
      // Board messages come back as "user" speech; they are not something the student said.
      if (p.speech && !(p.role === 'user' && p.speech.startsWith('[board]'))) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${role}: `;
        $('caption').replaceChildren(who, document.createTextNode(p.speech));
        log(`utterance (${p.role === 'user' ? 'student' : 'coach'})`, 'say', p.speech);
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- session
// The call runs on a Daily call object, not Daily's prebuilt UI: we render the
// coach's video ourselves, so the panel shows the coach and nothing else.
const setStage = (name) => {
  $('stage').dataset.state = name;
  $('callBar').hidden = name !== 'live';
};

function attach(el, track) {
  el.srcObject = new MediaStream([track]);
  el.play?.().catch(() => {});
}

function onTrackStarted(ev) {
  if (!ev.participant || !ev.track) return;
  audit('call.track_started', { kind: ev.track.kind, local: ev.participant.local });
  if (ev.participant.local) {
    if (ev.track.kind === 'video') {
      attach($('selfVideo'), ev.track);
      $('selfVideo').classList.remove('off');
    }
    return;
  }
  // The coach is the only remote participant.
  if (ev.track.kind === 'video') attach($('coachVideo'), ev.track);
  if (ev.track.kind === 'audio') attach($('coachAudio'), ev.track);
}

function onTrackStopped(ev) {
  if (ev.participant?.local && ev.track?.kind === 'video') $('selfVideo').classList.add('off');
}

function syncCallButtons() {
  const call = state.call;
  if (!call) return;
  const mic = call.localAudio();
  const cam = call.localVideo();
  $('micBtn').setAttribute('aria-pressed', String(mic));
  $('micBtn').setAttribute('aria-label', mic ? 'Mute microphone' : 'Unmute microphone');
  $('camBtn').setAttribute('aria-pressed', String(cam));
  $('camBtn').setAttribute('aria-label', cam ? 'Turn camera off' : 'Turn camera on');
}

async function startSession() {
  state.player = $('player').value.trim();
  try { localStorage.setItem('coach-rook-player', state.player); } catch {}
  $('lobbyError').textContent = '';
  $('caption').textContent = '';
  $('stageNote').textContent = '';
  setStage('connecting');
  let created = null; // conversation to end again if the video never connects
  const attempt = (state.attempt = (state.attempt || 0) + 1); // lets Cancel abandon this start
  const cancelled = () => state.attempt !== attempt;
  try {
    if (!window.Daily) throw new Error('The video library did not load. Reload the page and try again.');
    const { conversation_id, conversation_url, returning } = await api('/api/session', { player: state.player, key: notebookKey(), code: $('code').value.trim() });
    created = conversation_id;
    if (cancelled()) throw new Error('Cancelled.');
    state.conversationId = conversation_id;
    state.sessionLog = newSessionLog();
    log('session', 'in', `Conversation ${conversation_id} created${returning ? ' (returning student: last session notes sent to the coach)' : ''}`);
    const call = (state.call = window.Daily.createCallObject());
    call.on('app-message', onAppMessage);
    call.on('track-started', onTrackStarted);
    call.on('track-stopped', onTrackStopped);
    call.on('left-meeting', endSession);
    call.on('error', (ev) => log('video error', 'err', ev?.errorMsg || 'Video call error'));
    call.on('camera-error', (ev) => {
      audit('call.camera_error', { message: ev?.errorMsg?.errorMsg || ev?.error?.msg || String(ev?.errorMsg || '') });
      $('stageNote').textContent = "Coach Rook can't hear you: allow the microphone for this site, then start again.";
    });
    call.on('participant-updated', (ev) => ev.participant?.local && syncCallButtons());
    call.on('network-quality-change', (ev) => audit('call.network', { threshold: ev?.threshold, quality: ev?.quality }));
    let briefed = false;
    call.on('participant-joined', async (ev) => {
      // The PAL joins as a remote participant. Brief it on the board once.
      if (briefed || ev.participant.local) return;
      briefed = true;
      audit('call.coach_joined', { session_id: ev.participant.session_id, user_name: ev.participant.user_name });
      if (state.mode === 'review' && state.review) sendContext(state.review.context);
      else sendContext(await puzzleContext(puzzle()) + (state.ply ? ` Moves played so far: ${state.sanLog.join(' ')}.` : ''));
    });
    call.on('participant-left', (ev) => {
      if (ev.participant?.local) return;
      audit('call.coach_left', { reason: ev.reason });
      endSession(); // the coach hung up (time limit or timeout): the session is over
    });
    // Joining waits on the browser's microphone prompt; don't wait forever.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The call did not connect. Allow the microphone and camera for this site, then try again.')), JOIN_TIMEOUT_MS);
    });
    const options = { url: conversation_url, userName: state.player || 'Student', ...(NO_MEDIA ? { startVideoOff: true, startAudioOff: true } : {}) };
    await Promise.race([call.join(options), timeout]).finally(() => clearTimeout(timer));
    if (cancelled()) throw new Error('Cancelled.');
    audit('call.joined', { conversation_id });
    setStage('live');
    syncCallButtons();
  } catch (e) {
    const msg = e?.message || e?.errorMsg || 'The video call could not connect.';
    log('error', 'err', msg);
    if (state.call) {
      try { state.call.destroy(); } catch {}
      state.call = null;
    }
    state.conversationId = null;
    state.sessionLog = null;
    // Don't leave a conversation running (and billing) that nobody joined.
    if (created) api('/api/session/end', { conversation_id: created, code: $('code').value.trim() }).catch(() => {});
    setStage('lobby');
    $('lobbyError').textContent = msg === 'Cancelled.' ? '' : msg;
  }
}

// Cancel while connecting: abandon the attempt; startSession's cleanup ends the conversation.
function cancelStart() {
  state.attempt = (state.attempt || 0) + 1;
  audit('call.cancelled', {});
  if (state.conversationId) endSession(); // leaves the call and ends the conversation
  else setStage('lobby'); // still creating it; startSession ends it once it exists
}

function sessionSummary() {
  return state.sessionLog ? { puzzles: Object.values(state.sessionLog.puzzles), review: state.sessionLog.review } : null;
}

// Closing the tab mid-session: still end the conversation and save the note.
window.addEventListener('pagehide', () => {
  flushAudit(true);
  if (!state.conversationId || !navigator.sendBeacon) return;
  const body = { conversation_id: state.conversationId, player: state.player, key: notebookKey(), code: $('code').value.trim(), summary: sessionSummary(), client: CLIENT_ID };
  navigator.sendBeacon('/api/session/end', new Blob([JSON.stringify(body)], { type: 'application/json' }));
});

async function endSession() {
  const id = state.conversationId;
  state.conversationId = null;
  if (state.call) {
    const call = state.call;
    state.call = null;
    try { await call.leave(); } catch {}
    try { call.destroy(); } catch {}
  }
  for (const el of [$('coachVideo'), $('coachAudio'), $('selfVideo')]) el.srcObject = null;
  $('selfVideo').classList.add('off');
  setStage('lobby');
  if (id) {
    log('session', 'in', `Conversation ${id} ended`);
    const summary = sessionSummary();
    state.sessionLog = null;
    try {
      const r = await api('/api/session/end', { conversation_id: id, player: state.player, key: notebookKey(), code: $('code').value.trim(), summary });
      if (r.saved) log('memory → pinned session note', 'out', r.note);
      else if (state.player) log('memory', 'in', `No session note saved (${r.reason || 'nothing to save'})`);
    } catch {}
    loadNotebook();
  }
}

// ---------------------------------------------------------------- notebook
// "What Coach Rook remembers about you": the student's Tavus memory store,
// shown on screen so memory is something you can see, not just hear.
async function loadNotebook() {
  const name = $('player').value.trim();
  const code = $('code').value.trim();
  const box = $('notebook');
  if (!name || !state.tavusReady || (!$('codeField').hidden && !code)) {
    box.hidden = true;
    return;
  }
  try {
    const mem = await api('/api/memory', { player: name, key: notebookKey(), code });
    box.hidden = false;
    $('nbName').textContent = name;
    $('nbKey').textContent = formatKey(notebookKey());
    const list = $('nbNotes');
    list.innerHTML = '';
    const notes = mem.pinned || [];
    const learned = mem.learned && learnedLines(mem.learned);
    if (!notes.length && !learned?.length) {
      list.innerHTML = '<li class="empty">Nothing yet. After each session Coach Rook notes what you nailed and what tripped you up.</li>';
      return;
    }
    for (const n of notes.slice(-3).reverse()) {
      const li = document.createElement('li');
      li.textContent = n.text;
      list.appendChild(li);
    }
    for (const l of (learned || []).slice(0, 2)) {
      const li = document.createElement('li');
      li.className = 'learned';
      li.textContent = l;
      list.appendChild(li);
    }
  } catch (e) {
    box.hidden = true;
  }
}

// Flatten Tavus learned memory (profile object + timeline) into a few lines.
function learnedLines(learned) {
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, prefix ? `${prefix} › ${k}` : k);
      else out.push(`Learned: ${prefix ? prefix + ' › ' : ''}${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
  };
  walk(learned.profile, '');
  const recent = learned.timeline?.recent_conversations;
  if (Array.isArray(recent)) recent.slice(-2).forEach((c) => c?.summary && out.push(`Last call: ${c.summary}`));
  return out;
}

// ---------------------------------------------------------------- simulator
// ?sim=1 fires fake tool calls through the exact same handlers, so the board
// integration can be tested without spending conversation minutes.
function setupSim() {
  $('sim').hidden = false;
  const fake = (name, args) => handleToolCall({ name, arguments: JSON.stringify(args), tool_call_id: 'sim_' + Date.now() });
  $('sim').addEventListener('click', (e) => {
    const which = e.target.dataset.sim;
    if (which === 'analyze') fake('chess_analyze_position', { candidate_move: state.chess.moves()[0] });
    if (which === 'hint') {
      const from = puzzle().line[state.ply]?.slice(0, 2);
      fake('chess_show_on_board', { squares: from ? [from] : [], arrows: [] });
    }
    if (which === 'next') fake('chess_load_puzzle', { which: 'next' });
    if (which === 'solution') fake('chess_play_solution', {});
    if (which === 'moment') fake('chess_goto_moment', { moment: 1 });
    if (which === 'line') fake('chess_show_engine_line', {});
  });
}

// ---------------------------------------------------------------- boot
function setHood(open) {
  $('hood').hidden = !open;
  $('hoodBtn').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('coach-rook-hood', open ? 'open' : 'closed'); } catch {}
}

function syncSoundButton() {
  $('soundBtn').setAttribute('aria-pressed', String(!sounds.isMuted()));
  $('soundBtn').setAttribute('aria-label', sounds.isMuted() ? 'Turn sound on' : 'Turn sound off');
}

async function boot() {
  audit('visit', { url: location.pathname + (SIM ? '?sim' : ''), referrer: document.referrer || undefined, screen: `${innerWidth}x${innerHeight}`, agent: navigator.userAgent });
  try { $('player').value = localStorage.getItem('coach-rook-player') || ''; } catch {}
  // Browsers only allow audio after a gesture; the first click or key unlocks it.
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, sounds.unlock, { once: true });
  syncSoundButton();
  $('soundBtn').addEventListener('click', () => {
    sounds.setMuted(!sounds.isMuted());
    syncSoundButton();
    sounds.play('click');
  });
  let hoodOpen = SIM;
  try { hoodOpen ||= localStorage.getItem('coach-rook-hood') === 'open'; } catch {}
  setHood(hoodOpen);
  $('hoodBtn').addEventListener('click', () => setHood($('hood').hidden));
  $('hoodClose').addEventListener('click', () => setHood(false));
  if (SIM) setupSim();

  state.level = storedLevel();
  await loadPuzzle({ which: 'next' }, { announce: false });
  $('retry').addEventListener('click', () => loadPuzzle({ which: 'retry' }));
  $('next').addEventListener('click', () => loadPuzzle({ which: 'next' }));
  $('lobby').addEventListener('submit', (e) => {
    e.preventDefault();
    startSession();
  });
  $('stop').addEventListener('click', endSession);
  $('cancelCall').addEventListener('click', cancelStart);
  $('micBtn').addEventListener('click', () => {
    state.call?.setLocalAudio(!state.call.localAudio());
    syncCallButtons();
  });
  $('camBtn').addEventListener('click', () => {
    state.call?.setLocalVideo(!state.call.localVideo());
    syncCallButtons();
  });
  document.querySelectorAll('[data-tab]').forEach((t) =>
    t.addEventListener('click', () => {
      if (t.dataset.tab === 'puzzle') loadPuzzle({ which: 'retry' });
      else {
        setMode('review');
        if (state.review) gotoPly(state.reviewPly);
        else {
          $('pTitle').textContent = 'Review one of your games';
          $('pLevel').textContent = 'Game review';
          setStatus('Paste a PGN or a Lichess link below', '');
        }
      }
    })
  );
  $('reviewGo').addEventListener('click', () => {
    const pgn = $('pgn').value.trim();
    if (pgn) loadReview(pgn, $('side').value);
  });
  document.querySelectorAll('[data-sample]').forEach((b) =>
    b.addEventListener('click', async () => {
      const text = await (await fetch(`/samples/${b.dataset.sample}.pgn`)).text();
      $('pgn').value = text;
      $('side').value = b.dataset.side;
      loadReview(text, b.dataset.side);
    })
  );
  $('navStart').addEventListener('click', () => gotoPly(0));
  $('navPrev').addEventListener('click', () => gotoPly(state.reviewPly - 1));
  $('navNext').addEventListener('click', () => gotoPly(state.reviewPly + 1));
  $('navEnd').addEventListener('click', () => gotoPly(1e9));
  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'review' || !state.review || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') gotoPly(state.reviewPly - 1);
    if (e.key === 'ArrowRight') gotoPly(state.reviewPly + 1);
  });

  const cfg = await api('/api/config');
  state.tavusReady = cfg.tavusReady;
  $('codeField').hidden = !cfg.needsCode;
  try { $('code').value = localStorage.getItem('coach-rook-code') || ''; } catch {}
  const refresh = () => {
    try { localStorage.setItem('coach-rook-code', $('code').value.trim()); } catch {}
    loadNotebook();
  };
  $('nbKeyCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(formatKey(notebookKey()));
      $('nbKeyCopy').textContent = 'Copied';
    } catch {
      $('nbKeyCopy').textContent = 'Select and copy it';
    }
    setTimeout(() => ($('nbKeyCopy').textContent = 'Copy'), 1500);
  });
  $('nbKeyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.conversationId) return ($('nbKeyError').textContent = 'End the current session first.');
    if (!useNotebookKey($('nbKeyInput').value)) return ($('nbKeyError').textContent = "That doesn't look like a notebook key.");
    $('nbKeyInput').value = '';
    $('nbKeyError').textContent = '';
    loadNotebook();
  });
  $('player').addEventListener('change', refresh);
  $('code').addEventListener('change', refresh);
  loadNotebook();
  if (!cfg.tavusReady) {
    $('start').disabled = true;
    $('setupHint').textContent = 'The video coach is not set up on this server. The board and engine still work.';
  }
}

boot().catch((e) => {
  $('pTitle').textContent = "Couldn't load Coach Rook";
  setStatus(`${e.message}. Reload the page to try again.`, 'bad');
});
