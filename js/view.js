'use strict';
// Pan/zoom viewport shared by the schematic and PCB canvases.
class Viewport {
  constructor(svg, { min = 0.2, max = 40, scale = 2, onChange } = {}) {
    Object.assign(this, { svg, min, max, s: scale, cx: 0, cy: 0, onChange });
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this.toWorld(e.clientX, e.clientY), r = svg.getBoundingClientRect();
      this.s = Math.min(this.max, Math.max(this.min, this.s * Math.exp(-e.deltaY * 0.0015)));
      this.cx = p.x - (e.clientX - r.left - r.width / 2) / this.s;
      this.cy = p.y - (e.clientY - r.top - r.height / 2) / this.s;
      this.apply();
    }, { passive: false });
    new ResizeObserver(() => this.apply()).observe(svg);
  }
  toWorld(x, y) {
    const r = this.svg.getBoundingClientRect();
    return { x: this.cx + (x - r.left - r.width / 2) / this.s, y: this.cy + (y - r.top - r.height / 2) / this.s };
  }
  apply() {
    const r = this.svg.getBoundingClientRect(); if (!r.width) return;
    const w = r.width / this.s, h = r.height / this.s;
    this.vb = [this.cx - w / 2, this.cy - h / 2, w, h];
    this.svg.setAttribute('viewBox', this.vb.join(' '));
    this.onChange && this.onChange(this.vb);
  }
  fit(b, pad) {
    const r = this.svg.getBoundingClientRect(); if (!r.width || !b) return;
    const bw = b[2] - b[0] + 2 * pad, bh = b[3] - b[1] + 2 * pad;
    this.s = Math.min(this.max, Math.max(this.min, Math.min(r.width / bw, r.height / bh)));
    this.cx = (b[0] + b[2]) / 2; this.cy = (b[1] + b[3]) / 2; this.apply();
  }
  panBy(dxPx, dyPx) { this.cx -= dxPx / this.s; this.cy -= dyPx / this.s; this.apply(); }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
