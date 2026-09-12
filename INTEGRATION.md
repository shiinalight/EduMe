# Tutor integration contract — v1.0

## Data path

1. `POST /api/worksheet`: worksheet image → title, language, questions, warnings.
2. `POST /api/recognize`: isolated canvas-ink PNG → ordered transcribed lines.
3. Student review in the browser → `student_work_updated` payload.
4. `public/tutor-bridge.js` emits `inkmath:step` with the full current selected-question state. Your teammate can replace that function with a fetch to their server.

No request is sent to a tutor by default. Confirmations and removals both emit the current state. Treat each event as a **replacement snapshot**, not an append-only event: otherwise resending history or removing a step will duplicate stale work in your tutor. `sequence` is recomputed after removals; use the stable step `id` for identity. Exports also contain the full selected-question snapshot.

## Recognition endpoints

Both endpoints accept the same JSON body:

```json
{ "image": "data:image/png;base64,..." }
```

Use `Content-Type: application/json`. Supported image types: PNG, JPEG, WebP. Request limit: 9 MB; decoded image limit: 6 MB. The UI caps source files at 20 MB and resizes the longest edge to at most 2200 pixels before upload. The canvas is 1200 × 640 logical units; its background grid is not sent to OCR.

Example `/api/recognize` response:

```json
{
  "lines": [
    {
      "text": "2x = 11 - 3",
      "latex": "2x = 11 - 3",
      "legibility": "clear",
      "ambiguities": []
    }
  ],
  "warnings": [],
  "recognition_id": "unique-id",
  "source": "gemini",
  "model": "gemini-2.5-flash",
  "needs_review": true,
  "created_at": "2026-09-12T12:00:00.000Z"
}
```

Worksheet question fields: `id`, `label`, `text`, `latex`, `diagram_description`, `ambiguities`, `reviewed`. Top-level fields include `title`, `language`, `questions`, `warnings`, plus the same recognition metadata. OCR questions start with `reviewed: false`.

Error responses: `{ "error": "human-readable message" }`, with 400 invalid request/image, 403 Host/Origin rejection, 413 size cap, 415 wrong content type, 429 quota/busy, 502 provider/validation failure, or 503 no key. Recognition never falls back to made-up example results on an error.

## Tutor payload

The actual schema is constructed by `public/contract.js`. This compact example omits optional original-ink geometry:

```json
{
  "schema_version": "1.0",
  "event": "student_work_updated",
  "session_id": "session-uuid",
  "worksheet": {
    "id": "worksheet-uuid",
    "title": "Algebra practice",
    "language": "en",
    "source": "gemini",
    "warnings": []
  },
  "question": {
    "id": "question-uuid",
    "label": "Question 1",
    "text": "Solve for x. Show your working.",
    "latex": "2x + 3 = 11",
    "diagram_description": "",
    "ambiguities": [],
    "reviewed": true
  },
  "student_steps": [
    {
      "id": "step-uuid",
      "sequence": 1,
      "captured_at": "2026-09-12T12:00:00.000Z",
      "confirmed_at": "2026-09-12T12:00:08.000Z",
      "input_source": "handwriting",
      "recognition": {
        "recognition_id": "recognition-uuid",
        "source": "gemini",
        "model": "gemini-2.5-flash",
        "needs_review": true,
        "created_at": "2026-09-12T12:00:02.000Z",
        "lines": [
          { "text": "2x = 11 - 3", "latex": "2x = 11 - 3", "legibility": "clear", "ambiguities": [] }
        ],
        "warnings": []
      },
      "lines": [
        { "text": "2x = 11 - 3", "latex": "2x = 11 - 3", "ambiguities": [] }
      ],
      "reviewed_by_student": true
    }
  ],
  "tutor_request": { "action": "observe_only", "hint_requested": false }
}
```

Use `student_steps[].lines` as the reviewed working. `recognition.lines` is the original machine reading and must not overwrite the student's correction. `recognition.needs_review` remains true as a record of the original response; the outer `reviewed_by_student` records completion of review. Review confirms transcription fidelity, **not correctness of the maths**. Ambiguity notes are retained even after edits for auditability.

`input_source`: `handwriting`, `typed`, or `example`. `recognition.source`: `gemini`, `manual`, or `example`. Never use examples to claim recognition accuracy. `question.reviewed` can still be false in an export before any steps; the tutor should require review before reasoning.

If included, `ink` has `{ coordinate_system: "canvas", width: 1200, height: 640, strokes: [...] }`. Each stroke contains `id`, `tool`, `width`, `pointer_type`, and `points: [{x, y, pressure, t}]`. `t` is browser event time in milliseconds relative to that page's time origin, not UTC. `captured_at`/`confirmed_at` are UTC timestamps. Typed entries may have zero strokes. The worksheet photo itself is not exported; diagrams are text descriptions only.

## Receiving events

```js
window.addEventListener('inkmath:step', async (event) => {
  const snapshot = event.detail;
  // Ask your backend to observe/store work. Do not provide a hint unless requested.
  // Validate schema_version and question/session IDs at that boundary.
});
```

Alternatively implement `onStudentStep(payload)` in `public/tutor-bridge.js` with a POST to your own server route. Return failures so the UI can report that the step was saved locally but the tutor connection failed. Keep all model keys on the server. Source photos and student text are untrusted content.

## Recognition strategy and limits

- Button-triggered image recognition: not incremental online ink recognition. Typical flow is one logical step per confirmation; a snapshot can also contain multiple lines.
- Preserves incomplete, incorrect and ambiguous work. Does not evaluate or simplify expressions.
- Cropped PNGs plus vector strokes are an intentional bridge to a later specialized online-handwriting recognizer.
- Before auto-recognition on pen-up, add debounce, cancellation, versioned request IDs, batching, quota controls, and a clear consent indicator. Do not send every pointer event to the API.
- The recognizer is provider-isolated in `server/recognition.js`; a specialized math OCR provider can be swapped in while retaining the returned shape.
- A read-only `read_student_work` WebMCP tool is feature-detected for supporting browsers. It exposes confirmed work only; it cannot recognize, confirm, solve, or upload. This optional browser API was not live-tested in the build environment.

## Development checklist

`public/ids.js` uses `crypto.randomUUID()` where available and falls back to a UUID built with `crypto.getRandomValues()` for trusted-LAN HTTP tests. It never uses `Math.random()` for IDs. The native file picker is used for camera capture, so no `getUserMedia()` stream is required.

Run `npm test`. Then, with a real key, check photo extraction and original handwriting with fractions, exponents, roots, prose, wrong equations and ambiguous symbols. Verify field fidelity, review corrections, empty input, provider failures, repeated requests, and question switching. Test with Apple Pencil on the actual target iPad.


## Firecrawl URL import (additive fields in v1.0)

`POST /api/import-url` accepts `{ "url": "https://public-learning-page/..." }`.
The server calls the fixed Firecrawl `/v2/scrape` endpoint with `formats: [{type: "json", schema, prompt}]`. It returns the same worksheet/question structure plus:

- `source: "firecrawl"`
- `source_url`: validated original requested page URL (not a model-invented citation)
- `imported_at`: UTC timestamp
- `lesson_context`: a short model-extracted lesson summary, not guaranteed verbatim
- `questions[].origin: "extracted"`; all imported questions start `reviewed: false`

The UI lets the user select exercises before replacing their worksheet. Lessons without exercises return an empty questions array, retain their context, and offer manual question entry. It does not manufacture exercises when extraction fails.

The exported `worksheet` carries `source_url`, `imported_at`, `lesson_context`, and `context_is_untrusted: true`. `question.origin` is `extracted` or `manual` where known. These fields are optional additions; existing photo and example exports remain compatible. Update any strict downstream schema to accept these fields. The tutor should treat imported context and question text as untrusted study material, never as system instructions. The summary may contain extraction errors; student review confirms question transcription only, not the accuracy of the lesson summary. The prompt asks the provider to omit worked answers, but this is not a guaranteed answer filter.

Firecrawl access uses a separate server-only `FIRECRAWL_API_KEY`. This endpoint does not call Gemini. Status adds a `firecrawl_configured` boolean, never the secret. Invalid URLs produce 400, empty/non-learning pages 422, missing key 503, rate limits 429 and provider/response failures 502. Credit errors identify the Firecrawl account. It fetches only the provider API from this server and rejects IP-literal/local-name/credential-bearing input URLs; this is syntactic URL checking, not a general network security boundary. Remote retrieval/redirect handling is Firecrawl's responsibility. Keep the server local as described above.
