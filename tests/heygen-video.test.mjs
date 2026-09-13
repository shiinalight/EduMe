import test from 'node:test';
import assert from 'node:assert/strict';
import { tutorScript, setupHeygenVideo } from '../static/heygen-video.js';

class Element {
  constructor() { this.listeners = new Map(); this.children = []; this.value = ''; this.checked = false; this.open = false; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async emit(type) { for (const fn of this.listeners.get(type) || []) await fn({ target: this }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  pause() {}
  removeAttribute(key) { delete this[key]; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

function harness(t, override = () => null) {
  const nodes = new Map(), calls = [], win = new Element();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  t.after(() => $('heygen-dialog').close());
  for (const [key, value] of Object.entries({ document: { getElementById: $, createElement: () => new Element() }, window: win, confirm: () => true,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const custom = override(url, options); if (custom) return custom;
      if (url.endsWith('/config')) return response({ configured: true, defaultAvatarId: 'public_look', defaultVoiceId: '' });
      if (url.includes('/avatars')) return response({ avatars: [{ id: 'presenter', name: 'Presenter' }], nextToken: null });
      if (options.method === 'POST') return response({ id: 'job-1', status: 'pending' }, 202);
      if (url.includes('sessionId=')) return response({ videos: [] });
      return response({ id: 'job-1', status: 'completed', videoUrl: 'https://files.heygen.ai/video/v.mp4' });
    }
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  let session = 'practice-a';
  const controller = setupHeygenVideo({ getSessionId: () => session });
  controller.setGuidance({ prompt: 'Square each side.' });
  return { $, calls, controller, changeSession(value) { session = value; }, async open() { await $('heygen-open').emit('click'); await flush(); } };
}

test('script contains only actual tutor guidance, example and visual cue', () => {
  assert.equal(tutorScript(null), '');
  assert.equal(tutorScript({ prompt: 'Hint', workedExample: { title: 'Example', steps: ['Step one', 'Step two'], handoff: 'Your turn' }, visualCue: 'Look at c', studentName: 'Not narration' }), 'Hint\n\nExample\n\nStep one\n\nStep two\n\nYour turn\n\nLook at c');
});

test('opening and avatar selection never generate; approval is mandatory and edits clear it', async t => {
  const h = harness(t); await h.open(); const { $ } = h;
  assert.equal($('heygen-script').value, 'Square each side.');
  assert.equal($('heygen-generate').disabled, true);
  await $('heygen-load-avatars').emit('click'); await flush();
  $('heygen-avatar').value = 'presenter'; await $('heygen-avatar').emit('input');
  assert(!h.calls.some(c => c.options.method === 'POST'));
  $('heygen-consent').checked = true; await $('heygen-consent').emit('change');
  assert.equal($('heygen-generate').disabled, false);
  $('heygen-script').value = 'Square both sides.'; await $('heygen-script').emit('input');
  assert.equal($('heygen-consent').checked, false);
  $('heygen-consent').checked = true; await $('heygen-consent').emit('change');
  await $('heygen-generate').emit('click'); await flush();
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal($('heygen-generate').disabled, true);
  await $('heygen-refresh').emit('click'); await flush();
  assert.equal($('heygen-player').src, 'https://files.heygen.ai/video/v.mp4');
  assert.equal($('heygen-download').hidden, false);
});

test('network retry preserves exact request ID and script instead of creating another paid job', async t => {
  let attempts = 0;
  const h = harness(t, (url, options) => options.method === 'POST' && ++attempts === 1 ? Promise.reject(new TypeError('offline')) : null);
  await h.open(); const { $ } = h;
  $('heygen-consent').checked = true; await $('heygen-consent').emit('change');
  await $('heygen-generate').emit('click'); await flush();
  assert.equal($('heygen-script').disabled, true); assert.equal($('heygen-generate').disabled, false);
  await $('heygen-generate').emit('click'); await flush();
  const posts = h.calls.filter(c => c.options.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body);
  assert(JSON.parse(posts[0].options.body).requestId);
});

test('late status after close is discarded and logout resets sensitive UI state', async t => {
  let finish;
  const h = harness(t, url => url.endsWith('/job-1') ? new Promise(resolve => { finish = resolve; }) : null);
  await h.open(); const { $ } = h;
  $('heygen-consent').checked = true; await $('heygen-consent').emit('change');
  await $('heygen-generate').emit('click'); await flush();
  await $('heygen-refresh').emit('click'); await flush();
  await $('heygen-dialog').close(); finish(response({ id: 'job-1', status: 'completed', videoUrl: 'https://files.heygen.ai/v.mp4' })); await flush();
  assert.equal($('heygen-player').hidden, true);
  h.controller.reset();
  assert.equal($('heygen-script').value, ''); assert.equal($('heygen-open').disabled, true); assert.equal($('heygen-download').href, undefined);
});

test('unconfigured key disables generation and practice changes cannot submit an old draft', async t => {
  const h = harness(t, url => url.endsWith('/config') ? response({ configured: false, defaultAvatarId: '', defaultVoiceId: '' }) : null);
  await h.open(); const { $ } = h;
  assert.match($('heygen-status').textContent, /HEYGEN_API_KEY/);
  assert.equal($('heygen-load-avatars').disabled, true);
  h.changeSession('practice-b'); await $('heygen-generate').emit('click');
  assert(!h.calls.some(c => c.options.method === 'POST'));
});