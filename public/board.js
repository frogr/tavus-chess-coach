// Board renderer: persistent piece elements that slide between squares,
// drag-or-click moves with legal-move dots, capture fades, a check glow,
// drawn arrows, coach highlights and review badges. Ported from a-review.
import { Chess } from "/vendor/chess.js";

const FILES = "abcdefgh";
const NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const SIDES = { w: "White", b: "Black" };
// Review badges for the move just shown.
const CLASSES = {
  blunder: { sym: "??", color: "var(--c-blunder)" },
  mistake: { sym: "?", color: "var(--c-mistake)" },
  inaccuracy: { sym: "?!", color: "var(--c-inaccuracy)" },
};

export class Board {
  // onMove(from, to, promotion): the student made a legal move.
  // canMove(): asked at every interaction, so the app decides when the board is live.
  constructor(el, { onMove, canMove } = {}) {
    this.el = el;
    this.onMove = onMove || (() => {});
    this.canMove = canMove || (() => true);
    this.highlights = [];
    this.orientation = "w";
    this.pieces = new Map(); // square -> {type,color,el}
    this.fen = null;
    this.chess = new Chess();
    this.selected = null;
    this.lastMove = null;
    this.badge = null;
    this.checkSq = null;
    this.promo = el.querySelector(".promo");
    this._build();
    this._bindPointer();
  }

  _build() {
    this.squares = new Map();
    for (let i = 0; i < 64; i++) {
      const d = document.createElement("div");
      d.className = "sq";
      d.dataset.i = i;
      d.tabIndex = 0;
      d.setAttribute("role", "button");
      d.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        this._activate(d.dataset.sq);
      });
      this.el.insertBefore(d, this.promo);
    }
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "arrows");
    this.svg.setAttribute("viewBox", "0 0 8 8");
    this.el.appendChild(this.svg);
    this.badgeEl = document.createElement("div");
    this.badgeEl.className = "badge";
    this.badgeEl.style.display = "none";
    this.el.appendChild(this.badgeEl);
    this._layoutSquares();
  }

  _sqAt(i) {
    const col = i % 8, row = Math.floor(i / 8);
    const file = this.orientation === "w" ? col : 7 - col;
    const rank = this.orientation === "w" ? 7 - row : row;
    return FILES[file] + (rank + 1);
  }
  _pos(square) {
    const file = FILES.indexOf(square[0]), rank = +square[1] - 1;
    const col = this.orientation === "w" ? file : 7 - file;
    const row = this.orientation === "w" ? 7 - rank : rank;
    return { col, row };
  }
  _layoutSquares() {
    const sqs = this.el.querySelectorAll(".sq");
    sqs.forEach((d, i) => {
      const sq = this._sqAt(i);
      const file = FILES.indexOf(sq[0]), rank = +sq[1] - 1;
      d.className = "sq " + ((file + rank) % 2 === 0 ? "dark" : "light");
      d.dataset.sq = sq;
      d.innerHTML = "";
      const col = i % 8, row = Math.floor(i / 8);
      if (row === 7) { const c = document.createElement("span"); c.className = "coord file"; c.textContent = sq[0]; d.appendChild(c); }
      if (col === 0) { const c = document.createElement("span"); c.className = "coord rank"; c.textContent = sq[1]; d.appendChild(c); }
      this.squares.set(sq, d);
    });
  }

  flip() { this.setOrientation(this.orientation === "w" ? "b" : "w"); }
  setOrientation(o) {
    if (o === this.orientation) return;
    this.orientation = o;
    this._layoutSquares();
    for (const [sq, p] of this.pieces) this._place(p.el, sq, false);
    this._paintHighlights();
    this._paintBadge(false);
    this.setArrows(this._arrows || [], false);
  }

  _place(el, square, animate = true) {
    const { col, row } = this._pos(square);
    if (!animate) el.style.transition = "none";
    el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    if (!animate) { void el.offsetWidth; el.style.transition = ""; }
  }

  setPosition(fen, { lastMove = null, animate = true } = {}) {
    const same = fen === this.fen;
    this.fen = fen;
    this.chess = new Chess(fen);
    this.lastMove = lastMove;
    this.selected = null;
    if (!same) {
      const next = new Map();
      for (const row of this.chess.board()) for (const p of row) if (p) next.set(p.square, { type: p.type, color: p.color });
      const removed = [], added = [];
      for (const [sq, p] of this.pieces) {
        const n = next.get(sq);
        if (!n || n.type !== p.type || n.color !== p.color) removed.push({ sq, ...p });
      }
      for (const [sq, n] of next) {
        const o = this.pieces.get(sq);
        if (!o || o.type !== n.type || o.color !== n.color) added.push({ sq, ...n });
      }
      const newPieces = new Map(this.pieces);
      for (const r of removed) newPieces.delete(r.sq);
      for (const a of added) {
        let idx = removed.findIndex((r) => r.type === a.type && r.color === a.color && lastMove && r.sq === lastMove.from);
        if (idx < 0) idx = removed.findIndex((r) => r.type === a.type && r.color === a.color);
        let el;
        if (idx >= 0) { el = removed[idx].el; removed.splice(idx, 1); this._place(el, a.sq, animate); }
        else {
          el = document.createElement("div");
          el.className = "piece";
          el.style.backgroundImage = `url(/pieces/${a.color}${a.type.toUpperCase()}.svg)`;
          this.el.insertBefore(el, this.svg);
          this._place(el, a.sq, false);
        }
        el.dataset.sq = a.sq;
        newPieces.set(a.sq, { type: a.type, color: a.color, el });
      }
      for (const r of removed) {
        // Captured pieces fade out instead of vanishing.
        if (animate) { r.el.classList.add("fade"); setTimeout(() => r.el.remove(), 220); }
        else r.el.remove();
      }
      this.pieces = newPieces;
    }
    this.checkSq = null;
    if (this.chess.isCheck()) {
      const t = this.chess.turn();
      for (const row of this.chess.board()) for (const p of row) if (p && p.type === "k" && p.color === t) this.checkSq = p.square;
    }
    this.cancelPromotion();
    this.refresh();
    this._paintHighlights();
    this.clearDots();
    for (const [sq, d] of this.squares) {
      const p = this.pieces.get(sq);
      d.setAttribute("aria-label", p ? `${sq}, ${SIDES[p.color]} ${NAMES[p.type]}` : `${sq}, empty`);
    }
  }

  // Re-read canMove(): shows the grab cursor on the side to move only while the board is live.
  refresh() {
    const live = this.canMove();
    const turn = this.chess.turn();
    this.el.classList.toggle("interactive", live);
    for (const [, p] of this.pieces) p.el.classList.toggle("own", live && p.color === turn);
    if (!live) { this.selected = null; this.clearDots(); this._paintHighlights(); }
  }

  // Squares the coach is pointing at.
  setHighlights(squares) {
    this.highlights = squares || [];
    this._paintHighlights();
  }

  // Brief red flash on a square (a wrong try).
  flash(square) {
    const d = this.squares.get(square);
    if (!d) return;
    d.classList.remove("wrong"); void d.offsetWidth; d.classList.add("wrong");
    setTimeout(() => d.classList.remove("wrong"), 700);
  }

  _paintHighlights() {
    for (const [sq, d] of this.squares) {
      d.classList.toggle("last", !!this.lastMove && (sq === this.lastMove.from || sq === this.lastMove.to));
      d.classList.toggle("sel", this.selected === sq);
      d.classList.toggle("check", this.checkSq === sq);
      d.classList.toggle("hl", this.highlights.includes(sq));
    }
  }

  setBadge(square, cls) {
    const changed = !this.badge || !square || this.badge.square !== square || this.badge.cls !== cls;
    this.badge = square && cls ? { square, cls } : null;
    this._paintBadge(changed);
  }
  _paintBadge(pop = false) {
    if (!this.badge) { this.badgeEl.style.display = "none"; return; }
    const { col, row } = this._pos(this.badge.square);
    const c = CLASSES[this.badge.cls];
    const cell = 100 / 8;
    this.badgeEl.style.display = "grid";
    this.badgeEl.style.background = c.color;
    this.badgeEl.textContent = c.sym;
    this.badgeEl.style.left = `${col * cell + cell * 0.7}%`;
    this.badgeEl.style.top = `${row * cell - cell * 0.08}%`;
    this.badgeEl.style.width = `${cell * 0.38}%`;
    this.badgeEl.style.height = `${cell * 0.38}%`;
    this.badgeEl.style.right = "auto";
    if (pop) { this.badgeEl.classList.remove("pop"); void this.badgeEl.offsetWidth; this.badgeEl.classList.add("pop"); }
  }

  setArrows(arrows, animate = true) {
    this._arrows = arrows;
    this.svg.innerHTML = "";
    for (const a of arrows) {
      if (!a.from || !a.to || a.from === a.to) continue;
      const f = this._pos(a.from), t = this._pos(a.to);
      const x1 = f.col + 0.5, y1 = f.row + 0.5, x2 = t.col + 0.5, y2 = t.row + 0.5;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      if (!len) continue;
      const ux = dx / len, uy = dy / len;
      const k = a.thin ? 0.7 : 1;
      const head = 0.32 * k, w = 0.16 * k;
      const sx = x1 + ux * 0.3, sy = y1 + uy * 0.3;
      const bx = x2 - ux * head, by = y2 - uy * head;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const px = -uy, py = ux;
      const d = [
        `M ${sx + px * w / 2} ${sy + py * w / 2}`,
        `L ${bx + px * w / 2} ${by + py * w / 2}`,
        `L ${bx + px * w} ${by + py * w}`,
        `L ${x2} ${y2}`,
        `L ${bx - px * w} ${by - py * w}`,
        `L ${bx - px * w / 2} ${by - py * w / 2}`,
        `L ${sx - px * w / 2} ${sy - py * w / 2}`, "Z",
      ].join(" ");
      path.setAttribute("d", d);
      path.setAttribute("fill", a.color || "var(--arrow)");
      if (a.opacity != null) path.setAttribute("opacity", a.opacity);
      if (animate) path.setAttribute("class", "draw");
      this.svg.appendChild(path);
    }
  }

  showDots(from) {
    this.clearDots();
    const moves = this.chess.moves({ square: from, verbose: true });
    for (const m of moves) {
      const d = this.squares.get(m.to);
      const dot = document.createElement("div");
      dot.className = "dot" + (m.captured ? " capture" : "");
      d.appendChild(dot);
    }
  }
  clearDots() { this.el.querySelectorAll(".dot").forEach((d) => d.remove()); }

  _squareFromEvent(ev) {
    const r = this.el.getBoundingClientRect();
    const col = Math.floor(((ev.clientX - r.left) / r.width) * 8);
    const row = Math.floor(((ev.clientY - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const file = this.orientation === "w" ? col : 7 - col;
    const rank = this.orientation === "w" ? 7 - row : row;
    return FILES[file] + (rank + 1);
  }

  // Click / keyboard on a square: select a piece, or move the selected one here.
  // Returns true when a piece of the side to move is now selected.
  _activate(sq) {
    if (!this.canMove()) return false;
    const p = this.pieces.get(sq);
    const turn = this.chess.turn();
    if (this.selected && sq !== this.selected && !(p && p.color === turn)) { this._tryMove(this.selected, sq); return false; }
    if (!p || p.color !== turn) { this.selected = null; this._paintHighlights(); this.clearDots(); return false; }
    this.selected = sq; this._paintHighlights(); this.showDots(sq);
    return true;
  }

  _bindPointer() {
    let drag = null;
    this.el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.target.closest(".promo")) return;
      const sq = this._squareFromEvent(ev);
      if (!sq || !this._activate(sq)) return;
      const r = this.el.getBoundingClientRect();
      const pc = this.pieces.get(this.selected);
      drag = { sq: this.selected, el: pc.el, r, moved: false };
      pc.el.classList.add("dragging");
      ev.preventDefault();
    });
    const moveHandler = (ev) => {
      if (!drag) return;
      drag.moved = true;
      const cell = drag.r.width / 8;
      const x = ev.clientX - drag.r.left - cell / 2, y = ev.clientY - drag.r.top - cell / 2;
      drag.el.style.transform = `translate(${x}px, ${y}px)`;
    };
    const upHandler = (ev) => {
      if (!drag) return;
      const d = drag; drag = null;
      d.el.classList.remove("dragging");
      const target = this._squareFromEvent(ev);
      this._place(d.el, d.sq, false);
      if (d.moved && target && target !== d.sq) this._tryMove(d.sq, target);
    };
    window.addEventListener("pointermove", moveHandler);
    window.addEventListener("pointerup", upHandler);
    window.addEventListener("pointercancel", upHandler);
  }

  async _tryMove(from, to) {
    const legal = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!legal.length) { this.selected = null; this._paintHighlights(); this.clearDots(); return; }
    let promotion = null;
    if (legal.some((m) => m.promotion)) promotion = await this._askPromotion(legal[0].color);
    this.selected = null; this._paintHighlights(); this.clearDots();
    if (legal.some((m) => m.promotion) && !promotion) return;
    this.onMove(from, to, promotion);
  }

  _askPromotion(color) {
    return new Promise((resolve) => {
      const box = this.promo.querySelector("div");
      box.innerHTML = "";
      for (const t of ["q", "r", "b", "n"]) {
        const b = document.createElement("button");
        b.style.backgroundImage = `url(/pieces/${color}${t.toUpperCase()}.svg)`;
        b.setAttribute("aria-label", `Promote to ${NAMES[t]}`);
        b.onclick = (e) => { e.stopPropagation(); this.promo.classList.remove("show"); resolve(t); };
        box.appendChild(b);
      }
      this.promo.onclick = () => { this.promo.classList.remove("show"); resolve(null); };
      this.promo.classList.add("show");
      this._cancelPromo = () => { this.promo.classList.remove("show"); resolve(null); };
      box.firstChild.focus();
    });
  }

  cancelPromotion() {
    if (this._cancelPromo) { const c = this._cancelPromo; this._cancelPromo = null; c(); }
  }
}
