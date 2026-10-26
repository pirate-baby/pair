// A simulated mouse pointer, so the user can follow what the presenter is "doing".

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeCursor {
  private el: HTMLDivElement;
  private x = window.innerWidth / 2;
  private y = window.innerHeight / 2;
  private shown = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "fake-cursor";
    this.el.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 10.5-6.6 1.2 3.9 7.6-2.7 1.4-3.9-7.7L4 19.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(this.el);
    this.place(0);
  }

  private place(ms: number) {
    this.el.style.transitionDuration = `${ms}ms`;
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
  }

  async moveTo(x: number, y: number) {
    if (!this.shown) {
      this.shown = true;
      this.x = x + 60;
      this.y = y + 40;
      this.place(0);
      this.el.classList.add("visible");
      await sleep(30);
    }
    const dist = Math.hypot(x - this.x, y - this.y);
    const ms = Math.round(Math.min(650, Math.max(180, dist * 0.9)));
    this.x = x;
    this.y = y;
    this.place(ms);
    await sleep(ms + 40);
  }

  async moveToElement(el: Element, opts: { dx?: number } = {}) {
    const r = el.getBoundingClientRect();
    await this.moveTo(r.left + (opts.dx ?? Math.min(48, r.width / 2)), r.top + r.height / 2);
  }

  async click() {
    const ripple = document.createElement("div");
    ripple.className = "click-ripple";
    ripple.style.left = `${this.x}px`;
    ripple.style.top = `${this.y}px`;
    document.body.appendChild(ripple);
    this.el.classList.add("pressed");
    await sleep(120);
    this.el.classList.remove("pressed");
    setTimeout(() => ripple.remove(), 600);
    await sleep(80);
  }

  /** Glide (used for drag-selecting code) without the travel-time floor. */
  async glideTo(x: number, y: number, ms: number) {
    this.x = x;
    this.y = y;
    this.place(ms);
    await sleep(ms);
  }
}
