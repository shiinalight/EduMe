const canvas = document.querySelector('#writing-pad');
const context = canvas.getContext('2d');
const placeholder = document.querySelector('#canvas-placeholder');
const errorMarkers = document.querySelector('#error-markers');
const latexInput = document.querySelector('#latex-input');
const checkButton = document.querySelector('#check-button');
const reviewButton = document.querySelector('#review-button');
const undoButton = document.querySelector('#undo-button');
const clearButton = document.querySelector('#clear-button');
const ocrMessage = document.querySelector('#ocr-message');
const feedbackEmpty = document.querySelector('#feedback-empty');
const feedbackResult = document.querySelector('#feedback-result');
const resultLabel = document.querySelector('#result-label');
const resultTitle = document.querySelector('#result-title');
const resultHint = document.querySelector('#result-hint');
const connectionLabel = document.querySelector('#connection-label');
const authScreen = document.querySelector('#auth-screen');
const learningApp = document.querySelector('#learning-app');
const learningHome = document.querySelector('#learning-home');
const dashboardView = document.querySelector('#dashboard-view');
const authForm = document.querySelector('#auth-form');
const authTitle = document.querySelector('#auth-title');
const authDescription = document.querySelector('#auth-description');
const authSubmit = document.querySelector('#auth-submit');
const authSwitch = document.querySelector('#auth-switch');
const authMessage = document.querySelector('#auth-message');
const profileFields = document.querySelector('#profile-fields');
const studentSummary = document.querySelector('#student-summary');
const logoutButton = document.querySelector('#logout-button');
const homeStudentName = document.querySelector('#home-student-name');
const homeLogoutButton = document.querySelector('#home-logout-button');
const homeSubtitle = document.querySelector('#home-subtitle');
const homeGrade = document.querySelector('#home-grade');
const backToTopicsButton = document.querySelector('#back-to-topics');
const homePythagorasTopicButton = document.querySelector('#home-pythagoras-topic');
const startPythagorasButton = document.querySelector('#start-pythagoras-button');
const homeAlgebraTopicButton = document.querySelector('#home-algebra-topic');
const startAlgebraButton = document.querySelector('#start-algebra-button');
const practiceTopicLabel = document.querySelector('#practice-topic-label');
const problemPrompt = document.querySelector('#problem-prompt');
const problemGoal = document.querySelector('#problem-goal');
const newProblemButton = document.querySelector('#new-problem-button');
const foundationName = document.querySelector('#foundation-name');
const foundationDescription = document.querySelector('#foundation-description');
const foundationLink = document.querySelector('#foundation-link');
const foundationModal = document.querySelector('#foundation-modal');
const closeFoundation = document.querySelector('#close-foundation');
const tutorMode = document.querySelector('#tutor-mode');
const tutorPrompt = document.querySelector('#tutor-prompt');
const tutorGuidance = document.querySelector('#tutor-guidance');
const workedExample = document.querySelector('#worked-example');
const workedTitle = document.querySelector('#worked-title');
const workedSteps = document.querySelector('#worked-steps');
const workedHandoff = document.querySelector('#worked-handoff');
const visualBoard = document.querySelector('#visual-board');
const visualCue = document.querySelector('#visual-cue');
const reviewFindings = document.querySelector('#review-findings');
const ocrProviderPicker = document.querySelector('#ocr-provider');
const inkmathTranscript = document.querySelector('#inkmath-transcript');
const inkmathTitle = document.querySelector('#inkmath-title');
const inkmathBadge = document.querySelector('#inkmath-badge');
const inkmathSummary = document.querySelector('#inkmath-summary');
const inkmathLines = document.querySelector('#inkmath-lines');
const recheckTranscriptionButton = document.querySelector('#recheck-transcription');

let strokes = [];
let activeStroke = null;
let stepIndex = 0;
let learningSessionId = null;
let authMode = 'register';
let defaultOcrProvider = 'local-pix2tex';
let currentInkMathLines = [];
let currentInkLineGroups = [];
let currentStudent = null;
let selectedTopicKey = 'pythagoras';
const sessionId = crypto.randomUUID();

function resizeCanvas() {
  const scale = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * scale;
  canvas.height = canvas.clientHeight * scale;
  context.scale(scale, scale);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  redraw();
}

function drawStroke(stroke) {
  if (stroke.length < 2) return;
  context.beginPath();
  context.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length; i += 1) {
    const point = stroke[i];
    context.lineWidth = 2.2 + point.pressure * 3.8;
    context.lineTo(point.x, point.y);
    context.stroke();
    context.beginPath();
    context.moveTo(point.x, point.y);
  }
}

function redraw() {
  context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  strokes.forEach(drawStroke);
}

function clearWriting() {
  strokes = [];
  redraw();
  placeholder.classList.remove('hidden');
  errorMarkers.replaceChildren();
  clearInkMathTranscription();
}

function relativePoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure || 0.5 };
}

canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  activeStroke = [relativePoint(event)];
  strokes.push(activeStroke);
  placeholder.classList.add('hidden');
});
canvas.addEventListener('pointermove', (event) => {
  if (!activeStroke) return;
  activeStroke.push(relativePoint(event));
  drawStroke(activeStroke.slice(-2));
});
function finishStroke() { activeStroke = null; }
canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);

undoButton.addEventListener('click', () => { strokes.pop(); redraw(); if (!strokes.length) placeholder.classList.remove('hidden'); });
clearButton.addEventListener('click', clearWriting);
document.querySelectorAll('.sample-button').forEach((button) => {
  button.addEventListener('click', () => { latexInput.value = button.dataset.latex; latexInput.focus(); });
});

function showOcrMessage(message) { ocrMessage.textContent = message; ocrMessage.classList.remove('hidden'); }
function hideOcrMessage() { ocrMessage.classList.add('hidden'); }
function showAuthMessage(message) { authMessage.textContent = message; authMessage.classList.remove('hidden'); }
function hideAuthMessage() { authMessage.classList.add('hidden'); }

function applyTutorGuidance(tutor) {
  if (!tutor) return;
  tutorGuidance.classList.remove('hidden');
  const labels = { guided: 'Guided', socratic: 'Socratic', worked_example: 'Worked example', visual: 'Visual' };
  tutorMode.textContent = labels[tutor.mode] || 'Guided';
  tutorPrompt.textContent = tutor.prompt;
  if (tutor.workedExample) {
    workedTitle.textContent = tutor.workedExample.title;
    workedSteps.replaceChildren(...tutor.workedExample.steps.map((step) => {
      const item = document.createElement('li'); item.textContent = step; return item;
    }));
    workedHandoff.textContent = tutor.workedExample.handoff;
    workedExample.classList.remove('hidden');
  } else {
    workedExample.classList.add('hidden');
  }
  if (tutor.visualCue) {
    visualCue.textContent = tutor.visualCue;
    visualBoard.classList.remove('hidden');
  } else {
    visualBoard.classList.add('hidden');
  }
}

function clearTutorGuidance() {
  tutorGuidance.classList.add('hidden');
  workedExample.classList.add('hidden');
  visualBoard.classList.add('hidden');
}

async function loadDefaultOcrProvider() {
  try {
    const [providersResponse, defaultResponse] = await Promise.all([
      fetch('/ocr-providers'), fetch('/ocr-default'),
    ]);
    const providers = providersResponse.ok ? await providersResponse.json() : [];
    if (defaultResponse.ok) defaultOcrProvider = (await defaultResponse.json()).providerId;
    ocrProviderPicker.replaceChildren(...providers.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.configured ? provider.label : `${provider.label} (not connected)`;
      option.disabled = !provider.configured;
      return option;
    }));
    ocrProviderPicker.value = defaultOcrProvider;
    if (!ocrProviderPicker.value && providers.some((provider) => provider.configured)) {
      defaultOcrProvider = providers.find((provider) => provider.configured).id;
      ocrProviderPicker.value = defaultOcrProvider;
    }
  } catch (_) {
    defaultOcrProvider = 'inkmath';
  }
}

ocrProviderPicker.addEventListener('change', () => {
  defaultOcrProvider = ocrProviderPicker.value;
  clearInkMathTranscription();
  hideOcrMessage();
});

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  authTitle.textContent = registering ? 'Create your learner profile' : 'Welcome back';
  authDescription.textContent = registering ? 'This helps tailor foundations and practice to where you are learning.' : 'Sign in to continue your personalised practice.';
  authSubmit.firstChild.textContent = registering ? 'Create profile ' : 'Sign in ';
  authSwitch.textContent = registering ? 'I already have an account' : 'Create a new learner profile';
  profileFields.classList.toggle('hidden', !registering);
  document.querySelector('#full-name').required = registering;
  document.querySelector('#grade').required = registering;
  document.querySelector('#country').required = registering;
  document.querySelector('#state').required = registering;
  document.querySelector('#password').autocomplete = registering ? 'new-password' : 'current-password';
  hideAuthMessage();
}

function enterLearningHome(student) {
  currentStudent = student;
  homeStudentName.textContent = student.fullName;
  homeGrade.textContent = student.grade;
  homeSubtitle.textContent = `A concept map shaped around your Grade ${student.grade} mathematics practice.`;
  authScreen.classList.add('hidden');
  learningApp.classList.add('hidden');
  learningHome.classList.remove('hidden');
  dashboardView.classList.remove('hidden');
}

function openTopicPractice(topicKey) {
  if (!currentStudent) return;
  selectedTopicKey = topicKey;
  studentSummary.textContent = `${currentStudent.fullName} · Grade ${currentStudent.grade} · ${currentStudent.curriculum.jurisdiction}`;
  foundationName.textContent = currentStudent.curriculum.foundation;
  foundationDescription.textContent = currentStudent.curriculum.explanation;
  learningHome.classList.add('hidden');
  learningApp.classList.remove('hidden');
  requestAnimationFrame(resizeCanvas);
  loadDefaultOcrProvider();
  startPractice();
}

function openPythagorasPractice() { openTopicPractice('pythagoras'); }
function openAlgebraPractice() { openTopicPractice('algebraic_equations'); }

authSwitch.addEventListener('click', () => setAuthMode(authMode === 'register' ? 'login' : 'register'));
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideAuthMessage();
  authSubmit.disabled = true;
  authSubmit.firstChild.textContent = 'Saving… ';
  const payload = { email: document.querySelector('#email').value, password: document.querySelector('#password').value };
  if (authMode === 'register') Object.assign(payload, {
    fullName: document.querySelector('#full-name').value,
    grade: Number(document.querySelector('#grade').value),
    country: document.querySelector('#country').value,
    state: document.querySelector('#state').value,
    tutorModes: Array.from(document.querySelectorAll('[name="tutor-mode"]:checked')).map((input) => input.value),
  });
  if (authMode === 'register' && !payload.tutorModes.length) { showAuthMessage('Choose at least one helpful teaching approach.'); authSubmit.disabled = false; setAuthMode(authMode); return; }
  try {
    const response = await fetch(`/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'We could not save your profile.');
    enterLearningHome(data);
  } catch (error) { showAuthMessage(error.message); }
  finally { authSubmit.disabled = false; setAuthMode(authMode); }
});

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  learningSessionId = null;
  currentStudent = null;
  learningApp.classList.add('hidden');
  learningHome.classList.add('hidden');
  authScreen.classList.remove('hidden');
  authForm.reset();
  setAuthMode('login');
}

logoutButton.addEventListener('click', signOut);
homeLogoutButton.addEventListener('click', signOut);
backToTopicsButton.addEventListener('click', () => {
  learningApp.classList.add('hidden');
  learningHome.classList.remove('hidden');
  dashboardView.classList.remove('hidden');
});
homePythagorasTopicButton.addEventListener('click', openPythagorasPractice);
startPythagorasButton.addEventListener('click', openPythagorasPractice);
homeAlgebraTopicButton.addEventListener('click', openAlgebraPractice);
startAlgebraButton.addEventListener('click', openAlgebraPractice);

async function startPractice() {
  newProblemButton.disabled = true;
  try {
    const response = await fetch('/learning-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicKey: selectedTopicKey }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'A problem could not be created.');
    learningSessionId = data.sessionId;
    stepIndex = data.nextStep;
    problemPrompt.textContent = data.prompt;
    problemGoal.textContent = data.goal;
    foundationName.textContent = data.foundation;
    practiceTopicLabel.textContent = `${data.topic} practice`;
    foundationDescription.textContent = data.topic === 'Algebraic equations'
      ? 'Use inverse operations to keep both sides of an equation balanced while solving for an unknown.'
      : 'Use the theorem fluently and rearrange it to find an unknown side.';
    clearTutorGuidance();
    reviewFindings.replaceChildren();
    feedbackEmpty.classList.remove('hidden');
    feedbackResult.className = 'feedback-result hidden';
    connectionLabel.textContent = 'New problem ready';
    latexInput.value = '';
    clearWriting();
    hideOcrMessage();
  } catch (error) { showOcrMessage(error.message); }
  finally { newProblemButton.disabled = false; }
}
newProblemButton.addEventListener('click', startPractice);

checkButton.addEventListener('click', async () => {
  const rawLatex = latexInput.value.trim();
  if (!rawLatex) { showOcrMessage('Enter an equation before checking this step.'); latexInput.focus(); return; }
  if (!learningSessionId) { showOcrMessage('Choose a new problem before checking your step.'); return; }
  hideOcrMessage();
  checkButton.disabled = true;
  checkButton.firstChild.textContent = 'Checking…';
  try {
    const response = await fetch(`/learning-sessions/${learningSessionId}/steps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawLatex, confidence: 0.91, timestamp: Date.now() })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'The checker could not process this step.');
    feedbackEmpty.classList.add('hidden');
    feedbackResult.className = `feedback-result ${data.status}`;
    reviewFindings.replaceChildren();
    resultLabel.textContent = data.status === 'correct' ? 'Step looks good' : data.status === 'unclear' ? 'Need a clearer step' : 'A useful check';
    resultTitle.textContent = data.complete ? 'Problem complete.' : data.status === 'correct' ? 'Nice connection.' : data.status === 'unclear' ? 'Let’s make this readable.' : 'Pause and check this part.';
    resultHint.textContent = data.hint;
    foundationName.textContent = data.foundation;
    applyTutorGuidance(data.tutor);
    connectionLabel.textContent = data.complete ? 'Completed' : data.stepAccepted ? `Step ${data.nextStep + 1} ready` : 'Try this step again';
    if (data.stepAccepted) { stepIndex = data.nextStep; latexInput.value = ''; clearWriting(); }
  } catch (error) { showOcrMessage(error.message); }
  finally { checkButton.disabled = false; checkButton.firstChild.textContent = 'Check this step '; }
});

function handwritingLineGroups() {
  const markedStrokes = strokes.map((stroke) => ({
    stroke,
    centerY: stroke.reduce((total, point) => total + point.y, 0) / stroke.length,
  })).sort((left, right) => left.centerY - right.centerY);
  const threshold = Math.max(42, canvas.clientHeight * 0.12);
  return markedStrokes.reduce((groups, item) => {
    const current = groups.at(-1);
    if (!current || item.centerY - current.centerY > threshold) groups.push({ centerY: item.centerY, strokes: [item.stroke] });
    else {
      current.strokes.push(item.stroke);
      current.centerY = (current.centerY * (current.strokes.length - 1) + item.centerY) / current.strokes.length;
    }
    return groups;
  }, []);
}

function lineImageData(line) {
  const points = line.strokes.flat();
  const padding = 26;
  const left = Math.max(0, Math.min(...points.map((point) => point.x)) - padding);
  const top = Math.max(0, Math.min(...points.map((point) => point.y)) - padding);
  const right = Math.min(canvas.clientWidth, Math.max(...points.map((point) => point.x)) + padding);
  const bottom = Math.min(canvas.clientHeight, Math.max(...points.map((point) => point.y)) + padding);
  const scale = window.devicePixelRatio || 1;
  const image = document.createElement('canvas');
  image.width = Math.max(80, (right - left) * scale);
  image.height = Math.max(80, (bottom - top) * scale);
  const imageContext = image.getContext('2d');
  imageContext.fillStyle = '#fffef8';
  imageContext.fillRect(0, 0, image.width, image.height);
  imageContext.scale(scale, scale);
  imageContext.strokeStyle = '#000';
  imageContext.lineCap = 'round';
  imageContext.lineJoin = 'round';
  line.strokes.forEach((stroke) => {
    if (stroke.length < 2) return;
    imageContext.beginPath();
    imageContext.moveTo(stroke[0].x - left, stroke[0].y - top);
    for (let index = 1; index < stroke.length; index += 1) {
      const point = stroke[index];
      imageContext.lineWidth = 2.2 + point.pressure * 3.8;
      imageContext.lineTo(point.x - left, point.y - top);
      imageContext.stroke();
      imageContext.beginPath();
      imageContext.moveTo(point.x - left, point.y - top);
    }
  });
  return image.toDataURL('image/png');
}

function fullWritingImageData() {
  const points = strokes.flat();
  if (!points.length) return null;
  const padding = 32;
  const left = Math.max(0, Math.min(...points.map((point) => point.x)) - padding);
  const top = Math.max(0, Math.min(...points.map((point) => point.y)) - padding);
  const right = Math.min(canvas.clientWidth, Math.max(...points.map((point) => point.x)) + padding);
  const bottom = Math.min(canvas.clientHeight, Math.max(...points.map((point) => point.y)) + padding);
  const scale = window.devicePixelRatio || 1;
  const image = document.createElement('canvas');
  image.width = Math.max(80, Math.round((right - left) * scale));
  image.height = Math.max(80, Math.round((bottom - top) * scale));
  const imageContext = image.getContext('2d');
  imageContext.fillStyle = '#fffef8';
  imageContext.fillRect(0, 0, image.width, image.height);
  imageContext.drawImage(
    canvas,
    Math.round(left * scale), Math.round(top * scale), Math.round((right - left) * scale), Math.round((bottom - top) * scale),
    0, 0, image.width, image.height,
  );
  return image.toDataURL('image/png');
}

function clearInkMathTranscription() {
  currentInkMathLines = [];
  currentInkLineGroups = [];
  inkmathTranscript.classList.add('hidden');
  inkmathLines.replaceChildren();
  recheckTranscriptionButton.classList.add('hidden');
}

function showInkMathTranscription(recognition) {
  inkmathTitle.textContent = 'InkMath read your working';
  inkmathBadge.textContent = recognition.model || 'InkMath';
  const uncertainCount = recognition.lines.filter((line) => line.legibility === 'uncertain').length;
  inkmathSummary.textContent = uncertainCount
    ? `It found ${recognition.lines.length} line${recognition.lines.length === 1 ? '' : 's'}; ${uncertainCount} needs a quick visual check.`
    : `It found ${recognition.lines.length} line${recognition.lines.length === 1 ? '' : 's'} in reading order and sent them to Math Coach.`;
  currentInkMathLines = recognition.lines.map((line) => ({ ...line }));
  inkmathLines.replaceChildren(...currentInkMathLines.map((line, index) => {
    const card = document.createElement('div');
    card.className = `inkmath-line ${line.legibility}`;
    const heading = document.createElement('div');
    heading.className = 'inkmath-line-head';
    heading.textContent = `Line ${index + 1} · ${line.legibility === 'clear' ? 'read clearly' : 'please verify'}`;
    const latex = document.createElement('input');
    latex.type = 'text';
    latex.value = line.latex || line.text || '';
    latex.setAttribute('aria-label', `InkMath transcription for line ${index + 1}`);
    latex.addEventListener('input', () => {
      currentInkMathLines[index].latex = latex.value;
      // A student-confirmed correction should be checked as deliberate input,
      // rather than penalised for the original OCR confidence.
      currentInkMathLines[index].legibility = 'clear';
    });
    card.append(heading, latex);
    if (line.ambiguities?.length) {
      const warning = document.createElement('p');
      warning.className = 'inkmath-warning';
      warning.textContent = `Check: ${line.ambiguities.join(' · ')}`;
      card.append(warning);
    }
    return card;
  }));
  inkmathTranscript.classList.remove('hidden');
  recheckTranscriptionButton.classList.remove('hidden');
}

async function recognizeFullWritingWithInkMath(imageData) {
  const response = await fetch('/recognize-handwriting/inkmath', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData, sessionId, stepIndex, providerId: 'inkmath' }),
  });
  const recognition = await response.json();
  if (!response.ok) throw new Error(recognition.detail || 'InkMath could not read the handwriting.');
  return recognition;
}

async function submitRecognizedLine(imageData) {
  const recognitionResponse = await fetch('/recognize-handwriting', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData, sessionId, stepIndex, providerId: defaultOcrProvider }),
  });
  const recognition = await recognitionResponse.json();
  if (!recognitionResponse.ok) throw new Error(recognition.detail || 'The handwriting could not be read.');
  const stepResponse = await fetch(`/learning-sessions/${learningSessionId}/steps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawLatex: recognition.rawLatex, confidence: recognition.confidence, timestamp: Date.now() }),
  });
  const step = await stepResponse.json();
  if (!stepResponse.ok) throw new Error(step.detail || 'A recognized line could not be checked.');
  step.recognizedLatex = recognition.rawLatex;
  return step;
}

async function submitRecognizedLatex(rawLatex, legibility) {
  const stepResponse = await fetch(`/learning-sessions/${learningSessionId}/steps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawLatex, confidence: legibility === 'clear' ? 0.91 : 0.55, timestamp: Date.now() }),
  });
  const step = await stepResponse.json();
  if (!stepResponse.ok) throw new Error(step.detail || 'A recognized line could not be checked.');
  step.recognizedLatex = rawLatex;
  return step;
}

function showErrorMarkers(lineResults) {
  errorMarkers.replaceChildren();
  lineResults.filter((line) => line.status !== 'correct').forEach((line, index) => {
    const marker = document.createElement('div');
    marker.className = 'error-marker';
    marker.style.top = `${Math.max(18, Math.min(canvas.clientHeight - 18, line.centerY))}px`;
    marker.innerHTML = `<span>${index + 1}</span><span>←</span>`;
    errorMarkers.append(marker);
  });
}

function renderReviewFindings(data, lineResults) {
  reviewFindings.replaceChildren();
  const findings = lineResults.length
    ? lineResults.filter((line) => line.status !== 'correct').map((line) => ({
      label: `Line ${line.lineNumber}`,
      explanation: line.status === 'unclear'
        ? 'I could not read this line reliably. Please rewrite it clearly, including the squared terms.'
        : line.hint,
    }))
    : data.findings.map((finding, index) => ({
      label: `Attempt ${index + 1}`,
      explanation: finding.explanation,
    }));
  findings.forEach((finding) => {
    const item = document.createElement('div');
    item.className = 'review-finding';
    const title = document.createElement('strong');
    title.textContent = finding.label;
    const explanation = document.createElement('p');
    explanation.textContent = finding.explanation;
    item.append(title, explanation);
    reviewFindings.append(item);
  });
  return findings.length;
}

function displaySolutionReview(data, recognizedLines = [], lineResults = []) {
  const issueCount = renderReviewFindings(data, lineResults);
  const reviewedCurrentLines = lineResults.length > 0;
  feedbackEmpty.classList.add('hidden');
  feedbackResult.className = `feedback-result ${issueCount ? 'error' : 'correct'}`;
  resultLabel.textContent = data.complete ? 'Solution review' : 'Progress review';
  resultTitle.textContent = issueCount
    ? `${issueCount} line${issueCount === 1 ? '' : 's'} to revisit`
    : data.complete ? 'Your solution is complete' : 'Your solution is on track';
  resultHint.textContent = issueCount
    ? 'The numbered markers point to the lines that need attention. Start with the first one, then use the coach guidance below.'
    : data.complete ? data.summary
    : reviewedCurrentLines
      ? 'These lines are correct so far. Next, simplify the squares and then solve for c.'
      : data.summary;
  foundationName.textContent = data.foundation;
  connectionLabel.textContent = data.complete ? 'Completed' : 'Solution reviewed';
}

async function fetchAndDisplaySolutionReview(recognizedLines = [], lineResults = []) {
  const response = await fetch(`/learning-sessions/${learningSessionId}/review`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'The solution could not be reviewed.');
  displaySolutionReview(data, recognizedLines, lineResults);
}

async function evaluateInkMathLines(lines, lineGroups) {
  const recognizedLines = [];
  const lineResults = [];
  for (let index = 0; index < lines.length; index += 1) {
    reviewButton.textContent = `Checking line ${index + 1} of ${lines.length}…`;
    const line = lines[index];
    const checkedLine = await submitRecognizedLatex(line.latex || line.text, line.legibility);
    recognizedLines.push(checkedLine.recognizedLatex);
    const matchingInkLine = lineGroups[Math.min(index, lineGroups.length - 1)];
    lineResults.push({ ...checkedLine, lineNumber: index + 1, centerY: matchingInkLine.centerY });
    applyTutorGuidance(checkedLine.tutor);
    stepIndex = checkedLine.nextStep;
  }
  showErrorMarkers(lineResults);
  await fetchAndDisplaySolutionReview(recognizedLines, lineResults);
}

reviewButton.addEventListener('click', async () => {
  if (!learningSessionId) { showOcrMessage('Choose a new problem before reviewing the solution.'); return; }
  const handwrittenLines = handwritingLineGroups();
  if (!handwrittenLines.length) { showOcrMessage('Write your working on the notepad before reviewing it.'); return; }
  reviewButton.disabled = true;
  reviewButton.textContent = 'Reading writing…';
  try {
    const recognizedLines = [];
    const lineResults = [];
    if (defaultOcrProvider === 'inkmath') {
      const recognition = await recognizeFullWritingWithInkMath(fullWritingImageData());
      currentInkLineGroups = handwrittenLines;
      showInkMathTranscription(recognition);
      await evaluateInkMathLines(currentInkMathLines, currentInkLineGroups);
      return;
    } else {
      clearInkMathTranscription();
      for (let index = 0; index < handwrittenLines.length; index += 1) {
        reviewButton.textContent = `Reading line ${index + 1} of ${handwrittenLines.length}…`;
        const checkedLine = await submitRecognizedLine(lineImageData(handwrittenLines[index]));
        recognizedLines.push(checkedLine.recognizedLatex);
        lineResults.push({ ...checkedLine, lineNumber: index + 1, centerY: handwrittenLines[index].centerY });
        applyTutorGuidance(checkedLine.tutor);
        stepIndex = checkedLine.nextStep;
      }
    }
    showErrorMarkers(lineResults);
    await fetchAndDisplaySolutionReview(recognizedLines, lineResults);
  } catch (error) { showOcrMessage(error.message); }
  finally { reviewButton.disabled = false; reviewButton.textContent = 'Review full solution'; }
});

recheckTranscriptionButton.addEventListener('click', async () => {
  if (!learningSessionId || !currentInkMathLines.length) return;
  hideOcrMessage();
  recheckTranscriptionButton.disabled = true;
  reviewButton.disabled = true;
  try {
    await evaluateInkMathLines(currentInkMathLines, currentInkLineGroups);
  } catch (error) { showOcrMessage(error.message); }
  finally {
    recheckTranscriptionButton.disabled = false;
    reviewButton.disabled = false;
    reviewButton.textContent = 'Review full solution';
  }
});

foundationLink.addEventListener('click', () => foundationModal.showModal());
closeFoundation.addEventListener('click', () => foundationModal.close());
foundationModal.addEventListener('click', (event) => { if (event.target === foundationModal) foundationModal.close(); });

async function restoreLogin() {
  try {
    const response = await fetch('/me');
    if (response.ok) enterLearningHome(await response.json());
    else setAuthMode('register');
  } catch (_) { setAuthMode('register'); }
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
restoreLogin();
