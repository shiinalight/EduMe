import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImage, recognize, validateResult } from '../server/recognition.js';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
const transcript = { lines: [{ text: '2 + 2 = 5', latex: '2 + 2 = 5', legibility: 'uncertain', ambiguities: ['Last symbol could be 5 or S.'] }], warnings: [] };
const response = value => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] }), { status: 200 });

test('accepts image bytes and rejects unsupported, disguised, missing, and oversized images', () => {
  assert.equal(parseImage(image).mimeType, 'image/png');
  for (const bad of [null, '', 'https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,aGVsbG8=', image.replace('image/png', 'image/jpeg')]) assert.throws(() => parseImage(bad), e => e.status === 400);
  assert.throws(() => parseImage('data:image/png;base64,' + Buffer.alloc(7 * 1024 * 1024).toString('base64')), e => e.status === 413);
});
test('live recognition without key fails explicitly and never becomes a fake result', async () => {
  await assert.rejects(recognize('handwriting', { image }, { apiKey: '' }), e => e.status === 503);
});
test('adapter sends actual image and strict schema, preserving incorrect mathematics', async () => {
  let request;
  const result = await recognize('handwriting', { image }, { apiKey: 'test-key', fetcher: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return response(transcript); } });
  assert.equal(result.lines[0].latex, '2 + 2 = 5'); assert.equal(result.needs_review, true);
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key'); assert(!request.url.includes('test-key'));
  assert.equal(request.body.contents[0].parts[1].inlineData.data, image.split(',')[1]);
  assert(request.body.generationConfig.responseJsonSchema.properties.lines);
  assert.match(request.body.systemInstruction.parts[0].text, /Do not solve/);
  assert.equal(result.source, 'gemini'); assert(result.recognition_id);
});
test('worksheet response adds unique question IDs and requires human review', async () => {
  const result = await recognize('worksheet', { image }, { apiKey: 'test', fetcher: async () => response({ title: 'Practice', language: 'de', questions: [{ label: '1', text: 'Löse die Gleichung.', latex: 'x+3=7', diagram_description: '', ambiguities: [] }], warnings: [] }) });
  assert.equal(result.questions[0].reviewed, false); assert(result.questions[0].id);
});
test('malformed output, quota errors, timeout and blocked/incomplete responses surface safely', async () => {
  assert.throws(() => validateResult({ lines: [{ text: 'x' }], warnings: [] }, 'handwriting'), e => e.status === 502);
  for (const [fetcher, expected] of [
    [async () => response({ invalid: true }), 502],
    [async () => new Response('secret provider error', { status: 429 }), 429],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 502],
    [async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), 502]
  ]) await assert.rejects(recognize('handwriting', { image }, { apiKey: 'test', fetcher }), e => e.status === expected && !e.message.includes('secret'));
});
