// The side panel: the tiles nearest a search or a clicked tile, hung as a salon wall, with Gemma's
// note beside whichever piece the pointer rests on.

const SOURCE = 'The Moon · LOLA via OpenPlanetaryMap';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// One hung piece: the tile's picture with a museum label.
function piece(it, n, { large = false } = {}) {
  const fig = el('figure', `piece${large ? ' piece--large' : ''}`);
  fig.dataset.index = String(n.index);
  fig.style.setProperty('--work', it.color || '#9a958c');
  const frame = el('div', 'frame');
  const img = el('img');
  img.src = it.thumb;
  img.alt = it.title;
  img.decoding = 'async';
  frame.appendChild(img);
  fig.appendChild(frame);
  const cap = el('figcaption', 'label');
  cap.appendChild(el('span', 'label-no', `No. ${n.rank}`));
  cap.appendChild(el('span', 'label-title', it.title));
  if (it.creator) cap.appendChild(el('span', 'label-meta', it.creator));
  cap.appendChild(el('span', 'label-src', SOURCE));
  fig.appendChild(cap);
  return fig;
}

// Salon hang: rank 1 across the top, then each piece goes to the shorter of two columns.
function hangInto(container, items, neighbors) {
  container.replaceChildren();
  const lead = piece(items[neighbors[0].index], neighbors[0], { large: true });
  lead.classList.add('piece--lead');
  container.appendChild(lead);
  const row = el('div', 'hang-cols');
  const columns = [el('div', 'hang-col'), el('div', 'hang-col')];
  row.append(...columns);
  neighbors.slice(1).forEach((n, i) => columns[i % 2].appendChild(piece(items[n.index], n)));   // tiles are square
  container.appendChild(row);
  container.querySelectorAll('.piece').forEach((p, i) => p.style.setProperty('--i', i));
}

export class Wall {
  constructor({ items, onHover, onClose }) {
    this.items = items;
    this.panel = document.getElementById('wall');
    this.hang = document.getElementById('hang');
    this.label = document.getElementById('wall-label');
    this.hang.addEventListener('pointerover', (e) => {
      const p = e.target.closest('.piece');
      if (!p) return;
      onHover(Number(p.dataset.index));
      this.showLabel(p);
    });
    this.hang.addEventListener('pointerout', (e) => {
      const p = e.target.closest('.piece');
      if (p && !p.contains(e.relatedTarget)) { onHover(null); this.hideLabel(); }
    });
    this.hang.addEventListener('scroll', () => this.hideLabel(), { passive: true });
    document.getElementById('close-wall').addEventListener('click', onClose);
  }

  render(result) {
    const { neighbors, query, weak } = result;
    const fromTile = result.item != null;   // opened from a clicked tile: its title, not a quoted query
    document.getElementById('wall-title').textContent = fromTile ? this.items[result.item].title : `“${query}”`;
    const k = document.getElementById('wall-kicker');
    k.textContent = fromTile ? 'Nearest to' : weak ? 'Weak matches' : 'Nearest tiles';
    k.classList.toggle('is-weak', !!weak);
    document.getElementById('wall-sub').textContent = `${neighbors.length} tiles`;
    hangInto(this.hang, this.items, neighbors);
    this.hang.scrollTop = 0;
  }

  // The wall label: Gemma's note hung beside the piece, on the side with more room.
  showLabel(pieceEl) {
    const it = this.items[Number(pieceEl.dataset.index)];
    const lab = this.label;
    lab.querySelector('.wall-label-text').textContent = it.summary;
    lab.style.setProperty('--work', it.color || '#9a958c');
    const r = pieceEl.querySelector('.frame').getBoundingClientRect();
    const w = lab.offsetWidth, h = lab.offsetHeight, gap = 18, vw = window.innerWidth, vh = window.innerHeight;
    const left = r.left - gap - w >= 12 ? r.left - gap - w : Math.min(r.right + gap, vw - w - 12);
    const top = Math.min(Math.max(r.top, 12), vh - h - 12);
    lab.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    lab.classList.add('is-shown');
  }

  hideLabel() {
    this.label.classList.remove('is-shown');
  }

  show() {
    this.panel.classList.add('is-open');
    this.panel.setAttribute('aria-hidden', 'false');
  }

  hide() {
    this.hideLabel();
    this.panel.classList.remove('is-open');
    this.panel.setAttribute('aria-hidden', 'true');
  }

  mark(index) {
    for (const p of document.querySelectorAll('.piece.is-linked')) p.classList.remove('is-linked');
    if (index == null) return;
    for (const p of document.querySelectorAll(`.piece[data-index="${index}"]`)) p.classList.add('is-linked');
  }

  panelWidth() {
    return this.panel.getBoundingClientRect().width;
  }
}
