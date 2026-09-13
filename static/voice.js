const MAX_BYTES = 6 * 1024 * 1024;
const MAX_DURATION_MS = 60_000;
const AUDIO_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]);
const baseType = type => String(type || '').split(';', 1)[0].trim().toLowerCase();

/**
 * Bind once after the voice DOM exists. open() works without a practice session.
 * Call reset() on logout; it closes the dialog and cancels all local work.
 * onUse receives {text, latex, ambiguities}; onNotebook receives a capture draft
 * (not saved or approved). The common capture review must start unchecked.
 * Only explicit Transcribe/Format clicks POST to the same-origin voice endpoints.
 */
export function setupVoice({ getSessionId = () => null, onUse, onNotebook } = {}) {
  const $ = id => document.getElementById(`voice-${id}`);
  const dialog = $('dialog'), transcript = $('transcript'), reviewed = $('reviewed');
  const record = $('record'), stop = $('stop'), file = $('file');
  const transcribe = $('transcribe'), format = $('format'), playback = $('playback');
  const formulas = $('formulas'), reviewLabel = $('review-label'), status = $('status');
  const notebook = $('notebook'), download = $('download');
  let generation = 0, session = null, active = false, busy = false;
  let request = null, reader = null, recording = null, permission = null;
  let audio = null, audioUrl = null, downloadUrl = null, lines = [], warnings = [], rows = [];

  const current = token => active && dialog.open && token === generation;
  const locked = () => busy || Boolean(recording) || permission?.token === generation;
  const canAct = () => current(generation) && !locked();
  const sameSession = () => session != null && getSessionId() === session;
  const message = text => { status.textContent = text; };
  function visible(element, show) {
    element.hidden = !show;
    element.classList.toggle('hidden', !show);
  }
  function refresh() {
    const disabled = !active || locked();
    record.disabled = disabled || Boolean(permission);
    stop.disabled = !active || !recording || recording.stopping;
    file.disabled = disabled;
    transcript.disabled = disabled;
    transcribe.disabled = disabled || !audio;
    format.disabled = disabled || !transcript.value.trim();
    reviewed.disabled = disabled || !lines.length;
    notebook.disabled = disabled || !lines.length || !reviewed.checked || typeof onNotebook !== 'function';
    download.disabled = disabled || (!transcript.value.trim() && !lines.length);
    for (const row of rows) {
      row.input.disabled = disabled;
      row.use.disabled = disabled || !reviewed.checked || !sameSession() || typeof onUse !== 'function';
    }
  }
  function clearFormulas() {
    lines = []; warnings = []; rows = [];
    formulas.replaceChildren();
    visible(formulas, false); visible(reviewLabel, false);
    reviewed.checked = false;
  }
  function clearAudio() {
    audio = null;
    playback.pause(); playback.removeAttribute('src'); playback.load();
    playback.hidden = true;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
  function release(job) {
    clearTimeout(job.timer); job.timer = null;
    job.stream.getTracks().forEach(track => track.stop());
  }
  function stopRecording(job = recording) {
    if (!job || job.stopping) return;
    job.stopping = true;
    // Release the microphone immediately, not when the queued stop event arrives.
    try { if (job.recorder.state !== 'inactive') job.recorder.stop(); }
    catch {
      job.chunks = [];
      if (recording === job) {
        recording = null;
        if (current(job.token)) message('Recording failed. Try an audio file or type instead.');
      }
    } finally { release(job); }
    refresh();
  }
  function clear() {
    generation++;
    active = false; session = null;
    request?.abort(); request = null;
    const pendingReader = reader; reader = null;
    if (pendingReader?.readyState === 1) pendingReader.abort();
    const job = recording; recording = null;
    if (job) { job.chunks = []; stopRecording(job); release(job); }
    // An OS permission prompt cannot be cancelled. Keep its latch until it settles
    // so reopening cannot create a second concurrent prompt.
    busy = false;
    clearAudio(); clearFormulas(); transcript.value = ''; file.value = '';
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    message(''); refresh();
  }
  function reset() {
    clear();
    if (dialog.open) dialog.close();
  }
  function open() {
    clear(); session = getSessionId() ?? null; active = true;
    if (!dialog.open) dialog.showModal();
    message('Record up to 60 seconds, select audio (up to 6 MiB), or type. Nothing is sent until you choose Transcribe or Format.');
    refresh();
  }
  function setAudio(blob) {
    const type = baseType(blob.type);
    if (!AUDIO_TYPES.has(type)) throw new Error('Choose WebM, Ogg, MP4, MP3, or WAV audio.');
    if (!blob.size || blob.size > MAX_BYTES) throw new Error('Audio must be nonempty and no larger than 6 MiB.');
    clearAudio();
    audioUrl = URL.createObjectURL(blob); audio = blob;
    playback.src = audioUrl; playback.hidden = false;
    message('Audio stays local until you choose Transcribe. Listen using the playback controls.');
  }
  function readAudio(blob) {
    return new Promise((resolve, reject) => {
      const local = new FileReader(); reader = local;
      const finish = (callback, value) => {
        if (reader === local) reader = null;
        callback(value);
      };
      local.onload = () => {
        // MediaRecorder commonly adds ;codecs=opus. The backend accepts base MIME only.
        const value = String(local.result || '');
        const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
        if (!match || !AUDIO_TYPES.has(baseType(match[1]))) {
          finish(reject, new Error('Could not read a supported audio file.'));
        } else finish(resolve, `data:${baseType(blob.type)};base64,${match[2]}`);
      };
      local.onerror = () => finish(reject, new Error('Could not read the audio. Please try again.'));
      local.onabort = () => finish(reject, new Error('Audio reading cancelled.'));
      try { local.readAsDataURL(blob); }
      catch (error) { finish(reject, error); }
    });
  }
  async function operation(action) {
    if (!canAct()) return;
    const token = generation, controller = new AbortController();
    request = controller; busy = true; refresh();
    try { await action(token, controller.signal); }
    catch (error) {
      if (current(token)) message(error instanceof Error ? error.message : 'Voice operation failed. Please try again.');
    } finally {
      if (current(token)) { request = null; busy = false; refresh(); }
    }
  }
  async function post(path, body, signal) {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Voice request failed. Please try again.');
    return data;
  }
  const copyLine = line => ({ text: line.text, latex: line.latex, ambiguities: [...line.ambiguities] });
  async function handoff(callback, value) {
    reset();
    const token = generation;
    try { await callback(value); }
    catch (error) {
      // A failed callback must not repopulate a closed or subsequently reopened draft.
      if (current(token)) message(error instanceof Error ? error.message : 'Could not use the reviewed maths.');
    }
  }
  function render() {
    const token = generation;
    formulas.replaceChildren(); rows = [];
    for (const [index, line] of lines.entries()) {
      const card = document.createElement('div'); card.className = 'voice-formula';
      const label = document.createElement('label'); label.textContent = `Formula ${index + 1} LaTeX`;
      const input = document.createElement('input'); input.type = 'text'; input.value = line.latex;
      const text = document.createElement('p'); text.textContent = line.text;
      const warning = document.createElement('small'); warning.textContent = line.ambiguities.join(' ');
      const use = document.createElement('button'); use.type = 'button';
      use.className = 'secondary-button'; use.textContent = `Use formula ${index + 1}`;
      input.addEventListener('input', () => {
        if (!current(token) || !canAct() || !lines.includes(line)) return;
        line.latex = input.value; reviewed.checked = false; refresh();
      });
      use.addEventListener('click', () => {
        if (!current(token) || !canAct() || !lines.includes(line) || !reviewed.checked || typeof onUse !== 'function') return;
        if (!sameSession()) { message('Open voice again from the current practice before using a formula.'); refresh(); return; }
        return handoff(onUse, copyLine(line));
      });
      label.append(input); card.append(text, label, warning, use); formulas.append(card);
      rows.push({ input, use });
    }
    reviewed.checked = false;
    visible(formulas, Boolean(lines.length)); visible(reviewLabel, Boolean(lines.length));
  }

  document.getElementById('close-voice').addEventListener('click', reset);
  dialog.addEventListener('cancel', event => { event.preventDefault(); reset(); });
  // Native close events are queued: ignore an old close delivered after open().
  dialog.addEventListener('close', () => { if (!dialog.open) clear(); });
  playback.autoplay = false; playback.preload = 'none';
  file.accept = [...AUDIO_TYPES].join(',');
  file.addEventListener('change', () => {
    if (!canAct()) return;
    const selected = file.files?.[0];
    if (!selected) return;
    clearAudio(); clearFormulas(); transcript.value = '';
    try { setAudio(selected); }
    catch (error) { file.value = ''; message(error.message); }
    refresh();
  });
  transcript.addEventListener('input', () => {
    if (!canAct()) return;
    clearFormulas(); refresh();
  });
  reviewed.addEventListener('change', refresh);
  record.addEventListener('click', async () => {
    if (!canAct() || permission) return;
    clearAudio(); clearFormulas(); transcript.value = ''; file.value = ''; refresh();
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      message('Microphone recording is unavailable. Select an audio file or type instead.'); return;
    }
    const token = generation, latch = { token }; permission = latch;
    message('Waiting for microphone permission…'); refresh();
    let stream, job;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current(token)) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      if (!AUDIO_TYPES.has(baseType(recorder.mimeType || mimeType))) throw new Error('Unsupported recording format.');
      job = { token, stream, recorder, chunks: [], size: 0, stopping: false, overflow: false, timer: null };
      recording = job;
      recorder.addEventListener('dataavailable', event => {
        if (!current(token) || recording !== job || job.overflow || !event.data.size) return;
        job.size += event.data.size;
        if (job.size > MAX_BYTES) {
          job.overflow = true; job.chunks = [];
          message('Recording exceeded 6 MiB. Please record a shorter clip.'); stopRecording(job);
        } else job.chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        release(job);
        if (!current(token) || recording !== job) { job.chunks = []; return; }
        recording = null;
        try {
          if (!job.overflow) setAudio(new Blob(job.chunks, { type: baseType(recorder.mimeType || mimeType) }));
        } catch (error) { message(error.message); }
        job.chunks = []; refresh();
      });
      recorder.addEventListener('error', () => {
        if (!current(token) || recording !== job) return;
        job.overflow = true; job.chunks = [];
        message('Recording failed. Try an audio file or type instead.');
        stopRecording(job); recording = null; refresh();
      });
      recorder.start(250);
      job.timer = setTimeout(() => {
        if (current(token) && recording === job) stopRecording(job);
      }, MAX_DURATION_MS);
      message('Recording locally (maximum 60 seconds). Stop, listen, then choose Transcribe.');
    } catch (error) {
      if (job) { stopRecording(job); if (recording === job) recording = null; }
      else stream?.getTracks().forEach(track => track.stop());
      if (current(token)) message(error?.name === 'NotAllowedError'
        ? 'Microphone permission was not granted. Select an audio file or type instead.'
        : 'Could not start recording. Select an audio file or type instead.');
    } finally {
      if (permission === latch) permission = null;
      // Releasing the prompt latch also re-enables recording in a newer open draft.
      refresh();
    }
  });
  stop.addEventListener('click', () => { if (current(generation)) stopRecording(); });
  transcribe.addEventListener('click', () => {
    if (!audio) return;
    return operation(async (token, signal) => {
      clearFormulas(); refresh(); message('Transcribing audio…');
      const audioData = await readAudio(audio);
      if (!current(token)) return;
      const data = await post('/voice/transcribe', { audioData }, signal);
      if (!current(token)) return;
      if (typeof data?.transcript !== 'string') throw new Error('The server returned an invalid transcript.');
      transcript.value = data.transcript;
      message('Review and edit the transcript, then choose Format as maths.');
    });
  });
  format.addEventListener('click', () => {
    const value = transcript.value.trim();
    if (!value) return;
    return operation(async (token, signal) => {
      clearFormulas(); refresh(); message('Formatting your words as maths…');
      const data = await post('/voice/math-json', { transcript: value }, signal);
      if (!current(token)) return;
      if (!Array.isArray(data?.lines) || !data.lines.length) throw new Error('No formula was found. Edit the transcript and try again.');
      if (data.lines.some(line => !line || typeof line.text !== 'string' || typeof line.latex !== 'string'
        || (line.ambiguities != null && (!Array.isArray(line.ambiguities) || line.ambiguities.some(item => typeof item !== 'string'))))) {
        throw new Error('The server returned invalid formula data. Please try again.');
      }
      lines = data.lines.map(line => ({ text: line.text, latex: line.latex, ambiguities: [...(line.ambiguities || [])] }));
      warnings = Array.isArray(data.warnings) ? data.warnings.filter(item => typeof item === 'string') : [];
      render(); message([...warnings, 'Check every formula, then confirm before using or saving.'].join(' '));
    });
  });
  notebook.addEventListener('click', () => {
    if (!canAct() || !reviewed.checked || !lines.length || typeof onNotebook !== 'function') return;
    return handoff(onNotebook, {
      title: 'Spoken maths', sourceType: 'voice',
      questions: lines.map((line, index) => ({ label: String(index + 1), ...copyLine(line), diagram_description: '' })),
    });
  });
  download.addEventListener('click', event => {
    event.preventDefault();
    if (!canAct() || (!transcript.value.trim() && !lines.length)) return;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    const blob = new Blob([JSON.stringify({
      transcript: transcript.value, lines: lines.map(copyLine), warnings: [...warnings], needsReview: !reviewed.checked,
    }, null, 2)], { type: 'application/json' });
    downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl; anchor.download = 'spoken-maths.json';
    document.body.append(anchor); anchor.click(); anchor.remove();
  });
  clear();
  return { open, reset };
}