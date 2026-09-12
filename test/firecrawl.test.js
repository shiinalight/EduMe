import test from 'node:test';
import assert from 'node:assert/strict';
import { importPage, publicPageUrl } from '../server/firecrawl.js';
import { buildTutorPayload } from '../public/contract.js';

const page = () => ({ title: 'Linear equations', language: 'en', lesson_context: 'Apply the same operation to both sides.',
  questions: [{ label: 'Exercise 1', text: 'Solve for x.', latex: '2x + 3 = 11', diagram_description: '', ambiguities: [] }], warnings: [] });
const response = value => ({ ok: true, json: async () => ({ success: true, data: { json: value } }) });

test('public URL validation rejects credentials, local endpoints and non-web schemes before provider calls', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]',
    'http://localhost', 'https://host.local', 'https://host.internal', 'https://name:pass@www.mathsisfun.com',
    'https://www.mathsisfun.com:3000', 'bad', null]) assert.throws(() => publicPageUrl(url), { status: 400 });
  assert.equal(publicPageUrl(' https://www.mathsisfun.com/algebra/index.html#intro '), 'https://www.mathsisfun.com/algebra/index.html');
});

test('web extraction uses the fixed Firecrawl endpoint and exports source context without leaking a key', async () => {
  let request;
  const value = page(); value.questions[0].reviewed = true; value.questions[0].id = 'untrusted-id';
  const result = await importPage({ url: 'https://www.mathsisfun.com/algebra/index.html' }, { apiKey: 'private-test-key',
    fetcher: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return response(value); } });
  assert.equal(request.url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(request.options.headers.Authorization, 'Bearer private-test-key');
  assert.equal(request.options.redirect, 'error'); assert.equal(request.body.formats[0].type, 'json');
  assert.equal(result.questions[0].reviewed, false); assert.notEqual(result.questions[0].id, 'untrusted-id');
  assert.equal(result.questions[0].latex, '2x + 3 = 11'); assert.equal(result.source, 'firecrawl');
  const payload = buildTutorPayload({ sessionId: 's', worksheet: result, question: result.questions[0], attempts: [] });
  assert.equal(payload.worksheet.source_url, request.body.url);
  assert.equal(payload.worksheet.lesson_context, value.lesson_context);
  assert.equal(payload.worksheet.context_is_untrusted, true);
  assert.equal(payload.question.origin, 'extracted');
  assert(!JSON.stringify(payload).includes('private-test-key'));
});

test('lesson-only pages keep context without inventing exercises; empty pages fail', async () => {
  const value = page(); value.questions = [];
  const result = await importPage({ url: 'https://www.mathsisfun.com' }, { apiKey: 'test', fetcher: async () => response(value) });
  assert.equal(result.questions.length, 0); assert.match(result.warnings.join(' '), /manually/);
  value.lesson_context = '';
  await assert.rejects(importPage({ url: 'https://www.mathsisfun.com' }, { apiKey: 'test', fetcher: async () => response(value) }), { status: 422 });
});

test('missing key, credits, rate limit, network, malformed and oversized extraction errors are explicit', async () => {
  const body = { url: 'https://www.mathsisfun.com' };
  await assert.rejects(importPage(body, { apiKey: '', fetcher: () => assert.fail('must not fetch') }), { status: 503 });
  for (const [status, pattern] of [[401, /API key/], [402, /credits/], [429, /rate limit/]]) {
    await assert.rejects(importPage(body, { apiKey: 'test', fetcher: async () => ({ ok: false, status }) }), pattern);
  }
  for (const fetcher of [
    async () => { throw new Error('network secret'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    async () => ({ ok: true, json: async () => ({ success: false }) }),
    async () => response({ ...page(), questions: [{ text: 'incomplete' }] }),
    async () => response({ ...page(), lesson_context: 'x'.repeat(16001) }),
  ]) await assert.rejects(importPage(body, { apiKey: 'test', fetcher }), { status: 502 });
});
