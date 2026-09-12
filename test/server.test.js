import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server/index.js';

test('HTTP routes, request guards, and static serving', async t => {
  const calls = []; const importCalls = [];
  const server = createApp({ pageImporter: async body => { importCalls.push(body); return { source: 'firecrawl', questions: [] }; }, recognizer: async (kind, body) => { calls.push({ kind, body }); return { ok: true }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(base); assert.equal(home.status, 200); assert.match(await home.text(), /InkMath/); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const status = await (await fetch(base + '/api/status')).json(); assert.equal(status.provider, 'Gemini'); assert(!('apiKey' in status));
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/api/recognize')).status, 405);
  assert.equal((await fetch(base + '/api/recognize', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const deniedHost = await new Promise((resolve, reject) => { const req = http.get(base, { headers: { Host: 'rebind.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(deniedHost, 403);
  assert.equal((await fetch(base + '/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  for (const endpoint of ['recognize', 'worksheet']) {
    const result = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: 'test-image' }) }); assert.equal(result.status, 200);
  }
  assert.deepEqual(calls.map(c => c.kind), ['handwriting', 'worksheet']);
  const imported = await fetch(base + '/api/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.mathsisfun.com' }) });
  assert.equal(imported.status, 200); assert.equal((await imported.json()).source, 'firecrawl');
  assert.deepEqual(importCalls, [{ url: 'https://www.mathsisfun.com' }]);
  assert.equal((await fetch(base + '/api/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal(typeof status.firecrawl_configured, 'boolean');
});
