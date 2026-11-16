'use strict';
// Settings, /healthz, the start-up line, SIGTERM, and that nodemailer is loaded only
// when there is a mailbox to send from.

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { start, makeSite, tempRoot, form, GOOD } = require('./helpers.js');
const { createApp, readSettings, smtpOptions } = require('../server.js');

const SERVER = path.join(__dirname, '..', 'server.js');
const HAS_NODEMAILER = (() => {
  try {
    require.resolve('nodemailer');
    return true;
  } catch {
    return false;
  }
})();

function scratch(t) {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('/healthz: mail off and list writable, with nothing personal', async (t) => {
  const s = await start(t, { transport: null });
  await s.post(form(GOOD));
  const res = await s.request({ path: '/healthz' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, mail: 'off', list: 'writable', forwarded: false, trust_proxy: 0, settings_file: 'none', mail_off_because: 'settings',
  });
  assert.ok(!res.body.toString().includes('ada'));
});

test('/healthz: mail on', async (t) => {
  const s = await start(t);
  assert.deepEqual(JSON.parse((await s.request({ path: '/healthz' })).body), { ok: true, mail: 'on', list: 'writable', forwarded: false, trust_proxy: 0, settings_file: 'none' });
});

test('/healthz: list not writable', async (t) => {
  const s = await start(t, {
    prepare: ({ privateDir }) => fs.mkdirSync(path.join(privateDir, 'requests.jsonl'), { recursive: true }),
  });
  assert.deepEqual(JSON.parse((await s.request({ path: '/healthz' })).body), { ok: true, mail: 'on', list: 'not writable', forwarded: false, trust_proxy: 0, settings_file: 'none' });
});

test('/healthz behind a proxy with TRUST_PROXY at 0 says forwarded and gives the fixed advice', async (t) => {
  const s = await start(t);
  const res = await s.request({ path: '/healthz', headers: { 'X-Forwarded-For': '198.51.100.23' } });
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, mail: 'on', list: 'writable', forwarded: true, trust_proxy: 0, settings_file: 'none', advice: 'set TRUST_PROXY=1',
  });
  // Nothing from the header itself.
  assert.ok(!res.body.toString().includes('198.51.100'));
});

test('/healthz behind a proxy with TRUST_PROXY=1 says forwarded, with no advice', async (t) => {
  const s = await start(t, { env: { TRUST_PROXY: '1' } });
  const res = await s.request({ path: '/healthz', headers: { 'X-Forwarded-For': '198.51.100.23' } });
  assert.deepEqual(JSON.parse(res.body), { ok: true, mail: 'on', list: 'writable', forwarded: true, trust_proxy: 1, settings_file: 'none' });
});

test('a proxied request with TRUST_PROXY at 0 prints one warning, once, with no address', async (t) => {
  const s = await start(t);
  await s.request({ path: '/' });
  assert.equal(s.logs.length, 0);
  await s.request({ path: '/', headers: { 'X-Forwarded-For': '198.51.100.23' } });
  await s.post(form(GOOD), { headers: { 'X-Forwarded-For': '203.0.113.5' } });
  await s.request({ path: '/healthz', headers: { 'X-Forwarded-For': '192.0.2.77' } });
  const warnings = s.logs.filter((line) => line.startsWith('warning:'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TRUST_PROXY is 0.*set TRUST_PROXY=1/);
  assert.ok(!s.logs.join('\n').match(/\d+\.\d+\.\d+\.\d+/));
});

test('with TRUST_PROXY=1 a proxied request prints no warning', async (t) => {
  const s = await start(t, { env: { TRUST_PROXY: '1' } });
  await s.request({ path: '/', headers: { 'X-Forwarded-For': '198.51.100.23' } });
  assert.equal(s.logs.length, 0);
});

test('/healthz answers HEAD and refuses POST', async (t) => {
  const s = await start(t);
  assert.equal((await s.request({ method: 'HEAD', path: '/healthz' })).status, 200);
  assert.equal((await s.request({ method: 'POST', path: '/healthz' })).status, 405);
});

test('settings are read from private/settings.json, and the environment wins over it', (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    MAIL_TO: 'owner@example.com',
    SMTP_USER: 'box@example.com',
    SMTP_PASS: 'from-file',
    SMTP_PORT: 465,
    HOURLY_LIMIT: '7',
  }));
  const { settings, notes } = readSettings({ SMTP_PASS: 'from-env' }, root);
  assert.deepEqual(notes, []);
  assert.equal(settings.mailTo, 'owner@example.com');
  assert.equal(settings.mailFrom, 'hello@xylum.io');
  assert.equal(settings.smtpHost, 'mail.infomaniak.com');
  assert.equal(settings.smtpUser, 'box@example.com');
  assert.equal(settings.smtpPass, 'from-env');
  assert.equal(settings.smtpPort, 465);
  assert.equal(settings.hourlyLimit, 7);
  assert.equal(settings.trustProxy, 0);
  assert.equal(settings.addressLimit, 5);
});

test('ADDRESS_LIMIT is a whole number from 0; a bad one falls back to 5 and says so', (t) => {
  const root = scratch(t);
  assert.equal(readSettings({ ADDRESS_LIMIT: '0' }, root).settings.addressLimit, 0);
  assert.equal(readSettings({ ADDRESS_LIMIT: '40' }, root).settings.addressLimit, 40);
  const bad = readSettings({ ADDRESS_LIMIT: '-1' }, root);
  assert.equal(bad.settings.addressLimit, 5);
  assert.deepEqual(bad.notes, ['ADDRESS_LIMIT must be a whole number from 0 to 100000; using 5']);
});

test('a broken settings.json or a bad value is reported, never fatal', async (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'settings.json'), '{ not json');
  assert.equal(readSettings({}, root).notes.length, 1);
  const bad = readSettings({ HOURLY_LIMIT: 'lots', SMTP_PORT: '99999', MAIL_TO: 'a@b.com, c@d.com' }, root);
  assert.equal(bad.settings.hourlyLimit, 60);
  assert.equal(bad.settings.smtpPort, 587);
  assert.equal(bad.settings.mailTo, null);
  assert.equal(bad.notes.length, 4);
  // What became of the file is one word, for /healthz.
  assert.equal(readSettings({}, root).fileState, 'ignored');
  assert.equal(readSettings({}, scratch(t)).fileState, 'none');
  const good = scratch(t);
  fs.writeFileSync(path.join(good, 'settings.json'), '{"TRUST_PROXY": 1}');
  assert.equal(readSettings({}, good).fileState, 'read');
  // And the server still runs, with mail off, and says in one word why.
  const s = await start(t, { env: { MAIL_TO: 'a@b.com, c@d.com' } });
  const health = JSON.parse((await s.request({ path: '/healthz' })).body);
  assert.equal(health.mail, 'off');
  assert.equal(health.mail_off_because, 'address');
  assert.equal((await s.post(form(GOOD))).headers.location, '/signup.html#joined');
});

test('a private folder inside the served folder is refused at start', (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  assert.throws(() => createApp({ env: {}, siteDir: site, privateDir: path.join(site, 'private') }), /must not hold/);
  assert.throws(() => createApp({ env: {}, siteDir: site, privateDir: root }), /must not hold/);
});

test('a private folder that is a link into the served folder is refused at start', (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  fs.mkdirSync(path.join(site, 'hidden'));
  fs.symlinkSync(path.join(site, 'hidden'), path.join(root, 'private-link'));
  assert.throws(() => createApp({ env: {}, siteDir: site, privateDir: path.join(root, 'private-link') }), /must not hold/);
  // And a folder not made yet, under a link into the site.
  assert.throws(() => createApp({ env: {}, siteDir: site, privateDir: path.join(root, 'private-link', 'deeper') }), /must not hold/);
  assert.ok(!fs.existsSync(path.join(site, 'hidden', 'deeper')));
});

test('on start the private folder is made 0700 and the list and settings.json 0600', (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv, { mode: 0o755 });
  fs.chmodSync(priv, 0o755);
  fs.writeFileSync(path.join(priv, 'requests.jsonl'), '', { mode: 0o644 });
  fs.chmodSync(path.join(priv, 'requests.jsonl'), 0o644);
  fs.writeFileSync(path.join(priv, 'settings.json'), '{}', { mode: 0o644 });
  fs.chmodSync(path.join(priv, 'settings.json'), 0o644);
  const app = createApp({ env: {}, siteDir: site, privateDir: priv });
  assert.deepEqual(app.notes, []);
  assert.equal(fs.statSync(priv).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(priv, 'requests.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(priv, 'settings.json')).mode & 0o777, 0o600);
});

test('a mode that cannot be changed is reported once, never fatal', (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv);
  fs.chmodSync(priv, 0o755);
  fs.writeFileSync(path.join(priv, 'requests.jsonl'), '');
  fs.chmodSync(path.join(priv, 'requests.jsonl'), 0o644);
  // Only the outermost edge is stubbed: the chmod call itself refuses.
  const realChmod = fs.chmodSync;
  fs.chmodSync = () => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  };
  let app;
  try {
    app = createApp({ env: {}, siteDir: site, privateDir: priv });
  } finally {
    fs.chmodSync = realChmod;
  }
  assert.deepEqual(app.notes, ['the private folder or its files could not be made owner-only (EPERM); check their modes']);
});

test('the timeouts are the ones set, and TLS verification of the mail server stays on', (t) => {
  const root = scratch(t);
  const app = createApp({ env: {}, siteDir: makeSite(root), privateDir: path.join(root, 'p') });
  assert.equal(app.server.requestTimeout, 30000);
  assert.equal(app.server.headersTimeout, 20000);
  assert.equal(app.server.keepAliveTimeout, 5000);
  for (const port of [465, 587]) {
    const options = smtpOptions({ smtpHost: 'mail.example.com', smtpUser: 'u', smtpPass: 'p', smtpPort: port });
    assert.notEqual(options.tls.rejectUnauthorized, false);
    assert.equal(options.ignoreTLS, undefined);
  }
});

test('SMTP on 587 must upgrade with STARTTLS; 465 is TLS from the start', () => {
  const base = { smtpHost: 'mail.infomaniak.com', smtpUser: 'u@example.com', smtpPass: 'p' };
  const starttls = smtpOptions({ ...base, smtpPort: 587 });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.tls.minVersion, 'TLSv1.2');
  assert.equal(starttls.disableFileAccess, true);
  assert.equal(starttls.disableUrlAccess, true);
  const implicit = smtpOptions({ ...base, smtpPort: 465 });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
});

test('nodemailer is not loaded without a mailbox, and is with one', { skip: !HAS_NODEMAILER && !process.env.CI && 'nodemailer is not installed' }, (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  const probe = (env) => execFileSync(process.execPath, ['-e', `
    const { createApp } = require(${JSON.stringify(SERVER)});
    const app = createApp({ env: ${JSON.stringify(env)}, siteDir: ${JSON.stringify(site)}, privateDir: ${JSON.stringify(path.join(root, 'p'))} });
    console.log(JSON.stringify({ loaded: Object.keys(require.cache).some((k) => k.includes('nodemailer')), mail: app.mailState }));
  `], { env: { PATH: process.env.PATH } }).toString();
  assert.deepEqual(JSON.parse(probe({})), { loaded: false, mail: 'off (SMTP_USER and SMTP_PASS are not set)' });
  assert.deepEqual(JSON.parse(probe({ SMTP_USER: 'u@example.com', SMTP_PASS: 'p' })), { loaded: true, mail: 'on' });
});

test('the real program starts on PORT, says one line, keeps a request, and closes on SIGTERM', async (t) => {
  const root = scratch(t);
  const site = makeSite(root);
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', SITE_DIR: site, PRIVATE_DIR: path.join(root, 'private') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (part) => { out += part; });
  child.stderr.on('data', (part) => { out += part; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start-up line: ${out}`)), 5000);
    child.stdout.on('data', () => {
      const found = /port (\d+),/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve(Number(found[1]));
      }
    });
  });
  assert.match(out, /^xylum site: port \d+, serving .+, mail off \(SMTP_USER and SMTP_PASS are not set\), list writable \(/);
  assert.equal(out.trim().split('\n').length, 1);
  const { post, request } = require('./helpers.js');
  assert.equal((await post(port, form(GOOD))).headers.location, '/signup.html#joined');
  assert.equal((await request(port, { path: '/' })).status, 200);
  const code = await new Promise((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode));
    child.kill('SIGTERM');
  });
  assert.equal(code, 0);
  assert.match(out, /SIGTERM: closing\nclosed\n$/);
  assert.equal(fs.readFileSync(path.join(root, 'private', 'requests.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
});

test('an unexpected error is a plain 500 with no stack trace and no detail', async (t) => {
  const s = await start(t);
  // A realpath that answers nonsense makes the path check throw a TypeError the server
  // did not plan for: the catch-all must answer, and say nothing about it.
  const original = fs.promises.realpath;
  fs.promises.realpath = async () => ({ not: 'a path at /secret/place' });
  let res;
  try {
    res = await s.request({ path: '/index.html' });
  } finally {
    fs.promises.realpath = original;
  }
  assert.equal(res.status, 500);
  assert.equal(res.body.toString(), 'Something went wrong.\n');
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.headers.etag, undefined);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  // And the server goes on serving.
  assert.equal((await s.request({ path: '/index.html' })).status, 200);
});
