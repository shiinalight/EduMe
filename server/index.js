import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { importPage } from './firecrawl.js';
import { recognize, HttpError } from './recognition.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function readJson(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > 9 * 1024 * 1024) throw new HttpError(413, 'Request exceeds the 9 MB limit.'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
  catch { throw new HttpError(400, 'Invalid JSON request.'); }
}
export function createApp({ recognizer = recognize, pageImporter = importPage } = {}) {
  let activeRecognition = 0;
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const requestHost = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
      const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)]);
      if (!allowedHosts.has(requestHost)) throw new HttpError(403, 'Host not allowed. For a trusted LAN test, explicitly set ALLOWED_HOSTS.');
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { configured: Boolean(process.env.GEMINI_API_KEY), firecrawl_configured: Boolean(process.env.FIRECRAWL_API_KEY), provider: 'Gemini', model: process.env.GEMINI_MODEL || 'gemini-3.6-flash' });
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
        // Reject cross-origin browser requests; the server is local-only by default.
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
        const isPageImport = url.pathname === '/api/import-url';
        const kind = url.pathname === '/api/recognize' ? 'handwriting' : url.pathname === '/api/worksheet' ? 'worksheet' : null;
        if (!kind && !isPageImport) throw new HttpError(404, 'Unknown endpoint.');
        if (activeRecognition >= 2) throw new HttpError(429, 'Recognition is busy. Please wait for the current request.');
        activeRecognition++;
        try { return json(res, 200, await (isPageImport ? pageImporter(await readJson(req)) : recognizer(kind, await readJson(req)))); }
        finally { activeRecognition--; }
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new HttpError(403, 'Forbidden.');
      let content;
      try { content = await readFile(path); } catch { throw new HttpError(404, 'File not found.'); }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error.' }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => console.log(`InkMath ready at http://${host}:${port}\n${process.env.GEMINI_API_KEY ? 'Live recognition configured.' : 'No API key: example and manual mode available. Add GEMINI_API_KEY to .env for live recognition.'}`));
}
