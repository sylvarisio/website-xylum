'use strict';
/*
 * The Xylum website as one small Node.js program.
 *
 * It does two jobs:
 *   1. It serves the website's pages, pictures and styles (the folder SITE_DIR).
 *   2. It answers the invitation form on signup.html, which posts to
 *      /api/v1/signups/public/early-access/. A good request is written as one line to a
 *      private list (PRIVATE_DIR/requests.jsonl), and only once it is written is the
 *      owner sent one mail about it.
 *
 * The form's address is the hosted Xylum app's own (backend/xylum/signups/api.py,
 * PublicSignupView), and this door answers the way that one does: a 303 back to
 * /signup.html with #joined, #check-details or #try-later. When the app is hosted, that
 * one path is routed to it and this door is retired; the pages do not change.
 *
 * The list is the gate. No line written means not joined: the answer is try-later and no
 * mail goes out. The mail is only the notice.
 *
 * Nothing about a person is written anywhere except the five facts of the list (time,
 * email, name, the consent sentence, the list's name). The per-address flood brake holds
 * the asker's network address in MEMORY for at most an hour and never writes it down.
 *
 * Needs Node.js 20 or newer. The only package is nodemailer, and it is loaded only when
 * SMTP_USER and SMTP_PASS are set. Tests: test/ (node --test). README.md says how to
 * host it.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');

// --- fixed: the app's door says the same ---------------------------------------------

const DOOR = '/api/v1/signups/public/early-access/';
const RETURN_PAGE = '/signup.html';
const LIST_SLUG = 'early-access';
// MAX_PUBLIC_SIGNUP_BYTES (backend/xylum/signups/api.py)
const MAX_BYTES = 4096;
// DEFAULT_CONSENT_TEXT, byte for byte (backend/xylum/signups/models.py). Pinned by
// backend/xylum/signups/tests/test_site_server.py.
const CONSENT_TEXT = 'Yes, email me when Xylum early access opens. Keep my address and name for that alone, and remove them when I ask.';
const JOINED = '#joined';
const CHECK = '#check-details';
const LATER = '#try-later';
// NAME_MAX (backend/xylum/signups/models.py)
const NAME_MAX = 120;
// The app's `signup` throttle: 5 an hour from one client address (settings/base.py).
// The default of the ADDRESS_LIMIT setting; 0 switches the per-address brake off.
const ADDRESS_LIMIT = 5;
const HOUR_MS = 3600 * 1000;
// The brake's table never holds more addresses than this.
const ADDRESS_TABLE_MAX = 10000;
const MAX_URL = 2048;
const LIST_FILE = 'requests.jsonl';
// How long Node waits for a whole request, for its headers, and on an idle kept-alive
// connection. Pinned by test/process.test.js.
const REQUEST_TIMEOUT_MS = 30000;
const HEADERS_TIMEOUT_MS = 20000;
const KEEP_ALIVE_TIMEOUT_MS = 5000;
const SETTINGS_FILE = 'settings.json';
const FORM = 'application/x-www-form-urlencoded';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// The only kinds of file served. Anything else is a 404.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
// Text is compressed on the way out; pictures and fonts already are.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.txt', '.xml', '.md']);
// Pages, styles and the script change together on a deploy, and their names carry no
// version, so a browser asks again each time (a 304 when nothing changed). Pictures and
// fonts are kept for a day.
const REVALIDATE = new Set(['.html', '.css', '.js', '.txt', '.xml', '.md']);

// Python's str.strip(): the characters str.isspace() calls whitespace.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');
// xylum.core.mail.is_bare_address
const ONE_ADDRESS = /^[^\s<>,;"\x00-\x1f\x7f\x85]+@[^\s<>,;"\x00-\x1f\x7f\x85]+$/u;
// django.core.validators.EmailValidator, ASCII only.
const EMAIL_USER = /^[-!#$%&'*+/=?^_`{}|~0-9A-Z]+(?:\.[-!#$%&'*+/=?^_`{}|~0-9A-Z]+)*$/i;
const EMAIL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.(?!-)(?:[a-z-]{2,63}|xn--[a-z0-9]{1,59})(?<!-)$/i;
// The app's _INVISIBLE set: control, format, surrogate, private-use, unassigned, and the
// line and paragraph separators. CR and LF are in it.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const INVALID = Symbol('not UTF-8');

// --- settings ---------------------------------------------------------------------------

/**
 * Every setting, from the environment first and then from PRIVATE_DIR/settings.json.
 * A setting that is missing or wrong never stops the server: it falls back and says so.
 */
function readSettings(env, privateDir) {
  const notes = [];
  let file = {};
  // What became of the file, for /healthz: 'read', 'none' (there is no file) or 'ignored'
  // (it is there and could not be used). One word, and nothing from inside the file.
  let fileState = 'none';
  const where = path.join(privateDir, SETTINGS_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(where, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      file = parsed;
      fileState = 'read';
    } else {
      fileState = 'ignored';
      notes.push(`${SETTINGS_FILE} is not one JSON object; it was ignored`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fileState = 'ignored';
      notes.push(`${SETTINGS_FILE} could not be read (${error.code || 'not valid JSON'}); it was ignored`);
    }
  }
  const pick = (key, fallback) => {
    if (env[key] !== undefined && env[key] !== '') return String(env[key]);
    const value = file[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
    return fallback;
  };
  const whole = (key, fallback, low, high) => {
    const text = pick(key, String(fallback));
    const value = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
    if (Number.isInteger(value) && value >= low && value <= high) return value;
    notes.push(`${key} must be a whole number from ${low} to ${high}; using ${fallback}`);
    return fallback;
  };
  const address = (key) => {
    const value = pick(key, 'hello@xylum.io');
    if (cleanEmail(value) === value.toLowerCase()) return value;
    notes.push(`${key} is not one plain email address; mail is off`);
    return null;
  };
  const settings = {
    mailTo: address('MAIL_TO'),
    mailFrom: address('MAIL_FROM'),
    smtpHost: pick('SMTP_HOST', 'mail.infomaniak.com'),
    smtpPort: whole('SMTP_PORT', 587, 1, 65535),
    smtpUser: pick('SMTP_USER', ''),
    smtpPass: pick('SMTP_PASS', ''),
    hourlyLimit: whole('HOURLY_LIMIT', 60, 1, 100000),
    trustProxy: whole('TRUST_PROXY', 0, 0, 10),
    addressLimit: whole('ADDRESS_LIMIT', ADDRESS_LIMIT, 0, 100000),
  };
  return { settings, notes, fileState };
}

/** The nodemailer transport options. Port 465 is TLS from the start; any other port
 * must upgrade with STARTTLS before the password is sent, or the mail is not sent. */
function smtpOptions(settings) {
  const implicit = settings.smtpPort === 465;
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: implicit,
    requireTLS: !implicit,
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
    tls: { minVersion: 'TLSv1.2', servername: settings.smtpHost },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

// --- the form ---------------------------------------------------------------------------

/** Text as Python's str.strip() leaves it. */
function pyStrip(text) {
  return text.replace(PY_STRIP, '');
}

/** Bytes as UTF-8 text, or INVALID. A byte-order mark is kept, as Python keeps it. */
function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return INVALID;
  }
}

/** One form-encoded part, `+` and `%XX` decoded to bytes (a bad escape stays as it is). */
function unescapeBytes(bytes) {
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  const hex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 0x2b) {
      out[n++] = 0x20;
    } else if (b === 0x25 && i + 2 < bytes.length && hex(bytes[i + 1]) && hex(bytes[i + 2])) {
      out[n++] = parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16);
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

/** The four fields, last value wins (as the app's QueryDict.get). Nothing else is read. */
function formFields(raw) {
  const fields = { email: null, name: null, consent: null, website: null };
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0x26, start);
    if (end === -1) end = raw.length;
    const pair = raw.subarray(start, end);
    start = end + 1;
    if (pair.length === 0) continue;
    const eq = pair.indexOf(0x3d);
    const key = utf8(unescapeBytes(eq === -1 ? pair : pair.subarray(0, eq)));
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(fields, key)) {
      fields[key] = utf8(unescapeBytes(eq === -1 ? Buffer.alloc(0) : pair.subarray(eq + 1)));
    }
  }
  return fields;
}

/** The honeypot is filled: any text, or bytes that are not even text. */
function isBot(website) {
  return website !== null && (website === INVALID || pyStrip(website) !== '');
}

/** The address trimmed and lowercased, or null for one the app's door would refuse. */
function cleanEmail(value) {
  if (typeof value !== 'string') return null;
  const text = pyStrip(value);
  if ([...text].length > 254 || !ONE_ADDRESS.test(text)) return null;
  const at = text.lastIndexOf('@');
  if (!EMAIL_USER.test(text.slice(0, at)) || !EMAIL_DOMAIN.test(text.slice(at + 1))) return null;
  return text.toLowerCase();
}

/** The name trimmed, '' when absent, or null for one the app's door would refuse. */
function cleanName(value) {
  if (value === null) return '';
  if (typeof value !== 'string') return null;
  const text = pyStrip(value);
  if ([...text].length > NAME_MAX || INVISIBLE.test(text)) return null;
  return text;
}

// --- the list ---------------------------------------------------------------------------

/**
 * The private list: one JSON line per request. One writer at a time (this process
 * serialises its own writes), each line flushed to disk before it counts as kept.
 */
class List {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  /** Run `job` after every job before it, never two at once. */
  serial(job) {
    const run = this.queue.then(job, job);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The addresses on the list and how many lines each UTC clock hour holds. Read again
   * whenever the file changed, so a line the owner deletes by hand is gone here too. */
  async read() {
    let stat;
    try {
      stat = await fsp.stat(this.file);
    } catch (error) {
      if (error.code === 'ENOENT') return { emails: new Set(), hours: new Map() };
      throw error;
    }
    const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (this.cache && this.cache.key === key) return this.cache;
    const emails = new Set();
    const hours = new Map();
    for (const line of (await fsp.readFile(this.file, 'utf8')).split('\n')) {
      let seen;
      try {
        seen = JSON.parse(line);
      } catch {
        // A blank line, or a half line from a write that stopped short.
        continue;
      }
      if (seen && typeof seen.email === 'string') emails.add(seen.email);
      if (seen && typeof seen.time === 'string') {
        const hour = seen.time.slice(0, 13);
        hours.set(hour, (hours.get(hour) || 0) + 1);
      }
    }
    this.cache = { key, emails, hours };
    return this.cache;
  }

  /** Append one line and flush it to disk. True only when the whole line is there. */
  async append(row) {
    const handle = await fsp.open(this.file, 'a+', 0o600);
    let size = 0;
    try {
      size = (await handle.stat()).size;
      let text = `${JSON.stringify(row)}\n`;
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        // An earlier write that stopped short left a line with no end: start a fresh one.
        if (last[0] !== 0x0a) text = `\n${text}`;
      }
      const bytes = Buffer.from(text, 'utf8');
      const { bytesWritten } = await handle.write(bytes, 0, bytes.length);
      if (bytesWritten !== bytes.length) throw Object.assign(new Error('short write'), { code: 'ESHORT' });
      await handle.sync();
      return true;
    } catch {
      // Take a half line back off, so the list holds whole lines only.
      await handle.truncate(size).catch(() => undefined);
      return false;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Whether a line could be written now. */
  async writable() {
    try {
      await fsp.access(path.dirname(this.file), fs.constants.W_OK);
      const stat = await fsp.stat(this.file).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null) return true;
      if (!stat.isFile()) return false;
      await fsp.access(this.file, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// --- the per-address brake --------------------------------------------------------------

/**
 * At most `limit` requests an hour from one client address, held in memory only: never
 * written anywhere, and gone on a restart. The table never holds more than `max`
 * addresses; when it is full the oldest address is forgotten.
 */
class Brake {
  constructor(limit, max) {
    this.limit = limit;
    this.max = max;
    this.seen = new Map();
  }

  /** Seconds to wait, or 0 when this request may pass (and is then counted). A limit of
   * 0 is the brake switched off: everything passes and nothing is held. */
  take(address, now) {
    if (this.limit === 0) return 0;
    const since = now - HOUR_MS;
    const times = (this.seen.get(address) || []).filter((t) => t > since);
    if (times.length >= this.limit) {
      this.seen.set(address, times);
      return Math.max(1, Math.ceil((times[0] + HOUR_MS - now) / 1000));
    }
    times.push(now);
    this.seen.delete(address);
    if (this.seen.size >= this.max) {
      for (const [key, old] of this.seen) {
        if (old[old.length - 1] <= since) this.seen.delete(key);
      }
      if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value);
    }
    this.seen.set(address, times);
    return 0;
  }
}

/** The client's address: the socket's, or with TRUST_PROXY=N the N-th address from the
 * right of X-Forwarded-For (the one the N-th proxy in front of us saw), as the app's
 * DRF NUM_PROXIES does. Without TRUST_PROXY the header is never read. */
function clientAddress(req, trustProxy) {
  let socket = req.socket.remoteAddress || '';
  if (socket.startsWith('::ffff:')) socket = socket.slice(7);
  if (!trustProxy) return socket;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header === '') return socket;
  const addresses = header.split(',').map((part) => part.trim()).filter(Boolean);
  if (addresses.length === 0) return socket;
  const chosen = addresses[addresses.length - Math.min(trustProxy, addresses.length)];
  return net.isIP(chosen) ? chosen : socket;
}

// --- the app ------------------------------------------------------------------------------

function defaultSiteDir() {
  const built = path.join(__dirname, 'public');
  return fs.existsSync(built) ? built : path.join(__dirname, '..', 'site');
}

/** The real path of `target` even when it does not exist yet: the nearest folder that
 * does exist is resolved through its links, and the rest is put back on. */
function realish(target) {
  let existing = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Owner-only modes on what the private folder already holds: the folder 0700, the list
 * and settings.json 0600. Only what this process owns, and never through a link.
 * Returns the error codes of what could not be changed. */
function tighten(privateDir) {
  const failed = new Set();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const make = (target, mode, folder) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (folder ? !stat.isDirectory() : !stat.isFile()) return;
    if (uid !== null && stat.uid !== uid) return;
    if ((stat.mode & 0o777) === mode) return;
    try {
      fs.chmodSync(target, mode);
    } catch (error) {
      failed.add(error.code || 'error');
    }
  };
  make(privateDir, 0o700, true);
  make(path.join(privateDir, LIST_FILE), 0o600, false);
  make(path.join(privateDir, SETTINGS_FILE), 0o600, false);
  return [...failed];
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Build the server. Options exist for the tests: `env` (default process.env), `siteDir`,
 * `privateDir`, `now` (a clock), `log`, `transport` (anything with sendMail(message)
 * returning a promise, used instead of SMTP) and `smtpExtra` (merged into the SMTP
 * options). Neither of the last two can be set from the environment or settings.json.
 */
function createApp(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((line) => console.log(line));
  const now = options.now || Date.now;
  const siteDir = fs.realpathSync(path.resolve(options.siteDir || env.SITE_DIR || defaultSiteDir()));
  // Resolved through any link first, so a link into the site cannot pass the check.
  const privateDir = realish(path.resolve(options.privateDir || env.PRIVATE_DIR || path.join(__dirname, 'private')));
  if (inside(privateDir, siteDir) || inside(siteDir, privateDir)) {
    throw new Error(`PRIVATE_DIR (${privateDir}) and SITE_DIR (${siteDir}) must not hold one another`);
  }
  try {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  } catch {
    // Reported as "list not writable" below and on /healthz.
  }
  const untightened = tighten(privateDir);
  const { settings, notes, fileState } = readSettings(env, privateDir);
  if (untightened.length > 0) {
    notes.push(`the private folder or its files could not be made owner-only (${untightened.join(', ')}); check their modes`);
  }
  const list = new List(path.join(privateDir, LIST_FILE));
  const brake = new Brake(settings.addressLimit, ADDRESS_TABLE_MAX);
  let warnedProxy = false;

  let mailer = null;
  let mailState = 'off';
  // Why mail is off, as one fixed word for /healthz: 'address', 'settings' or 'package'.
  // On 2026-11-16 the live site said "mail: off" three times for three different causes
  // (a broken settings file, the package not installed after a pull by hand, and then
  // nothing wrong at all), and each took a round of guessing.
  let mailWhy = 'settings';
  if (!settings.mailTo || !settings.mailFrom) {
    mailState = 'off (MAIL_TO or MAIL_FROM is not a plain address)';
    mailWhy = 'address';
  } else if (options.transport) {
    mailer = options.transport;
    mailState = 'on';
  } else if (!settings.smtpUser || !settings.smtpPass) {
    mailState = 'off (SMTP_USER and SMTP_PASS are not set)';
  } else {
    try {
      // Loaded only here, so the server runs, and its tests pass, with no package installed.
      const nodemailer = require('nodemailer');
      mailer = nodemailer.createTransport({ ...smtpOptions(settings), ...(options.smtpExtra || {}) });
      mailState = 'on';
    } catch {
      mailState = 'off (nodemailer is not installed: run npm install)';
      mailWhy = 'package';
    }
  }
  let mailsInFlight = 0;
  let mailsDone = () => undefined;

  function tell(row) {
    if (!mailer) return;
    const body = `time: ${row.time}\nemail: ${row.email}\nname: ${row.name}\nconsent: ${row.consent}\nlist: ${row.list}\n`;
    const message = {
      from: { name: 'Xylum website', address: settings.mailFrom },
      to: settings.mailTo,
      replyTo: row.email,
      subject: `Xylum invitation request: ${row.email}`,
      text: body,
    };
    mailsInFlight += 1;
    Promise.resolve()
      .then(() => mailer.sendMail(message))
      .catch((error) => {
        // The code only: an SMTP error's text can quote the address back.
        const code = [error && error.code, error && error.responseCode].filter(Boolean).join(' ');
        log(`mail failed: ${code || 'unknown error'}`);
      })
      .finally(() => {
        mailsInFlight -= 1;
        if (mailsInFlight === 0) mailsDone();
      });
  }

  /** What the door answers: [fragment, Retry-After seconds or null, row to mail or null]. */
  async function decide(raw) {
    if (utf8(raw) === INVALID) return [CHECK, null, null];
    const form = formFields(raw);
    // A filled honeypot is spam: nothing kept, nothing sent, and the success answer.
    if (isBot(form.website)) return [JOINED, null, null];
    if (form.consent !== 'yes') return [CHECK, null, null];
    const email = cleanEmail(form.email);
    const name = cleanName(form.name);
    if (email === null || name === null) return [CHECK, null, null];
    return list.serial(async () => {
      const moment = new Date(now());
      const hour = moment.toISOString().slice(0, 13);
      let state;
      try {
        state = await list.read();
      } catch {
        return [LATER, 600, null];
      }
      // The flood brake for everyone together: lines kept this UTC clock hour.
      if ((state.hours.get(hour) || 0) >= settings.hourlyLimit) {
        return [LATER, 3600 - (Math.floor(moment.getTime() / 1000) % 3600), null];
      }
      // Already asked: the same answer as joined, and no second mail.
      if (state.emails.has(email)) return [JOINED, null, null];
      const row = {
        time: `${moment.toISOString().slice(0, 19)}Z`,
        email,
        name,
        consent: CONSENT_TEXT,
        list: LIST_SLUG,
      };
      // The list is the gate. Not kept means not joined, and no mail.
      if (!(await list.append(row))) return [LATER, 600, null];
      return [JOINED, null, row];
    });
  }

  function finish(res, status, headers, body) {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8');
    res.setHeader('Content-Length', String(bytes.length));
    res.writeHead(status);
    res.end(res.req.method === 'HEAD' ? undefined : bytes);
  }

  function plain(res, status, text, headers = {}) {
    finish(res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, `${text}\n`);
  }

  /** A refusal before the form is read: the app's problem+json shape, a fixed sentence. */
  function problem(res, status, title, detail, headers = {}) {
    const body = JSON.stringify({ type: 'about:blank', title, status, detail });
    finish(res, status, { 'Content-Type': 'application/problem+json', ...headers }, body);
  }

  function seeOther(res, fragment, wait) {
    const headers = { Location: RETURN_PAGE + fragment };
    if (wait !== null) headers['Retry-After'] = String(wait);
    finish(res, 303, headers);
  }

  /** Stop reading a body that is too big, without reading it to the end. */
  function closeAfter(req, res) {
    res.setHeader('Connection', 'close');
    let drained = 0;
    req.on('data', (chunk) => {
      drained += chunk.length;
      if (drained > 64 * 1024) req.socket.destroy();
    });
    req.resume();
  }

  /** The body, or null when it grows past `max` bytes. */
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      const onData = (chunk) => {
        total += chunk.length;
        if (total > max) {
          req.off('data', onData);
          req.off('end', onEnd);
          resolve(null);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => resolve(Buffer.concat(chunks, total));
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', reject);
    });
  }

  async function door(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      finish(res, 405, { Allow: 'POST' });
      return;
    }
    const media = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    const wait = brake.take(clientAddress(req, settings.trustProxy), now());
    if (wait > 0) {
      closeAfter(req, res);
      if (media === FORM) {
        seeOther(res, LATER, wait);
      } else {
        problem(res, 429, 'Too many requests', 'Too many requests. Try again later.', { 'Retry-After': String(wait) });
      }
      return;
    }
    if (media !== FORM) {
      closeAfter(req, res);
      problem(res, 415, 'Unsupported media type', 'Send the form as a form post.');
      return;
    }
    const tooBig = () => problem(res, 413, 'Delivery too large', `One delivery may carry at most ${MAX_BYTES} bytes.`);
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > MAX_BYTES) {
      closeAfter(req, res);
      tooBig();
      return;
    }
    const raw = await readBody(req, MAX_BYTES);
    if (raw === null) {
      closeAfter(req, res);
      tooBig();
      return;
    }
    let answer;
    try {
      answer = await decide(raw);
    } catch {
      answer = [LATER, 600, null];
    }
    const [fragment, retry, row] = answer;
    seeOther(res, fragment, retry);
    // Kept, so joined, whether or not the notice reaches the owner.
    if (row) tell(row);
  }

  async function healthz(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      finish(res, 405, { Allow: 'GET, HEAD' });
      return;
    }
    // Whether THIS request came through a proxy that adds X-Forwarded-For. Nothing from
    // the header itself is shown.
    const forwarded = req.headers['x-forwarded-for'] !== undefined;
    const state = {
      ok: true,
      mail: mailer ? 'on' : 'off',
      list: (await list.writable()) ? 'writable' : 'not writable',
      forwarded,
      trust_proxy: settings.trustProxy,
      settings_file: fileState,
    };
    // 'settings': SMTP_USER or SMTP_PASS is missing. 'address': MAIL_TO or MAIL_FROM is
    // not one plain address. 'package': nodemailer is not installed (run the build).
    if (!mailer) state.mail_off_because = mailWhy;
    if (forwarded && settings.trustProxy === 0) state.advice = 'set TRUST_PROXY=1';
    const body = JSON.stringify(state);
    finish(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body);
  }

  /** The file a request path names, or null. Never a dotfile or dot-folder, never a
   * README.md, never anything under api/, and never outside the site folder. */
  async function resolveFile(rawPath) {
    if (/%2f|%5c|%00/i.test(rawPath)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
    const parts = relative.split('/');
    for (const part of parts) {
      if (part === '' || part.startsWith('.')) return null;
    }
    if (parts[0].toLowerCase() === 'api') return null;
    if (parts[parts.length - 1].toLowerCase() === 'readme.md') return null;
    const type = TYPES[path.extname(relative).toLowerCase()];
    if (!type) return null;
    const full = path.resolve(siteDir, ...parts);
    if (!inside(full, siteDir) || full === siteDir) return null;
    let real;
    try {
      real = await fsp.realpath(full);
    } catch {
      return null;
    }
    if (!inside(real, siteDir) || real === siteDir) return null;
    return { real, extension: path.extname(relative).toLowerCase(), type };
  }

  function encodingFor(req, extension, size) {
    if (!COMPRESSIBLE.has(extension) || size < 256) return null;
    const accepted = new Map();
    for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
      const [name, ...params] = part.trim().toLowerCase().split(';');
      let q = 1;
      for (const param of params) {
        const [k, v] = param.trim().split('=');
        if (k === 'q') q = Number(v);
      }
      if (name) accepted.set(name, Number.isFinite(q) ? q : 0);
    }
    if ((accepted.get('br') || 0) > 0) return 'br';
    if ((accepted.get('gzip') || 0) > 0) return 'gzip';
    return null;
  }

  async function serveStatic(req, res, rawPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      finish(res, 405, { Allow: 'GET, HEAD' });
      return;
    }
    const found = await resolveFile(rawPath);
    let handle = null;
    let stat = null;
    if (found) {
      try {
        handle = await fsp.open(found.real, 'r');
        stat = await handle.stat();
      } catch {
        stat = null;
      }
    }
    if (!found || !stat || !stat.isFile()) {
      if (handle) await handle.close().catch(() => undefined);
      plain(res, 404, 'Not found.', { 'Cache-Control': 'no-cache' });
      return;
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const modified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', modified.toUTCString());
    res.setHeader('Cache-Control', REVALIDATE.has(found.extension) ? 'no-cache' : 'public, max-age=86400');
    if (COMPRESSIBLE.has(found.extension)) res.setHeader('Vary', 'Accept-Encoding');
    const match = req.headers['if-none-match'];
    let fresh = false;
    if (typeof match === 'string') {
      const strip = (tag) => tag.trim().replace(/^W\//, '');
      fresh = match.trim() === '*' || match.split(',').some((tag) => strip(tag) === strip(etag));
    } else if (typeof req.headers['if-modified-since'] === 'string') {
      const since = Date.parse(req.headers['if-modified-since']);
      fresh = Number.isFinite(since) && modified.getTime() <= since;
    }
    if (fresh) {
      await handle.close();
      res.writeHead(304);
      res.end();
      return;
    }
    res.setHeader('Content-Type', found.type);
    const encoding = encodingFor(req, found.extension, stat.size);
    if (encoding) {
      res.setHeader('Content-Encoding', encoding);
    } else {
      res.setHeader('Content-Length', String(stat.size));
    }
    res.writeHead(200);
    if (req.method === 'HEAD') {
      await handle.close();
      res.end();
      return;
    }
    const source = handle.createReadStream();
    const steps = [source];
    if (encoding === 'br') {
      steps.push(zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stat.size },
      }));
    } else if (encoding === 'gzip') {
      steps.push(zlib.createGzip({ level: 6 }));
    }
    steps.push(res);
    pipeline(...steps, () => undefined);
  }

  async function handle(req, res) {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    if (!warnedProxy && settings.trustProxy === 0 && req.headers['x-forwarded-for'] !== undefined) {
      // Once per process, and with no address in it.
      warnedProxy = true;
      log('warning: requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY is 0, so every visitor counts as one address; set TRUST_PROXY=1');
    }
    const url = req.url || '';
    if (url.length > MAX_URL) {
      plain(res, 414, 'That address is too long.');
      return;
    }
    if (!url.startsWith('/')) {
      plain(res, 400, 'Bad request.');
      return;
    }
    const query = url.indexOf('?');
    const rawPath = query === -1 ? url : url.slice(0, query);
    if (rawPath === '/healthz') {
      await healthz(req, res);
    } else if (rawPath === DOOR || rawPath === DOOR.slice(0, -1)) {
      await door(req, res);
    } else {
      await serveStatic(req, res, rawPath);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      // No stack trace to a client: a plain 500, or a closed connection mid-file.
      if (res.headersSent) {
        res.destroy();
      } else {
        const keep = new Set(Object.keys(SECURITY_HEADERS).map((key) => key.toLowerCase()));
        for (const name of res.getHeaderNames()) {
          if (!keep.has(name)) res.removeHeader(name);
        }
        plain(res, 500, 'Something went wrong.');
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  // Node's own answers to a request it cannot parse (400, 408, 431) carry the same
  // security headers as every other answer. Nothing from the request is echoed.
  const CLIENT_ERRORS = { ERR_HTTP_REQUEST_TIMEOUT: '408 Request Timeout', HPE_HEADER_OVERFLOW: '431 Request Header Fields Too Large' };
  const securityLines = Object.entries(SECURITY_HEADERS).map(([key, value]) => `${key}: ${value}\r\n`).join('');
  server.on('clientError', (error, socket) => {
    if (!socket.writable || socket.bytesWritten > 0 || (error && error.code === 'ECONNRESET')) {
      socket.destroy();
      return;
    }
    const status = CLIENT_ERRORS[error && error.code] || '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\n${securityLines}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  });

  /** Stop taking requests, let the ones in hand finish and the list's writes and the
   * mails in flight end (at most `grace` ms for the mails), then resolve. */
  async function close(grace = 10000) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await list.queue;
    if (mailsInFlight > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, grace);
        timer.unref();
        mailsDone = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  return {
    server,
    close,
    siteDir,
    privateDir,
    settings,
    notes,
    mailState,
    listWritable: () => list.writable(),
  };
}

async function main() {
  let app;
  try {
    app = createApp();
  } catch (error) {
    console.error(`cannot start: ${error.message}`);
    process.exit(1);
  }
  for (const note of app.notes) console.log(`setting: ${note}`);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || undefined;
  app.server.listen(port, host, async () => {
    const writable = (await app.listWritable()) ? 'writable' : 'NOT WRITABLE';
    console.log(
      `xylum site: port ${app.server.address().port}, serving ${app.siteDir}, mail ${app.mailState}, ` +
        `list ${writable} (${path.join(app.privateDir, LIST_FILE)})`,
    );
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: closing`);
    setTimeout(() => process.exit(1), 15000).unref();
    app.close().then(() => {
      console.log('closed');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

module.exports = {
  createApp,
  smtpOptions,
  readSettings,
  cleanEmail,
  cleanName,
  formFields,
  CONSENT_TEXT,
  DOOR,
  CSP,
  SECURITY_HEADERS,
};

if (require.main === module) {
  main();
}
