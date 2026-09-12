// Audio stays in memory until the user explicitly sends it for transcription.
export function setupVoice({ post, canOpen, onImport }) {
  const $ = id => document.getElementById(id), dialog = $('voice-dialog');
  let recorder = null, stream = null, timer = null, audio = null, audioUrl = null;
  let recording = false, busy = false, opening = false, generation = 0;
  let pending = null, originalTranscript = '';
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  const status = message => { $('voice-status').textContent = message; };
  function refresh() {
    $('voice-record').disabled = !supported || busy || recording || opening;
    $('voice-stop').disabled = !recording;
    $('voice-upload').disabled = busy || recording || opening;
    $('voice-transcribe').disabled = busy || recording || opening || !audio;
    $('voice-transcript').disabled = busy || recording || opening;
    $('voice-convert').disabled = busy || recording || opening || !$('voice-transcript').value.trim();
    const approved = pending?.questions.length && $('voice-reviewed').checked;
    $('voice-use').disabled = busy || !approved;
    $('voice-download').disabled = busy || !approved;
  }
  function invalidate() {
    pending = null; $('voice-preview').hidden = true; $('voice-reviewed').checked = false; refresh();
  }
  function releaseStream() { clearTimeout(timer); timer = null; stream?.getTracks().forEach(track => track.stop()); stream = null; }
  function clearAudio() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null; audio = null; $('voice-playback').pause(); $('voice-playback').removeAttribute('src'); $('voice-playback').hidden = true;
  }
  function setAudio(blob) {
    clearAudio();
    if (!blob.size || blob.size > 6 * 1024 * 1024) { status('Recording is empty or over 6 MB. Try a shorter recording.'); refresh(); return; }
    audio = blob; audioUrl = URL.createObjectURL(blob); $('voice-playback').src = audioUrl; $('voice-playback').hidden = false;
    status('Audio ready locally. Listen back, then choose Transcribe audio to send it to ElevenLabs.'); refresh();
  }
  $('speak-problem').addEventListener('click', () => {
    if (!canOpen()) return;
    dialog.showModal(); refresh();
    if (!supported) status('Microphone recording is unavailable. Use localhost/HTTPS with a supported browser, or upload audio instead.');
  });
  $('voice-record').addEventListener('click', async () => {
    if (busy || recording || opening) return;
    const token = ++generation; opening = true; refresh(); status('Waiting for microphone permission…');
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (token !== generation || !dialog.open) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('No supported recording format. Upload a WebM, M4A, MP3, Ogg, or WAV file instead.');
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      const chunks = []; let size = 0, failed = false;
      recorder.addEventListener('dataavailable', e => { if (token !== generation) return; if (e.data.size) { chunks.push(e.data); size += e.data.size; if (size > 6 * 1024 * 1024 && recorder?.state === 'recording') recorder.stop(); } });
      recorder.addEventListener('error', () => { if (token !== generation) return; failed = true; recording = false; releaseStream(); status('Recording failed. Try again or upload audio.'); refresh(); });
      recorder.addEventListener('stop', () => {
        if (token !== generation) return;
        releaseStream(); recording = false;
        if (token === generation && dialog.open && !failed) setAudio(new Blob(chunks, { type: mimeType }));
        refresh();
      });
      clearAudio(); invalidate(); originalTranscript = ''; $('voice-transcript').value = '';
      recorder.start(250); recording = true;
      timer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 60000);
      status('Recording locally… Say your formula clearly. Stops automatically after 60 seconds.');
    } catch (error) {
      if (token !== generation) return;
      releaseStream();
      if (token === generation) status(error.name === 'NotAllowedError' ? 'Microphone permission denied. Allow microphone access in your browser, or upload audio.' : error.message || 'Microphone unavailable.');
    } finally { if (token === generation) { opening = false; refresh(); } }
  });
  $('voice-stop').addEventListener('click', () => { if (recorder?.state === 'recording') recorder.stop(); });
  $('voice-upload').addEventListener('change', e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file || busy || recording || opening) return;
    invalidate(); originalTranscript = ''; $('voice-transcript').value = '';
    const extension = file.name.split('.').pop().toLowerCase();
    const mime = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' }[extension];
    if (!mime) { clearAudio(); status('Choose WebM, Ogg, M4A/MP4, MP3, or WAV audio.'); refresh(); return; }
    setAudio(file.slice(0, file.size, mime));
  });
  async function request(work) {
    if (busy || recording || opening) return;
    const token = generation; busy = true; refresh();
    try { await work(() => token === generation && dialog.open); }
    catch (error) { if (token === generation) status(error.message); }
    finally { busy = false; refresh(); }
  }
  $('voice-transcribe').addEventListener('click', () => {
    if (!audio) return;
    request(async isCurrent => {
      invalidate(); status('Sending audio to ElevenLabs for transcription…');
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the recording.')); reader.readAsDataURL(audio); });
      if (!isCurrent()) return;
      const result = await post('/api/transcribe-audio', { audio: dataUrl }, 70000);
      if (!isCurrent()) return;
      originalTranscript = result.text; $('voice-transcript').value = result.text;
      status('Review and correct the transcript, then choose Convert to math JSON.');
    });
  });
  $('voice-transcript').addEventListener('input', invalidate);
  function reviewedResult() {
    return { ...pending, needs_review: false, questions: pending.questions.map(q => ({ ...q, reviewed: true })) };
  }
  function updateJson() { $('voice-json').textContent = JSON.stringify($('voice-reviewed').checked ? reviewedResult() : pending, null, 2); refresh(); }
  $('voice-convert').addEventListener('click', () => request(async isCurrent => {
    invalidate(); status('Sending the reviewed transcript to Gemini for math formatting—not solving…');
    const result = await post('/api/voice-math', { transcript: $('voice-transcript').value.trim() });
    if (!isCurrent()) return;
    if (!result.questions.length) { status(result.warnings.join(' ') || 'No math found. Edit the transcript and try again.'); return; }
    pending = { ...result, original_transcript: originalTranscript || null, transcription_provider: originalTranscript ? 'elevenlabs' : 'typed', transcription_model: originalTranscript ? 'scribe_v2' : null };
    $('voice-editors').replaceChildren();
    pending.questions.forEach((q, index) => {
      const card = document.createElement('div'); card.className = 'line-editor';
      const title = document.createElement('h3'); title.textContent = q.label || `Formula ${index + 1}`; card.append(title);
      for (const [key, text] of [['text', 'Plain text'], ['latex', 'LaTeX']]) {
        const label = document.createElement('label'); label.textContent = text; label.htmlFor = `voice-${index}-${key}`;
        const input = document.createElement('textarea'); input.id = label.htmlFor; input.value = q[key]; input.rows = 2; input.maxLength = 16000;
        input.addEventListener('input', () => { q[key] = input.value; $('voice-reviewed').checked = false; updateJson(); }); card.append(label, input);
      }
      const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = q.ambiguities.join(' '); warning.hidden = !q.ambiguities.length; card.append(warning);
      $('voice-editors').append(card);
    });
    $('voice-warnings').textContent = pending.warnings.join(' '); $('voice-warnings').hidden = !pending.warnings.length;
    $('voice-preview').hidden = false; updateJson(); status('Check every formula, especially grouping and exponents. Edit below, then confirm your review.');
  }));
  $('voice-reviewed').addEventListener('change', () => { if (pending) updateJson(); });
  function validReview() {
    if (!pending || busy || !$('voice-reviewed').checked) return false;
    if (pending.questions.some(q => !q.text.trim() && !q.latex.trim())) { status('Each formula needs plain text or LaTeX.'); return false; }
    return true;
  }
  $('voice-use').addEventListener('click', () => { if (validReview() && canOpen()) { onImport(reviewedResult()); dialog.close(); } });
  $('voice-download').addEventListener('click', () => {
    if (!validReview()) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(reviewedResult(), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'inkmath-voice.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function cleanup() {
    generation++; opening = false;
    if (recorder?.state === 'recording') recorder.stop();
    releaseStream(); recording = false; clearAudio(); invalidate();
    originalTranscript = ''; $('voice-transcript').value = ''; status(''); refresh();
  }
  dialog.addEventListener('close', cleanup);
  window.addEventListener('pagehide', cleanup);
  refresh();
}