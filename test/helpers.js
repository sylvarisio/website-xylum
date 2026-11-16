'use strict';
// Shared by the tests: a throwaway site and private folder, the real server on a free
// port, a fake mail transport that records what it is handed, and a plain HTTP client.
// node --test also loads this file; it holds no tests of its own.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createApp, DOOR } = require('../server.js');

const BIG = `<!doctype html><title>x</title>${'<p>words words words</p>\n'.repeat(40)}`;

/** A small site with every trap a request could try to reach. */
function makeSite(root) {
  const site = path.join(root, 'site');
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(site, name)), { recursive: true });
    fs.writeFileSync(path.join(site, name), body);
  };
  write('index.html', BIG);
  write('signup.html', '<!doctype html><title>signup</title>');
  write('styles/site.css', `body{color:#123}\n${'.a{margin:0}\n'.repeat(40)}`);
  write('pic.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  write('README.md', 'not for the public\n');
  write('notes.md', 'a public markdown file\n');
  write('.git/config', '[core]\n');
  write('.env', 'SECRET=1\n');
  // Dot-files a served extension would otherwise let through.
  write('.hidden.txt', 'SECRET=1\n');
  write('.well-known/page.html', 'SECRET=1\n');
  write('api/_private/.ht-requests.jsonl', '{"email":"old@example.com"}\n');
  write('api/v1/signups/public/early-access/index.php', '<?php echo 1;');
  write('api/v1/notes.txt', 'SECRET=1\n');
  write('data.bin', 'unknown kind of file');
  return site;
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xylum-site-test-'));
}

/**
 * The real server on 127.0.0.1 and a free port. `env` is its whole environment (nothing
 * leaks in from the test runner's); `transport` defaults to a recording fake; pass
 * `transport: null` for no transport at all.
 */
async function start(t, options = {}) {
  const root = tempRoot();
  const siteDir = options.siteDir || makeSite(root);
  const privateDir = options.privateDir || path.join(root, 'private');
  if (options.prepare) options.prepare({ root, siteDir, privateDir });
  const sent = [];
  const logs = [];
  const fake = {
    sendMail: async (message) => {
      if (options.failMail) {
        const error = new Error(`550 rejected for ${message.replyTo}`);
        error.code = 'EENVELOPE';
        error.responseCode = 550;
        throw error;
      }
      sent.push(message);
      return { messageId: 'fake' };
    },
  };
  const app = createApp({
    env: options.env || {},
    siteDir,
    privateDir,
    now: options.now,
    log: (line) => logs.push(line),
    transport: options.transport === null ? undefined : options.transport || fake,
    smtpExtra: options.smtpExtra,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close(2000);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const listFile = path.join(privateDir, 'requests.jsonl');
  return {
    app,
    port,
    root,
    siteDir,
    privateDir,
    listFile,
    sent,
    logs,
    request: (opts) => request(port, opts),
    post: (body, opts = {}) => post(port, body, opts),
    lines: () => (fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : '')
      .split('\n')
      .filter(Boolean),
    rows: () => (fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    /** Wait for the mails already handed over to settle. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 30)),
  };
}

/** One HTTP request. `body` is a string or Buffer; `chunks` sends it in pieces with no
 * Content-Length (chunked). */
function request(port, { method = 'GET', path: target = '/', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunks) {
      for (const part of chunks) req.write(part);
      req.end();
    } else {
      req.end(body);
    }
  });
}

function post(port, body, { headers = {}, ...rest } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  return request(port, {
    method: 'POST',
    path: DOOR,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': bytes.length, ...headers },
    body: bytes,
    ...rest,
  });
}

/** A request written byte for byte on a socket, for what http.request refuses to send. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    // Written without closing our side: a half-closed socket is dropped by Node's server
    // before a slow answer is sent. The request's Connection: close ends it instead.
    const socket = net.connect(port, '127.0.0.1', () => socket.write(Buffer.from(text, 'latin1')));
    const parts = [];
    socket.on('data', (part) => parts.push(part));
    socket.on('end', () => resolve(Buffer.concat(parts).toString('latin1')));
    socket.on('error', reject);
  });
}

/** A form body, every value percent-encoded. */
function form(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

const GOOD = { email: 'ada@example.com', name: 'Ada', consent: 'yes', website: '' };

module.exports = { start, request, post, raw, form, makeSite, tempRoot, GOOD, DOOR };
