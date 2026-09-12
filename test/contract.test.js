import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTutorPayload } from '../public/contract.js';

test('contract preserves ordered steps, original vs reviewed math, and original ink', () => {
  const attempts = [{ id: 'step-1', captured_at: '2026-09-12T12:00:00Z', confirmed_at: '2026-09-12T12:00:05Z', input_source: 'handwriting', recognition: { lines: [{ latex: 'x = S' }] }, lines: [{ text: 'x = 5', latex: 'x = 5', ambiguities: ['S or 5'] }], ink: { width: 1200, height: 640, strokes: [] } }];
  const args = { sessionId: 'session-1', worksheet: { id: 'sheet-1', title: 'Math', source: 'example', language: 'en' }, question: { id: 'q1', label: '1', text: 'Solve.', latex: 'x+2=7', reviewed: true }, attempts };
  const full = buildTutorPayload(args), compact = buildTutorPayload({ ...args, includeInk: false });
  assert.equal(full.schema_version, '1.0'); assert.equal(full.student_steps[0].sequence, 1);
  assert.equal(full.student_steps[0].recognition.lines[0].latex, 'x = S'); assert.equal(full.student_steps[0].lines[0].latex, 'x = 5');
  assert.equal(full.student_steps[0].reviewed_by_student, true); assert(full.student_steps[0].ink); assert(!compact.student_steps[0].ink);
  assert.equal(full.tutor_request.hint_requested, false); assert.equal(full.tutor_request.action, 'observe_only');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(full)));
});
