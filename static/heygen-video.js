// One integration point: tutor output in, reviewed narration out. Never auto-generate.
export function tutorScript(tutor) {
  if (!tutor) return '';
  return [tutor.prompt, tutor.workedExample?.title, ...(tutor.workedExample?.steps || []), tutor.workedExample?.handoff, tutor.visualCue]
    .filter(value => typeof value === 'string' && value.trim()).join('\n\n');
}

export function setupHeygenVideo({ getSessionId }) {
  const $ = id => document.getElementById(id), dialog = $('heygen-dialog');
  let source = '', draftSession = null, generation = 0, pollTimer = null, pollCount = 0;
  let busy = false, config = null, submitted = null, activeJob = null, nextToken = null;
  const pendingStates = new Set(['pending', 'processing', 'submitting']);
  function message(text) { $('heygen-status').textContent = text; }
  function refresh() {
    const script = $('heygen-script').value.trim();
    $('heygen-count').textContent = `${$('heygen-script').value.length} / 4000 characters`;
    $('heygen-generate').disabled = busy || !config?.configured || !script || script.length > 4000 || !$('heygen-avatar').value || !$('heygen-consent').checked || Boolean(activeJob);
    for (const id of ['heygen-script', 'heygen-avatar', 'heygen-voice', 'heygen-consent']) $(id).disabled = busy || Boolean(submitted);
    $('heygen-load-avatars').disabled = busy || !config?.configured || Boolean(submitted);
    $('heygen-more-avatars').disabled = busy || !nextToken || Boolean(submitted);
    $('heygen-refresh').disabled = busy || !activeJob;
    $('heygen-new-draft').disabled = busy;
    $('heygen-generate').textContent = submitted && !activeJob ? 'Retry same submission' : 'Generate video · uses credits';
  }
  function clearPlayer() {
    $('heygen-player').pause(); $('heygen-player').removeAttribute('src'); $('heygen-player').hidden = true;
    $('heygen-download').removeAttribute('href'); $('heygen-download').hidden = true;
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  async function api(path, options = {}) {
    const response = await fetch(`/api/heygen${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(55000) });
    let value;
    try { value = await response.json(); } catch { throw new Error('The server returned an unreadable response. Check its connection.'); }
    if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Invalid video request. Review the script and settings.');
    return value;
  }
  async function operation(action) {
    if (busy) return;
    const token = generation; busy = true; refresh();
    try { await action(() => generation === token && dialog.open); }
    catch (error) {
      if (generation === token) message(error.name === 'TimeoutError' || error instanceof TypeError ? 'Connection interrupted. If submitting, retry the same unchanged draft or check HeyGen before generating another video.' : error.message);
    } finally { if (generation === token) { busy = false; refresh(); } }
  }
  function showJob(job) {
    activeJob = job.id; $('heygen-job-id').textContent = `Local job: ${job.id}`;
    clearPlayer();
    if (job.status === 'completed' && job.videoUrl) {
      const url = new URL(job.videoUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid video delivery link.');
      $('heygen-player').src = url.href; $('heygen-player').hidden = false;
      $('heygen-download').href = url.href; $('heygen-download').hidden = false;
      message('Video ready. AI avatar narration—check the spoken math before sharing. Delivery links may expire; Check status refreshes them.');
    } else message(job.message || ({ pending: 'Video queued with HeyGen…', processing: 'HeyGen is rendering your video…', submitting: 'Submitting to HeyGen…', failed: 'Generation failed. Check HeyGen before trying again.', submission_unknown: 'Submission outcome is unknown. Check HeyGen before generating another video.' }[job.status] || 'Check status for an update.'));
    if (pendingStates.has(job.status) && dialog.open && pollCount < 75) {
      stopPolling(); pollTimer = setTimeout(() => { pollCount++; checkStatus(); }, 8000);
    } else if (pendingStates.has(job.status)) message('Still rendering. Automatic checks paused after 10 minutes; use Check status later.');
    refresh();
  }
  function checkStatus() {
    if (!activeJob || busy) return;
    stopPolling(); const jobId = activeJob;
    operation(async current => { const job = await api(`/videos/${encodeURIComponent(jobId)}`); if (current() && activeJob === jobId) showJob(job); });
  }
  function renderHistory(videos) {
    $('heygen-history').replaceChildren();
    for (const job of videos) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'heygen-history-item';
      button.textContent = `${new Date(job.createdAt * 1000).toLocaleTimeString()} · ${job.status.replaceAll('_', ' ')} · ${job.id.slice(0, 8)}`;
      button.addEventListener('click', () => { if (busy) return; stopPolling(); activeJob = job.id; pollCount = 0; checkStatus(); });
      $('heygen-history').append(button);
    }
  }
  async function loadHistory(current) {
    const history = await api(`/videos?sessionId=${encodeURIComponent(draftSession)}`);
    if (current()) renderHistory(history.videos);
  }
  function blankDraft() {
    stopPolling(); submitted = null; activeJob = null; pollCount = 0;
    $('heygen-script').value = source; $('heygen-consent').checked = false; $('heygen-job-id').textContent = ''; clearPlayer(); refresh();
  }
  $('heygen-open').addEventListener('click', () => {
    if (!source || !getSessionId()) return;
    const changed = draftSession !== getSessionId(); draftSession = getSessionId();
    dialog.showModal();
    if (changed || !submitted && !activeJob) blankDraft();
    operation(async current => {
      const settings = await api('/config'); if (!current()) return;
      config = settings;
      if (!$('heygen-avatar').value && settings.defaultAvatarId) {
        const option = document.createElement('option'); option.value = settings.defaultAvatarId; option.textContent = 'Configured avatar'; $('heygen-avatar').append(option); $('heygen-avatar').value = settings.defaultAvatarId;
      }
      if (!submitted && !$('heygen-voice').value) $('heygen-voice').value = settings.defaultVoiceId;
      message(settings.configured ? 'Review the narration, load an avatar, and confirm before spending credits.' : 'Add HEYGEN_API_KEY to your local .env, save, and restart the Python app.');
      await loadHistory(current);
      if (current() && activeJob) {
        const jobId = activeJob;
        const job = await api(`/videos/${encodeURIComponent(jobId)}`);
        if (current() && activeJob === jobId) showJob(job);
      }
    });
  });
  function loadAvatars(more = false) {
    operation(async current => {
      message('Loading public HeyGen avatars…');
      const data = await api(`/avatars${more && nextToken ? `?token=${encodeURIComponent(nextToken)}` : ''}`);
      if (!current()) return;
      if (!more) $('heygen-avatar').replaceChildren();
      for (const avatar of data.avatars) {
        const option = document.createElement('option'); option.value = avatar.id; option.textContent = avatar.name; $('heygen-avatar').append(option);
      }
      nextToken = data.nextToken;
      message(data.avatars.length ? 'Choose a public avatar. Its default voice is used unless you supply a HeyGen voice ID.' : 'No compatible avatars on this page. Try More avatars or check your HeyGen account.');
    });
  }
  $('heygen-load-avatars').addEventListener('click', () => loadAvatars());
  $('heygen-more-avatars').addEventListener('click', () => loadAvatars(true));
  for (const id of ['heygen-script', 'heygen-avatar', 'heygen-voice']) $(id).addEventListener('input', () => { $('heygen-consent').checked = false; refresh(); });
  $('heygen-consent').addEventListener('change', refresh);
  $('heygen-generate').addEventListener('click', () => {
    if ($('heygen-generate').disabled || !draftSession || draftSession !== getSessionId()) return;
    operation(async current => {
      // Preserve the exact draft + request ID across errors. Retrying must not charge twice.
      submitted ||= { sessionId: draftSession, requestId: crypto.randomUUID(), script: $('heygen-script').value.trim(), avatarId: $('heygen-avatar').value, voiceId: $('heygen-voice').value.trim(), reviewed: true };
      message('Submitting once to HeyGen. This uses API credits and may take several minutes…'); refresh();
      const job = await api('/videos', { method: 'POST', body: JSON.stringify(submitted) });
      if (!current()) return;
      showJob(job); await loadHistory(current);
    });
  });
  $('heygen-refresh').addEventListener('click', () => { pollCount = 0; checkStatus(); });
  $('heygen-new-draft').addEventListener('click', () => {
    if (busy) return;
    if ((submitted || activeJob) && !confirm('A new draft can create another paid video. Existing generation is NOT cancelled. Check its status or HeyGen dashboard first. Continue?')) return;
    blankDraft(); message('New draft ready. Review pronunciation and confirm before generating.');
  });
  $('heygen-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; busy = false; stopPolling(); clearPlayer(); });
  window.addEventListener('pagehide', stopPolling);
  refresh();
  return {
    setGuidance(tutor) { source = tutorScript(tutor); $('heygen-open').disabled = !source || !getSessionId(); },
    reset() {
      generation++; stopPolling(); busy = false; source = ''; submitted = null; activeJob = null; config = null; draftSession = null;
      $('heygen-open').disabled = true; $('heygen-history').replaceChildren(); $('heygen-script').value = ''; clearPlayer();
      if (dialog.open) dialog.close(); refresh();
    }
  };
}