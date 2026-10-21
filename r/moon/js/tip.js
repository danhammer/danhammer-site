// The small name tag that follows the pointer over a tile.

export class Tip {
  constructor(items, root) {
    this.items = items;
    this.root = root;
    this.index = null;
  }

  show(index, x, y) {
    if (index == null) { this.root.classList.remove('is-shown'); this.index = null; return; }
    if (index !== this.index) {
      const it = this.items[index];
      const title = document.createElement('span');
      title.className = 'tip-title';
      title.textContent = it.title;
      this.root.replaceChildren(title);
      this.root.style.setProperty('--work', it.color || '#9a958c');
      this.index = index;
    }
    const w = this.root.offsetWidth || 220;
    const left = x + 16 + w > window.innerWidth ? x - 16 - w : x + 16;
    this.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(y + 14)}px)`;
    this.root.classList.add('is-shown');
  }
}
