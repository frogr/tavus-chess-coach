// Synthesized UI sounds (no audio files). Everything is built from short oscillator
// and noise bursts on a shared AudioContext, so the first user gesture unlocks it.

let ctx = null;
let muted = false;
try { muted = localStorage.getItem("coach-rook-sound") === "off"; } catch (e) { /* ignore */ }

function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem("coach-rook-sound", muted ? "off" : "on"); } catch (e) { /* ignore */ }
}
export function unlock() { ac(); }

function tone(freq, { t = 0, dur = 0.08, type = "sine", gain = 0.25, slide = null, attack = 0.003 } = {}) {
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  const t0 = c.currentTime + t;
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise({ t = 0, dur = 0.05, gain = 0.18, lp = 1800 } = {}) {
  const c = ac(); if (!c) return;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp;
  const g = c.createGain(); g.gain.value = gain;
  const t0 = c.currentTime + t;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}

const S = {
  move() { noise({ dur: 0.035, gain: 0.12, lp: 1400 }); tone(190, { dur: 0.07, gain: 0.22, slide: 120 }); },
  capture() { noise({ dur: 0.06, gain: 0.22, lp: 2400 }); tone(150, { dur: 0.1, gain: 0.28, slide: 80, type: "triangle" }); },
  castle() { S.move(); noise({ t: 0.09, dur: 0.035, gain: 0.1, lp: 1400 }); tone(210, { t: 0.09, dur: 0.07, gain: 0.2, slide: 130 }); },
  check() { tone(880, { dur: 0.09, gain: 0.16 }); tone(1320, { t: 0.02, dur: 0.12, gain: 0.08 }); noise({ dur: 0.03, gain: 0.08, lp: 3000 }); },
  promote() { [523, 659, 784, 1047].forEach((f, i) => tone(f, { t: i * 0.05, dur: 0.12, gain: 0.14 })); },
  end() { [392, 494, 587].forEach((f, i) => tone(f, { t: i * 0.09, dur: 0.22, gain: 0.14, type: "triangle" })); },
  blunder() { tone(330, { dur: 0.16, gain: 0.16, type: "sawtooth", slide: 200 }); tone(165, { t: 0.02, dur: 0.22, gain: 0.12, type: "triangle", slide: 110 }); },
  mistake() { tone(300, { dur: 0.12, gain: 0.13, type: "triangle", slide: 240 }); },
  miss() { tone(420, { dur: 0.1, gain: 0.12, type: "triangle", slide: 300 }); },
  inaccuracy() { tone(380, { dur: 0.06, gain: 0.08, type: "triangle" }); },
  great() { tone(988, { dur: 0.12, gain: 0.12 }); tone(1319, { t: 0.06, dur: 0.16, gain: 0.1 }); },
  brilliant() { [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, { t: i * 0.045, dur: 0.18, gain: 0.1 })); noise({ dur: 0.08, gain: 0.04, lp: 6000 }); },
  click() { tone(600, { dur: 0.03, gain: 0.06 }); },
};

export function play(name) {
  if (muted || !S[name]) return;
  try { S[name](); } catch (e) { /* ignore */ }
}

// Sound for a move object from chess.js (flags: c capture, e en passant, k/q castle, p promotion) plus check state.
export function playMove(move, { check = false, mate = false } = {}) {
  if (mate) { play("end"); return; }
  if (check) { play("check"); return; }
  const f = move.flags || "";
  if (move.promotion || f.includes("p")) play("promote");
  else if (f.includes("k") || f.includes("q")) play("castle");
  else if (move.captured || f.includes("c") || f.includes("e")) play("capture");
  else play("move");
}

export function playClass(cls) {
  if (["blunder", "mistake", "miss", "inaccuracy", "great", "brilliant"].includes(cls)) play(cls);
}
