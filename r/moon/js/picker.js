// The "Search for ___" menu: the underlined blank of the sentence, opening onto a short list drawn in the
// page's own type and glass (a native <select> would open the system's menu instead).

export class Picker {
  constructor(root, options, onPick) {
    this.root = root;
    this.btn = root.querySelector('.pick-btn');
    this.list = root.querySelector('.pick-list');
    this.text = root.querySelector('.pick-value');
    this.placeholder = this.text.textContent;
    this.options = options;
    this.onPick = onPick;
    this.active = -1;
    this.current = '';
    this.list.replaceChildren(...options.map((o, i) => {
      const li = document.createElement('li');
      li.id = `${root.id}-opt-${i}`;
      li.className = 'pick-opt';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.i = String(i);
      li.textContent = o.label;
      return li;
    }));

    this.btn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.open(e.key === 'ArrowUp' ? options.length - 1 : 0); }
    });
    this.list.addEventListener('keydown', (e) => {
      const n = options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); this.setActive(e.key === 'Home' ? 0 : n - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (this.active >= 0) this.pick(this.active); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(true); }
      else if (e.key === 'Tab') this.close();
    });
    this.list.addEventListener('pointermove', (e) => {
      const li = e.target.closest('.pick-opt');
      if (li) this.setActive(Number(li.dataset.i));
    });
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('.pick-opt');
      if (li) this.pick(Number(li.dataset.i));
    });
    // a press anywhere else closes it (and goes on to do whatever it would have done)
    document.addEventListener('pointerdown', (e) => { if (this.isOpen && !root.contains(e.target)) this.close(); });
  }

  get isOpen() { return !this.list.hidden; }

  get value() { return this.current; }

  set value(v) {
    const i = this.options.findIndex((o) => o.value === v);
    this.current = i < 0 ? '' : v;
    this.text.textContent = i < 0 ? this.placeholder : this.options[i].label;
    this.root.classList.toggle('is-empty', i < 0);
    this.list.querySelectorAll('.pick-opt').forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
  }

  open(at) {
    this.list.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    const i = this.options.findIndex((o) => o.value === this.current);
    this.setActive(at ?? Math.max(i, 0));
    this.list.focus();
  }

  close(refocus = false) {
    if (!this.isOpen) return;
    this.list.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    this.setActive(-1);
    if (refocus) this.btn.focus();
  }

  setActive(i) {
    this.active = i;
    this.list.querySelectorAll('.pick-opt').forEach((li, k) => li.classList.toggle('is-active', k === i));
    if (i >= 0) this.list.setAttribute('aria-activedescendant', `${this.root.id}-opt-${i}`);
    else this.list.removeAttribute('aria-activedescendant');
  }

  pick(i) {
    this.value = this.options[i].value;
    this.close(true);
    this.onPick(this.options[i]);
  }
}
