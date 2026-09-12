import { InkCanvas, exampleInk } from './ink.js';
import { buildTutorPayload } from './contract.js';
import { onStudentStep } from './tutor-bridge.js';
import { uuid } from './ids.js';
import { setupVoice } from './voice.js';

const $ = id => document.getElementById(id);
const state = { sessionId: uuid(), configured: false, worksheet: null, questionId: null, work: new Map(), image: null, revision: 0, busy: false, extractionBusy: false, recognition: null, recognitionSnapshot: null, fixture: false, questionEditing: null, pendingImport: null };
function newWork() { return { strokes: [], attempts: [], fixture: false }; }
function currentQuestion() { return state.worksheet?.questions.find(q => q.id === state.questionId); }
function currentWork() { return state.work.get(state.questionId); }
function note(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function payload(includeInk = true) { return buildTutorPayload({ sessionId: state.sessionId, worksheet: state.worksheet, question: currentQuestion(), attempts: currentWork()?.attempts || [], includeInk }); }
function refreshPayload() { $('payload').textContent = currentQuestion() ? JSON.stringify(payload(false), null, 2) : 'No question selected.'; $('export').disabled = !currentQuestion(); }
function invalidateReading() { state.revision++; state.recognition = null; state.recognitionSnapshot = null; $('reading').hidden = true; $('reading-empty').hidden = false; $('review-check').checked = false; }
const ink = new InkCanvas($('ink'), phase => {
  if (phase === 'finish') ink.commitHistory();
  if (phase === 'cancel') ink.before = null;
  if (phase === 'start' || ['undo', 'redo', 'clear'].includes(phase)) { state.fixture = false; invalidateReading(); }
  const work = currentWork(); if (work) { work.strokes = structuredClone(ink.strokes); work.fixture = state.fixture; }
  refreshInk();
});
function refreshInk() {
  const has = ink.strokes.length > 0, question = Boolean(currentQuestion()), busy = state.busy || state.extractionBusy;
  ink.enabled = question && !busy;
  $('canvas-placeholder').hidden = has;
  $('drawing-help').textContent = !question ? 'Choose Try example, upload a worksheet, or add a question to start.' : 'Click and drag with your mouse, or write with a stylus or finger.';
  $('undo').disabled = busy || !ink.history?.length;
  $('redo').disabled = busy || !ink.redoStack.length;
  $('clear').disabled = busy || !has;
  $('recognize').disabled = busy || !has || !question;
  $('sample-ink').disabled = busy || !question;
  $('type-math').disabled = busy || !question;
  for (const id of ['upload', 'camera-button', 'sample-sheet', 'manual-question', 'edit-question', 'pen', 'eraser', 'import-link', 'speak-problem', 'extract']) $(id).disabled = busy;
  updateConfirm();
  $('ink-status').textContent = state.fixture ? 'Example ink · fixed sample' : has ? `${ink.strokes.length} pen stroke${ink.strokes.length === 1 ? '' : 's'} · not yet submitted` : 'No ink yet';
}
function showQuestions() {
  const questions = state.worksheet?.questions || [];
  $('question-count').textContent = questions.length;
  $('questions').replaceChildren();
  for (const q of questions) {
    const button = document.createElement('button'); button.className = `question-item${q.id === state.questionId ? ' selected' : ''}`; button.setAttribute('aria-pressed', String(q.id === state.questionId));
    const title = document.createElement('strong'); title.textContent = q.label || 'Question'; const text = document.createElement('span'); text.textContent = q.text || q.latex;
    button.append(title, text); button.addEventListener('click', () => selectQuestion(q.id)); $('questions').append(button);
  }
}
function selectQuestion(id) {
  if (state.busy || state.extractionBusy) return;
  if (state.questionId) { const old = currentWork(); if (old) { old.strokes = structuredClone(ink.strokes); old.fixture = state.fixture; } }
  state.questionId = id;
  if (!state.work.has(id)) state.work.set(id, newWork());
  const work = currentWork(); state.fixture = work.fixture; ink.set(work.strokes); invalidateReading();
  renderQuestion(); showQuestions(); showSteps(); refreshInk(); refreshPayload();
}
function renderQuestion() {
  const q = currentQuestion();
  if (!q) {
    $('question-heading').textContent = 'Add a question'; $('question-text').textContent = 'Lesson imported. Add a question manually to start practicing.';
    $('question-source').textContent = 'Lesson context'; $('question-latex').hidden = true;
    $('question-warning').hidden = true; $('edit-question').hidden = true; return;
  } $('question-heading').textContent = q.label || 'Selected question'; $('question-text').textContent = q.text;
  $('question-latex').textContent = q.latex; $('question-latex').hidden = !q.latex;
  $('question-source').textContent = state.worksheet.source === 'example' ? 'Example worksheet' : q.reviewed ? 'Reviewed' : 'Review needed';
  const warnings = [...(state.worksheet.warnings || []), ...(q.ambiguities || []), ...(q.diagram_description ? [`Diagram: ${q.diagram_description}`] : [])];
  $('question-warning').textContent = warnings.join(' '); $('question-warning').hidden = !warnings.length;
  $('edit-question').hidden = false;
}
function acceptWorksheet(worksheet) {
  // Keep prior work in memory but only the active worksheet is exported.
  state.worksheet = { ...worksheet, id: uuid() }; state.questionId = null;
  state.work.clear();
  $('web-source').hidden = !worksheet.source_url;
  if (worksheet.source_url) { $('web-title').textContent = worksheet.title; $('web-url').href = worksheet.source_url; $('web-context').textContent = worksheet.lesson_context || 'No additional lesson context extracted.'; }
  if (worksheet.questions.length) selectQuestion(worksheet.questions[0].id);
  else { ink.set([]); state.fixture = false; invalidateReading(); renderQuestion(); showQuestions(); showSteps(); refreshInk(); refreshPayload(); }
}
$('sample-sheet').addEventListener('click', () => {
  if (state.busy || state.extractionBusy || !mayReplaceSheet()) return;
  acceptWorksheet({ title: 'Algebra · practice sheet', source: 'example', language: 'en', warnings: [], questions: [
    { id: uuid(), label: 'Question 1', text: 'Solve for x. Show each step of your working.', latex: '2x + 3 = 11', ambiguities: [], reviewed: true },
    { id: uuid(), label: 'Question 2', text: 'Expand and simplify the expression.', latex: '3(x + 4) - 2x', ambiguities: [], reviewed: true },
    { id: uuid(), label: 'Question 3', text: 'Add the fractions. Show your working.', latex: '\\frac{1}{3} + \\frac{1}{4}', ambiguities: [], reviewed: true }
  ] });
  state.image = null; $('photo-wrap').hidden = true; $('extract').hidden = true;
  note('Example worksheet loaded. Draw your own work for live recognition, or load the explicitly labeled example ink.');
});
function mayReplaceSheet() { return !state.worksheet || ![...state.work.values()].some(w => w.attempts.length || w.strokes.length) || confirm('Replace the active worksheet? Export any work you want to keep first.'); }
async function imageData(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Please choose a PNG, JPEG or WebP photo. Convert HEIC to JPEG first. PDF import is not part of this prototype.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Please choose a photo under 20 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .92);
  } finally { URL.revokeObjectURL(url); }
}
async function uploadFile(file) {
  if (!file || state.busy || state.extractionBusy) return;
  try { const image = await imageData(file); state.image = image; $('photo').src = image; $('photo-name').textContent = file.name; $('photo-wrap').hidden = false; $('extract').hidden = false; note('Photo is ready locally. Check that the sheet is upright and legible, then choose Convert worksheet to send it for recognition.'); }
  catch (e) { note(e.message, true); }
}
$('upload').addEventListener('change', e => { uploadFile(e.target.files[0]); e.target.value = ''; });
$('camera').addEventListener('change', e => { uploadFile(e.target.files[0]); e.target.value = ''; });
$('camera-button').addEventListener('click', () => $('camera').click());
$('dropzone').addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('drag'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag'));
$('dropzone').addEventListener('drop', e => { e.preventDefault(); $('dropzone').classList.remove('drag'); uploadFile(e.dataTransfer.files[0]); });
async function post(path, body, timeout = 55000) {
  let response;
  try { response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error('Could not complete the request. Check that the local server is running, then retry.'); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Recognition failed.'); return data;
}
setupVoice({ post, canOpen: () => !state.busy && !state.extractionBusy, onImport: result => {
  const voice = { transcript: result.transcript, original_transcript: result.original_transcript, transcription_provider: result.transcription_provider, transcription_model: result.transcription_model, math_model: result.model, created_at: result.created_at, context_is_untrusted: true };
  const questions = result.questions.map(q => ({ ...q, voice: structuredClone(voice) }));
  if (!state.worksheet) acceptWorksheet({ ...result, questions });
  else { state.worksheet.questions.push(...questions); state.worksheet.warnings = [...new Set([...(state.worksheet.warnings || []), ...result.warnings])]; selectQuestion(questions[0].id); }
  note('Reviewed voice formulas added as questions. Existing questions and work are preserved. Export tutor JSON or write your next step.');
} });
// Preview results before replacing the active worksheet. Page text is never rendered as HTML.
$('import-link').addEventListener('click', () => { if (!state.busy && !state.extractionBusy) $('link-dialog').showModal(); });
$('lesson-url').addEventListener('input', () => { state.pendingImport = null; $('link-preview').hidden = true; $('link-status').textContent = ''; });
function updateImportButton() {
  const imported = state.pendingImport;
  $('use-link').disabled = !imported || (imported.questions.length > 0 && !$('link-questions').querySelector('input:checked'));
  $('use-link').textContent = imported?.questions.length ? 'Use selected questions' : 'Use lesson & add a question';
}
$('link-form').addEventListener('submit', async e => {
  e.preventDefault(); if (state.busy || state.extractionBusy) return;
  state.extractionBusy = true; state.pendingImport = null; $('link-preview').hidden = true;
  $('fetch-link').disabled = true; $('lesson-url').disabled = true; $('fetch-link').textContent = 'Reading page…';
  $('link-status').textContent = 'Reading this page and extracting its exercises. This can take about a minute.'; refreshInk();
  try {
    const result = await post('/api/import-url', { url: $('lesson-url').value.trim() }, 85000);
    state.pendingImport = result; $('link-title').textContent = result.title;
    $('link-context').textContent = result.lesson_context; $('link-warnings').textContent = result.warnings.join(' ');
    $('link-questions').replaceChildren();
    for (const q of result.questions) {
      const label = document.createElement('label'); label.className = 'import-question';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.value = q.id;
      check.addEventListener('change', updateImportButton);
      const content = document.createElement('span'); const title = document.createElement('strong'); title.textContent = q.label || 'Exercise';
      const text = document.createElement('p'); text.textContent = q.text;
      const math = document.createElement('pre'); math.textContent = q.latex;
      content.append(title, text, math); label.append(check, content); $('link-questions').append(label);
    }
    $('link-status').textContent = result.questions.length ? `Found ${result.questions.length} exercise(s). Choose which to import.` : 'Lesson found, but no existing exercises. You can add your own question.';
    $('link-preview').hidden = false; updateImportButton();
  } catch (error) { $('link-status').textContent = error.message; }
  finally { state.extractionBusy = false; $('fetch-link').disabled = false; $('lesson-url').disabled = false; $('fetch-link').textContent = 'Read page'; refreshInk(); }
});
$('use-link').addEventListener('click', () => {
  if (!state.pendingImport || state.busy || state.extractionBusy || !mayReplaceSheet()) return;
  const chosen = new Set([...$('link-questions').querySelectorAll('input:checked')].map(input => input.value));
  const original = state.pendingImport;
  if (original.questions.length && !chosen.size) return;
  acceptWorksheet({ ...original, questions: original.questions.filter(q => chosen.has(q.id)) });
  state.image = null; $('photo-wrap').hidden = true; $('extract').hidden = true;
  $('link-dialog').close(); state.pendingImport = null; $('link-preview').hidden = true; $('link-status').textContent = '';
  note('Web lesson imported. Review the questions against the original page, then write or type your next step.');
  if (!state.worksheet.questions.length) openQuestionEditor(true);
});
$('extract').addEventListener('click', async () => {
  if (!state.image || state.extractionBusy || state.busy || !mayReplaceSheet()) return;
  state.extractionBusy = true; $('extract').disabled = true; $('extract').textContent = 'Reading worksheet…'; refreshInk();
  try { const result = await post('/api/worksheet', { image: state.image }); if (!result.questions.length) throw new Error('No readable questions found. Try a clearer crop or add a question manually.'); state.extractionBusy = false; acceptWorksheet(result); note(`Found ${result.questions.length} question(s). Review the selected question against the photo before confirming a student step.`); }
  catch (e) { note(e.message, true); }
  finally { state.extractionBusy = false; $('extract').disabled = false; $('extract').textContent = 'Convert worksheet'; refreshInk(); }
});
function openQuestionEditor(manual = false) {
  if (state.busy || state.extractionBusy) return;
  state.questionEditing = manual ? null : currentQuestion()?.id;
  const q = manual ? null : currentQuestion(); $('question-input').value = q?.text || ''; $('question-math-input').value = q?.latex || ''; $('question-dialog').showModal();
}
$('manual-question').addEventListener('click', () => openQuestionEditor(true));
$('edit-question').addEventListener('click', () => openQuestionEditor());
$('question-form').addEventListener('submit', e => {
  e.preventDefault(); const text = $('question-input').value.trim(); if (!text) return;
  if (!state.worksheet) state.worksheet = { id: uuid(), title: 'My practice', source: 'manual', language: 'und', warnings: [], questions: [] };
  const existing = state.worksheet.questions.find(q => q.id === state.questionEditing);
  const q = existing || { id: uuid(), origin: 'manual', label: `Question ${state.worksheet.questions.length + 1}`, ambiguities: [], diagram_description: '' };
  if (existing && currentWork()?.attempts.length && (q.text !== text || q.latex !== $('question-math-input').value.trim()) && !confirm('You are editing a question with saved steps. The export will use this revised question. Continue?')) return;
  Object.assign(q, { text, latex: $('question-math-input').value.trim(), reviewed: true }); if (!existing) state.worksheet.questions.push(q);
  $('question-dialog').close();
  if (existing && state.questionId === q.id) { renderQuestion(); showQuestions(); refreshPayload(); }
  else selectQuestion(q.id);
  note('Question reviewed. You can confirm any pending transcription or continue writing.');
});
for (const mode of ['pen', 'eraser']) $(mode).addEventListener('click', () => { ink.mode = mode; for (const other of ['pen', 'eraser']) { $(other).classList.toggle('active', mode === other); $(other).setAttribute('aria-pressed', String(mode === other)); } });
$('ignore-touch').addEventListener('change', e => { ink.ignoreTouch = e.target.checked; note(ink.ignoreTouch ? 'Finger touch ignored. Mouse and stylus drawing remain enabled.' : 'Click and drag with your mouse, or write with a stylus or finger.'); });
$('undo').addEventListener('click', () => ink.undo()); $('redo').addEventListener('click', () => ink.redo());
$('clear').addEventListener('click', () => { if (confirm('Clear the current ink? You can undo this.')) ink.clear(); });
$('sample-ink').addEventListener('click', () => {
  if (ink.strokes.length && !confirm('Replace current ink with the fixed example “2x + 3 = 11”?')) return;
  invalidateReading(); ink.set(exampleInk()); state.fixture = true; currentWork().strokes = structuredClone(ink.strokes); currentWork().fixture = true; refreshInk(); note('Fixed example loaded: 2x + 3 = 11. Reading this unchanged sample uses a fixture, not the recognition API. Editing any stroke switches to live recognition.');
});
function displayRecognition(result, snapshot) {
  state.recognition = structuredClone(result); state.recognitionSnapshot = snapshot;
  $('reading-empty').hidden = true; $('reading').hidden = false; $('review-check').checked = false;
  $('reading-meta').textContent = result.source === 'example' ? 'Example fixture · not live recognition' : result.source === 'manual' ? 'Manual transcription · not OCR' : 'Gemini transcription · review required';
  const warnings = [...(result.warnings || []), ...result.lines.flatMap(l => l.ambiguities || [])];
  if (result.lines.some(l => l.legibility === 'uncertain')) warnings.unshift('Some handwriting was uncertain. Check every symbol.');
  $('reading-warnings').textContent = warnings.join(' '); $('reading-warnings').hidden = !warnings.length;
  $('line-editors').replaceChildren();
  result.lines.forEach((line, i) => {
    const wrap = document.createElement('div'); wrap.className = 'line-editor'; const title = document.createElement('h3'); title.textContent = `Line ${i + 1}`; wrap.append(title);
    for (const [key, labelText] of [['text', 'Plain text'], ['latex', 'LaTeX']]) {
      const label = document.createElement('label'); label.textContent = labelText; label.htmlFor = `line-${i}-${key}`;
      const textarea = document.createElement('textarea'); textarea.id = label.htmlFor; textarea.rows = 2; textarea.maxLength = 16000; textarea.spellcheck = false; textarea.value = line[key]; textarea.className = key; textarea.dataset.line = i; textarea.dataset.field = key;
      textarea.addEventListener('input', () => { $('review-check').checked = false; updateConfirm(); }); wrap.append(label, textarea);
    }
    $('line-editors').append(wrap);
  });
  updateConfirm();
}
function editedLines() { return state.recognition.lines.map((line, i) => ({ text: $(`line-${i}-text`).value.trim(), latex: $(`line-${i}-latex`).value.trim(), ambiguities: line.ambiguities || [] })); }
function updateConfirm() { $('confirm-step').disabled = state.busy || state.extractionBusy || !state.recognition || !$('review-check').checked || !state.recognition.lines.length || editedLines().some(l => !l.text && !l.latex); }
$('review-check').addEventListener('change', updateConfirm);
$('recognize').addEventListener('click', async () => {
  if (state.busy || state.extractionBusy || !ink.strokes.length) return;
  const revision = state.revision, questionId = state.questionId, image = ink.image();
  const snapshot = { revision, questionId, ink: ink.export(), captured_at: new Date().toISOString(), input_source: state.fixture ? 'example' : 'handwriting' };
  state.busy = true; $('recognize').textContent = 'Reading your ink…'; refreshInk();
  try {
    const result = state.fixture ? { recognition_id: uuid(), source: 'example', model: null, needs_review: true, lines: [{ text: '2x + 3 = 11', latex: '2x + 3 = 11', legibility: 'clear', ambiguities: [] }], warnings: ['Fixed sample transcription. This is not recognition of arbitrary handwriting.'] } : await post('/api/recognize', { image });
    if (revision !== state.revision || questionId !== state.questionId) return;
    if (!result.lines.length) throw new Error('No readable handwriting found. Try larger, darker writing or type the line manually.');
    displayRecognition(result, snapshot); note('Check the plain text and LaTeX against your ink, then confirm the step. Mathematical correctness has not been checked.');
  } catch (e) { note(e.message, true); }
  finally { state.busy = false; $('recognize').innerHTML = 'Read my handwriting <span aria-hidden="true">→</span>'; refreshInk(); }
});
$('type-math').addEventListener('click', () => {
  displayRecognition({ recognition_id: uuid(), source: 'manual', model: null, lines: [{ text: '', latex: '', legibility: 'clear', ambiguities: [] }], warnings: [] }, { revision: state.revision, questionId: state.questionId, ink: ink.export(), captured_at: new Date().toISOString(), input_source: 'typed' });
  $('line-0-text').focus(); note('Enter the step manually. It will be labeled typed, not recognized handwriting.');
});
$('confirm-step').addEventListener('click', async () => {
  if (state.busy || state.extractionBusy || !state.recognition || !$('review-check').checked || !currentQuestion()) return;
  if (state.recognitionSnapshot.revision !== state.revision || state.recognitionSnapshot.questionId !== state.questionId) return note('The ink changed. Please recognize it again before confirming.', true);
  if (!currentQuestion().reviewed) return note('First review / edit the question against the source photo or original webpage and save it. Your transcription is still here.', true);
  const lines = editedLines(); if (lines.some(l => !l.text && !l.latex)) return;
  const snapshot = state.recognitionSnapshot;
  currentWork().attempts.push({ id: uuid(), captured_at: snapshot.captured_at, confirmed_at: new Date().toISOString(), input_source: snapshot.input_source, recognition: structuredClone(state.recognition), lines, ink: snapshot.ink });
  const event = payload(); ink.set([]); currentWork().strokes = []; currentWork().fixture = false; state.fixture = false; invalidateReading(); showSteps(); refreshInk(); refreshPayload();
  note('Step confirmed. The canvas is ready for your next step. Export the JSON whenever you want to pass this work to the tutor.');
  try { await onStudentStep(event); } catch { note('The step is saved in this tab, but the tutor integration failed. Export JSON to keep the work.', true); }
});
function showSteps() {
  const attempts = currentWork()?.attempts || []; $('step-count').textContent = attempts.length; $('steps').replaceChildren();
  if (!attempts.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Reviewed steps will appear here, in the order you wrote them.'; $('steps').append(p); return; }
  attempts.forEach((step, i) => {
    const card = document.createElement('div'); card.className = 'step-card'; const badge = document.createElement('span'); badge.className = 'step-index'; badge.textContent = i + 1;
    const content = document.createElement('div'); content.className = 'step-content';
    for (const line of step.lines) { const pre = document.createElement('pre'); pre.textContent = line.latex || line.text; content.append(pre); }
    const meta = document.createElement('small'); meta.textContent = `${step.input_source === 'example' ? 'Example fixture' : step.input_source === 'typed' ? 'Typed' : 'Handwritten'} · reviewed by you`; content.append(meta);
    const remove = document.createElement('button'); remove.className = 'subtle'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove step ${i + 1}`); remove.addEventListener('click', async () => { if (!confirm('Remove this confirmed step?')) return; currentWork().attempts = currentWork().attempts.filter(s => s.id !== step.id); showSteps(); refreshPayload(); try { await onStudentStep(payload()); } catch { note('Step removed locally, but the tutor integration failed.', true); } });
    card.append(badge, content, remove); $('steps').append(card);
  });
}
$('export').addEventListener('click', () => {
  const data = payload(); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `inkmath-${state.questionId.slice(0, 8)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  note('Exported the selected question and its confirmed steps. Unconfirmed ink is not included. Export other questions separately.');
});
$('setup-button').addEventListener('click', () => $('setup-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
window.addEventListener('beforeunload', e => { if ([...state.work.values()].some(w => w.attempts.length || w.strokes.length)) { e.preventDefault(); e.returnValue = ''; } });
try { const response = await fetch('/api/status'); if (!response.ok) throw new Error(); const status = await response.json(); state.configured = status.configured; $('voice-connection').textContent = status.elevenlabs_configured && status.configured ? 'ElevenLabs + Gemini · voice ready' : !status.elevenlabs_configured ? 'Voice: add ELEVENLABS_API_KEY in Setup' : 'Voice math: add GEMINI_API_KEY in Setup'; $('link-connection').textContent = status.firecrawl_configured ? 'Firecrawl · link import ready' : 'Link import: add a Firecrawl API key in Setup'; $('connection').textContent = status.configured ? 'Live recognition ready' : 'Gemini not configured · manual input ready'; $('connection').classList.toggle('live', status.configured); }
catch { $('connection').textContent = 'Server unavailable'; note('Run npm start and open the localhost URL. Opening index.html directly will not connect the recognizer.', true); }
refreshInk();

// Optional browser-agent integration: read-only, no uploads or automatic confirmations.
if (document.modelContext?.registerTool) {
  try { await document.modelContext.registerTool({ name: 'read_student_work', title: 'Read confirmed student work', description: 'Return the selected question and student-confirmed steps. Does not recognize, solve, send data, or confirm anything.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object.'); return currentQuestion() ? payload(false) : { status: 'no_question_selected' }; } }); }
  catch { /* Not required for regular browsers. */ }
}
