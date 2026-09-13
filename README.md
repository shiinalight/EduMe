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
{"imageData":"data:image/png;base64,...","sessionId":"...","stepIndex":0}
```

and must return:

```json
{"rawLatex":"a^2 + b^2 = c^2","confidence":0.91,"provider":"Teammate OCR"}
```

If your teammate's API uses different field names or multipart uploads, adapt
only `recognize_with_team_ocr` in `main.py`; the tablet UI and checker remain
unchanged. `OCR_SERVICE_URL` continues to work as a legacy alias for
`TEAM_OCR_URL`. When Team OCR is not selected, the service uses local Pix2Tex
at port `8502`.

## Voice formulas and public lesson links

The teammate's `photo-to-json-handwriting-to-latex` branch was built as a
separate Node application, so its voice and Firecrawl features are ported into
this FastAPI service instead of cherry-picked as a disconnected second app.

- `POST /voice/transcribe` accepts a learner-approved recording (maximum 6 MB)
  and sends it to ElevenLabs Scribe only when `ELEVENLABS_API_KEY` is configured.
- `POST /voice/math-json` sends an editable transcript to Gemini and returns
  plain-text/LaTex lines marked `needsReview: true`. It is instructed to retain
  mistakes and ambiguity, never solve the mathematics.
- `POST /import-problem-url` uses `FIRECRAWL_API_KEY` to extract existing
  problems from one public lesson URL. Private, local, IP-address, and custom
  port URLs are rejected. Returned items are also marked for review.

Copy `.env.example` to `.env` and add only the keys you have authority to use.
Keys stay server-side and must never be added to browser code or committed.

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
