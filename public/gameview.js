// The parts of a chess site's game screen: a two-column move list, an
// evaluation timeline, an evaluation bar and player lines. Ported from the
// a-review project. They only draw; app.js decides what they show.

const MARK = { inaccuracy: '?!', mistake: '?', blunder: '??' };

// Chance of winning for White, in percent, from a centipawn score (the Lichess curve).
export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);

// A move's accuracy from the winning chances it gave away (0-100).
const accuracyOf = (loss) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

// One side's accuracy over a reviewed game, or null if that side made no moves.
export function accuracy(moves, color) {
  const mine = moves.filter((m) => m.color === color);
  return mine.length ? mine.reduce((sum, m) => sum + accuracyOf(m.loss || 0), 0) / mine.length : null;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// Rows of "12.  Nf3  Nc6", each move a button. Mistakes carry a small badge.
export class MoveList {
  constructor(root, onSelect) {
    this.root = root;
    this.onSelect = onSelect;
  }

  // moves: [{ san, cls }] in order from the first move. selectable: whether clicking a move does anything.
  set(moves, selectable = true) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < moves.length; i += 2) {
      const row = el('div', 'mv-row');
      row.append(el('div', 'no', `${i / 2 + 1}.`));
      for (const j of [i, i + 1]) {
        if (j >= moves.length) {
          row.append(el('div'));
          continue;
        }
        const b = el('button', `mv ${moves[j].cls || ''}`);
        b.type = 'button';
        b.dataset.ply = j + 1;
        b.disabled = !selectable;
        const mini = el('span', `mini ${moves[j].cls || ''}`, MARK[moves[j].cls] || '');
        b.append(mini, el('span', 'san', moves[j].san));
        if (selectable) b.addEventListener('click', () => this.onSelect(j + 1));
        row.append(b);
      }
      frag.append(row);
    }
    this.root.replaceChildren(frag);
  }

  // Marks the move that led to the position on the board (0 = the start).
  highlight(ply) {
    let current = null;
    for (const b of this.root.querySelectorAll('.mv')) {
      const on = Number(b.dataset.ply) === ply;
      b.classList.toggle('cur', on);
      if (on) current = b;
    }
    if (current) {
      const top = current.offsetTop - this.root.offsetTop;
      if (top < this.root.scrollTop || top > this.root.scrollTop + this.root.clientHeight - 30) this.root.scrollTop = top - this.root.clientHeight / 2;
    } else if (ply === 0) this.root.scrollTop = 0;
    else this.root.scrollTop = this.root.scrollHeight;
  }
}

// White's winning chances across the game as a filled area, with a dot on
// each mistake and a cursor at the move being shown. Click to jump there.
const W = 600;
const H = 84;
const svgEl = (tag, attrs) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

export class EvalGraph {
  constructor(svg, tip, onSelect) {
    this.svg = svg;
    this.tip = tip;
    this.points = [];
    this.labels = [];
    this.area = svgEl('path', { fill: '#f0ede4' });
    this.dots = svgEl('g', {});
    this.future = svgEl('rect', { y: 0, height: H, fill: 'rgba(13,20,16,.45)' });
    this.hover = svgEl('line', { y1: 0, y2: H, stroke: 'rgba(232,237,229,.35)', 'stroke-width': 1, visibility: 'hidden' });
    this.cursorLine = svgEl('line', { y1: 0, y2: H, stroke: 'var(--accent)', 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' });
    svg.replaceChildren(
      svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#2b332d' }),
      this.area,
      svgEl('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, stroke: 'rgba(111,208,138,.45)', 'stroke-width': 1 }),
      this.future,
      this.dots,
      this.hover,
      this.cursorLine
    );
    const at = (e) => {
      const r = svg.getBoundingClientRect();
      const n = this.points.length;
      return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    };
    svg.addEventListener('click', (e) => this.points.length && onSelect(at(e)));
    svg.addEventListener('mousemove', (e) => {
      if (!this.points.length) return;
      const i = at(e);
      this.hover.setAttribute('x1', this.x(i));
      this.hover.setAttribute('x2', this.x(i));
      this.hover.setAttribute('visibility', 'visible');
      tip.textContent = this.labels[i] || '';
      tip.hidden = !tip.textContent;
      const r = svg.getBoundingClientRect();
      tip.style.left = `${Math.max(60, Math.min(r.width - 60, (this.x(i) / W) * r.width))}px`;
    });
    svg.addEventListener('mouseleave', () => {
      this.hover.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  x(i) {
    return this.points.length > 1 ? (i / (this.points.length - 1)) * W : 0;
  }

  // points: White's winning chances at the start and after every move.
  // marks: [{ i, cls }] for the moves worth a dot. labels: hover text per point.
  set(points, marks, labels) {
    this.points = points;
    this.labels = labels;
    const y = (wp) => H - (wp / 100) * H;
    let d = `M 0 ${H}`;
    points.forEach((wp, i) => (d += ` L ${this.x(i).toFixed(1)} ${y(wp).toFixed(1)}`));
    this.area.setAttribute('d', `${d} L ${W} ${H} Z`);
    this.dots.replaceChildren(
      ...marks.map(({ i, cls }) =>
        svgEl('circle', { cx: this.x(i).toFixed(1), cy: y(points[i]).toFixed(1), r: cls === 'inaccuracy' ? 2.5 : 4, fill: `var(--c-${cls})`, stroke: '#0d1410', 'stroke-width': 1 })
      )
    );
  }

  cursor(i) {
    const x = this.x(i);
    this.cursorLine.setAttribute('x1', x);
    this.cursorLine.setAttribute('x2', x);
    this.future.setAttribute('x', x);
    this.future.setAttribute('width', Math.max(0, W - x));
  }
}

// The bar beside the board: how much of it is white is White's winning chances.
export function renderEvalBar(bar, cp, text, flipped) {
  const wp = Math.max(3, Math.min(97, winPct(cp)));
  bar.classList.toggle('flipped', flipped);
  bar.querySelector('.white').style.height = `${wp}%`;
  const label = bar.querySelector('.label');
  label.textContent = text;
  const whiteWinning = wp >= 50;
  label.className = `label ${whiteWinning ? 'on-white' : 'on-black'}`;
  // The number sits inside the larger part, at its outer end.
  const atBottom = whiteWinning ? !flipped : flipped;
  label.style.top = atBottom ? 'auto' : '0';
  label.style.bottom = atBottom ? '0' : 'auto';
}

// "A  Anna  (you)            91.2 accuracy  ●"
export function renderPlayerLine(line, { name, color, you, accuracy: acc, active }) {
  const left = el('span', 'name');
  left.append(el('span', `avatar ${color}`, (name[0] || '?').toUpperCase()), el('b', '', name));
  if (you) left.append(el('span', 'you', 'you'));
  const right = el('span', 'right');
  if (acc !== null && acc !== undefined) {
    const a = el('span', 'acc', acc.toFixed(1));
    a.append(el('small', '', 'accuracy'));
    right.append(a);
  }
  const turn = el('span', `turn ${active ? 'active' : ''}`);
  turn.append(el('span', 'dot'));
  right.append(turn);
  line.classList.toggle('active', Boolean(active));
  line.replaceChildren(left, right);
}
