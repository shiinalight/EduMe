/** Shared with the teammate's tutor. This module has no browser dependencies. */
export function buildTutorPayload({ sessionId, worksheet, question, attempts, includeInk = true }) {
  return {
    schema_version: '1.0', event: 'student_work_updated', session_id: sessionId,
    worksheet: worksheet ? { id: worksheet.id, title: worksheet.title, language: worksheet.language, source: worksheet.source, warnings: worksheet.warnings || [] } : null,
    question: question ? { id: question.id, label: question.label, text: question.text, latex: question.latex, diagram_description: question.diagram_description || '', ambiguities: question.ambiguities || [], reviewed: question.reviewed === true } : null,
    student_steps: attempts.map((step, index) => ({
      id: step.id, sequence: index + 1, captured_at: step.captured_at, confirmed_at: step.confirmed_at,
      input_source: step.input_source, recognition: step.recognition,
      lines: step.lines, reviewed_by_student: true,
      ...(includeInk ? { ink: step.ink } : {}),
    })),
    tutor_request: { action: 'observe_only', hint_requested: false },
  };
}
