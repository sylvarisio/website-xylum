'use strict';
// The invitation door: every case the PHP door was tested against, and the
// per-address brake. Each test runs the real server with a fake mail transport.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const { start, form, tempRoot, GOOD } = require('./helpers.js');
const { CONSENT_TEXT } = require('../server.js');

const answer = (res) => res.headers.location;
const JOINED = '/signup.html#joined';
const CHECK = '/signup.html#check-details';
const LATER = '/signup.html#try-later';

test('a good request is kept as one line of five facts, mailed once, and answered joined', async (t) => {
  const s = await start(t, { now: () => Date.parse('2026-11-16T10:15:30.500Z') });
  const res = await s.post(form({ ...GOOD, email: '  Ada@Example.COM ', name: '  Ada Lovelace ' }));
  assert.equal(res.status, 303);
  assert.equal(answer(res), JOINED);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.length, 0);
  assert.deepEqual(s.rows(), [{
    time: '2026-11-16T10:15:30Z',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    consent: CONSENT_TEXT,
    list: 'early-access',
  }]);
  await s.settle();
  assert.equal(s.sent.length, 1);
  const mail = s.sent[0];
  assert.equal(mail.subject, 'Xylum invitation request: ada@example.com');
  assert.equal(mail.replyTo, 'ada@example.com');
  assert.deepEqual(mail.from, { name: 'Xylum website', address: 'hello@xylum.io' });
  assert.equal(mail.to, 'hello@xylum.io');
  assert.equal(mail.text, [
    'time: 2026-11-16T10:15:30Z',
    'email: ada@example.com',
    'name: Ada Lovelace',
    `consent: ${CONSENT_TEXT}`,
    'list: early-access',
    '',
  ].join('\n'));
  const mode = fs.statSync(s.listFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the door answers with and without its trailing slash', async (t) => {
  const s = await start(t);
  const res = await s.post(form(GOOD), { path: '/api/v1/signups/public/early-access' });
  assert.equal(answer(res), JOINED);
  assert.equal(s.lines().length, 1);
});

test('the same address again, in another case, is joined with no second line or mail', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form(GOOD))), JOINED);
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'ADA@example.com', name: 'Someone else' }))), JOINED);
  await s.settle();
  assert.equal(s.lines().length, 1);
  assert.equal(s.sent.length, 1);
});

for (const [label, email] of [
  ['no at sign', 'not-an-address'],
  ['two addresses', 'a@example.com,b@example.com'],
  ['a display name', 'Ada <ada@example.com>'],
  ['no dot in the domain', 'ada@localhost'],
  ['an IP literal', 'ada@[127.0.0.1]'],
  ['a space inside', 'ada lovelace@example.com'],
  ['too long', `${'a'.repeat(250)}@example.com`],
  ['empty', ''],
]) {
  test(`a bad email (${label}) is check-details and kept nowhere`, async (t) => {
    const s = await start(t);
    const res = await s.post(form({ ...GOOD, email }));
    assert.equal(answer(res), CHECK);
    await s.settle();
    assert.equal(s.lines().length, 0);
    assert.equal(s.sent.length, 0);
  });
}

test('missing consent is check-details', async (t) => {
  const s = await start(t);
  const { consent, ...rest } = GOOD;
  assert.equal(consent, 'yes');
  assert.equal(answer(await s.post(form(rest))), CHECK);
  assert.equal(s.lines().length, 0);
});

test('consent=on (a checkbox with no value) is check-details, only yes counts', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form({ ...GOOD, consent: 'on' }))), CHECK);
  assert.equal(answer(await s.post(form({ ...GOOD, consent: 'YES' }))), CHECK);
  assert.equal(s.lines().length, 0);
});

test('a filled honeypot is answered joined and nothing is kept or sent', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form({ ...GOOD, website: 'http://spam.example' }))), JOINED);
  await s.settle();
  assert.equal(s.lines().length, 0);
  assert.equal(s.sent.length, 0);
});

test('a honeypot holding bytes that are not UTF-8 counts as filled', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(`${form(GOOD)}&website=%FF`)), JOINED);
  assert.equal(s.lines().length, 0);
});

test('a raw body that is not UTF-8 at all is check-details', async (t) => {
  const s = await start(t);
  const body = Buffer.concat([Buffer.from(`${form(GOOD)}&website=`), Buffer.from([0xff])]);
  assert.equal(answer(await s.post(body)), CHECK);
  assert.equal(s.lines().length, 0);
});

test('a honeypot of whitespace only is empty, as the app strips it, and the request is kept', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form({ ...GOOD, website: ' \t\r\n 　' }))), JOINED);
  assert.equal(s.lines().length, 1);
});

for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
  test(`${method} on the door is 405 with Allow: POST`, async (t) => {
    const s = await start(t);
    const res = await s.request({ method, path: '/api/v1/signups/public/early-access/' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(res.headers['cache-control'], 'no-store');
  });
}

test('JSON is 415 and kept nowhere', async (t) => {
  const s = await start(t);
  const res = await s.post(JSON.stringify({ email: 'ada@example.com', consent: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 415);
  assert.equal(res.headers['content-type'], 'application/problem+json');
  assert.ok(!res.body.toString().includes('ada@example.com'));
  assert.equal(s.lines().length, 0);
});

test('multipart is 415', async (t) => {
  const s = await start(t);
  const body = '--b\r\nContent-Disposition: form-data; name="email"\r\n\r\nada@example.com\r\n--b--\r\n';
  const res = await s.post(body, { headers: { 'Content-Type': 'multipart/form-data; boundary=b' } });
  assert.equal(res.status, 415);
  assert.equal(s.lines().length, 0);
});

test('a form post with a charset parameter is still a form post', async (t) => {
  const s = await start(t);
  const res = await s.post(form(GOOD), { headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' } });
  assert.equal(answer(res), JOINED);
});

/** A good form padded with an ignored field to exactly `size` bytes. */
function padded(size) {
  const base = `${form(GOOD)}&pad=`;
  return base + 'x'.repeat(size - base.length);
}

test('exactly 4096 bytes is read', async (t) => {
  const s = await start(t);
  const body = padded(4096);
  assert.equal(body.length, 4096);
  assert.equal(answer(await s.post(body)), JOINED);
  assert.equal(s.lines().length, 1);
});

test('4097 bytes is 413, by its Content-Length, and kept nowhere', async (t) => {
  const s = await start(t);
  const res = await s.post(padded(4097));
  assert.equal(res.status, 413);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(s.lines().length, 0);
});

test('a chunked body with no length is counted while it is read: 5000 bytes is 413', async (t) => {
  const s = await start(t);
  const body = padded(5000);
  const res = await s.request({
    method: 'POST',
    path: '/api/v1/signups/public/early-access/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    chunks: [body.slice(0, 2000), body.slice(2000, 4000), body.slice(4000)],
  });
  assert.equal(res.status, 413);
  assert.equal(s.lines().length, 0);
});

test('a small chunked body with no length is read', async (t) => {
  const s = await start(t);
  const body = form(GOOD);
  const res = await s.request({
    method: 'POST',
    path: '/api/v1/signups/public/early-access/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    chunks: [body.slice(0, 10), body.slice(10)],
  });
  assert.equal(answer(res), JOINED);
});

for (const field of ['email', 'name', 'consent']) {
  test(`CR/LF and a header in ${field} are refused, and nothing reaches a mail`, async (t) => {
    const s = await start(t);
    const res = await s.post(form({ ...GOOD, [field]: `${GOOD[field]}\r\nBcc: victim@example.com` }));
    assert.equal(answer(res), CHECK);
    assert.equal(res.headers.location.includes('victim'), false);
    await s.settle();
    assert.equal(s.lines().length, 0);
    assert.equal(s.sent.length, 0);
  });
}

test('CR/LF and a header in the honeypot make it a bot: joined, nothing kept', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form({ ...GOOD, website: '\r\nBcc: victim@example.com' }))), JOINED);
  await s.settle();
  assert.equal(s.lines().length, 0);
  assert.equal(s.sent.length, 0);
});

test('a lone LF, a tab and a zero-width space in a name are refused', async (t) => {
  const s = await start(t);
  for (const name of ['Ada\nLovelace', 'Ada\tLovelace', 'Ada​Lovelace', 'Ada\u2028Lovelace']) {
    assert.equal(answer(await s.post(form({ ...GOOD, name }))), CHECK, JSON.stringify(name));
  }
  assert.equal(s.lines().length, 0);
});

test('a name of 120 characters is kept, 121 is check-details', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(form({ ...GOOD, name: 'n'.repeat(121) }))), CHECK);
  assert.equal(answer(await s.post(form({ ...GOOD, name: 'é'.repeat(120) }))), JOINED);
  assert.equal(s.rows()[0].name, 'é'.repeat(120));
});

test('a name of %FF (not UTF-8) is check-details', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post(`email=ada%40example.com&consent=yes&name=%FF`)), CHECK);
  assert.equal(s.lines().length, 0);
});

test('email[] is not the email field', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post('email[]=ada%40example.com&consent=yes')), CHECK);
  assert.equal(s.lines().length, 0);
});

test('the last value of a field wins', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post('email=first%40example.com&consent=no&consent=yes&email=last%40example.com')), JOINED);
  assert.equal(s.rows()[0].email, 'last@example.com');
});

test('no name at all is kept as an empty name', async (t) => {
  const s = await start(t);
  assert.equal(answer(await s.post('email=ada%40example.com&consent=yes')), JOINED);
  assert.equal(s.rows()[0].name, '');
});

test('a unicode name is kept and mailed as it was written', async (t) => {
  const s = await start(t);
  const name = 'Zoë 山田 Ørsted';
  assert.equal(answer(await s.post(form({ ...GOOD, name }))), JOINED);
  assert.equal(s.rows()[0].name, name);
  await s.settle();
  assert.ok(s.sent[0].text.includes(`name: ${name}\n`));
});

test('the global hourly limit says try-later with the wait to the next hour, then resets', async (t) => {
  let clock = Date.parse('2026-11-16T10:15:00Z');
  const s = await start(t, { env: { HOURLY_LIMIT: '3' }, now: () => clock });
  for (const n of [1, 2, 3]) {
    assert.equal(answer(await s.post(form({ ...GOOD, email: `p${n}@example.com` }))), JOINED);
  }
  const over = await s.post(form({ ...GOOD, email: 'p4@example.com' }));
  assert.equal(answer(over), LATER);
  assert.equal(over.headers['retry-after'], '2700');
  assert.equal(s.lines().length, 3);
  clock = Date.parse('2026-11-16T11:00:01Z');
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'p4@example.com' }))), JOINED);
  assert.equal(s.lines().length, 4);
  await s.settle();
  assert.equal(s.sent.length, 4);
});

test('the hourly limit is counted from the list itself, so it holds across a restart', async (t) => {
  const clock = () => Date.parse('2026-11-16T10:15:00Z');
  const s = await start(t, {
    env: { HOURLY_LIMIT: '2' },
    now: clock,
    prepare: ({ privateDir }) => {
      fs.mkdirSync(privateDir, { recursive: true });
      const old = (n) => JSON.stringify({ time: '2026-11-16T10:0' + n + ':00Z', email: `old${n}@example.com`, name: '', consent: CONSENT_TEXT, list: 'early-access' });
      fs.writeFileSync(path.join(privateDir, 'requests.jsonl'), `${old(1)}\n${old(2)}\n`);
    },
  });
  assert.equal(answer(await s.post(form(GOOD))), LATER);
});

test('an unwritable private folder is try-later and no mail', async (t) => {
  // A folder under a plain file can never be made, even by root (CI runs as root).
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'blocker'), 'x');
  const s = await start(t, { privateDir: path.join(root, 'blocker', 'private') });
  const res = await s.post(form(GOOD));
  assert.equal(answer(res), LATER);
  assert.equal(res.headers['retry-after'], '600');
  await s.settle();
  assert.equal(s.sent.length, 0);
});

test('a list that cannot be written (a folder in its place) is try-later and no mail', async (t) => {
  const s = await start(t, {
    prepare: ({ privateDir }) => fs.mkdirSync(path.join(privateDir, 'requests.jsonl'), { recursive: true }),
  });
  const res = await s.post(form(GOOD));
  assert.equal(answer(res), LATER);
  await s.settle();
  assert.equal(s.sent.length, 0);
});

// The list is the gate: the read succeeds and only the WRITE fails. The one thing stubbed
// is the file handle's write, the outermost edge; the real List.append runs around it.
const OLD_LINE = () => JSON.stringify({ time: '2026-11-16T09:00:00Z', email: 'old@example.com', name: '', consent: CONSENT_TEXT, list: 'early-access' });

function shortWrites(t, listFile) {
  const realOpen = fsp.open;
  fsp.open = async (target, ...rest) => {
    const handle = await realOpen(target, ...rest);
    if (path.resolve(String(target)) === listFile) {
      const realWrite = handle.write.bind(handle);
      // Half the line reaches the disk, then the disk is full.
      handle.write = async (buffer, offset, length) => {
        const half = Math.floor(length / 2);
        await realWrite(buffer, offset, half);
        return { bytesWritten: half, buffer };
      };
    }
    return handle;
  };
  t.after(() => {
    fsp.open = realOpen;
  });
}

test('a write that stops short after a good read is try-later, no mail, and the list keeps whole lines', async (t) => {
  const s = await start(t, {
    prepare: ({ privateDir }) => {
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'requests.jsonl'), `${OLD_LINE()}\n`);
    },
  });
  shortWrites(t, s.listFile);
  const res = await s.post(form(GOOD));
  assert.equal(answer(res), LATER);
  assert.equal(res.headers['retry-after'], '600');
  await s.settle();
  assert.equal(s.sent.length, 0);
  const text = fs.readFileSync(s.listFile, 'utf8');
  assert.equal(text, `${OLD_LINE()}\n`);
  assert.ok(text.endsWith('\n'));
});

test('a list file the program may read but not write is try-later and no mail', {
  skip: process.getuid && process.getuid() === 0 && 'root writes through a read-only mode',
}, async (t) => {
  const s = await start(t, {
    prepare: ({ privateDir }) => {
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'requests.jsonl'), `${OLD_LINE()}\n`);
    },
  });
  fs.chmodSync(s.listFile, 0o400);
  const res = await s.post(form(GOOD));
  assert.equal(answer(res), LATER);
  await s.settle();
  assert.equal(s.sent.length, 0);
  assert.equal(fs.readFileSync(s.listFile, 'utf8'), `${OLD_LINE()}\n`);
});

test('a mail that fails still answers joined, keeps the line, and logs only the code', async (t) => {
  const s = await start(t, { failMail: true });
  assert.equal(answer(await s.post(form(GOOD))), JOINED);
  await s.settle();
  assert.equal(s.lines().length, 1);
  assert.deepEqual(s.logs, ['mail failed: EENVELOPE 550']);
  assert.ok(!s.logs.join('\n').includes('ada@'));
});

test('a half line left by a stopped write is skipped, and the next line starts fresh', async (t) => {
  const whole = JSON.stringify({ time: '2026-11-15T09:00:00Z', email: 'old@example.com', name: '', consent: CONSENT_TEXT, list: 'early-access' });
  const s = await start(t, {
    prepare: ({ privateDir }) => {
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'requests.jsonl'), `${whole}\n{"time":"2026-11-15T09:0`);
    },
  });
  assert.equal(answer(await s.post(form(GOOD))), JOINED);
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'old@example.com' }))), JOINED);
  const lines = s.lines();
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '{"time":"2026-11-15T09:0');
  assert.equal(JSON.parse(lines[2]).email, 'ada@example.com');
  await s.settle();
  assert.equal(s.sent.length, 1);
});

test('50 posts at once each get exactly one whole line and one mail', async (t) => {
  const s = await start(t, { env: { TRUST_PROXY: '1' } });
  const results = await Promise.all(Array.from({ length: 50 }, (_, n) => s.post(
    form({ ...GOOD, email: `p${n}@example.com` }),
    { headers: { 'X-Forwarded-For': `10.0.${Math.floor(n / 200)}.${n + 1}` } },
  )));
  assert.ok(results.every((res) => answer(res) === JOINED));
  const rows = s.rows();
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map((row) => row.email)).size, 50);
  await s.settle();
  assert.equal(s.sent.length, 50);
});

test('the same address 50 times at once is one line and one mail', async (t) => {
  const s = await start(t, { env: { TRUST_PROXY: '1' } });
  const results = await Promise.all(Array.from({ length: 50 }, (_, n) => s.post(
    form(GOOD),
    { headers: { 'X-Forwarded-For': `10.1.0.${n + 1}` } },
  )));
  assert.ok(results.every((res) => answer(res) === JOINED));
  assert.equal(s.lines().length, 1);
  await s.settle();
  assert.equal(s.sent.length, 1);
});

// --- the per-address brake ------------------------------------------------------------

test('a sixth request in an hour from one address is try-later, kept nowhere', async (t) => {
  let clock = Date.parse('2026-11-16T10:00:00Z');
  const s = await start(t, { now: () => clock });
  for (let n = 0; n < 5; n += 1) {
    clock += 1000;
    assert.equal(answer(await s.post(form({ ...GOOD, email: `p${n}@example.com` }))), JOINED);
  }
  clock += 1000;
  const sixth = await s.post(form({ ...GOOD, email: 'p5@example.com' }));
  assert.equal(answer(sixth), LATER);
  // The first of the five falls out of the hour 3594 seconds from now.
  assert.equal(sixth.headers['retry-after'], '3595');
  assert.equal(s.lines().length, 5);
  clock = Date.parse('2026-11-16T11:00:01.500Z');
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'p5@example.com' }))), JOINED);
});

test('every post counts toward the brake, even a refused one', async (t) => {
  const s = await start(t);
  for (let n = 0; n < 5; n += 1) {
    assert.equal(answer(await s.post(form({ ...GOOD, consent: 'no' }))), CHECK);
  }
  assert.equal(answer(await s.post(form(GOOD))), LATER);
});

test('over the brake, a post that is not a form gets 429 with Retry-After', async (t) => {
  const s = await start(t);
  for (let n = 0; n < 5; n += 1) await s.post(form({ ...GOOD, email: `p${n}@example.com` }));
  const res = await s.post('{}', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers['retry-after']) > 0);
});

test('with TRUST_PROXY off, a forged X-Forwarded-For changes nothing', async (t) => {
  const s = await start(t);
  for (let n = 0; n < 5; n += 1) {
    await s.post(form({ ...GOOD, email: `p${n}@example.com` }), { headers: { 'X-Forwarded-For': `203.0.113.${n}` } });
  }
  const res = await s.post(form({ ...GOOD, email: 'p9@example.com' }), { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(answer(res), LATER);
});

test('with TRUST_PROXY=1, another address passes, and only the rightmost entry counts', async (t) => {
  const s = await start(t, { env: { TRUST_PROXY: '1' } });
  for (let n = 0; n < 5; n += 1) {
    await s.post(form({ ...GOOD, email: `p${n}@example.com` }), { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  }
  const again = await s.post(form({ ...GOOD, email: 'p6@example.com' }), { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  assert.equal(answer(again), LATER);
  // A forged entry on the left is ignored: the proxy's own entry is on the right.
  const forged = await s.post(form({ ...GOOD, email: 'p7@example.com' }), { headers: { 'X-Forwarded-For': '198.51.100.9, 192.0.2.1' } });
  assert.equal(answer(forged), LATER);
  const other = await s.post(form({ ...GOOD, email: 'p8@example.com' }), { headers: { 'X-Forwarded-For': '192.0.2.2' } });
  assert.equal(answer(other), JOINED);
});

test('ADDRESS_LIMIT=2 makes the third request from one address try-later', async (t) => {
  const s = await start(t, { env: { ADDRESS_LIMIT: '2' } });
  for (let n = 0; n < 2; n += 1) {
    assert.equal(answer(await s.post(form({ ...GOOD, email: `p${n}@example.com` }))), JOINED);
  }
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'p2@example.com' }))), LATER);
});

test('ADDRESS_LIMIT=0 switches the per-address brake off and leaves the hourly limit', async (t) => {
  const s = await start(t, { env: { ADDRESS_LIMIT: '0', HOURLY_LIMIT: '8' } });
  // Ten refused tries from one address: none is stopped by the brake.
  for (let n = 0; n < 10; n += 1) {
    assert.equal(answer(await s.post(form({ ...GOOD, consent: 'no' }))), CHECK);
  }
  for (let n = 0; n < 8; n += 1) {
    assert.equal(answer(await s.post(form({ ...GOOD, email: `p${n}@example.com` }))), JOINED);
  }
  assert.equal(answer(await s.post(form({ ...GOOD, email: 'p8@example.com' }))), LATER);
  assert.equal(s.lines().length, 8);
});

test('the brake writes nothing to disk: the private folder holds only the list', async (t) => {
  const s = await start(t);
  for (let n = 0; n < 7; n += 1) await s.post(form({ ...GOOD, email: `p${n}@example.com` }));
  assert.deepEqual(fs.readdirSync(s.privateDir), ['requests.jsonl']);
  assert.ok(!fs.readFileSync(s.listFile, 'utf8').includes('127.0.0.1'));
});
