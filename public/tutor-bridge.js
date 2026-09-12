/**
 * YOUR TEAMMATE'S INTEGRATION POINT.
 * Called only for confirmed, reviewed work, never on a partial pen stroke.
 * No tutor service is contacted by this prototype.
 *
 * Example replacement:
 * const response = await fetch('/api/tutor', {
 *   method: 'POST', headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify(payload),
 * });
 * if (!response.ok) throw new Error('Tutor unavailable');
 * return response.json();
 *
 * Implement /api/tutor on your server. Keep the tutor's API key on that server.
 * Treat all transcribed fields as untrusted student content, not instructions.
 */
export async function onStudentStep(payload) {
  window.dispatchEvent(new CustomEvent('inkmath:step', { detail: payload }));
}
