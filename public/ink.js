import { uuid } from './ids.js';
export const WIDTH = 1200, HEIGHT = 640;
/** Resolution-independent pen strokes; pressure is kept for later ink models. */
export class InkCanvas {
  constructor(canvas, onChange) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onChange = onChange;
    this.strokes = []; this.redoStack = []; this.mode = 'pen'; this.ignoreTouch = false;
    this.active = null; this.pointer = null; this.enabled = true; this.eraserBefore = null;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.cancel(e));
    canvas.addEventListener('lostpointercapture', e => this.cancel(e));
    this.resize = new ResizeObserver(() => this.draw()); this.resize.observe(canvas);
    this.draw();
  }
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(WIDTH, (e.clientX - r.left) / r.width * WIDTH)), y: Math.max(0, Math.min(HEIGHT, (e.clientY - r.top) / r.height * HEIGHT)), pressure: e.pressure || 0.5, t: Math.round(e.timeStamp) };
  }
  down(e) {
    if (!this.enabled || this.pointer !== null || (this.ignoreTouch && e.pointerType === 'touch') || e.button !== 0) return;
    e.preventDefault(); this.pointer = e.pointerId; this.canvas.setPointerCapture(e.pointerId);
    this.before = structuredClone(this.strokes); this.redoStack = [];
    if (this.mode === 'eraser') this.erase(this.point(e));
    else { this.active = { id: uuid(), tool: 'pen', width: 4, pointer_type: e.pointerType, points: [this.point(e)] }; this.strokes.push(this.active); }
    this.draw(); this.onChange('start');
  }
  move(e) {
    if (e.pointerId !== this.pointer) return; e.preventDefault();
    const events = e.getCoalescedEvents?.() || [e];
    for (const event of events.length ? events : [e]) {
      if (this.mode === 'eraser') this.erase(this.point(event));
      else if (this.active && this.active.points.length < 12000) this.active.points.push(this.point(event));
    }
    this.draw();
  }
  up(e) {
    if (e.pointerId !== this.pointer) return;
    this.move(e); this.finish(); this.onChange('finish');
  }
  cancel(e) {
    if (e.pointerId !== this.pointer) return;
    this.strokes = this.before || []; this.finish(); this.draw(); this.onChange('cancel');
  }
  finish() { const pointer = this.pointer; this.pointer = null; this.active = null; if (pointer !== null && this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer); }
  erase(p) {
    const distance = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const ratio = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - a.x - ratio * dx, p.y - a.y - ratio * dy);
    };
    this.strokes = this.strokes.filter(s => !s.points.some((q, i) => distance(q, s.points[Math.max(0, i - 1)]) < 15));
  }
  // History stores whole snapshots, so an eraser gesture can be undone too.
  commitHistory() { this.history ||= []; if (this.before && JSON.stringify(this.before) !== JSON.stringify(this.strokes)) this.history.push(this.before); this.before = null; }
  undo() { if (!this.history?.length) return; this.redoStack.push(structuredClone(this.strokes)); this.strokes = this.history.pop(); this.draw(); this.onChange('undo'); }
  redo() { if (!this.redoStack.length) return; this.history ||= []; this.history.push(structuredClone(this.strokes)); this.strokes = this.redoStack.pop(); this.draw(); this.onChange('redo'); }
  clear() { if (!this.strokes.length) return; this.history ||= []; this.history.push(structuredClone(this.strokes)); this.redoStack = []; this.strokes = []; this.draw(); this.onChange('clear'); }
  set(strokes) { this.finish(); this.strokes = structuredClone(strokes || []); this.history = []; this.redoStack = []; this.draw(); }
  paint(ctx, strokes = this.strokes) {
    ctx.strokeStyle = '#263559'; ctx.fillStyle = '#263559'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (!s.points.length) continue;
      if (s.points.length === 1) { const p = s.points[0]; ctx.beginPath(); ctx.arc(p.x, p.y, s.width / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      for (let i = 1; i < s.points.length; i++) { const a = s.points[i - 1], b = s.points[i]; ctx.lineWidth = s.width * (.65 + (a.pressure + b.pressure) / 2); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  }
  draw() { this.ctx.clearRect(0, 0, WIDTH, HEIGHT); this.paint(this.ctx); }
  image() {
    if (!this.strokes.length) return null;
    let left = WIDTH, right = 0, top = HEIGHT, bottom = 0;
    for (const s of this.strokes) for (const p of s.points) { left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
    left = Math.max(0, Math.floor(left - 30)); top = Math.max(0, Math.floor(top - 30)); right = Math.min(WIDTH, Math.ceil(right + 30)); bottom = Math.min(HEIGHT, Math.ceil(bottom + 30));
    const temp = document.createElement('canvas'); temp.width = Math.max(64, right - left); temp.height = Math.max(64, bottom - top);
    const ctx = temp.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, temp.width, temp.height); ctx.translate(-left, -top); this.paint(ctx);
    return temp.toDataURL('image/png');
  }
  export() { return { coordinate_system: 'canvas', width: WIDTH, height: HEIGHT, strokes: structuredClone(this.strokes) }; }
}

/** Deliberately fixed sample: 2x + 3 = 11. These are real vector strokes. */
export function exampleInk() {
  const paths = [
    [[160,215],[166,203],[180,197],[196,201],[205,211],[204,224],[193,236],[178,250],[161,268],[207,268]],
    [[228,222],[261,269]], [[260,221],[225,270]],
    [[292,242],[332,242]], [[312,222],[312,263]],
    [[368,206],[388,198],[405,205],[410,217],[401,230],[385,235],[401,237],[413,247],[410,260],[398,270],[378,270],[367,265]],
    [[447,232],[488,232]], [[447,253],[488,253]],
    [[528,214],[546,199],[546,268]], [[570,213],[588,198],[588,268]],
  ];
  return paths.map((points, i) => ({ id: `example-stroke-${i}`, tool: 'pen', width: 4, pointer_type: 'sample', points: points.map(([x, y], n) => ({ x, y, pressure: .5, t: i * 200 + n * 20 })) }));
}
