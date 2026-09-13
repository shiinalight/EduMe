import { setupHeygenVideo } from './heygen-video.js';
import { setupVoice } from './voice.js';
import { setupCapture, downloadJSON } from './capture.js';
import { Drawing, paintStrokes } from './drawing.js';

const $ = id => document.getElementById(id);
const canvas = $('writing-pad');
const latexInput = $('latex-input');
const reviewButton = $('review-button');
const checkButton = $('check-button');
const inkReviewed = $('ink-reviewed');
const recheckButton = $('recheck-transcription');
let strokes = [], stepIndex = 0, learningSessionId = null;
let currentStudent = null, currentPractice = null, currentSessionImported = false;
let authMode = 'register', selectedTopicKey = 'pythagoras', defaultOcrProvider = 'local-pix2tex';
let currentInkMathLines = [], currentInkLineGroups = [], submittedSteps = [];
let generation = 0, pending = null, providerGeneration = 0;

const tutorVideo = setupHeygenVideo({ getSessionId: () => learningSessionId });
const capture = setupCapture({ onPractice: activatePractice });
const voice = setupVoice({
  getSessionId: () => learningSessionId,
  onUse: line => {
    if (!learningSessionId || pending) return;
    latexInput.value = line.latex || line.text;
    setStepToolsVisible(true);
  },
  onNotebook: value => openLibrary(value),
});
const drawing = new Drawing(canvas, reason => {
  strokes = drawing.strokes;
  $('canvas-placeholder').classList.toggle('hidden', Boolean(strokes.length));
  if (reason !== 'resize') {
    clearInkMathTranscription();
    $('error-markers').replaceChildren();
  }
  refreshControls();
});

function showCoach() { $('coach-card').classList.remove('hidden'); $('practice-workspace').classList.remove('coach-hidden'); }
function showOcrMessage(message) { $('ocr-message').textContent = message; $('ocr-message').classList.remove('hidden'); showCoach(); }
function hideOcrMessage() { $('ocr-message').textContent = ''; $('ocr-message').classList.add('hidden'); }
function showAuthMessage(message) { $('auth-message').textContent = message; $('auth-message').classList.remove('hidden'); }
function hideAuthMessage() { $('auth-message').classList.add('hidden'); }
function clearWriting() { drawing.reset(); }
function resizeCanvas() { drawing.resize(); }

function refreshControls() {
  const locked = Boolean(pending) || !learningSessionId;
  for (const id of ['check-button', 'review-button', 'download-work', 'latex-input', 'ocr-provider',
    'toggle-step-tools', 'voice-formula-button', 'clear-button', 'eraser-button', 'pen-only']) $(id).disabled = locked;
  document.querySelectorAll('.sample-button').forEach(button => { button.disabled = locked; });
  document.querySelectorAll('.line-explain-button').forEach(button => { button.disabled = locked; });
  document.querySelectorAll('.sample-row').forEach(row => row.classList.toggle('hidden', currentSessionImported));
  $('undo-button').disabled = locked || !drawing.history.length;
  $('redo-button').disabled = locked || !drawing.redoStack.length;
  drawing.enabled = !locked;
  inkReviewed.disabled = locked || !currentInkMathLines.length;
  recheckButton.disabled = locked || !inkReviewed.checked || !currentInkMathLines.length
    || currentInkMathLines.some(line => !(line.latex || '').trim());
  $('inkmath-lines').querySelectorAll('input').forEach(input => { input.disabled = locked; });
  checkButton.firstChild.textContent = pending?.kind === 'step' ? 'Submitting… '
    : currentSessionImported ? 'Save this step ' : 'Check this step ';
  reviewButton.textContent = pending?.kind === 'recognition' ? 'Reading handwriting…'
    : pending?.kind === 'submission' ? 'Submitting reviewed lines…'
    : pending?.kind === 'review' ? 'Loading saved work…'
    : strokes.length ? 'Read handwriting' : 'Review saved work';
  $('download-work').textContent = pending?.kind === 'export' ? 'Preparing JSON…' : '↓ Work JSON';
}

// A token owns both the session ID and its abort signal. Every continuation
// checks it before changing UI or starting another request (especially OCR).
function current(token) { return token.generation === generation && token.id === learningSessionId; }
function assertCurrent(token) { if (!current(token)) throw new DOMException('Practice changed.', 'AbortError'); }
function cancelWork() {
  generation++;
  pending?.controller.abort(); pending = null;
  refreshControls();
}
async function request(token, path, body) {
  assertCurrent(token);
  const response = await fetch(path, { credentials: 'same-origin', signal: token.controller.signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  assertCurrent(token);
  const data = await response.json();
  assertCurrent(token);
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The request could not be completed.');
  return data;
}
async function operation(kind, action) {
  if (!learningSessionId || pending) return;
  drawing.cancel();
  const token = { generation, id: learningSessionId, controller: new AbortController(), kind, step: stepIndex, provider: defaultOcrProvider };
  pending = token; hideOcrMessage(); refreshControls();
  try { await action(token); }
  catch (error) { if (current(token) && error.name !== 'AbortError') showOcrMessage(error.message); }
  finally { if (current(token) && pending === token) { pending = null; refreshControls(); } }
}

function resetPractice() {
  cancelWork();
  learningSessionId = null; currentPractice = null; currentSessionImported = false; stepIndex = 0; submittedSteps = [];
  voice.reset(); capture.reset(); tutorVideo.reset();
  if ($('foundation-modal').open) $('foundation-modal').close();
  latexInput.value = ''; clearWriting(); clearTutorGuidance();
  drawing.mode = 'pen'; drawing.ignoreTouch = false;
  $('eraser-button').setAttribute('aria-pressed', 'false'); $('pen-only').checked = false;
  $('review-findings').replaceChildren(); $('feedback-result').className = 'feedback-result hidden';
  $('feedback-empty').classList.remove('hidden');
  for (const id of ['result-label', 'result-title', 'result-hint', 'problem-prompt', 'problem-goal', 'upload-status', 'connection-label']) $(id).textContent = '';
  $('upload-status').classList.add('hidden'); $('foundation-card').classList.add('hidden');
  setStepToolsVisible(false); hideOcrMessage();
  $('coach-card').classList.add('hidden'); $('practice-workspace').classList.add('coach-hidden');
  refreshControls();
}

function activatePractice(data) {
  if (!currentStudent || !data?.sessionId) return;
  resetPractice();
  learningSessionId = data.sessionId;
  currentSessionImported = data.imported === true;
  // Only problem presentation metadata is retained, never a learner/profile or key.
  currentPractice = { topic: data.topic || 'My question', prompt: data.prompt || '', goal: data.goal || '' };
  stepIndex = data.nextStep ?? 0;
  $('problem-prompt').textContent = currentPractice.prompt;
  $('problem-goal').textContent = currentPractice.goal;
  $('practice-topic-label').textContent = currentSessionImported ? 'Self-guided · Not graded' : `${currentPractice.topic} practice`;
  $('practice-title').textContent = currentPractice.topic;
  $('foundation-name').textContent = data.foundation || '';
  $('foundation-description').textContent = currentPractice.topic === 'Algebraic equations'
    ? 'Use inverse operations to keep both sides balanced while solving for an unknown.'
    : 'Use the theorem and rearrange it to find an unknown side.';
  $('student-summary').textContent = `${currentStudent.fullName} · Grade ${currentStudent.grade}`;
  $('connection-label').textContent = currentSessionImported ? 'Self-guided practice—not graded' : 'New problem ready';
  $('auth-screen').classList.add('hidden'); $('learning-home').classList.add('hidden'); $('learning-app').classList.remove('hidden');
  // Set and reveal initial guidance after clearing OCR/coach state, including
  // the HeyGen launch button; setting a draft never generates a video.
  hideOcrMessage(); applyTutorGuidance(data.tutor);
  if (currentSessionImported) displaySavedReview({ findings: [] });
  refreshControls(); requestAnimationFrame(resizeCanvas);
  void loadDefaultOcrProvider();
}

async function startPractice(topicKey = selectedTopicKey) {
  if (!currentStudent) return;
  selectedTopicKey = topicKey; resetPractice();
  $('learning-home').classList.add('hidden'); $('learning-app').classList.remove('hidden');
  const token = { generation, id: null, controller: new AbortController(), kind: 'start' };
  pending = token; refreshControls(); showOcrMessage('Opening practice…');
  try {
    const data = await request(token, '/learning-sessions', { topicKey });
    assertCurrent(token); activatePractice(data);
  } catch (error) {
    if (current(token) && error.name !== 'AbortError') showOcrMessage(error.message);
  } finally { if (current(token) && pending === token) { pending = null; refreshControls(); } }
}
function openLibrary(value = null) {
  if (!currentStudent) return;
  // Cancels an in-flight authored-session launch before an imported handoff.
  cancelWork(); voice.reset(); clearInkMathTranscription(); capture.open(value);
}
$('home-capture').addEventListener('click', () => openLibrary());
$('upload-problem-button').addEventListener('click', () => openLibrary());
$('home-voice').addEventListener('click', () => voice.open());
$('voice-formula-button').addEventListener('click', () => voice.open());
$('new-problem-button').addEventListener('click', () => currentSessionImported ? openLibrary() : startPractice());
$('back-to-topics').addEventListener('click', () => { resetPractice(); enterLearningHome(currentStudent); });
for (const id of ['home-pythagoras-topic', 'start-pythagoras-button']) $(id).addEventListener('click', () => startPractice('pythagoras'));
for (const id of ['home-algebra-topic', 'start-algebra-button']) $(id).addEventListener('click', () => startPractice('algebraic_equations'));

function clearTutorGuidance() {
  for (const id of ['tutor-guidance', 'worked-example', 'visual-board']) $(id).classList.add('hidden');
  for (const id of ['tutor-prompt', 'tutor-mode', 'worked-title', 'worked-handoff', 'visual-cue']) $(id).textContent = '';
  $('worked-steps').replaceChildren();
}
function applyTutorGuidance(tutor) {
  if (!tutor) return;
  tutorVideo.setGuidance(tutor); showCoach(); $('tutor-guidance').classList.remove('hidden');
  const labels = { guided: 'Next small step', socratic: 'Think about this', worked_example: 'Try this example', visual: 'Look at the diagram' };
  $('tutor-mode').textContent = currentSessionImported ? 'Self-guided practice' : labels[tutor.mode] || 'Next small step';
  $('tutor-prompt').textContent = tutor.prompt || '';
  $('worked-example').classList.toggle('hidden', !tutor.workedExample || currentSessionImported);
  if (tutor.workedExample && !currentSessionImported) {
    $('worked-title').textContent = tutor.workedExample.title;
    $('worked-steps').replaceChildren(...tutor.workedExample.steps.map(step => { const li = document.createElement('li'); li.textContent = step; return li; }));
    $('worked-handoff').textContent = tutor.workedExample.handoff;
  }
  $('visual-board').classList.toggle('hidden', !tutor.visualCue || currentSessionImported);
  $('visual-cue').textContent = tutor.visualCue || '';
}
function setFoundationVisibility(errorType) {
  $('foundation-card').classList.toggle('hidden', currentSessionImported || !['missing_square', 'wrong_hypotenuse', 'sign_error'].includes(errorType));
}
function setStepToolsVisible(visible) {
  $('manual-step-tools').classList.toggle('hidden', !visible); checkButton.classList.toggle('hidden', !visible);
  $('toggle-step-tools').textContent = visible ? 'Hide typed step' : 'Type a step instead';
  $('toggle-step-tools').setAttribute('aria-expanded', String(visible));
  if (visible) latexInput.focus();
}
$('toggle-step-tools').addEventListener('click', () => setStepToolsVisible($('manual-step-tools').classList.contains('hidden')));
document.querySelectorAll('.sample-button').forEach(button => button.addEventListener('click', () => {
  if (!pending && learningSessionId) { latexInput.value = button.dataset.latex; latexInput.focus(); }
}));
$('undo-button').addEventListener('click', () => drawing.undo());
$('redo-button').addEventListener('click', () => drawing.redo());
$('clear-button').addEventListener('click', () => drawing.clear());
$('eraser-button').addEventListener('click', () => {
  drawing.mode = drawing.mode === 'pen' ? 'eraser' : 'pen';
  $('eraser-button').setAttribute('aria-pressed', String(drawing.mode === 'eraser'));
});
$('pen-only').addEventListener('change', () => { drawing.ignoreTouch = $('pen-only').checked; });

async function loadDefaultOcrProvider() {
  const token = ++providerGeneration, epoch = generation;
  try {
    const [providersResponse, defaultResponse] = await Promise.all([fetch('/ocr-providers'), fetch('/ocr-default')]);
    const providers = providersResponse.ok ? await providersResponse.json() : [];
    const preferred = defaultResponse.ok ? (await defaultResponse.json()).providerId : 'inkmath';
    if (token !== providerGeneration || epoch !== generation || pending) return;
    $('ocr-provider').replaceChildren(...providers.map(provider => {
      const option = document.createElement('option'); option.value = provider.id;
      option.textContent = provider.configured ? provider.label : `${provider.label} (not connected)`;
      option.disabled = !provider.configured; return option;
    }));
    defaultOcrProvider = providers.find(p => p.id === preferred && p.configured)?.id || providers.find(p => p.configured)?.id || 'inkmath';
    $('ocr-provider').value = defaultOcrProvider;
  } catch { /* Keep the last selected provider; its request reports connection errors. */ }
}
$('ocr-provider').addEventListener('change', () => {
  if (pending) return;
  providerGeneration++; defaultOcrProvider = $('ocr-provider').value; clearInkMathTranscription(); hideOcrMessage();
});

async function submitLine(token, rawLatex) {
  const data = await request(token, `/learning-sessions/${encodeURIComponent(token.id)}/steps`, { rawLatex, confidence: 0.91, timestamp: Date.now() });
  assertCurrent(token);
  submittedSteps.push({ rawLatex });
  if (data.stepAccepted || data.saved) stepIndex = data.nextStep ?? stepIndex;
  return { ...data, recognizedLatex: rawLatex };
}
function displayStep(data) {
  if (currentSessionImported || data.assessment === 'ungraded') {
    displaySavedReview({ findings: submittedSteps }); applyTutorGuidance(data.tutor); return;
  }
  $('feedback-empty').classList.add('hidden'); showCoach();
  $('feedback-result').className = `feedback-result ${['correct', 'unclear', 'error'].includes(data.status) ? data.status : ''}`;
  $('review-findings').replaceChildren();
  $('result-label').textContent = data.status === 'correct' ? 'Step looks good' : data.status === 'unclear' ? 'Need a clearer step' : 'A useful check';
  $('result-title').textContent = data.complete ? 'Problem complete.' : data.status === 'correct' ? 'Nice connection.' : data.status === 'unclear' ? 'Let’s make this readable.' : 'Pause and check this part.';
  $('result-hint').textContent = data.hint;
  $('foundation-name').textContent = data.foundation; setFoundationVisibility(data.errorType); applyTutorGuidance(data.tutor);
  $('connection-label').textContent = data.complete ? 'Completed' : data.stepAccepted ? `Step ${data.nextStep + 1} ready` : 'Try this step again';
}
checkButton.addEventListener('click', () => {
  const rawLatex = latexInput.value.trim();
  if (!rawLatex) { showOcrMessage('Enter an equation before submitting this step.'); return; }
  return operation('step', async token => {
    const data = await submitLine(token, rawLatex); assertCurrent(token); displayStep(data);
    if (data.stepAccepted || data.saved) { latexInput.value = ''; clearWriting(); }
    if (data.saved || data.assessment === 'ungraded') await fetchAndDisplaySolutionReview(token);
  });
});

function handwritingLineGroups() {
  const marked = strokes.map(stroke => ({ stroke, centerY: stroke.reduce((n, p) => n + p.y, 0) / stroke.length })).sort((a, b) => a.centerY - b.centerY);
  const threshold = Math.max(42, drawing.height * 0.12);
  return marked.reduce((groups, item) => {
    const last = groups.at(-1);
    if (!last || item.centerY - last.centerY > threshold) groups.push({ centerY: item.centerY, strokes: [item.stroke] });
    else { last.strokes.push(item.stroke); last.centerY = (last.centerY * (last.strokes.length - 1) + item.centerY) / last.strokes.length; }
    return groups;
  }, []);
}
function lineImageData(line) {
  let left = drawing.width, top = drawing.height, right = 0, bottom = 0;
  for (const stroke of line.strokes) for (const p of stroke) { left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  left = Math.max(0, left - 32); top = Math.max(0, top - 32);
  right = Math.min(drawing.width, right + 32); bottom = Math.min(drawing.height, bottom + 32);
  const scale = window.devicePixelRatio || 1, image = document.createElement('canvas');
  image.width = Math.max(80, Math.ceil((right - left) * scale)); image.height = Math.max(80, Math.ceil((bottom - top) * scale));
  const ctx = image.getContext('2d'); ctx.fillStyle = '#fffef8'; ctx.fillRect(0, 0, image.width, image.height);
  ctx.scale(scale, scale); paintStrokes(ctx, line.strokes, left, top);
  return image.toDataURL('image/png');
}
function fullWritingImageData() { return strokes.length ? lineImageData({ strokes }) : null; }
function clearInkMathTranscription() {
  currentInkMathLines = []; currentInkLineGroups = []; inkReviewed.checked = false; inkReviewed.disabled = true;
  $('inkmath-transcript').classList.add('hidden'); $('inkmath-lines').replaceChildren();
  $('inkmath-title').textContent = ''; $('inkmath-summary').textContent = ''; $('inkmath-badge').textContent = '';
  recheckButton.classList.add('hidden'); recheckButton.disabled = true;
}
function showInkMathTranscription(recognition, groups) {
  clearInkMathTranscription();
  currentInkMathLines = recognition.lines.map(line => ({ ...line, latex: line.latex || line.text || '', ambiguities: [...(line.ambiguities || [])] }));
  currentInkLineGroups = groups.map(group => ({ relativeY: group.centerY / drawing.height }));
  $('inkmath-title').textContent = 'Review your handwriting transcription';
  $('inkmath-badge').textContent = recognition.model || recognition.provider || defaultOcrProvider;
  const uncertain = currentInkMathLines.filter(line => line.legibility !== 'clear').length;
  $('inkmath-summary').textContent = `${currentInkMathLines.length} lines transcribed; ${uncertain} need a careful visual check. Nothing has been submitted. Edit every line, then confirm below. ${(recognition.warnings || []).join(' ')}`;
  for (const [index, line] of currentInkMathLines.entries()) {
    const card = document.createElement('div'); card.className = `inkmath-line ${line.legibility === 'clear' ? 'clear' : 'uncertain'}`;
    const label = document.createElement('label'); label.textContent = `Line ${index + 1} · ${line.legibility === 'clear' ? 'verify transcription' : 'uncertain—please verify'}`;
    const input = document.createElement('input'); input.type = 'text'; input.value = line.latex; input.maxLength = 16000;
    input.setAttribute('aria-label', `Handwriting transcription for line ${index + 1}`);
    input.addEventListener('input', () => {
      if (pending || !currentInkMathLines.includes(line)) return;
      line.latex = input.value; inkReviewed.checked = false; refreshControls();
    });
    label.append(input); card.append(label);
    if (line.ambiguities.length || line.confidence != null) {
      const warning = document.createElement('p'); warning.className = 'inkmath-warning';
      warning.textContent = [line.confidence != null ? `OCR confidence: ${line.confidence}.` : '', ...line.ambiguities].filter(Boolean).join(' '); card.append(warning);
    }
    $('inkmath-lines').append(card);
  }
  $('inkmath-transcript').classList.remove('hidden'); recheckButton.classList.remove('hidden'); refreshControls();
}
inkReviewed.addEventListener('change', refreshControls);

reviewButton.addEventListener('click', () => operation(strokes.length ? 'recognition' : 'review', async token => {
  const groups = handwritingLineGroups();
  if (!groups.length) { await fetchAndDisplaySolutionReview(token); return; }
  let recognition;
  const body = imageData => ({ imageData, sessionId: token.id, stepIndex: token.step, providerId: token.provider });
  if (token.provider === 'inkmath') {
    recognition = await request(token, '/recognize-handwriting/inkmath', body(fullWritingImageData()));
  } else {
    // Snapshot every crop before the first await; no step is posted by Read.
    const images = groups.map(lineImageData), lines = [], warnings = [];
    for (const imageData of images) {
      assertCurrent(token);
      const line = await request(token, '/recognize-handwriting', body(imageData));
      lines.push({ latex: line.rawLatex, confidence: line.confidence, legibility: line.confidence >= 0.8 ? 'clear' : 'uncertain', ambiguities: line.ambiguities || [] });
      warnings.push(...(line.warnings || []));
    }
    recognition = { lines, warnings, provider: token.provider };
  }
  assertCurrent(token);
  if (!Array.isArray(recognition.lines) || !recognition.lines.length) throw new Error('No lines were found. Try clearer writing or type your step.');
  showInkMathTranscription(recognition, groups);
}));

recheckButton.addEventListener('click', () => {
  if (!inkReviewed.checked || !currentInkMathLines.length || currentInkMathLines.some(line => !line.latex.trim())) return;
  // Copy reviewed values. Consume approval before the first await; a retry must
  // not immediately duplicate a save, including after an ambiguous network error.
  const lines = currentInkMathLines.map(line => ({ latex: line.latex.trim() }));
  const groups = currentInkLineGroups.map(group => ({ ...group }));
  return operation('submission', async token => {
    clearInkMathTranscription();
    const results = [];
    try {
      for (const [index, line] of lines.entries()) {
        assertCurrent(token);
        const step = await submitLine(token, line.latex); assertCurrent(token);
        results.push({ ...step, lineNumber: index + 1, relativeY: groups[Math.min(index, groups.length - 1)]?.relativeY ?? 0.5 });
      }
    } catch (error) {
      assertCurrent(token);
      if (currentSessionImported) displaySavedReview({ findings: submittedSteps });
      throw new Error(`${error.message} Some lines may already be saved. Review saved history before transcribing or submitting again.`);
    }
    if (currentSessionImported || results.every(step => step.saved)) { latexInput.value = ''; clearWriting(); }
    showErrorMarkers(results);
    await fetchAndDisplaySolutionReview(token, results);
  });
});

function showErrorMarkers(lines) {
  $('error-markers').replaceChildren();
  if (currentSessionImported || lines.some(line => line.assessment === 'ungraded')) return;
  lines.filter(line => line.status !== 'correct').forEach((line, i) => {
    const marker = document.createElement('div'); marker.className = 'error-marker';
    marker.style.top = `${Math.max(18, Math.min(drawing.height - 18, line.relativeY * drawing.height))}px`;
    marker.textContent = `${i + 1} ←`; $('error-markers').append(marker);
  });
}
function displaySavedReview(data) {
  $('feedback-empty').classList.add('hidden'); $('feedback-result').className = 'feedback-result';
  $('result-label').textContent = 'Self-guided notebook';
  $('result-title').textContent = data.findings?.length ? 'Work saved—not graded' : 'Self-guided practice—not graded';
  $('result-hint').textContent = 'These are your recorded steps, not a correctness or completion assessment. Review your reasoning with a teacher or a trusted solution.';
  $('connection-label').textContent = data.findings?.length ? 'Work saved—not graded' : 'No steps saved yet';
  $('foundation-card').classList.add('hidden'); $('error-markers').replaceChildren(); $('review-findings').replaceChildren();
  for (const [index, finding] of (data.findings || []).entries()) {
    const item = document.createElement('div'); item.className = 'saved-step';
    const label = document.createElement('strong'); label.textContent = `Saved step ${index + 1} · Not graded`;
    const raw = document.createElement('p'); raw.textContent = finding.rawLatex;
    item.append(label, raw); $('review-findings').append(item);
  }
  showCoach();
}
function renderReviewFindings(data, lineResults) {
  $('review-findings').replaceChildren();
  const issues = lineResults.length ? lineResults.filter(line => line.status !== 'correct').map(line => ({
    lineNumber: line.lineNumber, errorType: line.errorType, rawLatex: line.recognizedLatex, explanation: line.hint, tutor: line.tutor,
  })) : (data.findings || []).map((finding, i) => ({ ...finding, lineNumber: i + 1 }));
  const owner = { generation, id: learningSessionId };
  for (const finding of issues) {
    const item = document.createElement('div'); item.className = 'review-finding';
    const title = document.createElement('strong'); title.textContent = `Line ${finding.lineNumber}`;
    const explanation = document.createElement('p'); explanation.textContent = finding.explanation;
    item.append(title, explanation);
    if (finding.rawLatex) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'line-explain-button'; button.textContent = 'I don’t understand';
      button.addEventListener('click', async () => {
        if (!current(owner) || pending || !item.isConnected || currentSessionImported) return;
        return operation('explanation', async token => {
          button.disabled = true; button.textContent = 'Explaining…';
          try {
            const detail = await request(token, `/learning-sessions/${encodeURIComponent(token.id)}/explain-step`, { rawLatex: finding.rawLatex, errorType: finding.errorType });
            assertCurrent(token);
            const text = document.createElement('p'); text.className = 'line-detailed-explanation'; text.textContent = detail.explanation;
            item.append(text); button.remove();
          } finally { if (current(token)) { button.disabled = false; button.textContent = 'Try explanation again'; } }
        });
      });
      item.append(button);
    }
    $('review-findings').append(item);
  }
  return issues;
}
function displaySolutionReview(data, lineResults = []) {
  if (currentSessionImported || data.assessment === 'ungraded') { displaySavedReview(data); return; }
  const issues = renderReviewFindings(data, lineResults), root = issues[0];
  $('feedback-empty').classList.add('hidden'); $('feedback-result').className = `feedback-result ${issues.length ? 'error' : 'correct'}`;
  $('result-label').textContent = data.complete ? 'Solution review' : 'Progress review';
  $('result-title').textContent = root ? `Start with line ${root.lineNumber}` : data.complete ? 'Your solution is complete' : 'Your submitted steps are on track';
  $('result-hint').textContent = root ? root.explanation : data.summary;
  $('foundation-name').textContent = data.foundation; setFoundationVisibility(root?.errorType);
  applyTutorGuidance(root?.tutor || lineResults.at(-1)?.tutor);
  $('connection-label').textContent = data.complete ? 'Completed' : 'Solution reviewed'; showCoach();
}
async function fetchAndDisplaySolutionReview(token, lineResults = []) {
  const data = await request(token, `/learning-sessions/${encodeURIComponent(token.id)}/review`);
  assertCurrent(token); displaySolutionReview(data, lineResults); return data;
}

$('download-work').addEventListener('click', () => operation('export', async token => {
  const problem = { ...currentPractice };
  const ink = { coordinateSystem: 'canvas-pixels', width: drawing.width, height: drawing.height, strokes: structuredClone(strokes) };
  const manualLatex = latexInput.value;
  const data = await request(token, `/learning-sessions/${encodeURIComponent(token.id)}/review`);
  assertCurrent(token);
  // Imported reviews contain every saved step. Authored reviews only expose
  // errors: retain all successful POST observations locally, without grades.
  const steps = currentSessionImported || data.assessment === 'ungraded' ? data.findings || [] : submittedSteps;
  downloadJSON({ schemaVersion: '1.0', observationOnly: true, title: problem.topic, sourceType: 'manual',
    questions: [{ label: '1', text: problem.prompt, latex: '', diagram_description: '', ambiguities: [] }],
    currentProblem: problem, savedSteps: steps.map(step => ({ rawLatex: step.rawLatex })),
    currentWork: { ink, manualLatex },
    note: 'Observed work only; no grading, completion or learner data. Import restores questions only, not student steps or ink.',
  }, 'math-work.json');
}));

$('foundation-link').addEventListener('click', () => { if (!currentSessionImported) $('foundation-modal').showModal(); });
$('close-foundation').addEventListener('click', () => $('foundation-modal').close());
$('foundation-modal').addEventListener('click', event => { if (event.target === $('foundation-modal')) $('foundation-modal').close(); });

function setAuthMode(mode) {
  authMode = mode; const registering = mode === 'register';
  $('auth-title').textContent = registering ? 'Create your learner profile' : 'Welcome back';
  $('auth-description').textContent = registering ? 'This helps tailor foundations and practice to where you are learning.' : 'Sign in to continue your personalised practice.';
  $('auth-submit').firstChild.textContent = registering ? 'Create profile ' : 'Sign in ';
  $('auth-switch').textContent = registering ? 'I already have an account' : 'Create a new learner profile';
  $('profile-fields').classList.toggle('hidden', !registering);
  for (const id of ['full-name', 'grade', 'country', 'state']) $(id).required = registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
}
function enterLearningHome(student) {
  if (!student) return;
  currentStudent = student; $('home-student-name').textContent = student.fullName; $('home-grade').textContent = student.grade;
  $('home-subtitle').textContent = 'Choose a guided topic or bring your own questions.';
  $('auth-screen').classList.add('hidden'); $('learning-app').classList.add('hidden'); $('learning-home').classList.remove('hidden'); $('dashboard-view').classList.remove('hidden');
}
$('auth-switch').addEventListener('click', () => { setAuthMode(authMode === 'register' ? 'login' : 'register'); hideAuthMessage(); });
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('auth-submit').disabled) return;
  const epoch = ++generation, mode = authMode;
  hideAuthMessage(); $('auth-submit').disabled = true; $('auth-switch').disabled = true;
  const payload = { email: $('email').value, password: $('password').value };
  if (mode === 'register') Object.assign(payload, { fullName: $('full-name').value, grade: Number($('grade').value), country: $('country').value, state: $('state').value,
    tutorModes: Array.from(document.querySelectorAll('[name="tutor-mode"]:checked')).map(input => input.value) });
  try {
    if (mode === 'register' && !payload.tutorModes.length) throw new Error('Choose at least one helpful teaching approach.');
    const response = await fetch(`/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json(); if (epoch !== generation) return;
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not sign in.');
    enterLearningHome(data); $('password').value = '';
  } catch (error) { if (epoch === generation) showAuthMessage(error.message); }
  finally { if (epoch === generation) { $('auth-submit').disabled = false; $('auth-switch').disabled = false; setAuthMode(authMode); } }
});
async function signOut() {
  // Clear local data and invalidate continuations immediately, before logout I/O.
  resetPractice(); currentStudent = null; providerGeneration++;
  const epoch = generation;
  $('learning-app').classList.add('hidden'); $('learning-home').classList.add('hidden'); $('auth-screen').classList.remove('hidden');
  $('home-student-name').textContent = ''; $('student-summary').textContent = ''; $('auth-form').reset(); setAuthMode('login'); hideAuthMessage();
  $('auth-submit').disabled = true; $('auth-switch').disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign-out could not be confirmed. Try again before leaving this device.');
  } catch (error) { if (epoch === generation) showAuthMessage(error.message); }
  finally { if (epoch === generation) { $('auth-submit').disabled = false; $('auth-switch').disabled = false; } }
}
$('logout-button').addEventListener('click', signOut); $('home-logout-button').addEventListener('click', signOut);
async function restoreLogin() {
  const epoch = generation;
  try {
    const response = await fetch('/me');
    const data = response.ok ? await response.json() : null;
    if (epoch !== generation) return;
    if (data) enterLearningHome(data); else setAuthMode('register');
  } catch { if (epoch === generation) setAuthMode('register'); }
}
window.addEventListener('resize', resizeCanvas);
if (globalThis.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas(); refreshControls(); void restoreLogin();
