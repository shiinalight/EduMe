# InkMath — handwriting input for an AI tutor

A small, editable tutoring workspace: photo → worksheet JSON; canvas handwriting → plain text + LaTeX → reviewed student-step JSON. The tutor model is deliberately **not implemented**. Your teammate consumes the handoff.

## Start in VS Code or Codex

1. Extract this ZIP and open the `inkmath` folder in VS Code or your coding workspace.
2. Install **Node.js 22 or newer**. There are **no npm dependencies to install**.
3. In the integrated terminal run:

```sh
npm start
```

4. Open `http://localhost:3000` in your browser. Do not open `public/index.html` directly.
5. For auto-restart while editing server code use `npm run dev`. Refresh the browser after frontend edits.

Without an API key, use **Try example → Load example ink → Read my handwriting → review → Confirm & add step → Export tutor JSON**. Only the unchanged sample ink has a fixed, explicitly labeled transcription. Any pen/eraser edit invalidates this fixture and requires real recognition. **Type math instead** works without any API.

## Import a lesson or exercises from a URL (Firecrawl)

1. Sign in to your Firecrawl account. Redeem the organizers' event code using their redemption instructions; the code itself is **not an API key**.
2. Copy your API key from the Firecrawl dashboard and add this line to `.env`:

   ```env
   FIRECRAWL_API_KEY=your_firecrawl_api_key
   ```

3. Restart `npm start`. The sidebar should say **Firecrawl · link import ready**.
4. Click **Import from link**, paste a public lesson/exercise URL, and click **Read page**.
5. Preview the extracted content and select the questions you want. Click **Use selected questions**.
6. Review/edit each question against the original page, then draw with a mouse/stylus or choose **Type math instead**. Export the selected question and confirmed steps as before.

**URL import requires only the Firecrawl key.** Gemini is still required to recognize arbitrary handwriting and worksheet photos. Mouse drawing, manual typing, review, and JSON export do not require Gemini.

Firecrawl's JSON extraction reads a single supplied page and extracts at most 12 existing exercise prompts. It does not crawl the entire website, generate replacement questions, grade work, or provide hints. A lesson or syllabus without exercises is imported as context; **Use lesson & add a question** opens the manual question editor. A page with no learning content reports an error and preserves your current worksheet. Mathematical formatting and missing diagrams must be checked against the source; not every website is supported.

The source URL, import timestamp, lesson context, and question origin survive the tutor JSON export. The page is sent to Firecrawl only when you click **Read page**; no Firecrawl key is exposed to the browser. This prototype intentionally requires a configured key to use your assigned account credits. Missing/invalid keys, unavailable credits, rate limits, timeout, empty extraction and malformed results are reported explicitly; errors never become fake sample content. Requests have no automatic retry that might consume extra credits.

API documentation: https://docs.firecrawl.dev/api-reference/endpoint/scrape and https://docs.firecrawl.dev/features/llm-extract

Validation for this update: 18 automated tests pass, including Firecrawl requests with mocked responses, source-preserving exports, lesson-only handling, URL validation, error handling and existing mouse gestures. **No live Firecrawl account/key test was performed.** The remote test browser blocks localhost, so the new interface still needs a local browser check.

## Enable real handwriting and photo recognition

Copy `.env.example` to `.env` using VS Code's file explorer, then fill in:

```dotenv
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.6-flash
PORT=3000
HOST=127.0.0.1
```

Restart the server. The key is read on the server and is never put into the page, exported JSON, or browser storage. Select a vision + structured-output model available to your key if your account does not support the default. This adapter uses the **Gemini Developer API**, not Vertex AI authentication; Google Cloud/Vertex-only credits are not automatically interchangeable with an AI Studio API key.

The adapter sends a base64 image with a structured-output schema to Gemini's `generateContent` endpoint. See [Google's image-input documentation](https://ai.google.dev/gemini-api/docs/image-understanding), [structured-output documentation](https://ai.google.dev/gemini-api/docs/structured-output), and [REST reference](https://ai.google.dev/api/generate-content).

## How to use your own worksheet

1. Choose or take a photo (PNG, JPG, WebP). HEIC and PDFs are not implemented; export/convert them first.
2. Preview it; crop names and other personal details **before** upload. Choose **Convert worksheet** to send the photo to Gemini. Merely selecting it does not transmit it.
3. Select a detected question. Use **Review / edit question** to check instructions and LaTeX against the original image. Save it as reviewed.
4. Write the next step on the canvas: **hold the left mouse button and drag**, or use a stylus or finger. Mouse input is always available when drawing is enabled. **Ignore finger touch** optionally blocks finger input while keeping mouse and stylus enabled; it is not a guarantee of OS-level palm rejection. The **Draw** and **Eraser** tools both work with a mouse. Select a question first to enable the canvas.
5. Choose **Read my handwriting**. This crops the ink into a clean white PNG and sends it to the recognizer. Recognition is button-triggered, not streaming while you write.
6. Correct any misread symbols in both plain text and LaTeX. Tick the review checkbox and confirm the step. The original model response is retained separately.
7. The canvas clears for the next step. Confirmed steps remain in chronological order. Switching questions keeps each question's ink and steps in this tab.
8. Export JSON for the selected question. Unconfirmed ink is not exported. Export other questions separately. There is no persistence after tab closure, so export before leaving.

## Why JSON _and_ LaTeX?

JSON is the envelope; LaTeX represents the actual math structure. For example, `\\frac{1}{2}` in JSON is the LaTeX fraction `\frac{1}{2}`. Plain text helps a language model read surrounding explanations. Vector ink preserves the original strokes so an integration can redraw the source later.

Transcription is **not mathematical verification**. If a student writes `2 + 2 = 5`, that is exactly what this component is instructed to return. It must not turn it into `2 + 2 = 4`. OCR can still misread or silently alter content, so human review is required. `legibility` is a qualitative model judgment, not a calibrated probability or mastery score.

## File map

| File                                     | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `public/index.html`, `public/styles.css` | Responsive three-panel workspace                           |
| `public/app.js`                          | Upload, question selection, review, history, export        |
| `public/ink.js`                          | Pointer input, pressure, eraser, undo/redo, cropped PNG    |
| `public/contract.js`                     | Pure tutor-payload builder                                 |
| `public/tutor-bridge.js`                 | Your teammate's connection point                           |
| `server/index.js`                        | Local HTTP server and two API routes                       |
| `server/recognition.js`                  | Gemini request, transcription prompts, schemas, validation |
| `INTEGRATION.md`                         | Endpoint and event contracts with examples                 |
| `test/`                                  | Node tests, no API/network credentials needed              |

## Tests

```sh
npm test
```

Automated tests cover image validation, missing-key handling, exact transcription preservation with mocked responses, provider errors, HTTP routes, request guards, ordered JSON, pointer coordinates, cancellation, undo/redo, and erasing. These are not live Gemini accuracy benchmarks. Live recognition needs your own configured key. Real Apple Pencil behavior, camera capture, layout, and accessibility must also be checked on your target browser/device; the build environment's remote browser blocks localhost, so those visual/device checks were unavailable.

Suggested live checks: handwritten fractions, roots, superscripts, negative signs, an intentionally wrong equation, incomplete expressions, a crossed-out line, and an ambiguous `1/l` or `5/S`. Verify each against the source before passing it to the tutor.

## Scope and safety

- This is a **local hackathon prototype**, not a deployed service. No accounts, database, exam planner, hints, grading, or tutor AI are included.
- No automatic remote transmission beyond the requested recognition calls. Source photos are not included in the exported tutor JSON. Stroke coordinates and timestamps are included; strip them with `buildTutorPayload({ ...args, includeInk: false })` if your teammate only needs text.
- Photos/ink are processed by Gemini once you submit them; provider-side retention and billing depend on your account terms. This app does not implement Anymize or certify privacy compliance. Do not test with real children's sensitive data.
- Source images are only in browser memory; the server does not save request bodies or keys to disk and does not log image content.
- Backend binds to loopback, restricts Host/Origin, caps image/request size and concurrent recognition, and returns sanitized errors. It does not include production authentication, per-user quotas, HTTPS termination, or persistent storage. Do not expose it publicly as-is.
- The mathematical content is plain text/LaTeX, not a validated symbolic AST. Diagrams are described in text and may need separate visual context. This is not a full page-layout reconstruction or a formula typesetting editor.

## iPad testing

First test locally on the computer. For a **trusted private LAN only**, intentionally set `HOST=0.0.0.0` and `ALLOWED_HOSTS=YOUR_COMPUTER_LAN_IP`, restart, and open `http://YOUR_COMPUTER_LAN_IP:3000` on the iPad. Do not port-forward this server to the internet. Prefer HTTPS for deployment. The file-picker camera option depends on the device/browser; direct camera streaming is not used. See `INTEGRATION.md` for the secure-context ID fallback.

## Next work for your teammate

Consume the confirmed JSON and implement the tutoring policy separately. Keep `observe_only` distinct from an explicit hint request. Decide whether the reasoning model needs one newest step or all prior steps, and preserve question/session IDs for context. Any model must treat OCR/student text as untrusted input, never higher-priority instructions.
