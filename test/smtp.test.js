'use strict';
// One real SMTP conversation: the real nodemailer against a throwaway SMTP sink on
// 127.0.0.1, so the message the owner receives is checked as bytes on the wire. The
// sink offers no STARTTLS, so this run turns TLS off through the test-only smtpExtra
// option; settings.json and the environment cannot do that.

const assert = require('node:assert/strict');
const net = require('node:net');
const { test } = require('node:test');

const { start, form, GOOD } = require('./helpers.js');
const { CONSENT_TEXT } = require('../server.js');

let installed = true;
try {
  require.resolve('nodemailer');
} catch {
  installed = false;
}

/** A minimal SMTP server that accepts one AUTH PLAIN login and records each message. */
function sink() {
  const got = { auth: [], from: [], to: [], data: [] };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (part) => {
      buffer += part.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          // The CRLF before the dot ends the message's last line; it is part of the message.
          got.data.push(buffer.slice(0, end + 2));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 kept\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(' ', 1)[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') {
          got.auth.push(Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8').split('\0'));
          socket.write('235 2.7.0 ok\r\n');
        } else if (verb === 'MAIL') {
          got.from.push(line);
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          got.to.push(line);
          socket.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go on\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 ok\r\n');
        else socket.write('502 5.5.1 not supported here\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })));
}

test('a real SMTP exchange: login, envelope and the message as nodemailer builds it', {
  skip: !installed && !process.env.CI && 'nodemailer is not installed (npm install)',
}, async (t) => {
  const smtp = await sink();
  t.after(() => smtp.server.close());
  const s = await start(t, {
    transport: null,
    env: { SMTP_USER: 'hello@xylum.io', SMTP_PASS: 'not-a-real-password', MAIL_TO: 'owner@example.com' },
    smtpExtra: { host: '127.0.0.1', port: smtp.port, secure: false, requireTLS: false, ignoreTLS: true },
    now: () => Date.parse('2026-11-16T10:15:30Z'),
  });
  assert.equal(s.app.mailState, 'on');
  const res = await s.post(form({ ...GOOD, name: 'Zoë Ørsted' }));
  assert.equal(res.headers.location, '/signup.html#joined');
  for (let n = 0; n < 100 && smtp.got.data.length === 0; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(smtp.got.data.length, 1, s.logs.join('\n'));
  assert.deepEqual(smtp.got.auth, [['', 'hello@xylum.io', 'not-a-real-password']]);
  assert.deepEqual(smtp.got.from, ['MAIL FROM:<hello@xylum.io>']);
  assert.deepEqual(smtp.got.to, ['RCPT TO:<owner@example.com>']);
  const message = Buffer.from(smtp.got.data[0], 'latin1').toString('utf8');
  t.diagnostic(`--- the message as sent ---\n${message}\n--- end ---`);
  const [head, ...rest] = message.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  assert.match(head, /^From: Xylum website <hello@xylum\.io>$/m);
  assert.match(head, /^To: owner@example\.com$/m);
  assert.match(head, /^Reply-To: ada@example\.com$/m);
  assert.match(head, /^Subject: Xylum invitation request: ada@example\.com$/m);
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.doesNotMatch(head, /^(Cc|Bcc):/im);
  // The body may be quoted-printable for the ë; decode it the simple way.
  const decoded = /^Content-Transfer-Encoding: quoted-printable$/m.test(head)
    ? Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')
    : body;
  assert.equal(decoded.replace(/\r\n/g, '\n'), [
    'time: 2026-11-16T10:15:30Z',
    'email: ada@example.com',
    'name: Zoë Ørsted',
    `consent: ${CONSENT_TEXT}`,
    'list: early-access',
    '',
  ].join('\n'));
  assert.deepEqual(s.logs, []);
});

test('with the real settings, a server that offers no STARTTLS never sees the password', {
  skip: !installed && !process.env.CI && 'nodemailer is not installed (npm install)',
}, async (t) => {
  const smtp = await sink();
  t.after(() => smtp.server.close());
  const s = await start(t, {
    transport: null,
    env: { SMTP_USER: 'hello@xylum.io', SMTP_PASS: 'not-a-real-password', SMTP_PORT: '587' },
    // Only where to connect is changed: requireTLS and the rest are the real options.
    smtpExtra: { host: '127.0.0.1', port: smtp.port },
  });
  const res = await s.post(form(GOOD));
  assert.equal(res.headers.location, '/signup.html#joined');
  for (let n = 0; n < 100 && s.logs.length === 0; n += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /^mail failed: [A-Z]+/);
  t.diagnostic(s.logs[0]);
  assert.ok(!s.logs[0].includes('ada@'));
  assert.deepEqual(smtp.got.auth, []);
  assert.deepEqual(smtp.got.data, []);
  assert.equal(s.lines().length, 1);
});
