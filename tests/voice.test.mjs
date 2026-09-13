import test from 'node:test';
import assert from 'node:assert/strict';
import { setupVoice } from '../static/voice.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.listeners = new Map(); this.children = [];
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.open = false; this.textContent = ''; this.files = []; this.classes = new Set();
    this.classList = { toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  async emit(type, detail = {}) {
    // Deliberately dispatch even on disabled elements to test handler-level guards.
    for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {}, ...detail });
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  click() { this.clicked = true; return this.emit('click'); }
  remove() { this.removed = true; }
  pause() { this.paused = true; }
  load() { this.loaded = true; }
  play() { throw new Error('Must never autoplay'); }
  removeAttribute(key) { delete this[key]; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise(resolve => setImmediate(resolve));
const formatted = {
  lines: [
    { text: 'x squared', latex: 'x^2', ambiguities: ['Check exponent'] },
    { text: 'y equals two', latex: 'y=2', ambiguities: [] },
  ], warnings: ['Review carefully'], needsReview: true,
};
const stream = () => { const track = { stopped: false, stop() { this.stopped = true; } }; return { track, getTracks: () => [track] }; };

function harness(t, options = {}) {
  const nodes = new Map(), calls = [], readers = [], recorders = [], urls = new Map(), revoked = [], timers = new Map();
  const created = [], body = new Element('body'); let nextUrl = 0, nextTimer = 0, permissionCalls = 0;
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  class Reader {
    constructor() { readers.push(this); this.readyState = 0; }
    readAsDataURL(blob) {
      this.blob = blob; this.readyState = 1;
      if (!options.manualRead) this.finish(`data:${blob.type};base64,YXVkaW8=`);
    }
    finish(value) { this.result = value; this.readyState = 2; this.onload?.(); }
    abort() { this.aborted = true; this.readyState = 2; this.onabort?.(); }
    fail() { this.readyState = 2; this.onerror?.(); }
  }
  class Recorder extends Element {
    static isTypeSupported(type) { return options.supportedType ? type === options.supportedType : type.startsWith('audio/webm'); }
    constructor(source, config) {
      super(); this.stream = source; this.mimeType = config?.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this);
    }
    start(interval) { if (options.startError) throw new Error('start failed'); this.interval = interval; this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.stopCalls = (this.stopCalls || 0) + 1; }
    chunk(size = 5) { return this.emit('dataavailable', { data: new Blob([new Uint8Array(size)], { type: this.mimeType }) }); }
    finish() { return this.emit('stop'); }
  }
  const originals = [];
  for (const [key, value] of Object.entries({
    document: { getElementById: $, body, createElement: tag => { const node = new Element(tag); created.push(node); return node; } },
    navigator: { mediaDevices: { getUserMedia: constraints => {
      permissionCalls++; assert.deepEqual(constraints, { audio: true });
      return options.permission ? options.permission() : Promise.resolve(stream());
    } } },
    MediaRecorder: Recorder, FileReader: Reader,
    URL: { createObjectURL: blob => { const url = `blob:voice-${++nextUrl}`; urls.set(url, blob); return url; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (options.fetch) return options.fetch(url, init);
      return response(url === '/voice/transcribe' ? { transcript: 'x squared', needsReview: true } : formatted);
    },
  })) {
    originals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let session = options.session === undefined ? 'practice-a' : options.session;
  const used = [], notebooks = [];
  const controller = setupVoice({ getSessionId: () => session,
    onUse: value => used.push(value),
    onNotebook: value => { assert.equal($('voice-reviewed').checked, false); assert.equal($('voice-dialog').open, false); notebooks.push(value); },
  });
  t.after(() => {
    controller.reset();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const click = name => $(name === 'close-voice' ? name : `voice-${name}`).emit('click');
  const type = async value => { $('voice-transcript').value = value; await $('voice-transcript').emit('input'); };
  const approve = async () => { $('voice-reviewed').checked = true; await $('voice-reviewed').emit('change'); };
  return { $, controller, calls, readers, recorders, urls, revoked, timers, created, used, notebooks, click, type, approve,
    get permissionCalls() { return permissionCalls; },
    changeSession(value) { session = value; },
    async file(type = 'audio/webm;codecs=opus', size = 5) {
      $('voice-file').files = [new Blob([new Uint8Array(size)], { type })]; await $('voice-file').emit('change');
    },
    async format() { await type('x squared'); await click('format'); },
    input(index = 0) { return $('voice-formulas').children[index].children[1].children[0]; },
    use(index = 0) { return $('voice-formulas').children[index].children[3]; },
  };
}

test('setup/open/file/manual entry never transmit, request permission, or autoplay', async t => {
  const h = harness(t, { session: null }); h.controller.open();
  await h.file(); await h.type('x squared');
  assert.equal(h.calls.length, 0); assert.equal(h.readers.length, 0); assert.equal(h.permissionCalls, 0);
  assert.equal(h.$('voice-playback').autoplay, false); assert.equal(h.$('voice-playback').hidden, false);
  assert.equal(h.$('voice-format').disabled, false);
  h.controller.open();
  assert.equal(h.$('voice-transcript').value, ''); assert.equal(h.$('voice-playback').hidden, true);
  assert.equal(h.revoked.length, 1);
});

test('file transcription and manual formatting use exact bodies and same-origin credentials', async t => {
  const h = harness(t); h.controller.open(); await h.file(); await h.click('transcribe');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/voice/transcribe');
  assert.deepEqual(JSON.parse(h.calls[0].body), { audioData: 'data:audio/webm;base64,YXVkaW8=' });
  assert.equal(h.$('voice-transcript').value, 'x squared');
  assert.equal(h.$('voice-formulas').children.length, 0);
  await h.type('  y equals two  '); await h.click('format');
  assert.equal(h.calls[1].url, '/voice/math-json');
  assert.deepEqual(JSON.parse(h.calls[1].body), { transcript: 'y equals two' });
  for (const call of h.calls) {
    assert.equal(call.method, 'POST'); assert.equal(call.credentials, 'same-origin');
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json' }); assert(call.signal instanceof AbortSignal);
  }
  assert.equal(h.$('voice-reviewed').checked, false); assert.equal(h.use().disabled, true);
  assert.match(h.$('voice-status').textContent, /Review carefully/);
});

test('manual-only format works on dashboard; notebook requires review and hands off all edited lines', async t => {
  const h = harness(t, { session: null }); h.controller.open(); await h.format();
  await h.click('notebook'); await h.use().emit('click'); assert.equal(h.notebooks.length, 0); assert.equal(h.used.length, 0);
  await h.approve(); h.input().value = 'x^3'; await h.input().emit('input');
  assert.equal(h.$('voice-reviewed').checked, false); assert.equal(h.$('voice-notebook').disabled, true);
  await h.click('notebook'); assert.equal(h.notebooks.length, 0);
  await h.approve(); assert.equal(h.use().disabled, true); await h.click('notebook');
  assert.deepEqual(h.notebooks, [{ title: 'Spoken maths', sourceType: 'voice', questions: [
    { label: '1', text: 'x squared', latex: 'x^3', ambiguities: ['Check exponent'], diagram_description: '' },
    { label: '2', text: 'y equals two', latex: 'y=2', ambiguities: [], diagram_description: '' },
  ] }]);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/voice/math-json');
});

test('onUse receives reviewed edited line only in the captured nonnull session', async t => {
  const h = harness(t); h.controller.open(); await h.format();
  h.input().value = 'x^4'; await h.input().emit('input'); await h.approve();
  await h.use().emit('click');
  assert.deepEqual(h.used, [{ text: 'x squared', latex: 'x^4', ambiguities: ['Check exponent'] }]);
  assert.equal(h.$('voice-dialog').open, false); assert.equal(h.$('voice-reviewed').checked, false);
});

for (const newSession of ['practice-b', null]) {
  test(`stale session ${newSession} cannot use an old formula`, async t => {
    const h = harness(t); h.controller.open(); await h.format(); await h.approve();
    h.changeSession(newSession); await h.use().emit('click'); assert.equal(h.used.length, 0);
    assert.equal(h.use().disabled, true);
  });
}

test('dashboard draft cannot be used after a practice session is started', async t => {
  const h = harness(t, { session: null }); h.controller.open(); await h.format(); await h.approve();
  h.changeSession('practice-b'); await h.use().emit('click'); assert.equal(h.used.length, 0);
});

test('transcript edits invalidate formulas, checkbox and detached callbacks', async t => {
  const h = harness(t); h.controller.open(); await h.format(); await h.approve(); const oldUse = h.use();
  await h.type('different words');
  assert.equal(h.$('voice-formulas').children.length, 0); assert.equal(h.$('voice-reviewed').checked, false);
  await h.format(); await h.approve(); await oldUse.emit('click'); assert.equal(h.used.length, 0);
});

test('download is local JSON with transcript, edits, warnings and review state', async t => {
  const h = harness(t); h.controller.open(); await h.type('manual words'); await h.click('download');
  let anchor = h.created.find(node => node.tagName === 'a');
  assert(anchor.clicked && anchor.removed); assert.equal(anchor.download, 'spoken-maths.json');
  assert.deepEqual(JSON.parse(await h.urls.get(anchor.href).text()), { transcript: 'manual words', lines: [], warnings: [], needsReview: true });
  const firstUrl = anchor.href;
  await h.format(); await h.approve(); await h.click('download');
  anchor = h.created.filter(node => node.tagName === 'a').at(-1);
  assert.deepEqual(JSON.parse(await h.urls.get(anchor.href).text()), { transcript: 'x squared', ...formatted, needsReview: false });
  assert(h.revoked.includes(firstUrl)); assert.equal(h.calls.length, 1);
  h.controller.reset(); assert(h.revoked.includes(anchor.href));
});

test('all accepted MIME types work including codec parameters; invalid/empty/oversize files clear old drafts', async t => {
  const h = harness(t); h.controller.open();
  for (const type of ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav']) {
    await h.file(`${type};codecs=test`); await h.click('transcribe');
    assert.equal(JSON.parse(h.calls.at(-1).body).audioData, `data:${type};base64,YXVkaW8=`);
  }
  await h.file('audio/wav', 6 * 1024 * 1024); assert.equal(h.$('voice-transcribe').disabled, false);
  for (const [type, size] of [['text/plain', 5], ['audio/wav', 0], ['audio/wav', 6 * 1024 * 1024 + 1]]) {
    await h.format(); await h.approve(); await h.file(type, size);
    assert.equal(h.$('voice-transcribe').disabled, true); assert.equal(h.$('voice-playback').hidden, true);
    assert.equal(h.$('voice-formulas').children.length, 0); assert.equal(h.$('voice-reviewed').checked, false);
    const count = h.calls.length; await h.click('transcribe'); assert.equal(h.calls.length, count);
  }
});

test('network locks all editable controls and duplicate actions; errors release busy for retry', async t => {
  const pending = deferred(); const h = harness(t, { fetch: () => pending.promise });
  h.controller.open(); await h.type('x'); const work = h.click('format');
  for (const id of ['file', 'transcript', 'record', 'transcribe', 'format', 'reviewed', 'notebook', 'download']) assert.equal(h.$(`voice-${id}`).disabled, true, id);
  await h.click('record'); await h.click('format'); await h.click('transcribe');
  assert.equal(h.calls.length, 1); assert.equal(h.permissionCalls, 0);
  pending.resolve(response({ detail: 'Try again' }, 503)); await work;
  assert.equal(h.$('voice-format').disabled, false); assert.equal(h.$('voice-transcript').disabled, false);
  assert.equal(h.$('voice-status').textContent, 'Try again');
});

for (const action of ['close', 'logout', 'reopen']) {
  for (const endpoint of ['format', 'transcribe']) {
    test(`${action} aborts pending ${endpoint}; late response cannot repopulate`, async t => {
      const pending = deferred(); const h = harness(t, { fetch: () => pending.promise }); h.controller.open();
      if (endpoint === 'format') await h.type('x'); else await h.file();
      const work = h.click(endpoint); await flush(); const signal = h.calls[0].signal;
      if (action === 'close') await h.click('close-voice');
      else if (action === 'logout') { h.changeSession(null); h.controller.reset(); }
      else h.controller.open();
      assert.equal(signal.aborted, true);
      pending.resolve(response(endpoint === 'format' ? formatted : { transcript: 'sensitive late transcript', needsReview: true })); await work;
      assert.equal(h.$('voice-transcript').value, ''); assert.equal(h.$('voice-formulas').children.length, 0);
      assert.equal(h.$('voice-reviewed').checked, false); assert.equal(h.$('voice-playback').hidden, true);
      assert.equal(h.$('voice-dialog').open, action === 'reopen');
    });
  }
}

test('old request errors/finally cannot replace new status or unlock newer pending work', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness(t, { fetch: () => ++count === 1 ? first.promise : second.promise });
  h.controller.open(); await h.type('old'); const oldWork = h.click('format');
  h.controller.open(); await h.type('new'); const newWork = h.click('format');
  const status = h.$('voice-status').textContent;
  first.reject(new Error('stale private error')); await oldWork;
  assert.equal(h.$('voice-status').textContent, status); assert.equal(h.$('voice-transcript').disabled, true);
  second.resolve(response(formatted)); await newWork;
  assert.equal(h.$('voice-transcript').disabled, false); assert.equal(h.$('voice-formulas').children.length, 2);
});

test('close while FileReader pending aborts it; even a late load never fetches', async t => {
  const h = harness(t, { manualRead: true }); h.controller.open(); await h.file(); const work = h.click('transcribe');
  const reader = h.readers[0]; await h.click('close-voice'); assert.equal(reader.aborted, true);
  h.controller.open(); reader.finish('data:audio/webm;codecs=opus;base64,YXVkaW8='); await work;
  assert.equal(h.calls.length, 0); assert.equal(h.$('voice-transcript').value, '');
  assert.equal(h.$('voice-file').disabled, false);
});

test('FileReader error is recoverable and does not transmit', async t => {
  const h = harness(t, { manualRead: true }); h.controller.open(); await h.file(); const work = h.click('transcribe');
  h.readers[0].fail(); await work;
  assert.equal(h.calls.length, 0); assert.equal(h.$('voice-transcribe').disabled, false);
  assert.match(h.$('voice-status').textContent, /Could not read/);
});

test('only one permission prompt even across reset/open; late granted stream is stopped', async t => {
  const pending = deferred(); const h = harness(t, { permission: () => pending.promise }); h.controller.open();
  await h.format(); await h.approve(); const work = h.click('record');
  assert.equal(h.$('voice-formulas').children.length, 0); assert.equal(h.$('voice-reviewed').checked, false);
  await h.click('record'); assert.equal(h.permissionCalls, 1);
  h.controller.reset(); h.controller.open(); await h.click('record'); assert.equal(h.permissionCalls, 1);
  const source = stream(); pending.resolve(source); await work;
  assert.equal(source.track.stopped, true); assert.equal(h.recorders.length, 0);
  assert.equal(h.$('voice-record').disabled, false); assert.equal(h.$('voice-transcript').disabled, false);
  assert.equal(h.timers.size, 0);
});

test('late permission rejection cannot overwrite a reopened draft', async t => {
  const pending = deferred(); const h = harness(t, { permission: () => pending.promise }); h.controller.open();
  const work = h.click('record'); h.controller.reset(); h.controller.open(); const status = h.$('voice-status').textContent;
  pending.reject(new Error('old permission error')); await work;
  assert.equal(h.$('voice-status').textContent, status); assert.equal(h.$('voice-record').disabled, false);
});

test('recording stops at 60 seconds, releases tracks/timer, and never auto transcribes', async t => {
  const h = harness(t); h.controller.open(); await h.click('record'); const recorder = h.recorders[0];
  assert.equal(recorder.interval, 250); const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 60_000);
  await recorder.chunk(); timer.fn();
  assert.equal(recorder.stream.track.stopped, true); assert.equal(h.timers.size, 0); assert.equal(recorder.stopCalls, 1);
  await recorder.finish(); assert.equal(h.$('voice-transcribe').disabled, false); assert.equal(h.calls.length, 0);
  await h.click('transcribe'); assert.equal(h.calls.length, 1);
});

test('recording byte overflow stops and discards all audio', async t => {
  const h = harness(t); h.controller.open(); await h.click('record'); const recorder = h.recorders[0];
  await recorder.chunk(6 * 1024 * 1024); await recorder.chunk(1); await recorder.finish();
  assert.equal(recorder.stream.track.stopped, true); assert.equal(h.timers.size, 0);
  assert.equal(h.$('voice-transcribe').disabled, true); assert.equal(h.$('voice-playback').hidden, true);
  assert.match(h.$('voice-status').textContent, /exceeded 6 MiB/); assert.equal(h.calls.length, 0);
});

test('close/reset and late stop callback cannot overwrite a newer recording', async t => {
  const h = harness(t); h.controller.open(); await h.click('record'); const old = h.recorders[0]; await old.chunk();
  h.controller.reset(); assert.equal(old.stream.track.stopped, true); assert.equal(h.timers.size, 0);
  h.controller.open(); await h.click('record'); const newer = h.recorders[1];
  await old.chunk(); await old.finish();
  assert.equal(h.$('voice-playback').hidden, true); assert.equal(newer.stream.track.stopped, false);
  assert.equal(h.$('voice-stop').disabled, false); assert.equal(h.timers.size, 1);
  await newer.chunk(); await h.click('stop'); await newer.finish();
  assert.equal(h.$('voice-playback').hidden, false); assert.equal(h.$('voice-transcribe').disabled, false);
  const url = h.$('voice-playback').src; await h.$('voice-dialog').emit('cancel');
  assert(h.revoked.includes(url)); assert.equal(h.$('voice-playback').src, undefined); assert.equal(h.$('voice-dialog').open, false);
});

test('queued native close from older open cannot reset a new draft', async t => {
  const h = harness(t); h.controller.open(); h.controller.reset(); h.controller.open(); await h.type('new draft');
  await h.$('voice-dialog').emit('close'); assert.equal(h.$('voice-transcript').value, 'new draft');
  await h.$('voice-dialog').close(); assert.equal(h.$('voice-transcript').value, '');
});

test('recording start failures and recorder errors release microphone and busy controls', async t => {
  const h = harness(t, { startError: true }); h.controller.open(); await h.click('record');
  assert.equal(h.recorders[0].stream.track.stopped, true); assert.equal(h.timers.size, 0);
  assert.equal(h.$('voice-record').disabled, false); assert.equal(h.$('voice-file').disabled, false);
});

test('recorder error drops buffered audio, clears timer and permits manual entry', async t => {
  const h = harness(t); h.controller.open(); await h.click('record'); const recorder = h.recorders[0];
  await recorder.chunk(); await recorder.emit('error'); await recorder.finish();
  assert.equal(recorder.stream.track.stopped, true); assert.equal(h.timers.size, 0);
  assert.equal(h.$('voice-transcribe').disabled, true); assert.equal(h.$('voice-transcript').disabled, false);
});