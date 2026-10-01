// Coach Rook frontend.
// The board is the source of truth. The PAL is told about every board event
// over the Tavus interaction protocol, and it acts on the board through tool
// calls (app-message delivery) that this file handles.
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm';

const $ = (id) => document.getElementById(id);
const PIECE_URL = (color, type) =>
  `https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/${color}${type.toUpperCase()}.svg`;
const FILES = 'abcdefgh';
const SIM = new URLSearchParams(location.search).has('sim');

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
};

const puzzle = () => state.puzzles[state.index];

// ---------------------------------------------------------------- API helpers
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------------------------------------------------------- feed log
function log(kind, cls, text, detail) {
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
function render() {
  const board = $('board');
  board.innerHTML = '';
  const legalTargets = state.selected
    ? state.chess.moves({ square: state.selected, verbose: true }).map((m) => m.to)
    : [];
  const grid = state.chess.board(); // rank 8 first
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const square = FILES[f] + (8 - r);
      const el = document.createElement('div');
      el.className = `sq ${(r + f) % 2 === 0 ? 'l' : 'd'}`;
      el.dataset.square = square;
      if (state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)) el.classList.add('last');
      if (state.selected === square) el.classList.add('sel');
      if (state.highlights.includes(square)) el.classList.add('hl');
      if (legalTargets.includes(square)) el.classList.add('target');
      const p = grid[r][f];
      if (p) {
        const pc = document.createElement('div');
        pc.className = 'piece';
        pc.style.backgroundImage = `url(${PIECE_URL(p.color, p.type)})`;
        pc.title = `${p.color === 'w' ? 'White' : 'Black'} ${p.type}`;
        el.appendChild(pc);
      }
      if (f === 0) el.insertAdjacentHTML('beforeend', `<span class="coord r">${8 - r}</span>`);
      if (r === 7) el.insertAdjacentHTML('beforeend', `<span class="coord f">${FILES[f]}</span>`);
      el.addEventListener('click', () => onSquare(square));
      board.appendChild(el);
    }
  }
  renderArrows();
  $('moves').textContent = state.sanLog.join(' ');
}

function sqCenter(sq) {
  return { x: FILES.indexOf(sq[0]) + 0.5, y: 8 - Number(sq[1]) + 0.5 };
}

function renderArrows() {
  const svg = $('arrows');
  svg.querySelectorAll('line').forEach((l) => l.remove());
  for (const a of state.arrows) {
    const [from, to] = a;
    const p1 = sqCenter(from);
    const p2 = sqCenter(to);
    // stop short of the target center so the head sits on the square
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1.x);
    line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x - (dx / len) * 0.35);
    line.setAttribute('y2', p2.y - (dy / len) * 0.35);
    svg.appendChild(line);
  }
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

async function loadPuzzle(index, { announce = true } = {}) {
  state.index = (index + state.puzzles.length) % state.puzzles.length;
  const p = puzzle();
  state.chess = new Chess(p.fen);
  state.ply = 0;
  state.solved = false;
  state.selected = null;
  state.lastMove = null;
  state.highlights = [];
  state.arrows = [];
  state.sanLog = [];
  $('pTitle').textContent = p.title;
  $('pLevel').textContent = `Puzzle ${state.index + 1} of ${state.puzzles.length} · difficulty ${'●'.repeat(p.level)}${'○'.repeat(3 - p.level)}`;
  setStatus(`${sideName(state.chess.turn())} to move and win`);
  render();
  const context = await puzzleContext(p);
  // When the student changes the puzzle themselves, let the coach react to it.
  if (announce && state.conversationId) sendRespond(context + ' The student loaded this themselves. Introduce it in one sentence.');
  return context;
}

// What the PAL needs to know about a freshly loaded puzzle. The solution is
// included (marked secret) so it can give graded hints without guessing.
async function puzzleContext(p) {
  const { text } = await api('/api/describe', { fen: p.fen });
  return (
    `[board] New puzzle loaded: "${p.title}", puzzle ${state.index + 1} of ${state.puzzles.length}, difficulty ${p.level} of 3. ` +
    `Position: ${text} The student plays ${sideName(new Chess(p.fen).turn())}, and the goal is to find the winning move. ` +
    `FOR THE COACH ONLY, do not reveal unless the student gives up: the solution is ${solutionSan(p).join(' ')}. ` +
    `Theme: ${p.theme}. Idea: ${p.idea}`
  );
}

function onSquare(square) {
  if (state.busy || state.solved) return;
  const piece = state.chess.get(square);
  const myTurn = state.chess.turn();
  if (state.selected) {
    const from = state.selected;
    const legal = state.chess.moves({ square: from, verbose: true }).find((m) => m.to === square);
    if (legal) {
      state.selected = null;
      playerMove(from, square);
      return;
    }
  }
  state.selected = piece && piece.color === myTurn ? square : null;
  render();
}

async function playerMove(from, to) {
  const p = puzzle();
  const fenBefore = state.chess.fen();
  const move = state.chess.move({ from, to, promotion: 'q' });
  state.lastMove = move;
  state.highlights = [];
  state.arrows = [];
  const expected = p.line[state.ply];
  const correct = move.lan === expected || state.chess.isCheckmate();
  const who = state.player || 'The student';
  const moveWords = describeMoveWords(move, state.chess);

  if (!correct) {
    render();
    setStatus(`${move.san} isn't it. Try again.`, 'bad');
    document.querySelector(`[data-square="${to}"]`)?.classList.add('wrong');
    state.busy = true;
    // Ask the engine what the move actually allows, so the coach's feedback is grounded.
    let facts = '';
    try {
      const a = await api('/api/analyze', { fen: fenBefore, candidate: move.lan });
      facts = ` Engine facts: ${a.text}`;
    } catch {}
    setTimeout(() => {
      state.chess.undo();
      state.lastMove = null;
      state.busy = false;
      render();
    }, 900);
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
    setStatus('Solved! ✓', 'good');
    sendRespond(
      `[board] ${who} played ${move.san} (${moveWords}). Correct, and that SOLVES the puzzle (theme: ${p.theme}). ` +
        `Celebrate specifically, name the pattern so it sticks, then offer the next puzzle.`
    );
    return;
  }

  // Correct but not finished: play the opponent's reply from the solution line.
  setStatus('Good move…', 'good');
  state.busy = true;
  await sleep(650);
  const replyUci = p.line[state.ply];
  const reply = state.chess.move({ from: replyUci.slice(0, 2), to: replyUci.slice(2, 4), promotion: replyUci[4] || 'q' });
  state.ply += 1;
  state.sanLog.push(reply.san);
  state.lastMove = reply;
  state.busy = false;
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
  state.busy = true;
  state.chess = new Chess(p.fen);
  state.sanLog = [];
  state.highlights = [];
  state.arrows = [];
  render();
  for (const uci of p.line) {
    await sleep(800);
    const m = state.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    state.sanLog.push(m.san);
    state.lastMove = m;
    render();
  }
  state.ply = p.line.length;
  state.solved = true;
  state.busy = false;
  setStatus('Solution shown', '');
  return `The board is now animating the full solution: ${state.sanLog.join(' ')}. Idea: ${p.idea} Walk the student through why it works in one or two sentences, then offer the next puzzle.`;
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
    const squares = (args.squares || []).filter((s) => /^[a-h][1-8]$/.test(s));
    const arrows = (args.arrows || [])
      .map((a) => String(a).toLowerCase().match(/([a-h][1-8]).*?([a-h][1-8])/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]);
    state.highlights = squares;
    state.arrows = arrows;
    render();
    const pieces = squares.map((s) => {
      const pc = state.chess.get(s);
      return pc ? `${s} (${sideName(pc.color)} ${NAMES[pc.type]})` : `${s} (empty)`;
    });
    return `Now showing on the board: ${pieces.length ? 'highlighted ' + pieces.join(', ') : 'no highlights'}${arrows.length ? '; arrows ' + arrows.map((a) => a.join('→')).join(', ') : ''}.`;
  },

  async chess_load_puzzle(args) {
    const which = args.which || 'next';
    let target = state.index;
    if (which === 'next') target = state.index + 1;
    if (which === 'harder' || which === 'easier') {
      const level = puzzle().level + (which === 'harder' ? 1 : -1);
      const candidates = state.puzzles.map((p, i) => ({ p, i })).filter(({ p, i }) => p.level === level && i !== state.index);
      target = candidates.length ? candidates[0].i : state.index + (which === 'harder' ? 1 : -1);
    }
    const context = await loadPuzzle(target, { announce: false });
    return context + ' Introduce the puzzle in one sentence and ask the student what they notice.';
  },

  async chess_play_solution() {
    return playSolution();
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
  if (!msg || msg.message_type !== 'conversation') return;
  const p = msg.properties || {};
  switch (msg.event_type) {
    case 'conversation.tool_call':
      handleToolCall(p);
      break;
    case 'conversation.utterance': {
      const role = p.role === 'user' ? 'You' : 'Coach Rook';
      if (p.speech) {
        $('caption').innerHTML = `<b>${role}:</b> `;
        $('caption').append(document.createTextNode(p.speech));
        log(`utterance (${p.role})`, 'say', p.speech);
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------- session
async function startSession() {
  state.player = $('player').value.trim();
  try { localStorage.setItem('coach-rook-player', state.player); } catch {}
  $('start').disabled = true;
  $('start').textContent = 'Starting…';
  try {
    const { conversation_id, conversation_url } = await api('/api/session', { player: state.player });
    state.conversationId = conversation_id;
    log('session', 'in', `Conversation ${conversation_id} created`);
    $('videoEmpty').hidden = true;
    state.call = window.Daily.createFrame($('video'), {
      showLeaveButton: true,
      iframeStyle: { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0' },
    });
    state.call.on('app-message', onAppMessage);
    state.call.on('left-meeting', endSession);
    let briefed = false;
    state.call.on('participant-joined', async (ev) => {
      // The PAL joins as a remote participant. Brief it on the board once.
      if (briefed || ev.participant.local) return;
      briefed = true;
      sendContext(await puzzleContext(puzzle()) + (state.ply ? ` Moves played so far: ${state.sanLog.join(' ')}.` : ''));
    });
    await state.call.join({ url: conversation_url, userName: state.player || 'Student' });
    $('start').hidden = true;
    $('stop').hidden = false;
  } catch (e) {
    log('error', 'err', e.message);
    alert(`Couldn't start the session: ${e.message}`);
    $('videoEmpty').hidden = false;
  } finally {
    $('start').disabled = false;
    $('start').textContent = 'Start coaching session';
  }
}

async function endSession() {
  const id = state.conversationId;
  state.conversationId = null;
  if (state.call) {
    const call = state.call;
    state.call = null;
    try { await call.leave(); } catch {}
    call.destroy();
  }
  $('videoEmpty').hidden = false;
  $('start').hidden = false;
  $('stop').hidden = true;
  if (id) {
    api('/api/session/end', { conversation_id: id }).catch(() => {});
    log('session', 'in', `Conversation ${id} ended`);
  }
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
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  try { $('player').value = localStorage.getItem('coach-rook-player') || ''; } catch {}
  state.puzzles = await api('/api/puzzles');
  await loadPuzzle(0, { announce: false });
  $('retry').addEventListener('click', () => loadPuzzle(state.index));
  $('next').addEventListener('click', () => loadPuzzle(state.index + 1));
  $('start').addEventListener('click', startSession);
  $('stop').addEventListener('click', endSession);
  const cfg = await api('/api/config');
  if (!cfg.tavusReady) {
    $('start').disabled = true;
    $('setupHint').textContent = 'Video coach not configured on this server (set TAVUS_API_KEY and run npm run setup). The board and engine still work.';
  }
  if (SIM) setupSim();
}

boot();
