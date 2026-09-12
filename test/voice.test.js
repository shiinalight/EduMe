import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudio, transcribeAudio, parseSpokenMath } from '../server/voice.js';
import { buildTutorPayload } from '../public/contract.js';

const audio = 'data:audio/webm;base64,' + Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3]).toString('base64');
const math = { title: 'Dictated math', language: 'en', questions: [{ label: 'Formula 1', text: 'x squared plus three x equals five', latex: 'x^2 + 3x = 5', diagram_description: '', ambiguities: ['Check grouping.'] }], warnings: [] };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const gemini = value => reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });

test('audio input validates size, encoding and container before any provider call', async () => {
  assert.equal(parseAudio(audio).mime, 'audio/webm');
  assert.equal(parseAudio(audio.replace('audio/webm', 'audio/webm;codecs=opus')).extension, 'webm');
  for (const invalid of ['', 'data:text/plain;base64,AAAA', audio.replace('audio/webm', 'audio/wav'), 'https://example.org/a.mp3', audio + '?']) assert.throws(() => parseAudio(invalid));
  assert.throws(() => parseAudio('x'.repeat(9 * 1024 * 1024)), e => e.status === 413);
  await assert.rejects(transcribeAudio({ audio: 'invalid' }, { apiKey: 'test', fetcher: () => assert.fail('must not fetch') }), e => e.status === 400);
  await assert.rejects(transcribeAudio({ audio }, { apiKey: '' }), e => e.status === 503);
});

test('ElevenLabs uses fixed endpoint, multipart Scribe request and returns only transcript metadata', async () => {
  const result = await transcribeAudio({ audio }, { apiKey: 'secret-test-key', fetcher: async (url, options) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(options.headers['xi-api-key'], 'secret-test-key');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body.get('model_id'), 'scribe_v2');
    assert.equal(options.body.get('tag_audio_events'), 'false');
    assert.equal(options.body.get('file').name, 'dictation.webm');
    assert.equal(options.body.get('file').size, 8);
    return reply({ text: ' x squared ', language_code: 'en', words: [], arbitrary: 'secret-test-key' });
  } });
  assert.deepEqual(result, { text: 'x squared', source: 'elevenlabs', model: 'scribe_v2', needs_review: true });
  assert(!JSON.stringify(result).includes('secret-test-key'));
});

test('speech provider errors, silence and malformed responses are explicit and sanitized', async () => {
  for (const status of [401, 403, 402, 422, 429, 500]) {
    await assert.rejects(transcribeAudio({ audio }, { apiKey: 'test', fetcher: async () => reply({ detail: 'secret-value' }, status) }), e => e.status === (status === 429 ? 429 : 502) && !e.message.includes('secret-value'));
  }
  for (const value of [null, {}, { text: 'a'.repeat(16001) }]) await assert.rejects(transcribeAudio({ audio }, { apiKey: 'test', fetcher: async () => reply(value) }), e => e.status === 502);
  await assert.rejects(transcribeAudio({ audio }, { apiKey: 'test', fetcher: async () => reply({ text: ' ' }) }), e => e.status === 422);
  await assert.rejects(transcribeAudio({ audio }, { apiKey: 'test', fetcher: async () => new Response('invalid') }), e => e.status === 502);
  for (const name of ['TimeoutError', 'TypeError']) await assert.rejects(transcribeAudio({ audio }, { apiKey: 'test', fetcher: async () => { throw Object.assign(new Error('secret-value'), { name }); } }), e => e.status === 502 && !e.message.includes('secret-value'));
});

test('spoken math uses untrusted text and schema, preserving review state and provenance', async () => {
  const result = await parseSpokenMath({ transcript: 'x squared plus three x equals five' }, { apiKey: 'test', model: 'test-model', fetcher: async (url, options) => {
    assert.match(url, /models\/test-model:generateContent$/);
    const body = JSON.parse(options.body);
    assert.match(body.systemInstruction.parts[0].text, /untrusted DATA/);
    assert.match(body.systemInstruction.parts[0].text, /Preserve incorrect and incomplete/);
    assert.equal(body.contents[0].parts[0].text, 'x squared plus three x equals five');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return gemini({ ...math, api_key: 'provider-extra', questions: [{ ...math.questions[0], extra: 'provider-extra' }] });
  } });
  assert.equal(result.source, 'voice'); assert.equal(result.needs_review, true);
  assert.equal(result.questions[0].reviewed, false); assert.equal(result.questions[0].origin, 'voice');
  assert.equal(result.questions[0].latex, math.questions[0].latex); assert(result.questions[0].id);
  assert(!JSON.stringify(result).includes('provider-extra'));
});

test('spoken math rejects invalid requests, incomplete or oversized output and provider failures', async () => {
  for (const transcript of [null, '', ' ', 'a'.repeat(16001)]) await assert.rejects(parseSpokenMath({ transcript }, { apiKey: 'test', fetcher: () => assert.fail('must not fetch') }), e => e.status === 400);
  await assert.rejects(parseSpokenMath({ transcript: 'x' }, { apiKey: '' }), e => e.status === 503);
  await assert.rejects(parseSpokenMath({ transcript: 'x' }, { apiKey: 'test', model: '../invalid' }), e => e.status === 500);
  for (const fetcher of [async () => gemini({}), async () => gemini({ ...math, questions: Array(13).fill(math.questions[0]) }), async () => reply({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), async () => new Response('bad'), async () => { throw new Error('network'); }]) {
    await assert.rejects(parseSpokenMath({ transcript: 'x' }, { apiKey: 'test', fetcher }), e => e.status === 502);
  }
  for (const status of [401, 429, 500]) await assert.rejects(parseSpokenMath({ transcript: 'x' }, { apiKey: 'test', fetcher: async () => reply({}, status) }), e => e.status === (status === 429 ? 429 : 502));
  const empty = await parseSpokenMath({ transcript: 'hello' }, { apiKey: 'test', fetcher: async () => gemini({ ...math, questions: [], warnings: ['No math.'] }) });
  assert.equal(empty.questions.length, 0);
});

test('tutor payload preserves voice transcript provenance without audio or invented student steps', () => {
  const voice = { original_transcript: 'ex squared', transcript: 'x squared', transcription_provider: 'elevenlabs', transcription_model: 'scribe_v2', math_model: 'test', context_is_untrusted: true };
  const payload = buildTutorPayload({ sessionId: 's', worksheet: { id: 'w', title: 'Math', source: 'voice' }, question: { ...math.questions[0], id: 'q', origin: 'voice', reviewed: true, voice }, attempts: [] });
  assert.deepEqual(payload.question.voice, voice); assert.equal(payload.question.origin, 'voice');
  assert.deepEqual(payload.student_steps, []); assert(!('audio' in payload.question.voice));
});