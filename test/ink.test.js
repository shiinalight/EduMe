import test from 'node:test';
import assert from 'node:assert/strict';
import { InkCanvas, exampleInk, WIDTH, HEIGHT } from '../public/ink.js';

// Minimal canvas test double: tests geometry and pointer-state logic, not browser rendering.
function setup() {
  const ctx = new Proxy({}, { get: (_, key) => ['strokeStyle','lineCap','lineJoin','fillStyle','lineWidth'].includes(key) ? null : () => {} });
  const canvas = { getContext: () => ctx, addEventListener() {}, getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 320 }), setPointerCapture() {}, hasPointerCapture: () => false };
  globalThis.ResizeObserver = class { observe() {} };
  let ink; ink = new InkCanvas(canvas, phase => { if (phase === 'finish') ink.commitHistory(); });
  const event = (x, y, extra = {}) => ({ clientX: x, clientY: y, pressure: .5, timeStamp: 10, pointerId: 1, pointerType: 'pen', button: 0, preventDefault() {}, ...extra });
  return { ink, event };
}
test('scaled handwriting coordinates, pointer end, undo, redo, and clear', () => {
  const { ink, event } = setup(); ink.down(event(110, 70)); ink.move(event(160, 120)); ink.up(event(170, 130));
  assert.equal(ink.strokes.length, 1); assert.equal(ink.strokes[0].points[0].x, 200); assert.equal(ink.strokes[0].points[0].y, 100);
  assert.equal(ink.pointer, null); ink.undo(); assert.equal(ink.strokes.length, 0); ink.redo(); assert.equal(ink.strokes.length, 1);
  ink.clear(); assert.equal(ink.strokes.length, 0); ink.undo(); assert.equal(ink.strokes.length, 1);
  assert.equal(ink.export().width, WIDTH); assert.equal(ink.export().height, HEIGHT);
});
test('ignore-touch mode, second-pointer rejection, and cancelled-stroke rollback', () => {
  const { ink, event } = setup(); ink.ignoreTouch = true; ink.down(event(50, 50, { pointerType: 'touch' })); assert.equal(ink.strokes.length, 0);
  ink.down(event(50, 50)); ink.down(event(55, 55, { pointerId: 2 })); assert.equal(ink.strokes.length, 1);
  ink.cancel(event(50, 50)); assert.equal(ink.strokes.length, 0); assert.equal(ink.pointer, null);
});
test('stroke eraser detects a point between sparse endpoints and is undoable', () => {
  const { ink, event } = setup(); ink.set([{ id: 'long', width: 4, points: [{ x: 0, y: 100, pressure: .5 }, { x: 1000, y: 100, pressure: .5 }] }]);
  ink.mode = 'eraser'; ink.down(event(260, 70)); ink.up(event(260, 70)); assert.equal(ink.strokes.length, 0); ink.undo(); assert.equal(ink.strokes.length, 1);
});
test('fixed sample consists of real, bounded vector strokes and is independently exported', () => {
  const { ink } = setup(); ink.set(exampleInk()); const exported = ink.export(); assert(exported.strokes.length > 5);
  assert(exported.strokes.every(s => s.pointer_type === 'sample' && s.points.every(p => p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT)));
  exported.strokes[0].points[0].x = 9999; assert.notEqual(ink.strokes[0].points[0].x, 9999);
});

for (const ignoreTouch of [false, true]) {
  test(`mouse drawing, erasing, and exported ink work with ignoreTouch=${ignoreTouch}`, () => {
    const { ink, event } = setup(); ink.ignoreTouch = ignoreTouch;
    const mouse = (x, y, extra = {}) => event(x, y, { pointerType: 'mouse', pressure: 0, ...extra });
    ink.down(mouse(110, 70)); ink.move(mouse(160, 70)); ink.up(mouse(170, 70));
    const exported = ink.export();
    assert.equal(exported.strokes.length, 1);
    assert.equal(exported.strokes[0].pointer_type, 'mouse');
    assert.equal(exported.strokes[0].points.length, 3);
    assert.equal(exported.strokes[0].points[0].pressure, .5);
    ink.undo(); assert.equal(ink.strokes.length, 0);
    ink.redo(); assert.equal(ink.strokes.length, 1);
    ink.mode = 'eraser'; ink.down(mouse(140, 70)); ink.up(mouse(140, 70));
    assert.equal(ink.strokes.length, 0);
    ink.undo(); assert.equal(ink.strokes.length, 1);
    ink.mode = 'pen'; ink.down(mouse(110, 70, { button: 2 }));
    assert.equal(ink.pointer, null); assert.equal(ink.strokes.length, 1);
  });
}
test('finger drawing remains available by default', () => {
  const { ink, event } = setup();
  ink.down(event(110, 70, { pointerType: 'touch' }));
  ink.up(event(160, 70, { pointerType: 'touch' }));
  assert.equal(ink.export().strokes[0].pointer_type, 'touch');
});
