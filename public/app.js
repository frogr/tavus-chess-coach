// Coach Rook frontend.
// The board is the source of truth. The PAL is told about every board event
// over the Tavus interaction protocol, and it acts on the board through tool
// calls (app-message delivery) that this file handles.
// chess.js and the Daily SDK are served by our own server from the installed
// npm packages (see VENDOR in server/index.js), so nothing loads from a CDN.
import { Chess } from '/vendor/chess.js';
import { Board } from '/board.js';
import * as sounds from '/sounds.js';
import { MoveList, EvalGraph, renderEvalBar, renderPlayerLine, winPct, accuracy } from '/gameview.js';

const $ = (id) => document.getElementById(id);
const SIM = new URLSearchParams(location.search).has('sim');
const DEBUG = SIM || new URLSearchParams(location.search).has('debug'); // shows the live log drawer
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
  mode: 'puzzle', // 'puzzle' | 'play' | 'review'
  game: null, // the game against the coach, if one was started
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
  return { puzzles: {}, review: null, games: [] };
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
// ---------------------------------------------------------------- puzzle rating
// Puzzles are scored like a rated game against the puzzle (Elo, K = 40): a
// clean solve is a win, a solve that needed wrong tries or hints is a draw,
// giving up is a loss. The rating picks the level of the next puzzle, and a
// run of clean solves is a streak.
const LEVEL_FLOORS = [0, 1000, 1400]; // the pool's three levels start at these puzzle ratings
const levelForRating = (r) => (r >= LEVEL_FLOORS[2] ? 3 : r >= LEVEL_FLOORS[1] ? 2 : 1);

function loadScore() {
  try {
    const s = JSON.parse(localStorage.getItem('coach-rook-score') || '{}');
    state.rating = Number.isFinite(s.rating) ? Math.max(400, Math.min(2400, s.rating)) : 800;
    state.streak = Number.isFinite(s.streak) ? Math.max(0, s.streak) : 0;
    state.best = Number.isFinite(s.best) ? Math.max(0, s.best) : 0;
  } catch {
    state.rating = 800;
    state.streak = state.best = 0;
  }
}

function renderScore(delta) {
  $('hudRating').textContent = state.rating;
  $('hudStreak').textContent = state.streak;
  $('hudStreak').parentElement.classList.toggle('hot', state.streak >= 3);
  if (delta === undefined) return;
  const d = $('hudDelta');
  d.textContent = `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}`;
  d.className = `delta ${delta >= 0 ? 'up' : 'down'}`;
  // Restart the animation even when two results land in a row.
  void d.offsetWidth;
  d.classList.add('show');
}

// Scores the puzzle on the board, once. Returns what changed, or null if it was already scored.
function ratePuzzle(score) {
  const c = state.current;
  if (!c || c.rated) return null;
  c.rated = true;
  const before = state.rating;
  const expected = 1 / (1 + 10 ** ((puzzle().rating - before) / 400));
  state.rating = Math.max(400, Math.min(2400, Math.round(before + 40 * (score - expected))));
  state.streak = score === 1 ? state.streak + 1 : 0;
  state.best = Math.max(state.best, state.streak);
  try { localStorage.setItem('coach-rook-score', JSON.stringify({ rating: state.rating, streak: state.streak, best: state.best })); } catch {}
  renderScore(state.rating - before);
  audit('puzzle.rated', { id: puzzle().id, score, before, after: state.rating, streak: state.streak });
  return { before, after: state.rating, streak: state.streak };
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

const AUDIT_BATCH = 200; // events per report
const AUDIT_BACKLOG = 5000; // kept while reports are failing; beyond this the oldest go

function audit(kind, data) {
  auditQueue.push({ t: Date.now(), kind, conversation_id: state.conversationId || undefined, data });
  if (auditQueue.length > AUDIT_BACKLOG) auditQueue.splice(0, auditQueue.length - AUDIT_BACKLOG);
  auditTimer ||= setTimeout(flushAudit, 2000);
}

// Reports go out on a timer, never per event: a talking coach produces dozens
// of events a second, and a report per burst runs into the server's rate
// limit. A report that fails is put back and sent again with the next one.
async function flushAudit(beacon = false) {
  clearTimeout(auditTimer);
  auditTimer = null;
  if (!auditQueue.length) return;
  const events = auditQueue.splice(0, AUDIT_BATCH);
  const body = JSON.stringify({ client: CLIENT_ID, events });
  if (beacon) {
    // The page is going away: hand the browser what fits in a beacon.
    navigator.sendBeacon?.('/api/events', new Blob([body], { type: 'application/json' }));
    return;
  }
  try {
    const res = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(String(res.status));
  } catch {
    auditQueue.unshift(...events);
  }
  if (auditQueue.length) auditTimer ||= setTimeout(flushAudit, auditQueue.length >= AUDIT_BATCH ? 600 : 2000);
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
const canMove = () => {
  if (state.busy) return false;
  if (state.mode === 'review') return state.trying;
  if (state.mode === 'play') return Boolean(state.game) && !state.game.over && state.chess === state.game.chess && state.chess.turn() === state.game.color;
  return !state.solved;
};
const board = new Board($('board'), {
  canMove,
  onMove: (from, to, promotion) => ({ review: reviewTry, play: gameMove, puzzle: playerMove })[state.mode](from, to, promotion || 'q'),
});
let shownArrows = '';
const moveList = new MoveList($('moveList'), (ply) => gotoPly(ply));
const evalGraph = new EvalGraph($('graph'), $('graphTip'), (ply) => gotoPly(ply));

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
    // Walking away from a puzzle after wrong tries counts as a loss.
    if (state.puzzle && !state.solved && state.current?.wrong.length) ratePuzzle(0);
    const level = request.which === 'next' || !state.puzzle ? levelForRating(state.rating) : state.puzzle.level;
    const res = await api('/api/puzzle', { which: request.which, theme: request.theme, level, lastTheme: state.puzzle?.theme, seen: seenPuzzles() });
    if (res.error) return { error: res.error };
    note = res.note || '';
    state.puzzle = res.puzzle;
    state.count = (state.count || 0) + 1;
    state.current = { wrong: [], hints: 0, solved: false, gaveUp: false };
    markSeen(res.puzzle.id);
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
  $('pLevel').textContent = `Puzzle ${state.count} · rated ${p.rating}`;
  setStatus('');
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
    setStatus(`${move.san} ✗`, 'bad');
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
    const c = state.current;
    const rated = ratePuzzle(!c.wrong.length && !c.hints ? 1 : 0.5);
    setStatus(`Solved · ${p.theme}`, 'good');
    audit('puzzle.solved', { id: p.id, theme: p.theme, wrong: state.current?.wrong, hints: state.current?.hints });
    setTimeout(() => sounds.play('great'), 260);
    sendRespond(
      `[board] ${who} played ${move.san} (${moveWords}). Correct, and that SOLVES the puzzle (theme: ${p.theme}). ` +
        (rated ? `Their puzzle rating went from ${rated.before} to ${rated.after}${rated.streak >= 2 ? `, and that is ${rated.streak} clean solves in a row` : ''}. ` : '') +
        `Celebrate specifically, name the pattern so it sticks, then offer the next puzzle.`
    );
    return;
  }

  // Correct but not finished: play the opponent's reply from the solution line.
  setStatus(`${move.san} ✓`, 'good');
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
  ratePuzzle(0);
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
  setStatus('');
  return `The board is now animating the full solution: ${state.sanLog.join(' ')}. Idea: ${p.idea} Walk the student through why it works in one or two sentences, then offer the next puzzle.`;
}

// ---------------------------------------------------------------- game review
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  stopAutoplay();
  syncPanel();
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

// Resolves to the review, or null if the game could not be analyzed.
async function loadReview(pgn, side, { announce = true } = {}) {
  setMode('review');
  $('reviewGo').disabled = true;
  $('reviewGo').textContent = 'Analyzing…';
  $('pTitle').textContent = 'Analyzing…';
  $('pLevel').textContent = 'Review';
  setStatus('');
  try {
    const review = await api('/api/review', { pgn, side, player: state.player || $('player').value.trim() });
    state.review = review;
    state.orientation = side === 'b' ? 'b' : 'w';
    const h = review.headers;
    $('pTitle').textContent = `${h.White} vs ${h.Black}`;
    $('pLevel').textContent = `${h.Result}${h.Event ? ' · ' + h.Event : ''}`;
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
    if (announce && state.conversationId) {
      sendRespond(review.context + ' The student just loaded this game. In one or two sentences, give your overall impression and offer to start with the first key moment.');
    }
    return review;
  } catch (e) {
    setStatus(e.message, 'bad');
    log('error', 'err', e.message);
    return null;
  } finally {
    $('reviewGo').disabled = false;
    $('reviewGo').textContent = 'Analyze';
  }
}

function renderReviewPanel() {
  const r = state.review;
  moveList.set(r.moves.map((m) => ({ san: m.san, cls: m.class })));
  const startCp = r.moves[0] ? r.moves[0].evalBefore : 0;
  evalGraph.set(
    [winPct(startCp), ...r.moves.map((m) => winPct(m.evalAfter))],
    r.moves.filter((m) => m.class).map((m) => ({ i: m.ply, cls: m.class })),
    ['Start', ...r.moves.map((m) => `${moveLabel(m)}  ${evalText(m.evalAfter)}`)]
  );
  r.accuracy = { w: accuracy(r.moves, 'w'), b: accuracy(r.moves, 'b') };
  const chips = $('moments');
  chips.innerHTML = '';
  if (!r.keyMoments.length) chips.innerHTML = '<span class="muted small">No mistakes</span>';
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

function gotoPly(ply, fromAutoplay = false) {
  const r = state.review;
  if (!r) return;
  if (!fromAutoplay) stopAutoplay();
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
    setStatus(m.class ? `${moveLabel(m)} · ${m.class}` : '', m.class === 'blunder' || m.class === 'mistake' ? 'bad' : '');
    if (m.class && m.bestSan) {
      state.arrows = [[m.best.slice(0, 2), m.best.slice(2, 4)]];
    }
  } else {
    setStatus('');
  }
  syncReviewView(ply, m ? m.evalAfter : r.moves[0] ? r.moves[0].evalBefore : 0);
  render();
}

// The move list, graph cursor, evaluation bar and player lines for the review position.
function syncReviewView(ply, cp) {
  const r = state.review;
  syncPanel();
  moveList.highlight(ply);
  evalGraph.cursor(ply);
  renderEvalBar($('evalbar'), cp, evalText(cp).replace('checkmate', '#'), state.orientation === 'b');
  const turn = state.chess.turn();
  const over = state.chess.isGameOver();
  const line = (color) => ({
    name: color === 'w' ? r.headers.White : r.headers.Black,
    color,
    you: r.side === color,
    accuracy: r.accuracy?.[color],
    active: !over && turn === color,
  });
  const top = state.orientation === 'w' ? 'b' : 'w';
  renderPlayerLine($('topPlayer'), line(top));
  renderPlayerLine($('bottomPlayer'), line(top === 'w' ? 'b' : 'w'));
}

// Which of the game-screen parts are on show, by mode.
function syncPanel() {
  const review = state.mode === 'review' && Boolean(state.review);
  const play = state.mode === 'play' && Boolean(state.game);
  $('gamePanel').hidden = !review && !(play && state.game.sans.length);
  $('reviewTools').hidden = !review;
  $('evalbar').hidden = !review;
  $('topPlayer').hidden = $('bottomPlayer').hidden = !review && !play;
}

function stopAutoplay() {
  clearInterval(state.autoplay);
  state.autoplay = null;
  $('navPlay').setAttribute('aria-pressed', 'false');
}

function toggleAutoplay() {
  if (state.autoplay) return stopAutoplay();
  const r = state.review;
  if (!r) return;
  if (state.reviewPly >= r.moves.length) gotoPly(0);
  $('navPlay').setAttribute('aria-pressed', 'true');
  state.autoplay = setInterval(() => {
    if (state.mode !== 'review' || state.reviewPly >= state.review.moves.length) return stopAutoplay();
    gotoPly(state.reviewPly + 1, true);
  }, 1100);
}

function flipBoard() {
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  if (state.mode === 'review' && state.review) {
    const r = state.review;
    const m = r.moves[state.reviewPly - 1];
    syncReviewView(state.reviewPly, m ? m.evalAfter : r.moves[0] ? r.moves[0].evalBefore : 0);
  }
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
  // The move they played in the game is drawn on the board; the better move is not.
  state.arrows = [[m.uci.slice(0, 2), m.uci.slice(2, 4)]];
  state.lastMove = prev ? { from: prev.uci.slice(0, 2), to: prev.uci.slice(2, 4) } : null;
  setStatus(`You played ${m.san}`, '');
  stopAutoplay();
  syncReviewView(k.ply - 1, m.evalBefore);
  render();
  return (
    `Board now shows key moment ${k.index}, the position BEFORE the student's move ${moveLabel(m)}. ` +
    `${k.text} The move they played is drawn as an arrow. The student can now move pieces to try a better move. Ask what they were thinking, then let them look; ` +
    `don't say the engine's move unless they give up. When you mention a piece or a square, point at it with chess_show_on_board.`
  );
}

async function reviewTry(from, to, promotion = 'q') {
  const fen = state.chess.fen();
  const move = state.chess.move({ from, to, promotion });
  state.lastMove = move;
  state.busy = true;
  state.badge = null;
  state.arrows = [];
  const gen = generation;
  moveSound(move.san);
  render();
  setStatus('');
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
    setStatus(`${j.san} ✓`, 'good');
    render();
    sendRespond(
      `[board] At key moment ${state.moment}, ${who} tried ${j.san} (${j.words}). The engine approves: evaluation after it is ${j.evalAfter}` +
        `${j.san === j.bestSan ? ", and it is the engine's top choice" : `, about as good as the engine's top choice ${j.bestSan}`}. ` +
        `Praise what they found, explain the idea in a sentence, and offer the next key moment.`
    );
  } else {
    setStatus(`${j.san} ✗`, 'bad');
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
  setStatus(line.join(' '), '');
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
  if (state.mode === 'puzzle') {
    tally((t) => !t.solved && (t.gaveUp = true)); // the engine's line from here is the answer
    if (!state.solved) ratePuzzle(0);
  }
  const before = { chess: state.chess, lastMove: state.lastMove };
  setStatus(line.join(' '), '');
  const played = await animateLine(before.chess.fen(), line);
  const gen = generation;
  setTimeout(() => {
    if (gen !== generation) return;
    state.chess = before.chess;
    state.lastMove = before.lastMove;
    state.busy = false;
    state.snap = true;
    if (state.mode === 'puzzle') setStatus(state.solved ? `Solved · ${puzzle().theme}` : '', state.solved ? 'good' : '');
    else setStatus('');
    render();
  }, 4000);
  return `The board animated the engine's line from the current position: ${played.join(' ')}. It returns to the position in a few seconds. Explain the key idea of the line in one or two sentences.`;
}

// ---------------------------------------------------------------- play the coach
// A full game against the coach. The server picks the coach's moves at the
// chosen strength and judges each of the student's moves; the coach is told
// about every move, and asked to speak only when there is something to say.
const RATINGS = [500, 1000, 1500, 2000, 2500, 3000];
const MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };
// How the coach should carry itself at each strength. Sent when a game starts.
const ATTITUDE = {
  500: 'You are playing like a beginner on purpose. Easygoing and generous: mention a threat before it lands, say what a good move of theirs achieved, and when a move leaves something loose, say what and why in a sentence, then play on.',
  1000: 'You are playing like a casual player. Easygoing: when a move lets something through, say what it let through and what the stronger idea was after, then play on.',
  1500: 'You are playing like a club player. Friendly sparring: when the game turns, say in a sentence what changed and why. Hints when asked.',
  2000: 'You are playing like a strong club player and this is a serious game. Speak less, comment only on turning points, and allow yourself a little competitive banter. Hints only when asked.',
  2500: 'You are playing at master strength and you want to win. Be confident and brief. Explain only when asked, and make them work for it.',
  3000: 'You are playing at full engine strength and giving nothing away. Dry, competitive, respectful. Still answer questions honestly when asked, and be generous once the game is over.',
};
// How the board describes a costly move to the coach. Deliberately not "mistake" or "blunder":
// the coach repeats the words it is given.
const COST = { inaccuracy: 'slightly loose', mistake: 'this gave up a good part of their position', blunder: 'this gave up a lot' };
// How many of the student's moves may pass before the coach says something unprompted.
const QUIET_MOVES = [4, 4, 6, 6, 9, 9];

function storedStrength() {
  try {
    const r = Number(localStorage.getItem('coach-rook-strength'));
    return RATINGS.includes(r) ? r : 1500;
  } catch {
    return 1500;
  }
}

// How the game on the board ended, or null while it is still going.
function outcome(g) {
  const c = g.chess;
  if (c.isCheckmate()) return c.turn() === g.color ? ['lost', 'Checkmate'] : ['won', 'Checkmate'];
  if (c.isStalemate()) return ['drew', 'Stalemate'];
  if (c.isThreefoldRepetition()) return ['drew', 'Draw by repetition'];
  if (c.isInsufficientMaterial()) return ['drew', 'Draw by insufficient material'];
  if (c.isDraw()) return ['drew', 'Draw by the fifty-move rule'];
  return null;
}

const costliest = (g) => [...g.mistakes].sort((a, b) => b.loss - a.loss).slice(0, 3).sort((a, b) => a.ply - b.ply).map((m) => m.label);

function renderGame() {
  const g = state.game;
  $('pLevel').textContent = g ? `vs ${coachName()} · ${g.rating}` : `vs ${coachName()}`;
  if (!g) {
    $('pTitle').textContent = 'Play the coach';
    setStatus('');
  } else if (g.over) {
    $('pTitle').textContent = g.reason;
    setStatus({ won: 'You won', lost: 'You lost', drew: 'Draw', unfinished: '' }[g.result], g.result === 'won' ? 'good' : g.result === 'lost' ? 'bad' : '');
  } else {
    $('pTitle').textContent = `${sideName(g.chess.turn())} to move`;
    setStatus('');
  }
  $('gameSetup').hidden = Boolean(g);
  $('gameBar').hidden = !g;
  $('takeBack').hidden = $('resign').hidden = !g || g.over;
  $('reviewGame').hidden = !g || !g.over || g.sans.length < 2;
  $('newGame').hidden = !g || !g.over;
  syncPanel();
  if (g) {
    // Verdicts on the student's moves appear once the game is over.
    moveList.set(g.sans.map((san, i) => ({ san, cls: g.over ? g.marks[i] : null })), false);
    moveList.highlight(g.sans.length);
    const turn = g.chess.turn();
    const line = (color) => ({ name: color === g.color ? state.player || 'You' : coachName(), color, you: color === g.color && Boolean(state.player), active: !g.over && turn === color });
    renderPlayerLine($('topPlayer'), line(g.color === 'w' ? 'b' : 'w'));
    renderPlayerLine($('bottomPlayer'), line(g.color));
  }
  render();
}

function showPlay() {
  setMode('play');
  newPosition();
  const g = state.game;
  state.chess = g ? g.chess : new Chess();
  state.orientation = g ? g.color : 'w';
  state.lastMove = g ? g.lastMove : null;
  state.selected = null;
  state.highlights = [];
  state.arrows = [];
  state.badge = null;
  renderGame();
}

const playerName = () => state.player || 'The student';

// Games played during a call go into the session note.
function logGame(g) {
  if (state.sessionLog && !state.sessionLog.games.includes(g)) state.sessionLog.games.push(g);
}

// Returns what the coach should know about the new game.
async function startGame(rating, color, { announce = true } = {}) {
  if (!RATINGS.includes(rating)) rating = storedStrength();
  if (state.game && !state.game.over) finishGame(state.game, 'unfinished', 'Game stopped');
  const side = color === 'w' || color === 'b' ? color : Math.random() < 0.5 ? 'w' : 'b';
  const g = (state.game = { rating, color: side, chess: new Chess(), sans: [], marks: {}, mistakes: [], over: false, result: 'unfinished', reason: '', quiet: 0, lastMove: null });
  try { localStorage.setItem('coach-rook-strength', String(rating)); } catch {}
  $('strength').value = RATINGS.indexOf(rating);
  $('strengthOut').textContent = rating;
  audit('play.new', { rating, color: side });
  showPlay();
  let opening = '';
  if (side === 'b') {
    const turn = await coachTurn(g, g.chess.fen(), null).catch((e) => (setStatus(e.message, 'bad'), null));
    if (turn?.reply) opening = ` You opened with ${turn.reply.san}.`;
  }
  const context =
    `[board] New game against you. Your strength for this game: ${rating}. ${playerName()} plays ${sideName(side)} and you play ${sideName(side === 'w' ? 'b' : 'w')}.${opening} ` +
    `How to behave at this strength: ${ATTITUDE[rating]}`;
  if (announce && state.conversationId) sendRespond(`${context} Say one short line to start the game.`);
  return context;
}

// Asks the server to judge the student's move (if there is one) and answer it,
// then plays the answer on the board. Resolves to null if the game was left
// or replaced while the coach was thinking.
async function coachTurn(g, fen, move) {
  const gen = generation;
  state.busy = true;
  board.refresh();
  const started = Date.now();
  let turn;
  try {
    turn = await api('/api/play', { fen, move, rating: g.rating });
  } finally {
    if (gen === generation) state.busy = false;
  }
  await sleep(Math.max(0, 500 - (Date.now() - started)));
  if (gen !== generation || state.game !== g) return null;
  if (turn.reply) {
    const uci = turn.reply.uci;
    const m = g.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    g.sans.push(m.san);
    g.lastMove = state.lastMove = m;
    moveSound(m.san);
    audit('play.reply', { san: m.san, uci, rating: g.rating });
  }
  renderGame();
  return turn;
}

async function gameMove(from, to, promotion = 'q') {
  const g = state.game;
  const fen = g.chess.fen();
  const move = g.chess.move({ from, to, promotion });
  const ply = g.sans.push(move.san);
  g.lastMove = state.lastMove = move;
  state.highlights = [];
  state.arrows = [];
  moveSound(move.san);
  logGame(g);
  audit('play.move', { fen, san: move.san, uci: move.lan, rating: g.rating });
  const moveNo = Math.ceil(ply / 2);
  const said = `${playerName()} played ${move.san} (${describeMoveWords(move, g.chess)})`;

  let end = outcome(g);
  if (end) {
    renderGame();
    sendRespond(finishGame(g, end[0], end[1], `[board] Game, move ${moveNo}: ${said}.`));
    return;
  }
  renderGame();

  // Put the student's move back if the coach's answer never arrives.
  const putBack = () => {
    g.chess.undo();
    g.sans.pop();
    const h = g.chess.history({ verbose: true });
    g.lastMove = h[h.length - 1] || null;
    if (state.mode === 'play' && state.game === g) {
      state.lastMove = g.lastMove;
      renderGame();
    }
  };
  let turn;
  try {
    turn = await coachTurn(g, fen, move.lan);
  } catch (e) {
    putBack();
    setStatus(e.message, 'bad');
    return;
  }
  if (!turn) return putBack();

  const j = turn.judge;
  if (j.class) {
    g.marks[ply - 1] = j.class;
    if (j.class !== 'inaccuracy') g.mistakes.push({ ply, loss: j.lossPct, label: `${moveNo}${g.color === 'w' ? '.' : '...'} ${move.san}${MARK[j.class]}` });
  }
  audit('play.judge', { san: move.san, class: j.class, lossPct: j.lossPct, best: j.bestSan });
  const text =
    `[board] Game, move ${moveNo}: ${said}. Engine: ${j.class ? COST[j.class] : move.san === j.bestSan ? "the engine's first choice" : 'a sound move'}. ` +
    (j.class
      ? `The engine preferred ${j.bestSan} (${j.bestWords}), continuing ${j.bestLine.join(' ')}. ` +
        (j.answerLine?.length ? `Its strongest answer to the move played: ${j.answerLine.join(' ')}. ` : '')
      : '') +
    `Evaluation after it: ${j.evalAfter}. ` +
    (turn.reply ? `You answered ${turn.reply.san} (${turn.reply.words}). ` : '') +
    `Position now: ${turn.position}`;

  end = outcome(g);
  if (end) return sendRespond(finishGame(g, end[0], end[1], text));

  const level = RATINGS.indexOf(g.rating);
  g.quiet += 1;
  // A costly move gets a remark, but not two moves running: nobody wants a comment on every slip.
  if (g.quiet >= 2 && (j.class === 'blunder' || (j.class === 'mistake' && level <= 3))) {
    g.quiet = 0;
    const ask =
      level <= 3
        ? `In one or two relaxed sentences, say what the move leaves open (name the pieces and squares from the engine's lines)${level <= 1 ? ' and what the stronger idea was after' : ''}. No grading words, no take-back offer. Then carry on with the game.`
        : 'One short, competitive remark. Explain only if they ask.';
    sendRespond(`${text} ${ask}`);
  } else if (g.quiet >= QUIET_MOVES[level]) {
    g.quiet = 0;
    sendRespond(
      `${text} Share one concrete observation in a sentence: the idea behind your last move, something their recent moves did well, or a piece or square that matters now. Keep it in character for this strength.`
    );
  } else {
    sendContext(text);
  }
}

// Ends the game and returns what the coach should be told about it.
function finishGame(g, result, reason, lead = '[board]') {
  g.over = true;
  g.result = result;
  g.reason = reason;
  audit('play.end', { result, reason, rating: g.rating, moves: Math.ceil(g.sans.length / 2), mistakes: costliest(g) });
  saveGame(g);
  if (state.game === g && state.mode === 'play') {
    state.busy = false;
    if (result === 'won') setTimeout(() => sounds.play('great'), 260);
    renderGame();
  }
  const who = playerName();
  const how = { won: `${who} won`, lost: `${who} lost`, drew: 'It is a draw', unfinished: `${who} stopped the game` }[result];
  const worst = costliest(g);
  return (
    `${lead} The game against you (strength ${g.rating}) is over: ${reason}. ${how} after ${Math.ceil(g.sans.length / 2)} moves. ` +
    (worst.length ? `Their costliest moves: ${worst.join(', ')}. ` : '') +
    'Say in a sentence or two what decided it, then offer to go through the game together (chess_review_game) or a rematch (chess_new_game).'
  );
}

// Undo the student's last move and the coach's answer to it.
async function takeBack() {
  const g = state.game;
  if (!g || g.over || state.mode !== 'play') return 'There is no game in progress to take a move back in.';
  if (state.busy || g.chess.turn() !== g.color) return 'Wait for your own move to be played before taking back.';
  if (g.sans.length < (g.color === 'w' ? 2 : 3)) return 'There is no move to take back yet.';
  g.chess.undo();
  g.chess.undo();
  const [san] = g.sans.splice(-2);
  delete g.marks[g.sans.length];
  g.mistakes = g.mistakes.filter((m) => m.ply !== g.sans.length + 1);
  const h = g.chess.history({ verbose: true });
  g.lastMove = state.lastMove = h[h.length - 1] || null;
  state.highlights = [];
  state.arrows = [];
  audit('play.takeback', { san });
  renderGame();
  const { text } = await api('/api/describe', { fen: g.chess.fen() }).catch(() => ({ text: '' }));
  return `[board] ${playerName()} took back ${san}. It is their move again. Position now: ${text}`;
}

function gamePgn(g) {
  const you = state.player || 'Student';
  g.chess.header('Event', `Game against ${coachName()} (${g.rating})`);
  g.chess.header('White', g.color === 'w' ? you : coachName());
  g.chess.header('Black', g.color === 'b' ? you : coachName());
  g.chess.header('Result', { won: g.color === 'w' ? '1-0' : '0-1', lost: g.color === 'w' ? '0-1' : '1-0', drew: '1/2-1/2', unfinished: '*' }[g.result]);
  return g.chess.pgn();
}

// ---------------------------------------------------------------- game history
// Games played against the coach are kept in this browser, newest first, and
// listed in the Review tab beside recent games from chess.com.
const GAMES_KEY = 'coach-rook-games';
function savedGames() {
  try { return JSON.parse(localStorage.getItem(GAMES_KEY) || '[]'); } catch { return []; }
}
function saveGame(g) {
  if (g.saved || g.sans.length < 4) return;
  g.saved = true;
  const entry = { at: Date.now(), opponent: coachName(), rating: g.rating, color: g.color, result: g.result, moves: Math.ceil(g.sans.length / 2), pgn: gamePgn(g) };
  try { localStorage.setItem(GAMES_KEY, JSON.stringify([entry, ...savedGames()].slice(0, 30))); } catch {}
  renderHistory();
}

const RESULT_WORD = { won: 'Won', lost: 'Lost', drew: 'Draw', unfinished: 'Unfinished', win: 'Won', loss: 'Lost', draw: 'Draw' };
const RESULT_CLASS = { won: 'win', win: 'win', lost: 'loss', loss: 'loss' };
function renderHistory() {
  const rows = [
    ...savedGames().map((g) => ({ ...g, title: `${g.opponent} (${g.rating})`, meta: `${g.moves} moves · ${new Date(g.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` })),
    ...(state.chesscom || []).map((g) => ({
      title: `${g.opponent} (${g.oppRating})`,
      meta: `${g.timeClass} · ${new Date(g.end * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · chess.com`,
      color: g.me === 'white' ? 'w' : 'b',
      result: g.result,
      pgn: g.pgn,
    })),
  ];
  $('historyList').replaceChildren(
    ...rows.map((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      const pip = document.createElement('span');
      pip.className = `pip ${RESULT_CLASS[g.result] || ''}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = g.title;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${g.color === 'w' ? 'White' : 'Black'} · ${g.meta}`;
      const res = document.createElement('span');
      res.className = `res ${RESULT_CLASS[g.result] || ''}`;
      res.textContent = RESULT_WORD[g.result] || '';
      b.append(pip, who, meta, res);
      b.addEventListener('click', () => {
        $('side').value = g.color;
        loadReview(g.pgn, g.color);
      });
      return b;
    })
  );
}

// A player's recent games from chess.com's public archives (the last two months).
async function loadChesscom(user) {
  const get = async (url) => {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.status === 404) throw new Error(`No chess.com player named "${user}".`);
    if (!r.ok) throw new Error(`chess.com returned ${r.status}.`);
    return r.json();
  };
  const archives = (await get(`https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`)).archives.slice(-2).reverse();
  const games = [];
  for (const url of archives) {
    if (!/^https:\/\/api\.chess\.com\/pub\/player\//.test(url)) continue;
    games.push(...(await get(url)).games.reverse());
    if (games.length >= 25) break;
  }
  return games
    .filter((g) => g.pgn && g.rules === 'chess')
    .slice(0, 25)
    .map((g) => {
      const me = g.white.username.toLowerCase() === user.toLowerCase() ? 'white' : 'black';
      const mine = g[me];
      const opp = me === 'white' ? g.black : g.white;
      const draw = ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(mine.result);
      return { pgn: g.pgn, me, result: mine.result === 'win' ? 'win' : draw ? 'draw' : 'loss', opponent: opp.username, oppRating: opp.rating, timeClass: g.time_class, end: g.end_time };
    });
}

// Loads the game just played into review mode. Returns the review context for the coach.
async function reviewPlayedGame({ announce = true } = {}) {
  const g = state.game;
  if (!g || g.sans.length < 2) return 'There is no game to review yet.';
  if (!g.over) finishGame(g, 'unfinished', 'Game stopped');
  const review = await loadReview(gamePgn(g), g.color, { announce });
  if (!review) return 'The game could not be analyzed.';
  return `${review.context} This is the game they just played against you. Give your overall impression in a sentence and offer to start with the first key moment.`;
}

// What the coach needs when a call starts with a game already on the board.
async function gameContext() {
  const g = state.game;
  const { text } = await api('/api/describe', { fen: g.chess.fen() }).catch(() => ({ text: '(piece list unavailable)' }));
  return (
    `[board] A game against you is on the board. Your strength for this game: ${g.rating}. ${playerName()} plays ${sideName(g.color)}. ` +
    `How to behave at this strength: ${ATTITUDE[g.rating]} Moves so far: ${g.sans.join(' ') || 'none'}. ` +
    (g.over ? `The game is over: ${g.reason}. ` : '') +
    `Position: ${text}`
  );
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
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\s]+/) : []);
    const squares = list(args.squares).map((s) => String(s).trim().toLowerCase()).filter((s) => /^[a-h][1-8]$/.test(s));
    const arrows = (Array.isArray(args.arrows) ? args.arrows : typeof args.arrows === 'string' ? args.arrows.split(/[,;]+/) : [])
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
    if (state.mode === 'play') return 'There is no solution to play in a game. chess_show_engine_line shows what the engine would do from here.';
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

  async chess_new_game(args) {
    const color = { white: 'w', black: 'b' }[String(args.color || '').toLowerCase()];
    return startGame(Number(args.strength), color, { announce: false }).then((context) => `${context} Say one short line to start the game.`);
  },

  async chess_take_back() {
    return takeBack();
  },

  async chess_review_game() {
    return reviewPlayedGame({ announce: false });
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
      // Board messages come back as "user" speech; they are not something the student said.
      if (p.speech && !(p.role === 'user' && p.speech.startsWith('[board]'))) {
        // Captions are the coach's words only.
        if (p.role !== 'user') $('caption').textContent = p.speech;
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
  // If the browser refuses to start playback, the next click anywhere starts it.
  el.play().catch(() => window.addEventListener('pointerdown', () => el.srcObject && el.play().catch(() => {}), { once: true }));
}

// Browsers hold back playback that starts in a background tab; resume when the tab is shown.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const el of [$('coachVideo'), $('coachAudio'), $('selfVideo')]) if (el.srcObject && el.paused) el.play().catch(() => {});
});

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

// Time left in the session, shown in the call bar. Tavus ends the call when it runs out.
function startCallClock(seconds) {
  clearInterval(state.clock);
  if (!seconds) return ($('callTime').textContent = '');
  state.callEnds = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((state.callEnds - Date.now()) / 1000));
    $('callTime').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('callTime').classList.toggle('low', left <= 120);
  };
  tick();
  state.clock = setInterval(tick, 1000);
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
    if (!window.Daily) throw new Error('Video failed to load. Reload the page.');
    const { conversation_id, conversation_url, returning, max_seconds } = await api('/api/session', { player: state.player, key: notebookKey(), code: $('code').value.trim(), mode: state.mode, coach: state.coach?.key });
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
      $('stageNote').textContent = 'Microphone blocked';
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
      else if (state.mode === 'play' && state.game) sendContext(await gameContext());
      else sendContext(await puzzleContext(puzzle()) + (state.ply ? ` Moves played so far: ${state.sanLog.join(' ')}.` : ''));
    });
    call.on('participant-left', (ev) => {
      if (ev.participant?.local) return;
      audit('call.coach_left', { reason: ev.reason });
      const timedOut = state.callEnds && state.callEnds - Date.now() < 15000;
      endSession().then(() => timedOut && ($('lobbyError').textContent = 'Session time limit reached.')); // the coach hung up: the session is over
    });
    // Joining waits on the browser's microphone prompt; don't wait forever.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Could not connect. Allow the microphone and camera, then try again.')), JOIN_TIMEOUT_MS);
    });
    const options = { url: conversation_url, userName: state.player || 'Student', ...(NO_MEDIA ? { startVideoOff: true, startAudioOff: true } : {}) };
    await Promise.race([call.join(options), timeout]).finally(() => clearTimeout(timer));
    if (cancelled()) throw new Error('Cancelled.');
    audit('call.joined', { conversation_id });
    startCallClock(max_seconds);
    setStage('live');
    syncCallButtons();
  } catch (e) {
    const msg = e?.message || e?.errorMsg || 'Could not connect.';
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
  if (!state.sessionLog) return null;
  const games = state.sessionLog.games.map((g) => ({ rating: g.rating, color: g.color, result: g.result, moves: Math.ceil(g.sans.length / 2), mistakes: costliest(g) }));
  return { puzzles: Object.values(state.sessionLog.puzzles), review: state.sessionLog.review, games };
}

// Closing the tab mid-session: still end the conversation and save the note.
window.addEventListener('pagehide', () => {
  flushAudit(true);
  if (!state.conversationId || !navigator.sendBeacon) return;
  const body = { conversation_id: state.conversationId, player: state.player, key: notebookKey(), code: $('code').value.trim(), summary: sessionSummary(), client: CLIENT_ID };
  navigator.sendBeacon('/api/session/end', new Blob([JSON.stringify(body)], { type: 'application/json' }));
});

async function endSession() {
  clearInterval(state.clock);
  state.callEnds = null;
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
  if (!name || !state.tavusReady || (!$('code').hidden && !code)) {
    box.hidden = true;
    return;
  }
  try {
    const mem = await api('/api/memory', { player: name, key: notebookKey(), code, coach: state.coach?.key });
    box.hidden = false;
    $('nbName').textContent = name;
    $('nbKey').textContent = formatKey(notebookKey());
    const list = $('nbNotes');
    list.innerHTML = '';
    const notes = mem.pinned || [];
    const learned = mem.learned && learnedLines(mem.learned);
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
      else out.push(`${prefix ? prefix + ' › ' : ''}${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
  };
  walk(learned.profile, '');
  const recent = learned.timeline?.recent_conversations;
  if (Array.isArray(recent)) recent.slice(-2).forEach((c) => c?.summary && out.push(c.summary));
  return out;
}

// ---------------------------------------------------------------- coach picker
const coachName = () => state.coach?.name || 'the coach';

function chooseCoach(key) {
  state.coach = state.coaches.find((c) => c.key === key) || state.coaches[0] || null;
  if (!state.coach) return;
  try { localStorage.setItem('coach-rook-coach', state.coach.key); } catch {}
  for (const b of $('coaches').children) b.setAttribute('aria-checked', String(b.dataset.coach === state.coach.key));
  $('coachStyle').textContent = state.coach.style;
  if (state.mode === 'play') renderGame();
}

function setupCoaches(coaches) {
  state.coaches = coaches || [];
  const many = state.coaches.length > 1;
  $('coaches').hidden = $('coachStyle').hidden = !many;
  for (const c of state.coaches) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'coach';
    b.dataset.coach = c.key;
    b.setAttribute('role', 'radio');
    const img = document.createElement('img');
    img.src = c.image;
    img.alt = '';
    b.append(img, c.name);
    b.addEventListener('click', () => {
      chooseCoach(c.key);
      loadNotebook();
    });
    $('coaches').append(b);
  }
  let stored = null;
  try { stored = localStorage.getItem('coach-rook-coach'); } catch {}
  chooseCoach(stored);
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
    if (which === 'game') fake('chess_new_game', { strength: 1000, color: 'white' });
    if (which === 'takeback') fake('chess_take_back', {});
    if (which === 'reviewgame') fake('chess_review_game', {});
  });
}

// ---------------------------------------------------------------- boot
function setHood(open) {
  $('hood').hidden = !open;
  $('hoodBtn').setAttribute('aria-expanded', String(open));
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
  setHood(SIM);
  $('hoodBtn').hidden = !DEBUG;
  $('hoodBtn').addEventListener('click', () => setHood($('hood').hidden));
  $('hoodClose').addEventListener('click', () => setHood(false));
  if (SIM) setupSim();

  loadScore();
  renderScore();
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
      else if (t.dataset.tab === 'play') showPlay();
      else {
        setMode('review');
        if (state.review) gotoPly(state.reviewPly);
        else {
          $('pTitle').textContent = 'Review a game';
          $('pLevel').textContent = '\u00a0';
          setStatus('');
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
  const strength = () => RATINGS[Number($('strength').value)];
  $('strength').value = RATINGS.indexOf(storedStrength());
  $('strengthOut').textContent = strength();
  $('strength').addEventListener('input', () => ($('strengthOut').textContent = strength()));
  $('gameSetup').addEventListener('submit', (e) => {
    e.preventDefault();
    startGame(strength(), $('gameColor').value);
  });
  $('takeBack').addEventListener('click', async () => {
    const told = await takeBack();
    if (told.startsWith('[board]') && state.conversationId) sendContext(told);
  });
  $('resign').addEventListener('click', () => {
    const g = state.game;
    if (g && !g.over) sendRespond(finishGame(g, 'lost', 'Resigned'));
  });
  $('reviewGame').addEventListener('click', () => reviewPlayedGame());
  $('newGame').addEventListener('click', () => {
    state.game = null;
    showPlay();
  });
  $('navStart').addEventListener('click', () => gotoPly(0));
  $('navPrev').addEventListener('click', () => gotoPly(state.reviewPly - 1));
  $('navNext').addEventListener('click', () => gotoPly(state.reviewPly + 1));
  $('navEnd').addEventListener('click', () => gotoPly(1e9));
  $('navPlay').addEventListener('click', toggleAutoplay);
  $('navFlip').addEventListener('click', flipBoard);
  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'review' || !state.review || ['TEXTAREA', 'INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = {
      ArrowLeft: () => gotoPly(state.reviewPly - 1),
      ArrowRight: () => gotoPly(state.reviewPly + 1),
      Home: () => gotoPly(0),
      End: () => gotoPly(1e9),
      ' ': toggleAutoplay,
      f: flipBoard,
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    keys[e.key]();
  });
  renderHistory();
  try { $('chesscomUser').value = localStorage.getItem('coach-rook-chesscom') || ''; } catch {}
  $('chesscomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = $('chesscomUser').value.trim();
    $('chesscomError').textContent = '';
    if (!/^[\w-]{2,40}$/.test(user)) return ($('chesscomError').textContent = 'Enter a chess.com username.');
    try {
      state.chesscom = await loadChesscom(user);
      try { localStorage.setItem('coach-rook-chesscom', user); } catch {}
      if (!state.chesscom.length) $('chesscomError').textContent = 'No recent games.';
      renderHistory();
    } catch (err) {
      $('chesscomError').textContent = err.message;
    }
  });

  const cfg = await api('/api/config');
  state.tavusReady = cfg.tavusReady;
  $('code').hidden = !cfg.needsCode;
  setupCoaches(cfg.coaches);
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
      $('nbKeyCopy').textContent = 'Copy failed';
    }
    setTimeout(() => ($('nbKeyCopy').textContent = 'Copy'), 1500);
  });
  $('nbKeyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.conversationId) return ($('nbKeyError').textContent = 'End the session first.');
    if (!useNotebookKey($('nbKeyInput').value)) return ($('nbKeyError').textContent = 'Not a valid key.');
    $('nbKeyInput').value = '';
    $('nbKeyError').textContent = '';
    loadNotebook();
  });
  $('player').addEventListener('change', refresh);
  $('code').addEventListener('change', refresh);
  loadNotebook();
  if (!cfg.tavusReady) {
    $('start').disabled = true;
    $('lobbyError').textContent = 'Video coach unavailable.';
  }
}

boot().catch((e) => {
  $('pTitle').textContent = 'Failed to load';
  setStatus(e.message, 'bad');
});
