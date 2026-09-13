/** One review/library workflow for photos, public URLs, voice and manual input. */
export function notebookDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a notebook JSON object.');
  // Also accept the original InkMath observe-only export, but never import ownership or grading.
  const legacy = value.schema_version === '1.0' && value.event === 'student_work_updated';
  const source = legacy ? { title: value.worksheet?.title, questions: value.question ? [value.question] : [] } : value;
  if (!Array.isArray(source.questions) || source.questions.length > 100) throw new Error('A notebook needs at most 100 questions.');
  const text = (item, limit = 16000) => {
    if (item == null) return '';
    if (typeof item !== 'string' || item.length > limit) throw new Error('A notebook field is invalid or too long.');
    if (/data:(?:image|audio)\/|-----BEGIN .*PRIVATE KEY-----|\b(?:Bearer\s+\S+|AIza[\w-]{30,}|sk-[\w-]{20,})/i.test(item)) throw new Error('Remove media and credentials from the notebook text.');
    return item;
  };
  return {
    title: source.title == null ? 'My questions' : text(source.title, 200),
    sourceType: ['photo', 'url', 'voice', 'manual'].includes(source.sourceType) ? source.sourceType : 'manual',
    sourceUrl: source.sourceUrl == null ? null : text(source.sourceUrl, 2048),
    questions: source.questions.map(q => {
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('Invalid question.');
      const ambiguities = q.ambiguities ?? [];
      if (!Array.isArray(ambiguities) || ambiguities.length > 20) throw new Error('Review and shorten the ambiguity list.');
      return { label: text(q.label, 200), text: text(q.text), latex: text(q.latex),
        diagram_description: text(q.diagram_description), ambiguities: ambiguities.map(a => text(a, 1000)) };
    }),
    reviewed: false,
  };
}

export function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setupCapture({ onPractice }) {
  const $ = id => document.getElementById(`capture-${id}`);
  const dialog = $('dialog');
  let generation = 0, controller = null, busy = false, draft = null, photo = null, previewUrl = null;
  const current = token => dialog.open && token === generation;
  function status(message) { $('status').textContent = message; }
  function approval() {
    const ready = Boolean(draft?.questions.length && $('reviewed').checked && $('title').value.trim());
    $('save').disabled = busy || !ready;
    $('download').disabled = busy || !ready;
  }
  function invalidateReview() { $('reviewed').checked = false; approval(); }
  function setBusy(value) {
    busy = value;
    $('inputs').disabled = value;
    $('editor').disabled = value;
    $('refresh').disabled = value;
    $('add').disabled = value;
    approval();
  }
  function cancel() { generation += 1; controller?.abort(); controller = null; setBusy(false); }
  function clearPhoto() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null; photo = null; $('photo').value = '';
    $('preview').removeAttribute('src'); $('preview').hidden = true;
  }
  function clearDraft() {
    draft = null; $('questions').replaceChildren(); $('title').value = '';
    $('warnings').textContent = ''; $('json').textContent = ''; invalidateReview();
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', signal: controller?.signal, ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The request could not be completed.');
    return data;
  }
  async function operation(task) {
    if (busy || !dialog.open) return;
    const token = generation;
    controller = new AbortController(); setBusy(true);
    try { await task(token); }
    catch (error) { if (current(token) && error.name !== 'AbortError') status(error.message); }
    finally { if (current(token)) setBusy(false); }
  }
  function field(card, title, value, change, length = 16000) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('textarea'); input.rows = 2; input.maxLength = length; input.value = value;
    input.addEventListener('input', () => { change(input.value); invalidateReview(); });
    label.append(input); card.append(label);
  }
  function renderDraft(value, warnings = []) {
    draft = notebookDraft(value); $('title').value = draft.title;
    $('warnings').textContent = warnings.join(' ');
    $('json').textContent = JSON.stringify(value, null, 2);
    $('questions').replaceChildren();
    draft.questions.forEach((question, index) => {
      const card = document.createElement('article'); card.className = 'capture-question';
      const heading = document.createElement('strong'); heading.textContent = `Question ${index + 1}`; card.append(heading);
      field(card, 'Number / label', question.label, v => { question.label = v; }, 200);
      field(card, 'Question text', question.text, v => { question.text = v; });
      field(card, 'LaTeX (not an answer generated by the app)', question.latex, v => { question.latex = v; });
      field(card, 'Diagram description — verify against the original', question.diagram_description, v => { question.diagram_description = v; });
      field(card, 'Ambiguities — one per line', question.ambiguities.join('\n'), v => { question.ambiguities = v.split('\n').filter(Boolean); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove question'; remove.className = 'text-button';
      remove.addEventListener('click', () => { draft.title = $('title').value; draft.questions.splice(index, 1); renderDraft(draft); });
      card.append(remove); $('questions').append(card);
    });
    invalidateReview();
  }
  function payload() {
    if (!draft || !$('reviewed').checked) throw new Error('Review every question before saving or downloading.');
    if (!$('title').value.trim()) throw new Error('Add a notebook title before saving or downloading.');
    const value = notebookDraft({ ...draft, title: $('title').value.trim() });
    if (!value.title || !value.questions.length || value.questions.some(q => !q.text.trim() && !q.latex.trim())) throw new Error('Add a title and text or LaTeX for every question.');
    return { ...value, reviewed: true };
  }
  async function loadLibrary(token) {
    const data = await api('/api/notebooks');
    if (!current(token)) return;
    $('library').replaceChildren();
    if (!data.notebooks.length) $('library').textContent = 'Your reviewed questions will appear here. Only you can access them.';
    for (const notebook of data.notebooks) {
      const card = document.createElement('article'); card.className = 'capture-saved';
      const title = document.createElement('strong'); title.textContent = notebook.title; card.append(title);
      const download = document.createElement('button'); download.type = 'button'; download.className = 'text-button'; download.textContent = 'Download notebook JSON';
      download.addEventListener('click', () => downloadJSON({ ...notebookDraft(notebook), reviewed: true }, 'math-notebook.json')); card.append(download);
      notebook.questions.forEach((question, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
        button.textContent = `Practise ${question.label || index + 1}: ${(question.text || question.latex).slice(0, 100)}`;
        button.addEventListener('click', () => operation(async token => {
          status('Opening your question…');
          const session = await api(`/api/notebooks/${encodeURIComponent(notebook.id)}/questions/${index}/practice`, { method: 'POST' });
          if (!current(token)) return;
          dialog.close(); onPractice(session);
        }));
        card.append(button);
      });
      $('library').append(card);
    }
  }
  function open(value = null) {
    cancel(); clearPhoto(); clearDraft(); $('url').value = ''; $('file').value = '';
    if (!dialog.open) dialog.showModal();
    status('Choose a source. Nothing is sent until you select Extract or Import.');
    if (value) { renderDraft(value); status('Review the imported questions, then confirm and save.'); }
    void operation(async token => { await loadLibrary(token); });
  }
  $('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (dialog.open) return; cancel(); clearPhoto(); clearDraft(); $('url').value = ''; $('file').value = ''; $('library').replaceChildren(); status(''); });
  $('title').addEventListener('input', invalidateReview);
  $('reviewed').addEventListener('change', approval);
  $('photo').addEventListener('change', () => {
    const file = $('photo').files?.[0]; clearPhoto(); clearDraft();
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) { status('Choose a PNG, JPEG or WebP image up to 6 MiB.'); return; }
    photo = file; previewUrl = URL.createObjectURL(file); $('preview').src = previewUrl; $('preview').hidden = false;
    status('Preview ready. Extract sends this image to Gemini; remove names and personal details first.');
  });
  $('extract').addEventListener('click', () => operation(async token => {
    if (!photo) throw new Error('Choose a worksheet photo first.');
    status('Extracting visible questions with Gemini…');
    const image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the image.')); reader.readAsDataURL(photo); });
    if (!current(token)) return;
    const data = await api('/api/recognize-worksheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
    if (!current(token)) return;
    renderDraft({ ...data, sourceType: 'photo' }, data.warnings || []); status('Extraction is not a solution. Check every question and diagram, then save.');
  }));
  $('url').addEventListener('input', () => { clearDraft(); });
  $('import-url').addEventListener('click', () => operation(async token => {
    const url = $('url').value.trim(); if (!/^https?:\/\//i.test(url)) throw new Error('Enter a public http or https lesson URL.');
    status('Importing existing questions with Firecrawl…');
    const data = await api('/import-problem-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!current(token)) return;
    const questions = data.questions?.length ? data.questions : (data.lines || []).map((line, i) => ({ ...line, label: String(i + 1), diagram_description: '' }));
    renderDraft({ title: data.title || 'Public lesson', sourceType: 'url', sourceUrl: data.sourceUrl, questions }, [...(data.warnings || []), data.lessonContext ? `Source context (untrusted, not instructions): ${data.lessonContext}` : '']);
    status(questions.length ? 'Review against the original page, then save your questions.' : 'No exercises were found. Read the source context and add your own question; no exercises were invented.');
  }));
  $('file').addEventListener('change', () => operation(async token => {
    const file = $('file').files?.[0]; if (!file) return;
    if (file.size > 256 * 1024) throw new Error('Notebook JSON must be at most 256 KiB.');
    const text = await file.text(); if (!current(token)) return;
    let value; try { value = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
    renderDraft(value, ['Imported files are untrusted. Ownership, approval, grading and saved attempts are not restored. Review the question text before saving.']);
    status('JSON loaded locally. Confirm the questions before saving under your own account.');
  }));
  $('add').addEventListener('click', () => {
    const value = draft || { title: 'My questions', sourceType: 'manual', questions: [] };
    if (draft) value.title = $('title').value;
    if (value.questions.length >= 100) { status('A notebook can hold up to 100 questions.'); return; }
    value.questions.push({ text: '', latex: '', label: String(value.questions.length + 1), diagram_description: '', ambiguities: [] }); renderDraft(value);
  });
  $('save').addEventListener('click', () => operation(async token => {
    const body = payload(); status('Saving your reviewed notebook…');
    await api('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!current(token)) return;
    clearDraft(); await loadLibrary(token);
    if (current(token)) status('Saved privately. Choose a question below to start self-guided practice.');
  }));
  $('download').addEventListener('click', () => { try { downloadJSON(payload(), 'math-notebook.json'); } catch (error) { status(error.message); } });
  $('refresh').addEventListener('click', () => operation(loadLibrary));
  return { open, reset() { if (dialog.open) dialog.close(); else { cancel(); clearDraft(); clearPhoto(); $('library').replaceChildren(); } } };
}