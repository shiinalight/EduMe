import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Drawing, paintStrokes } from '../static/drawing.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.listeners = new Map(); this.children = []; this.style = {}; this.attributes = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false;
    this.textContent = ''; this.firstChild = { textContent: '' }; this.files = []; this.isConnected = true;
    this.classes = new Set(); this.clientWidth = 600; this.clientHeight = 300; this.captures = new Set();
    this.classList = { add: (...names) => names.forEach(n => this.classes.add(n)), remove: (...names) => names.forEach(n => this.classes.delete(n)),
      contains: n => this.classes.has(n), toggle: (n, force = !this.classes.has(n)) => force ? this.classes.add(n) : this.classes.delete(n) };
    this.dots = [];
    this.ctx = Object.fromEntries(['beginPath', 'fill', 'moveTo', 'lineTo', 'stroke', 'clearRect', 'setTransform', 'fillRect', 'scale'].map(name => [name, () => {}]));
    this.ctx.arc = (...args) => this.dots.push(args);
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  async emit(type, values = {}) { for (const fn of this.listeners.get(type) || []) await fn({ target: this, preventDefault() {}, ...values }); }
  append(...children) { this.children.push(...children); children.forEach(c => { c.isConnected = true; }); }
  replaceChildren(...children) { this.children.forEach(c => { c.isConnected = false; }); this.children = []; this.append(...children); }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(selector === 'input' && c.tagName === 'input' ? [c] : []), ...c.querySelectorAll(selector)]); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  toDataURL() { return 'data:image/png;base64,aW5r'; }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  click() { return this.emit('click'); }
  pause() {}
  load() {}
  focus() {}
  reset() { this.value = ''; }
  remove() { this.isConnected = false; }
}
const event = (x = 10, y = 10, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'pen', pressure: 0.5, button: 0, preventDefault() {}, ...extra });
function pad(limits) { const canvas = new Element('canvas'), drawing = new Drawing(canvas, () => {}, limits); drawing.resize(1); return { canvas, drawing }; }
function stroke(d, x = 20, y = 20) { d.down(event(x, y)); d.move(event(x + 30, y)); d.up(event(x + 30, y)); }

test('drawing: dots, pointer ownership, coalesced events and pen-only touch rejection', () => {
  const { drawing: d, canvas } = pad();
  d.ignoreTouch = true; d.down(event(10, 10, { pointerType: 'touch' })); assert.equal(d.strokes.length, 0);
  d.down(event()); d.down(event(80, 80, { pointerId: 2 })); d.move(event(90, 90, { pointerId: 2 })); d.up(event(90, 90, { pointerId: 2 }));
  assert.equal(d.pointer, 1); assert.equal(d.strokes.length, 1);
  d.up(event()); assert.equal(d.strokes[0].length, 1); assert(canvas.dots.length > 0);
  d.down(event(100, 100)); d.move(event(130, 100, { getCoalescedEvents: () => [event(110, 100), event(120, 100)] })); d.up(event(130, 100));
  assert.deepEqual(d.strokes[1].map(p => p.x), [100, 110, 120, 130]);
  const target = new Element('canvas'); paintStrokes(target.ctx, [d.strokes[0]], 2, 3);
  assert.deepEqual(target.dots[0].slice(0, 2), [8, 7]);
});

test('drawing: whole gesture erasure, undo/redo, clear and fresh-action redo invalidation', () => {
  const { drawing: d } = pad(); stroke(d, 100, 80); stroke(d, 100, 130);
  const original = structuredClone(d.strokes);
  d.mode = 'eraser'; d.down(event(110, 40)); d.up(event(110, 160)); assert.equal(d.strokes.length, 0);
  d.undo(); assert.deepEqual(d.strokes, original); d.redo(); assert.equal(d.strokes.length, 0);
  d.undo(); d.clear(); assert.equal(d.strokes.length, 0); d.undo(); assert.deepEqual(d.strokes, original);
  d.mode = 'pen'; stroke(d, 250, 80); assert.equal(d.redoStack.length, 0);
});

test('drawing: cancel/lostcapture rolls back atomically without losing redo; reset drops history', () => {
  const { drawing: d, canvas } = pad(); stroke(d); d.undo();
  d.down(event(100, 100)); d.cancel(event(100, 100, { pointerId: 2 })); assert.equal(d.pointer, 1);
  d.cancel(event()); assert.equal(d.strokes.length, 0); assert.equal(d.redoStack.length, 1); assert.equal(canvas.captures.size, 0);
  d.redo(); const before = structuredClone(d.strokes);
  d.mode = 'eraser'; d.down(event(30, 20)); d.cancel(); assert.deepEqual(d.strokes, before);
  d.up(event()); assert.equal(d.history.length, 1);
  d.reset(); assert.equal(d.strokes.length, 0); assert.equal(d.history.length, 0); assert.equal(d.redoStack.length, 0);
});

test('drawing: resize scales current, undo and redo geometry; hidden sizes never erase ink', () => {
  const { drawing: d, canvas } = pad(); stroke(d, 100, 80); stroke(d, 200, 160); d.undo();
  canvas.clientWidth = 1200; canvas.clientHeight = 150; d.resize(2);
  assert.equal(d.strokes[0][0].x, 200); assert.equal(d.strokes[0][0].y, 40);
  d.redo(); assert.equal(d.strokes[1][0].x, 400); assert.equal(d.strokes[1][0].y, 80);
  d.undo(); assert.equal(d.strokes[0][0].x, 200);
  canvas.clientWidth = 0; canvas.clientHeight = 0; d.resize(1); assert.equal(d.width, 1200); assert.equal(d.strokes[0][0].x, 200);
});

test('drawing: point, stroke, total and history limits stay bounded', () => {
  const { drawing: d } = pad({ points: 3, strokes: 2, total: 5, history: 1 });
  d.down(event()); for (let i = 1; i <= 20; i++) d.move(event(i + 10, 10)); d.up(event(50, 10));
  assert.equal(d.strokes[0].length, 3); stroke(d, 100, 100); stroke(d, 200, 200);
  assert.equal(d.strokes.length, 2); assert.equal(d.strokes.flat().length, 5); assert.equal(d.history.length, 1);
  d.enabled = false; d.clear(); d.undo(); assert.equal(d.strokes.length, 2);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise(resolve => setImmediate(resolve));
let appInstance = 0;
async function appHarness(t, options = {}) {
  const html = await readFile(new URL('../static/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element(id === 'writing-pad' ? 'canvas' : 'div')]));
  const $ = id => nodes.get(id) || null, calls = [], downloads = [], originals = [], saved = new Map();
  let sessions = 0;
  const h = { $, calls, downloads, saved, handler: options.handler };
  const session = (id, imported = false) => ({ sessionId: id, imported, nextStep: 0, topic: imported ? 'Imported question' : 'Pythagoras', prompt: imported ? 'Find x in your question.' : 'Find c.', goal: 'Show your working.', foundation: 'Foundation', tutor: { mode: 'guided', prompt: 'Identify what is known and take one small step.' } });
  const mocks = {
    document: { getElementById: $, querySelectorAll: () => [], createElement: tag => new Element(tag) },
    window: { devicePixelRatio: 1, addEventListener() {} }, ResizeObserver: class { observe() {} }, requestAnimationFrame: fn => fn(),
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:download'; }, revokeObjectURL() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, init = {}) => {
      calls.push({ url, ...init });
      if (h.handler) { const result = h.handler(url, init); if (result !== undefined) return result; }
      if (url === '/me') return response({ fullName: 'Private Student', grade: 8, secret: 'not-exportable' });
      if (url === '/auth/logout') return response({});
      if (url === '/learning-sessions') return response(session(`session-${++sessions}`));
      if (url === '/ocr-providers') return response([{ id: 'inkmath', configured: true, label: 'InkMath' }, { id: 'local-pix2tex', configured: true, label: 'Local' }]);
      if (url === '/ocr-default') return response({ providerId: options.provider || 'inkmath' });
      if (url === '/api/notebooks') return response({ notebooks: [{ id: 'notebook', title: 'Private questions', questions: [{ text: 'Question', label: '1' }] }] });
      if (url === '/api/notebooks/notebook/questions/0/practice') return response(session('imported-session', true));
      if (url === '/recognize-handwriting/inkmath') return response({ lines: [{ latex: 'x=2', text: 'x=2', legibility: 'uncertain', ambiguities: ['Check x'] }], warnings: ['Check the exponent'], provider: 'InkMath' });
      if (url === '/recognize-handwriting') return response({ rawLatex: 'x=2', confidence: 0.55, provider: 'local-pix2tex' });
      const match = /^\/learning-sessions\/([^/]+)\/(steps|review|explain-step)$/.exec(url);
      if (match) {
        const [, id, action] = match, imported = id === 'imported-session';
        if (action === 'steps') {
          const list = saved.get(id) || []; list.push({ rawLatex: JSON.parse(init.body).rawLatex }); saved.set(id, list);
          return response({ status: imported ? 'unclear' : 'correct', assessment: imported ? 'ungraded' : null, saved: imported, stepAccepted: !imported, nextStep: list.length, complete: false, hint: imported ? 'Not graded' : 'Good step', tutor: { mode: 'guided', prompt: 'Continue your reasoning.' } });
        }
        if (action === 'review') return response({ assessment: imported ? 'ungraded' : null, findings: imported ? saved.get(id) || [] : [], complete: false, summary: 'Review', foundation: 'Foundation' });
        if (action === 'explain-step') return response({ explanation: 'A mocked explanation.' });
      }
      throw new Error(`Unexpected/paid request: ${url}`);
    },
  };
  for (const [key, value] of Object.entries(mocks)) {
    originals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  await import(`../static/app.js?test=${++appInstance}`); await flush();
  h.start = async () => { await $('start-pythagoras-button').click(); await flush(); };
  h.imported = async () => {
    await $('home-capture').click(); await flush();
    const button = $('capture-library').children[0].children.find(c => c.textContent.startsWith('Practise'));
    await button.click(); await flush();
  };
  h.ink = async (y = 30) => { const c = $('writing-pad'); await c.emit('pointerdown', event(30, y)); await c.emit('pointerup', event(60, y)); };
  h.approve = async () => { $('ink-reviewed').checked = true; await $('ink-reviewed').emit('change'); };
  h.posts = () => calls.filter(c => /\/steps$/.test(c.url));
  return h;
}

for (const provider of ['inkmath', 'local-pix2tex']) test(`app: ${provider} OCR never posts before explicit edited-line review; approval consumed`, async t => {
  const h = await appHarness(t, { provider }); await h.start(); await h.ink();
  await h.$('review-button').click(); assert.equal(h.posts().length, 0);
  assert.equal(h.$('ink-reviewed').checked, false); assert.equal(h.$('recheck-transcription').disabled, true);
  await h.$('recheck-transcription').click(); assert.equal(h.posts().length, 0);
  await h.approve(); const input = h.$('inkmath-lines').querySelectorAll('input')[0]; input.value = 'x=3'; await input.emit('input');
  assert.equal(h.$('ink-reviewed').checked, false); assert.equal(h.$('recheck-transcription').disabled, true);
  assert.match(h.$('inkmath-summary').textContent, /Nothing has been submitted/);
  await h.approve(); await h.$('recheck-transcription').click();
  assert.equal(h.posts().length, 1); assert.equal(JSON.parse(h.posts()[0].body).rawLatex, 'x=3'); assert.equal(JSON.parse(h.posts()[0].body).confidence, 0.91);
  assert.equal(h.$('ink-reviewed').checked, false); assert.equal(h.$('recheck-transcription').disabled, true);
  await h.$('recheck-transcription').click(); assert.equal(h.posts().length, 1);
});

test('app: imported handoff, initial guidance, neutral history and observation-only export', async t => {
  const h = await appHarness(t); await h.imported();
  assert.equal(h.$('learning-app').classes.has('hidden'), false); assert.equal(h.$('learning-home').classes.has('hidden'), true);
  assert.equal(h.$('coach-card').classes.has('hidden'), false); assert.equal(h.$('heygen-open').disabled, false);
  h.$('latex-input').value = '<script>student step</script>'; await h.$('check-button').click();
  assert.equal(h.$('result-title').textContent, 'Work saved—not graded'); assert.equal(h.$('latex-input').value, '');
  assert.equal(h.$('feedback-result').className, 'feedback-result'); assert.equal(h.$('foundation-card').classes.has('hidden'), true);
  assert.equal(h.$('review-findings').children[0].children[1].textContent, '<script>student step</script>');
  assert.equal(h.$('review-findings').children[0].children.length, 2); assert.equal(h.$('error-markers').children.length, 0);
  await h.ink(); await h.$('download-work').click();
  const value = JSON.parse(await h.downloads[0].text());
  assert.equal(value.observationOnly, true); assert.equal(value.questions[0].text, 'Find x in your question.');
  assert.equal(value.savedSteps[0].rawLatex, '<script>student step</script>'); assert.equal(value.currentWork.ink.strokes.length, 1);
  assert(!JSON.stringify(value).includes('Private Student')); assert(!JSON.stringify(value).includes('not-exportable')); assert(!JSON.stringify(value).includes('imported-session'));
  const before = h.calls.filter(c => c.url === '/learning-sessions').length; await h.$('new-problem-button').click(); await flush();
  assert.equal(h.$('capture-dialog').open, true); assert.equal(h.calls.filter(c => c.url === '/learning-sessions').length, before);
});

test('app: imported reviewed transcription saves neutrally and clears ink/approval', async t => {
  const h = await appHarness(t); await h.imported(); await h.ink(); await h.$('review-button').click(); await h.approve(); await h.$('recheck-transcription').click();
  assert.equal(h.$('result-title').textContent, 'Work saved—not graded'); assert.equal(h.$('error-markers').children.length, 0);
  assert.equal(h.$('canvas-placeholder').classes.has('hidden'), false); assert.equal(h.$('recheck-transcription').disabled, true);
  assert.equal(h.$('review-findings').children[0].children[1].textContent, 'x=2');
});

test('app: ink changes invalidate transcript and approval; undo/redo controls are wired', async t => {
  const h = await appHarness(t); await h.start(); await h.ink(); await h.$('review-button').click(); await h.approve(); await h.ink(150);
  assert.equal(h.$('ink-reviewed').checked, false); assert.equal(h.$('inkmath-lines').children.length, 0);
  await h.$('undo-button').click(); assert.equal(h.$('redo-button').disabled, false); await h.$('redo-button').click(); assert.equal(h.$('redo-button').disabled, true);
  await h.$('eraser-button').click(); assert.equal(h.$('eraser-button').attributes['aria-pressed'], 'true');
});

for (const destination of ['back', 'topic', 'logout']) test(`app: stale multi-line OCR on ${destination} stops before another request or POST`, async t => {
  const h = await appHarness(t, { provider: 'local-pix2tex' }); await h.start(); await h.ink(); await h.ink(180);
  const slow = deferred(); h.handler = url => url === '/recognize-handwriting' ? slow.promise : undefined;
  const read = h.$('review-button').click(); await flush();
  assert.equal(h.$('latex-input').disabled, true); assert.equal(h.$('check-button').disabled, true);
  if (destination === 'back') await h.$('back-to-topics').click();
  if (destination === 'topic') await h.$('start-algebra-button').click();
  if (destination === 'logout') await h.$('logout-button').click();
  slow.resolve(response({ rawLatex: 'stale', confidence: 1 })); await read; await flush();
  assert.equal(h.calls.filter(c => c.url === '/recognize-handwriting').length, 1); assert.equal(h.posts().length, 0);
  assert.equal(h.$('inkmath-lines').children.length, 0); assert(!h.$('ocr-message').textContent.includes('stale'));
});

test('app: competing start responses cannot replace the newer topic', async t => {
  const h = await appHarness(t), slow = deferred(); let first = true;
  h.handler = url => { if (url === '/learning-sessions' && first) { first = false; return slow.promise; } };
  const old = h.$('start-pythagoras-button').click(); await flush(); await h.$('start-algebra-button').click();
  const prompt = h.$('problem-prompt').textContent;
  slow.resolve(response({ sessionId: 'old-session', prompt: 'STALE', topic: 'Old', nextStep: 88 })); await old;
  assert.equal(h.$('problem-prompt').textContent, prompt);
  h.$('latex-input').value = 'x=1'; await h.$('check-button').click(); assert(h.posts()[0].url.includes('session-1'));
});

test('app: late first submitted line never posts the second line to a different session', async t => {
  const h = await appHarness(t); await h.start(); await h.ink();
  h.handler = url => url === '/recognize-handwriting/inkmath' ? response({ lines: [{ latex: 'a=1' }, { latex: 'b=2' }] }) : undefined;
  await h.$('review-button').click(); await h.approve();
  const slow = deferred(); h.handler = url => /\/steps$/.test(url) ? slow.promise : undefined;
  const submit = h.$('recheck-transcription').click(); await flush(); await h.$('start-algebra-button').click();
  slow.resolve(response({ nextStep: 99, stepAccepted: true, status: 'correct' })); await submit;
  assert.equal(h.posts().length, 1); assert(h.posts()[0].url.includes('session-1')); assert.equal(h.$('connection-label').textContent, 'New problem ready');
  h.handler = undefined; await h.ink(); await h.$('review-button').click();
  assert.equal(JSON.parse(h.calls.filter(c => c.url === '/recognize-handwriting/inkmath').at(-1).body).stepIndex, 0);
});

for (const action of ['step', 'review', 'export', 'explanation']) test(`app: stale ${action} result after leaving practice cannot alter UI or download`, async t => {
  const h = await appHarness(t); await h.start();
  if (action === 'explanation') {
    h.handler = url => /\/review$/.test(url) ? response({ findings: [{ rawLatex: 'x=1', errorType: 'sign_error', explanation: 'Check sign' }] }) : undefined;
    await h.$('review-button').click();
  }
  const slow = deferred(); h.handler = url => /\/(steps|review|explain-step)$/.test(url) ? slow.promise : undefined;
  h.$('latex-input').value = 'x=1';
  const target = action === 'step' ? h.$('check-button') : action === 'export' ? h.$('download-work')
    : action === 'explanation' ? h.$('review-findings').children[0].children[2] : h.$('review-button');
  const job = target.click(); await flush(); await h.$('back-to-topics').click();
  slow.resolve(response({ status: 'correct', stepAccepted: true, nextStep: 99, findings: [], complete: true, summary: 'STALE', explanation: 'STALE' })); await job;
  assert.equal(h.downloads.length, 0); assert.equal(h.$('result-title').textContent, ''); assert.equal(h.$('review-findings').children.length, 0);
  assert.equal(h.$('connection-label').textContent, ''); assert.equal(h.$('latex-input').value, '');
});

test('app: logout immediately clears ink, transcription, voice, capture and HeyGen even before server responds', async t => {
  const h = await appHarness(t); await h.start(); await h.ink(); await h.$('review-button').click();
  await h.$('voice-formula-button').click(); h.$('voice-transcript').value = 'private words'; h.$('heygen-script').value = 'private guidance';
  const slow = deferred(); h.handler = url => url === '/auth/logout' ? slow.promise : undefined;
  const logout = h.$('logout-button').click(); await flush();
  assert.equal(h.$('canvas-placeholder').classes.has('hidden'), false); assert.equal(h.$('inkmath-lines').children.length, 0);
  assert.equal(h.$('voice-transcript').value, ''); assert.equal(h.$('voice-dialog').open, false); assert.equal(h.$('capture-dialog').open, false);
  assert.equal(h.$('heygen-script').value, ''); assert.equal(h.$('heygen-open').disabled, true);
  slow.resolve(response({})); await logout;
});