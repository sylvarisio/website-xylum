'use strict';
// Serving the pages: types, caching, compression, and every way a request might try
// to reach a file that is not part of the public site.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');

const { start, raw, form, GOOD } = require('./helpers.js');
const { CSP } = require('../server.js');

test('/ serves index.html as html with no-cache', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.body.toString(), fs.readFileSync(path.join(s.siteDir, 'index.html'), 'utf8'));
  assert.ok(res.headers.etag);
  assert.ok(res.headers['last-modified']);
});

test('a stylesheet is served as text/css', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/styles/site.css' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
});

test('a picture is kept a day; a query string is ignored', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/pic.png?v=3' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
});

test('HEAD gives the headers and the length but no body', async (t) => {
  const s = await start(t);
  const res = await s.request({ method: 'HEAD', path: '/index.html' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
  assert.equal(Number(res.headers['content-length']), fs.statSync(path.join(s.siteDir, 'index.html')).size);
});

test('an unchanged file is 304 by ETag and by If-Modified-Since', async (t) => {
  const s = await start(t);
  const first = await s.request({ path: '/styles/site.css' });
  const byTag = await s.request({ path: '/styles/site.css', headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(byTag.status, 304);
  assert.equal(byTag.body.length, 0);
  const byDate = await s.request({ path: '/styles/site.css', headers: { 'If-Modified-Since': first.headers['last-modified'] } });
  assert.equal(byDate.status, 304);
  const stale = await s.request({ path: '/styles/site.css', headers: { 'If-None-Match': 'W/"other"' } });
  assert.equal(stale.status, 200);
});

test('text is compressed for a client that asks: brotli first, then gzip', async (t) => {
  const s = await start(t);
  const original = fs.readFileSync(path.join(s.siteDir, 'index.html'));
  const br = await s.request({ path: '/', headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), original);
  const gz = await s.request({ path: '/', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), original);
  const none = await s.request({ path: '/', headers: { 'Accept-Encoding': 'br;q=0, identity' } });
  assert.equal(none.headers['content-encoding'], undefined);
  const png = await s.request({ path: '/pic.png', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(png.headers['content-encoding'], undefined);
});

test('a missing file is a plain 404 with a short fixed body', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/nothing-here.html' });
  assert.equal(res.status, 404);
  assert.equal(res.body.toString(), 'Not found.\n');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
});

test('POST to a page is 405 with Allow: GET, HEAD', async (t) => {
  const s = await start(t);
  const res = await s.request({ method: 'POST', path: '/index.html', body: 'x' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('a folder path other than / and a file of an unknown kind are 404', async (t) => {
  const s = await start(t);
  assert.equal((await s.request({ path: '/styles/' })).status, 404);
  assert.equal((await s.request({ path: '/styles' })).status, 404);
  assert.equal((await s.request({ path: '/data.bin' })).status, 404);
  assert.equal((await s.request({ path: '/index.html/' })).status, 404);
});

test('a markdown file other than README.md is served', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/notes.md' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
});

// --- what must never be reached -------------------------------------------------------

const NEVER = [
  '/..%2f..%2fprivate/requests.jsonl',
  '/..%2F..%2Fprivate%2Frequests.jsonl',
  '/%2e%2e/private/requests.jsonl',
  '/%2e%2e/',
  '/../private/requests.jsonl',
  '/styles/..%5c..%5cprivate%5crequests.jsonl',
  '/.git/config',
  '/.env',
  '/.hidden.txt',
  '/.well-known/page.html',
  '/%2ehidden.txt',
  '/styles/../.hidden.txt',
  '/%2egit/config',
  '/README.md',
  '/readme.MD',
  '/private/requests.jsonl',
  '/api/_private/.ht-requests.jsonl',
  '/api/v1/signups/public/early-access/index.php',
  '/API/v1/signups/public/early-access/index.php',
  '/api/v1/notes.txt',
  '/Api/v1/notes.txt',
  '/index.html%00.png',
  '/%E0%A4%A',
  '/link.html',
];

for (const target of NEVER) {
  test(`${target} is never served`, async (t) => {
    const s = await start(t, {
      prepare: ({ siteDir, privateDir }) => {
        fs.mkdirSync(privateDir, { recursive: true });
        fs.writeFileSync(path.join(privateDir, 'requests.jsonl'), '{"email":"secret@example.com"}\n');
        // A link inside the site that points out of it.
        fs.symlinkSync(path.join(privateDir, 'requests.jsonl'), path.join(siteDir, 'link.html'));
      },
    });
    // Sent as written: no client tidies the dots away first.
    const text = await raw(s.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    const status = Number(text.split(' ')[1]);
    assert.ok(status === 404 || status === 400, `${target}: ${status}`);
    assert.ok(!text.includes('secret@example.com'));
    assert.ok(!text.includes('[core]'));
    assert.ok(!text.includes('SECRET=1'));
    assert.ok(!text.includes('not for the public'));
    assert.ok(!text.includes('old@example.com'));
    assert.ok(!text.includes('<?php'));
  });
}

test('a raw NUL byte in the path is refused', async (t) => {
  const s = await start(t);
  const text = await raw(s.port, 'GET /index.html\0.png HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.match(text, /^HTTP\/1\.1 400 /);
});

test('an over-long address is 414', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: `/${'a'.repeat(3000)}.html` });
  assert.equal(res.status, 414);
});

// --- security headers -----------------------------------------------------------------

function assertSecurityHeaders(res) {
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-frame-options'], 'DENY');
}

test('every security header is on a page, a 404, a 405, a 304, the door redirect and a 413', async (t) => {
  const s = await start(t);
  const page = await s.request({ path: '/' });
  assertSecurityHeaders(page);
  assertSecurityHeaders(await s.request({ path: '/missing.html' }));
  assertSecurityHeaders(await s.request({ method: 'DELETE', path: '/' }));
  assertSecurityHeaders(await s.request({ path: '/', headers: { 'If-None-Match': page.headers.etag } }));
  const door = await s.post(form(GOOD));
  assert.equal(door.status, 303);
  assertSecurityHeaders(door);
  assertSecurityHeaders(await s.post('x'.repeat(5000)));
  assertSecurityHeaders(await s.request({ path: '/healthz' }));
});

/** The status line and headers of a raw answer, as a lower-cased map. */
function rawHead(text) {
  const [head] = text.split('\r\n\r\n');
  const [status, ...lines] = head.split('\r\n');
  const headers = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status, headers };
}

test("Node's own 400 for a request it cannot parse carries the security headers", async (t) => {
  const s = await start(t);
  const answer = rawHead(await raw(s.port, 'NOT A REQUEST\r\n\r\n'));
  assert.equal(answer.status, 'HTTP/1.1 400 Bad Request');
  assertSecurityHeaders({ headers: answer.headers });
  assert.equal(answer.headers['content-length'], '0');
  assert.equal(answer.headers.connection, 'close');
});

test("Node's own 431 for headers that are too big carries the security headers", async (t) => {
  const s = await start(t);
  const answer = rawHead(await raw(s.port, `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`));
  assert.equal(answer.status, 'HTTP/1.1 431 Request Header Fields Too Large');
  assertSecurityHeaders({ headers: answer.headers });
});

test('the CSP is the one the pages were proven against', () => {
  assert.equal(
    CSP,
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
});
