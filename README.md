# EduMe

EduMe is a prototype mathematics practice space that helps learners show their working, receive targeted feedback, and revisit the concept behind a mistake. The current learning path connects square numbers, Pythagoras’ theorem, and algebraic equations.

The product is deliberately built around reasoning rather than answer reveal: a learner writes or types one mathematical step at a time, and the coach responds to the specific error pattern it sees.

## What it includes

- A learner profile and a simple Grade 9 mathematics journey.
- Pythagoras and algebra practice problems with deterministic step checking.
- A dotted handwriting canvas, typed-step alternative, undo, and clear controls.
- Adaptive support modes: guided prompts, Socratic questions, parallel worked examples, and visual cues.
- An **I don’t understand the problem** action that opens the relevant foundation lesson before work is submitted.
- A solution review with markers beside the handwritten lines that need attention.
- Three handwriting-recognition integrations:
  - InkMath, the teammate’s structured OCR service;
  - local Pix2Tex, which runs through Docker without an API key;
  - a configurable team OCR endpoint.
- Optional voice-to-maths input using ElevenLabs and Gemini.
- Optional public practice-link import using Firecrawl.

## Architecture

The app is a single FastAPI service that serves the HTML, CSS, and JavaScript frontend from `static/`.

```text
Browser notebook ──→ FastAPI (`main.py`) ──→ deterministic maths checker
       │                     │
       │                     ├── InkMath / Team OCR / local Pix2Tex
       │                     ├── Gemini (optional explanations and voice formatting)
       │                     ├── ElevenLabs (optional speech transcription)
       │                     └── Firecrawl (optional public practice-link import)
       └────────────────────→ SQLite learner/session data
```

Student profiles and practice sessions are stored locally in `student_data.db`. This file is intentionally excluded from Git.

## Quick start

Requirements:

- Python 3.10+
- Docker Desktop only if you want the local Pix2Tex OCR fallback
- Node.js only for the browser test suite or for running the separate InkMath project

Create a Python environment and install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start EduMe:

```bash
uvicorn main:app --reload
```

Open [http://127.0.0.1:8000/app/](http://127.0.0.1:8000/app/).

The health endpoint is [http://127.0.0.1:8000/](http://127.0.0.1:8000/) and FastAPI documentation is available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

## Configuration

Copy the example environment file and add only the services you intend to use:

```bash
cp .env.example .env
uvicorn main:app --reload --env-file .env
```

Never commit `.env` or place service keys in browser code.

| Variable | Purpose | Required? |
| --- | --- | --- |
| `DEFAULT_OCR_PROVIDER` | `inkmath`, `local-pix2tex`, or `team-ocr` | No; defaults to `inkmath` |
| `INKMATH_OCR_URL` | InkMath service URL | Needed for InkMath |
| `PIX2TEX_URL` | Override for local Pix2Tex | No |
| `TEAM_OCR_URL` | Server-side teammate OCR endpoint | Only for Team OCR |
| `TEAM_OCR_NAME` | Learner-facing Team OCR label | No |
| `GEMINI_API_KEY` | Detailed step explanations and voice formula formatting | Optional |
| `GEMINI_MODEL` | Gemini model name | No |
| `ELEVENLABS_API_KEY` | Speech transcription | Optional |
| `FIRECRAWL_API_KEY` | Public practice-link import | Optional |
| `MATH_TUTOR_DB` | Override for the local SQLite database path | Optional |

### InkMath (default OCR)

By default, EduMe sends handwriting to the teammate’s InkMath service at `http://127.0.0.1:3000/api/recognize`. Start that project separately and configure its `GEMINI_API_KEY` in that project’s own environment file. If it runs elsewhere, set `INKMATH_OCR_URL` here.

### Local Pix2Tex fallback

The bundled Docker Compose service provides an offline, no-key handwriting-maths fallback:

```bash
docker compose up -d ocr
```

Select **Local Pix2Tex** in the step tools, or set:

```bash
DEFAULT_OCR_PROVIDER=local-pix2tex
```

Pix2Tex is useful for prototyping, but handwritten maths recognition can be imperfect. EduMe therefore separates OCR from mathematical evaluation and treats unclear recognition conservatively.

### Team OCR contract

EduMe sends the selected endpoint JSON like this:

```json
{
  "imageData": "data:image/png;base64,...",
  "sessionId": "...",
  "stepIndex": 0
}
```

It expects:

```json
{
  "rawLatex": "a^2 + b^2 = c^2",
  "confidence": 0.91,
  "provider": "Team OCR"
}
```

Adapt `recognize_with_team_ocr` in `main.py` if the teammate service uses a different request or response shape.

## Learning and feedback flow

1. The learner picks a topic from the mathematics journey.
2. EduMe creates a private practice session and displays one problem.
3. The learner writes in the notebook, types a step, or uses the optional voice flow.
4. Each mathematical step is checked against the expected reasoning sequence—not merely the final answer.
5. If an error appears, the coach selects support appropriate to that error:
   - foundation guidance for a wrong relationship or theorem;
   - a focused hint for a calculation or progression mistake;
   - an optional detailed explanation when the learner selects **I don’t understand**;
   - a parallel worked example only after that additional support is needed.
6. Strategy outcomes are stored so the prototype can record which support helped a learner progress.

The current curriculum and learner-progress values are prototype data. They should be replaced with verified curriculum data and a measured mastery model before production use.

## Safety and privacy notes

- OCR output is treated as untrusted input and is evaluated separately.
- Gemini, ElevenLabs, and Firecrawl are only contacted when the learner initiates the relevant action and the server has the corresponding key.
- Public-link import rejects private, local, IP-address, login, and custom-port URLs.
- The app uses local SQLite and salted password hashing for the prototype. Production requires HTTPS, secure cookies, rate limiting, password reset/verification, and a managed database.
- This is a learning prototype, not a replacement for teacher assessment.

## Tests

Run the Python API and logic tests:

```bash
.venv/bin/python -m pytest -q
```

Run the browser-behaviour tests:

```bash
node --test tests/*.test.mjs
```

## Project layout

```text
main.py             FastAPI app, learning model, OCR adapters, and integrations
static/             EduMe frontend (HTML, CSS, JavaScript)
tests/              Backend and browser-behaviour tests
compose.yaml        Local Pix2Tex OCR service
.env.example        Optional server-side configuration
requirements.txt    Python dependencies
```

## Development notes

- Keep API keys server-side and out of commits.
- Add a new practice topic by expanding the problem definitions and expectations in `main.py`.
- Preserve the distinction between transcription and correctness: OCR reads what a learner wrote; the checker evaluates the mathematical step.
