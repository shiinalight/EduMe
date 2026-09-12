import test from 'node:test';
import assert from 'node:assert/strict';
import { setupVoice } from '../public/voice.js';

// Small DOM/media doubles: exercise controller behavior without real microphones or paid calls.
class Element {
  constructor() { this.listeners = new Map(); this.value = ''; this.children = []; this.checked = false; this.open = false; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, ...event }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  pause() {}
  removeAttribute(key) { delete this[key]; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = () => ({ title: 'Spoken math', source: 'voice', model: 'test-model', transcript: 'x squared', warnings: [], questions: [{ id: 'q', label: 'Formula', text: 'x squared', latex: 'x^2', ambiguities: [], origin: 'voice', reviewed: false }], needs_review: true });
function harness(t, { post = async () => result(), media = {} } = {}) {
  const nodes = new Map(), win = new Element();
  t.after(() => win.emit('pagehide'));
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  for (const [name, value] of Object.entries({ document: { getElementById: $, createElement: () => new Element() }, window: win, navigator: { mediaDevices: media }, MediaRecorder: undefined })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
  }
  const imports = [], calls = [];
  return { $, imports, calls, setup() {
    setupVoice({ canOpen: () => true, onImport: value => imports.push(value), post: async (...args) => { calls.push(args); return post(...args); } });
  } };
}

test('typed voice math requires review; edits invalidate approval and transcript changes invalidate conversion', async t => {
  const h = harness(t); h.setup(); const { $ } = h;
  await $('speak-problem').emit('click');
  assert.equal($('voice-record').disabled, true);
  $('voice-transcript').value = 'x squared'; await $('voice-transcript').emit('input');
  await $('voice-convert').emit('click'); await flush();
  assert.equal(h.calls[0][0], '/api/voice-math'); assert.equal($('voice-use').disabled, true);
  $('voice-reviewed').checked = true; await $('voice-reviewed').emit('change');
  assert.equal($('voice-use').disabled, false);
  const latex = $('voice-editors').children[0].children[4];
  latex.value = 'x^{2}'; await latex.emit('input');
  assert.equal($('voice-reviewed').checked, false); assert.equal($('voice-use').disabled, true);
  $('voice-reviewed').checked = true; await $('voice-reviewed').emit('change');
  await $('voice-use').emit('click');
  assert.equal(h.imports[0].questions[0].latex, 'x^{2}'); assert.equal(h.imports[0].questions[0].reviewed, true);
  assert.equal(h.imports[0].transcription_provider, 'typed'); assert.equal(h.imports[0].needs_review, false);
  await $('speak-problem').emit('click'); $('voice-transcript').value = 'x squared';
  await $('voice-convert').emit('click'); await flush();
  await $('voice-transcript').emit('input'); assert.equal($('voice-preview').hidden, true); assert.equal($('voice-use').disabled, true);
});

test('closing the dialog discards a late conversion result', async t => {
  let finish;
  const h = harness(t, { post: () => new Promise(resolve => { finish = resolve; }) }); h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); $('voice-transcript').value = 'x squared';
  const conversion = $('voice-convert').emit('click'); await flush();
  await $('voice-dialog').close(); finish(result()); await conversion; await flush();
  assert.equal($('voice-preview').hidden, true); assert.equal(h.imports.length, 0); assert.equal($('voice-use').disabled, true);
});

test('microphone permission resolving after close releases every track without recording', async t => {
  let grant; let stops = 0;
  const h = harness(t, { media: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  globalThis.MediaRecorder = class { constructor() { assert.fail('must not start recording after close'); } };
  h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); const recording = $('voice-record').emit('click');
  await $('voice-dialog').close(); grant({ getTracks: () => [{ stop: () => stops++ }] }); await recording;
  assert.equal(stops, 1); assert.equal(h.calls.length, 0);
});

test('recording is local, stop releases microphone, close clears playback', async t => {
  let stops = 0, instance;
  const h = harness(t, { media: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stops++ }] }) } });
  globalThis.MediaRecorder = class extends Element {
    static isTypeSupported() { return true; }
    constructor() { super(); instance = this; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; void this.emit('stop'); }
  };
  h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); await $('voice-record').emit('click');
  assert.equal($('voice-stop').disabled, false); assert.equal(h.calls.length, 0);
  await instance.emit('dataavailable', { data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])]) });
  await $('voice-stop').emit('click'); await flush();
  assert.equal(stops, 1); assert.equal($('voice-transcribe').disabled, false); assert.equal($('voice-playback').hidden, false);
  assert.equal(h.calls.length, 0);
  await $('voice-dialog').close(); assert.equal($('voice-playback').hidden, true); assert.equal($('voice-transcribe').disabled, true);
});

test('microphone denial and provider errors remain visible without enabling import', async t => {
  const h = harness(t, { media: { getUserMedia: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } }, post: async () => { throw new Error('Quota exceeded'); } });
  globalThis.MediaRecorder = class {};
  h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); await $('voice-record').emit('click');
  assert.match($('voice-status').textContent, /permission denied/);
  $('voice-transcript').value = 'x squared'; await $('voice-convert').emit('click'); await flush();
  assert.equal($('voice-status').textContent, 'Quota exceeded'); assert.equal($('voice-use').disabled, true);
});

test('late stop callbacks from a closed recording cannot stop a newer recording', async t => {
  const instances = []; let stops = 0;
  const h = harness(t, { media: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stops++ }] }) } });
  globalThis.MediaRecorder = class extends Element {
    static isTypeSupported() { return true; }
    constructor() { super(); instances.push(this); this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; } // Deliver stop later, as browsers may do.
  };
  h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); await $('voice-record').emit('click');
  await $('voice-dialog').close(); assert.equal(stops, 1);
  await $('speak-problem').emit('click'); await $('voice-record').emit('click');
  await instances[0].emit('stop'); await instances[0].emit('error');
  assert.equal(stops, 1); assert.equal($('voice-stop').disabled, false); assert.equal(instances[1].state, 'recording');
});

test('late permission failure cannot release a newer microphone session', async t => {
  let rejectFirst; let requests = 0, stops = 0;
  const h = harness(t, { media: { getUserMedia: () => ++requests === 1 ? new Promise((resolve, reject) => { rejectFirst = reject; }) : Promise.resolve({ getTracks: () => [{ stop: () => stops++ }] }) } });
  globalThis.MediaRecorder = class extends Element {
    static isTypeSupported() { return true; }
    constructor() { super(); this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; void this.emit('stop'); }
  };
  h.setup(); const { $ } = h;
  await $('speak-problem').emit('click'); const first = $('voice-record').emit('click');
  await $('voice-dialog').close(); await $('speak-problem').emit('click'); await $('voice-record').emit('click');
  rejectFirst(new Error('old request')); await first;
  assert.equal(stops, 0); assert.equal($('voice-stop').disabled, false);
});