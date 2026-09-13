// Pixel-coordinate strokes keep the existing OCR crops compatible. History is
// immutable, bounded, and scaled with the drawing when its CSS size changes.
export function paintStrokes(ctx, strokes, offsetX = 0, offsetY = 0) {
  ctx.strokeStyle = ctx.fillStyle = '#263559';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    const first = stroke[0];
    ctx.beginPath();
    ctx.arc(first.x - offsetX, first.y - offsetY, (2.2 + first.pressure * 3.8) / 2, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1], b = stroke[i];
      ctx.lineWidth = 2.2 + b.pressure * 3.8;
      ctx.beginPath(); ctx.moveTo(a.x - offsetX, a.y - offsetY);
      ctx.lineTo(b.x - offsetX, b.y - offsetY); ctx.stroke();
    }
  }
}

function distance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export class Drawing {
  constructor(canvas, onChange = () => {}, limits = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onChange = onChange;
    this.limits = { strokes: 400, points: 3000, total: 24000, history: 30, ...limits };
    this.strokes = []; this.history = []; this.redoStack = [];
    this.pointer = null; this.before = null; this.mode = 'pen'; this.ignoreTouch = false;
    this.enabled = true; this.width = 0; this.height = 0;
    canvas.style.touchAction = 'none';
    for (const [event, method] of Object.entries({ pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel', lostpointercapture: 'cancel' })) {
      canvas.addEventListener(event, e => this[method](e));
    }
  }
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(this.width, (e.clientX - r.left) * this.width / (r.width || 1))),
      y: Math.max(0, Math.min(this.height, (e.clientY - r.top) * this.height / (r.height || 1))),
      pressure: Math.max(0, Math.min(1, e.pressure || 0.5)) };
  }
  notify(reason) { this.draw(); this.onChange(reason); }
  down(e) {
    if (!this.enabled || this.pointer !== null || e.button !== 0 || (this.ignoreTouch && e.pointerType === 'touch')) return;
    const total = this.strokes.reduce((n, s) => n + s.length, 0);
    if (this.mode !== 'eraser' && (this.strokes.length >= this.limits.strokes || total >= this.limits.total)) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { return; }
    this.pointer = e.pointerId; this.before = this.strokes; this.gestureMode = this.mode;
    this.total = total; this.last = this.point(e);
    if (this.gestureMode === 'eraser') this.erase(this.last);
    else { this.strokes = [...this.strokes, [this.last]]; this.total++; }
    this.notify('start');
  }
  erase(p) {
    // Sample the eraser sweep, not just sparse pointer events, to avoid skipping
    // thin strokes between events. Each entire gesture is one undoable action.
    const from = this.last || p, steps = Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / 7) || 1;
    for (let i = 0; i <= steps; i++) {
      const q = { x: from.x + (p.x - from.x) * i / steps, y: from.y + (p.y - from.y) * i / steps };
      const kept = this.strokes.filter(s => !s.some((a, j) => distance(q, a, s[Math.max(0, j - 1)]) <= 15));
      if (kept.length !== this.strokes.length) this.strokes = kept;
    }
  }
  move(e) {
    if (this.pointer === null || e.pointerId !== this.pointer) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() || [];
    for (const event of events.length ? [...events, e] : [e]) {
      const p = this.point(event);
      if (this.gestureMode === 'eraser') this.erase(p);
      else {
        const stroke = this.strokes.at(-1), previous = stroke.at(-1);
        if ((previous.x !== p.x || previous.y !== p.y) && stroke.length < this.limits.points && this.total < this.limits.total) {
          this.strokes = [...this.strokes.slice(0, -1), [...stroke, p]]; this.total++;
        }
      }
      this.last = p;
    }
    this.notify('move');
  }
  finish() {
    const pointer = this.pointer;
    this.pointer = null; this.before = null; this.last = null;
    if (pointer !== null && this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
  }
  remember(before) {
    this.history.push(before);
    if (this.history.length > this.limits.history) this.history.shift();
    this.redoStack = [];
  }
  up(e) {
    if (this.pointer === null || e.pointerId !== this.pointer) return;
    this.move(e);
    if (this.strokes !== this.before) this.remember(this.before);
    this.finish(); this.notify('finish');
  }
  cancel(e) {
    if (this.pointer === null || (e && e.pointerId !== this.pointer)) return;
    this.strokes = this.before; this.finish(); this.notify('cancel');
  }
  undo() {
    if (!this.enabled) return;
    this.cancel();
    if (!this.history.length) return;
    this.redoStack.push(this.strokes); this.strokes = this.history.pop(); this.notify('undo');
  }
  redo() {
    if (!this.enabled) return;
    this.cancel();
    if (!this.redoStack.length) return;
    this.history.push(this.strokes); this.strokes = this.redoStack.pop(); this.notify('redo');
  }
  clear() {
    if (!this.enabled) return;
    this.cancel();
    if (!this.strokes.length) return;
    this.remember(this.strokes); this.strokes = []; this.notify('clear');
  }
  reset() {
    this.finish(); this.strokes = []; this.history = []; this.redoStack = []; this.notify('reset');
  }
  resize(scale = globalThis.devicePixelRatio || 1) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    // Hidden workspaces report zero; never destroy their coordinate system.
    if (!w || !h) return;
    if (w !== this.width || h !== this.height) {
      this.cancel();
      if (this.width && this.height) {
        const sx = w / this.width, sy = h / this.height;
        const scaled = new Map();
        const transform = strokes => strokes.map(stroke => {
          if (!scaled.has(stroke)) scaled.set(stroke, stroke.map(p => ({ ...p, x: p.x * sx, y: p.y * sy })));
          return scaled.get(stroke);
        });
        this.strokes = transform(this.strokes);
        this.history = this.history.map(transform); this.redoStack = this.redoStack.map(transform);
      }
      this.width = w; this.height = h;
    }
    this.canvas.width = Math.round(w * scale); this.canvas.height = Math.round(h * scale);
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0); this.notify('resize');
  }
  draw() { this.ctx.clearRect(0, 0, this.width, this.height); paintStrokes(this.ctx, this.strokes); }
}