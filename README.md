# Math Step Detection Service

A small FastAPI service that evaluates OCR-recognized mathematics deterministically with SymPy. It currently supports `pythagoras_01` and is designed to accept additional problem definitions in `main.py` without changing the endpoint logic.

## Setup

Use Python 3.10 or newer, then create and activate a virtual environment and install the dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run the service:

```bash
uvicorn main:app --reload
```

Open <http://127.0.0.1:8000/> to confirm the service is running, or use the
interactive API form at <http://127.0.0.1:8000/docs>. The equation checker is
a `POST` endpoint at `/check-step`, so it cannot be tested by simply opening
that URL in a browser.

## Optional HeyGen coach videos

This feature is isolated on `feature/heygen-assistant-video`, based on `full-stack-setup`. It narrates the assistant's existing authored guidance; it does not change the math checker or tutoring policy, generate new lesson content, or render mathematical diagrams.

1. Add `HEYGEN_API_KEY` to your **existing** local `.env`, save it, and restart the Python server with the environment file loaded. Do not overwrite your other keys or paste credentials into chat.
2. Use `uvicorn main:app --reload --env-file .env --host 127.0.0.1 --port 8000`, then open <http://127.0.0.1:8000/app/>. This is the Python assistant, not the separate InkMath service on port 3000.
3. Sign in or create a learner profile, open a practice topic, and choose **Turn coach guidance into a video**. The script is populated from the latest tutor prompt, worked example and visual cue (when present).
4. Review the script (maximum 4,000 characters). Write mathematical symbols as spoken words for accurate pronunciation. Remove names, emails, or other personal details. Load public avatars and select a presenter; its default voice is used. `HEYGEN_AVATAR_ID` and `HEYGEN_VOICE_ID` are optional server-side defaults, not additional API keys.
5. Confirm the script and credit-use checkbox, then select **Generate video**. This sends the script to HeyGen, uses API credits, and requests a 720p landscape avatar video. The website subscription and API billing may differ. Your API key needs access to video creation/status and avatar listing.
6. Status checks run every eight seconds for up to ten minutes while the dialog is open. Use **Check status** to resume, or reopen the dialog for recent jobs in this practice session. When complete, play the video or open/save it using the delivery link. Check status again if the signed link expires.

The included VS Code task **Run assistant with HeyGen (8001)** uses your selected Python interpreter and serves <http://127.0.0.1:8001/app/> so an existing service on port 8000 can stay running. Stop and restart the task after saving API-key changes; the environment file is loaded at process startup.

**Cost and privacy safeguards:** no generation on page load, guidance updates, or avatar selection; explicit review required on every new draft. Submissions use a stable HeyGen `Idempotency-Key` and a local uniqueness check, so a retry of the same unchanged draft reuses the request. Do not start a new draft to retry a timeout: a paid generation may already exist. Safe retries stop after 23 hours (HeyGen's documented window is 24 hours). At most three active/unconfirmed jobs per learner are allowed in a rolling day. Closing the dialog pauses polling but does **not** cancel a render already submitted to HeyGen. After a browser reload, an unconfirmed submission must be checked in HeyGen's dashboard before creating another video.

The local database stores job IDs, ownership, status, timestamps and a request fingerprint—not scripts, provider keys, or video bytes. Each job is accessible only to its signed-in owner. The reviewed script and chosen avatar/voice IDs are sent to HeyGen; learner profile data and the practice-session ID are not sent. Provider retention policies apply, and delivery URLs should be treated as private bearer links. The existing prototype deployment limitations still apply; do not expose this app publicly without stronger account/rate-limit controls.

Implementation: `heygen_video.py` contains the provider adapter and authenticated router; `static/heygen-video.js` and its stylesheet own the dialog. The assistant integration consists of an import and guidance/reset hooks in `static/app.js`. API endpoints: `GET /api/heygen/config`, `GET /api/heygen/avatars`, `POST /api/heygen/videos`, `GET /api/heygen/videos?sessionId=…`, and `GET /api/heygen/videos/{job_id}`. No raw provider credentials or error bodies are returned.

Official API references: [Create video](https://developers.heygen.com/reference/create-video), [Video status](https://developers.heygen.com/reference/get-video), [Avatar looks](https://developers.heygen.com/reference/list-avatar-looks). Tests use mocked HeyGen responses, not paid live generations. Run `pytest` for backend regressions and `node --test tests/heygen-video.test.mjs` for browser-controller tests.

## Tablet notebook and pluggable OCR

Open <http://127.0.0.1:8000/app/> on an iPad (or any touch-enabled browser).
The writing area supports Apple Pencil, touch, undo, and clear. Use a sample
equation to test the full feedback flow right away, or type the LaTeX returned
by your OCR system into the **Recognized equation** field.

The project includes a self-hosted handwriting-maths OCR service based on
[Pix2Tex / LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR). Start it
once with Docker Desktop running:

```bash
docker compose up ocr
```

Then start this FastAPI app in a second terminal as usual. The first model
startup may take a while because its model checkpoint is loaded locally. No API
token is required. The notebook's **Recognize writing** button sends a PNG of
the canvas to the local service, receives LaTeX, and places it in the review
field; use **Check this step** to get the concept feedback.

The notebook includes an **OCR provider** toggle. Choose **Local Pix2Tex** for
the included local model, or choose **Team OCR** after configuring your
teammate's service. Copy `.env.example` to `.env`, set `TEAM_OCR_URL`, then
start Uvicorn with:

```bash
uvicorn main:app --reload --env-file .env
```

The browser never receives the team URL or credentials. `TEAM_OCR_URL` is a
server-side adapter endpoint and must receive:

```json
{ "imageData": "data:image/png;base64,...", "sessionId": "...", "stepIndex": 0 }
```

and must return:

```json
{
  "rawLatex": "a^2 + b^2 = c^2",
  "confidence": 0.91,
  "provider": "Teammate OCR"
}
```

If your teammate's API uses different field names or multipart uploads, adapt
only `recognize_with_team_ocr` in `main.py`; the tablet UI and checker remain
unchanged. `OCR_SERVICE_URL` continues to work as a legacy alias for
`TEAM_OCR_URL`. When Team OCR is not selected, the service uses local Pix2Tex
at port `8502`.

## Student learning flow

The first visit to `/app/` now begins with a learner profile. The local app
stores a name, email, password, grade, country, and state/region in
`student_data.db` (which is excluded from Git). After signing in, it:

1. Selects a starter curriculum context from the grade and location profile.
2. Creates one right-triangle problem using a Pythagorean triple.
3. Keeps the student's submitted lines in a private practice session.
4. Accepts the foundation equation, the numerical substitution/simplification,
   or a direct valid solution for `c`.
5. Explains a recognisable misconception, such as a missing square, in terms of
   the Pythagorean foundation instead of merely marking the answer incorrect.

The tablet presents two review actions: **Check this step** evaluates the
current equation, while **Review full solution** summarises every flagged
attempt in that practice session and connects it back to the foundation lesson.
When handwriting is present, **Review full solution** silently separates the
canvas into written lines, sends each line to the server-configured default OCR
provider, then checks those returned equations in order before displaying the
review. It now defaults to the local teammate project **InkMath** at
`http://127.0.0.1:3000/api/recognize`. In
`/Users/demonslayer/Documents/Projects/EduMe-main`, add `GEMINI_API_KEY` to its
own `.env` and run `npm start`; then start this app with its `.env` file using
`uvicorn main:app --reload --env-file .env`. Set
`DEFAULT_OCR_PROVIDER=team-ocr` to use a different connected provider, or
`local-pix2tex` to use Pix2Tex.

## Adaptive tutoring strategies

During registration, a learner can select one or more helpful approaches:
Guided, Socratic, Worked Example, and Visual. The tutor begins with the first
selected approach, then records whether the strategy offered before each step
was followed by progress. Its initial authored rules are:

- **Guided:** one small next action.
- **Socratic:** after an incorrect line, ask a question targeted to the error.
- **Worked Example:** after the same misconception appears repeatedly, show the
  verified 6–8–10 parallel example before returning to the learner's triangle.
- **Visual:** show a pinned, labelled right-triangle diagram and a cue about
  the hypotenuse or the two shorter sides.

Strategies can blend: for example, a learner who selected Visual support can
receive a Socratic question alongside the pinned diagram. The authored prompts,
worked example, and selection policy live in `main.py` rather than being
generated by an LLM.

The grade/location rules live in `curriculum_context_for` in `main.py`. They
are intentionally a small starter policy, so replace or expand them with your
verified country/state curriculum data before using the app beyond a prototype.
Passwords are salted and hashed; for a deployed product, use HTTPS, secure
cookies, rate limiting, password-reset/email verification, and a managed
database.

Run the test suite:

```bash
pytest
```

## Manual request

```bash
curl -X POST http://127.0.0.1:8000/check-step \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "abc123",
    "stepIndex": 2,
    "problemId": "pythagoras_01",
    "rawLatex": "a + b^2 = c^2",
    "confidence": 0.91,
    "timestamp": 1234567890
  }'
```

The response reports `correct`, `error`, or `unclear`. Inputs with OCR confidence below `0.6` immediately return `unclear` and are not parsed. The `errorType` field is intended for software; the frontend should display the plain-language `hint`.
