# site-server/ — the Xylum website as one small Node.js app

## In plain words

This folder is a small program that runs the Xylum website. It does two jobs:

1. It sends the website's pages, pictures and styles to anyone who visits.
2. It takes the invitation form on the signup page. When someone fills it in, the program
   writes one line to a private list and then sends you one email about it.

**The list is what counts.** If the line could not be written, the person is told to try
again later and no email goes out. The email is only a notice, so a lost email loses
nothing: the line is still on the list.

It needs Node.js 20 or newer and one package, `nodemailer` (it sends the email). The
pages themselves are in `../site/` in this repository, or in `public/` once published.

When the Xylum app is hosted, the form's one address is pointed at the app instead, and
this door is retired (see the end). The pages do not change.

## Run it on your own computer

```sh
cd site-server
npm install          # fetches nodemailer, the only package
npm start            # then open http://localhost:8080
npm test             # the tests: they start the real server on a free port
```

With no settings at all it runs and writes the list, with email off. The first line it
prints says what it found, for example:

```
xylum site: port 8080, serving /…/site, mail off (SMTP_USER and SMTP_PASS are not set), list writable (/…/site-server/private/requests.jsonl)
```

Stop it with Ctrl-C. It finishes what it is doing, prints `closed` and exits.

## Put it on Infomaniak

The hosting repository is made by `scripts/site-publish.sh` (from this repository's root):
it puts this folder at the top and the pages in `public/`. Never edit that repository by
hand; the next publish replaces it.

In the Infomaniak panel, create a **Node.js site** and give it:

| field | value |
|---|---|
| source | the Git repository `site-publish.sh` publishes to, branch `main` |
| Node.js version | 20 or newer (22 or 24 if offered) |
| build command | `npm ci --omit=dev` |
| launch command | `npm start` (the same as `node server.js`) |
| port | whatever the panel says; the program listens on the `PORT` it is given |

Then put the settings in, either in the panel's environment variables (if it offers them)
or in a file `private/settings.json` next to `server.js` (see below). Prefer the panel's
environment variables for the password or token: then it is in no file at all. If the file
is used, the program makes it readable by its owner only each time it starts (and the
`private/` folder and the list too); if it cannot, its first lines say so. Then run the
go-live test.

## The settings

Every setting is read from the environment first and then from `private/settings.json`. A
setting that is missing or wrong never stops the website: it falls back to its default and
the first lines it prints say so.

| setting | what it is | default |
|---|---|---|
| `SMTP_USER` | the mailbox that sends the email, as its full address | none: mail is off |
| `SMTP_PASS` | that mailbox's password | none: mail is off |
| `SMTP_HOST` | the mail server | `mail.infomaniak.com` |
| `SMTP_PORT` | `587` (STARTTLS) or `465` (TLS from the start); any other port must offer STARTTLS, or nothing is sent | `587` |
| `MAIL_FROM` | the address the email is from | `hello@xylum.io` |
| `MAIL_TO` | where the email goes | `hello@xylum.io` |
| `HOURLY_LIMIT` | how many people can join in one clock hour, all together | `60` |
| `TRUST_PROXY` | how many proxies sit in front of the program (see "What a flood looks like") | `0` |
| `ADDRESS_LIMIT` | how many times one network address may send the form in an hour; `0` switches this brake off and leaves `HOURLY_LIMIT` | `5` |

Read from the environment only: `PORT` (default 8080), `HOST` (default every address),
`SITE_DIR` (default `public/` if it is there, else `../site`), `PRIVATE_DIR` (default
`private/` next to `server.js`).

**The website sends through Lettermint** (Sam, 2026-11-16), a service made for mail that a
program sends. Any mail service that offers SMTP works the same way; only these four
values change. For Lettermint, `private/settings.json` is:

```json
{
  "SMTP_HOST": "smtp.lettermint.co",
  "SMTP_PORT": 587,
  "SMTP_USER": "lettermint",
  "SMTP_PASS": "the sending token of the Lettermint project",
  "MAIL_FROM": "hello@xylum.io",
  "MAIL_TO": "hello@xylum.io"
}
```

- `SMTP_USER` is the word `lettermint`, as it stands. `SMTP_PASS` is the project's sending
  token, from the Lettermint dashboard. Treat the token like a password: it goes in this
  file on the host (or in the panel's environment variables), never into git, a chat or
  an email.
- `MAIL_FROM` must be an address on a domain that is verified in Lettermint (`xylum.io`),
  or Lettermint refuses the mail.
- `MAIL_TO` is the mailbox you read. It can be the same address as `MAIL_FROM`.

To send through a normal mailbox instead (for example one at Infomaniak): `SMTP_HOST`
`mail.infomaniak.com`, `SMTP_USER` the mailbox's full address, `SMTP_PASS` its password.

The password is never sent unless the mail server first agrees to encrypt the connection.
If it does not, the email is not sent and the log says `mail failed: …`.

## Where the list lives, and how to read it

`private/requests.jsonl`, next to `server.js` (or in `PRIVATE_DIR`). Only the program can
read it: it is made readable by its owner only, and no address on the website reaches
it. One person is one line:

```json
{"time":"2026-11-16T10:15:30Z","email":"ada@example.com","name":"Ada","consent":"Yes, email me when Xylum early access opens. Keep my address and name for that alone, and remove them when I ask.","list":"early-access"}
```

Read it over SSH or the panel's file manager. To count it: `wc -l private/requests.jsonl`.
Someone already on the list who asks again is told they are on it and gets no second line
and no second email. To remove a person who asks, delete their line (with the program
stopped, or by writing the whole file back in one go).

The email you get for each new line:

```
From: Xylum website <hello@xylum.io>
Reply-To: ada@example.com
Subject: Xylum invitation request: ada@example.com

time: 2026-11-16T10:15:30Z
email: ada@example.com
name: Ada
consent: Yes, email me when Xylum early access opens. …
list: early-access
```

Replying answers the person.

## The go-live test

After every first deploy, and after changing a setting:

1. Open `/healthz` (`https://<the site>/healthz`): `mail` must be `on`, `list` must be
   `writable`, and if it shows `forwarded: true` with `trust_proxy: 0`, set
   `TRUST_PROXY=1` and restart BEFORE anyone sees the page. A good answer behind
   Infomaniak's proxy looks like
   `{"ok":true,"mail":"on","list":"writable","forwarded":true,"trust_proxy":1,"settings_file":"read"}`.
   `list` other than `writable` means nobody can join: fix the folder first. When the
   answer also carries `"advice":"set TRUST_PROXY=1"`, that is the same thing said once
   more. When `mail` is `off`, no mail goes out, and two more words say why:

   | `/healthz` shows | it means | do this |
   |---|---|---|
   | `"settings_file":"ignored"` | `private/settings.json` is there and cannot be read: a missing or extra comma, a curly quote | fix the file; the console's first lines name the fault |
   | `"settings_file":"none"` | there is no `private/settings.json` beside `server.js` | fine if the settings are environment variables; else put the file there |
   | `"mail_off_because":"settings"` | `SMTP_USER` or `SMTP_PASS` is missing or empty | add both, spelled exactly so |
   | `"mail_off_because":"address"` | `MAIL_TO` or `MAIL_FROM` is not one plain address | write just `name@domain` |
   | `"mail_off_because":"package"` | the mail package is not installed | run `npm ci --omit=dev` beside `server.js`, then restart |
2. Open the signup page, fill in your own address, tick the box, send. You must land on
   "Thanks. You are on the list…".
3. Check `private/requests.jsonl` has your line, and that the email arrived.
4. Send the same address again: the same thanks, no new line, no new email.
5. Delete your line.

**When you test again later, use an address that is not on the list**, or empty the list
first (`: > private/requests.jsonl`). An address that is already there gets the same
thanks and no email, by design, which looks exactly like mail being broken. It cost an
hour on the first evening.

## What a flood looks like

Two brakes, both on purpose:

- **All together**: after `HOURLY_LIMIT` new people in one clock hour (60 by default),
  everyone else is told "Too many tries just now" until the next hour. The count is read
  from the list, so a restart does not reset it.
- **Per sender**: one network address may send the form `ADDRESS_LIMIT` times an hour (5
  by default). The next one is told to try later. Refused tries count too.

The hourly limit is the one that really bounds things: at most `HOURLY_LIMIT` new lines,
and so at most `HOURLY_LIMIT` emails to you, in an hour. Each of those emails has a
Reply-To that a stranger typed, so read it before you reply. The per-sender brake only
slows one sender down: anyone who can change their network address (a phone network, a
VPN) can step round it.

If the program sits behind Infomaniak's proxy, every visitor looks like the proxy, and the
per-sender brake would stop everyone together after 5 tries. `/healthz` shows this:
`forwarded: true` means the request came through a proxy that names the visitor in an
`X-Forwarded-For` header. Then set `TRUST_PROXY` to `1` (one proxy in front), which makes
the program read the visitor's address from that header. While it is still `0`, the
program also prints one warning line the first time such a request arrives. Never set it
higher than the number of proxies really in front: a visitor could then write their own
address and step round the brake.

If the host's proxy names the visitor in another header (for example `X-Real-IP`) and not
in `X-Forwarded-For`, `/healthz` shows `forwarded: false`, and the program cannot tell
visitors apart at all. The per-sender brake then counts everyone together: the form allows
`ADDRESS_LIMIT` tries an hour **in total**, 5 by default, and then tells everyone to try
later. The fix is to raise `ADDRESS_LIMIT` (for example to `60`) or set it to `0`, which
leaves only the hourly limit.

## What the program refuses on purpose

- **Anything under `/.well-known/`** is answered "not found", like every name that starts
  with a dot. While the host handles the certificate (HTTPS), nothing there is needed. If a
  service ever asks you to put a file there to prove you own the domain, this program will
  not serve it.
- **HSTS** (the header that tells browsers to use HTTPS only) is the host's to set, not
  this program's: behind the host's proxy, the program does not know whether the visitor
  came in over HTTPS.

## Never open the list in a spreadsheet

Do not open `requests.jsonl`, or any copy of it turned into CSV, in Excel, LibreOffice or
Google Sheets. A name is whatever a stranger typed, and a name that starts with `=` is run
as a formula when a spreadsheet opens it. Read it as plain text.

## Redeploy

Publish again (`scripts/site-publish.sh <url>`) and redeploy in the panel. The `private/`
folder is not in git (`.gitignore`), so a redeploy never carries a list or a password in
and should never take one away. On Infomaniak (seen 2026-11-16) `private/` is kept across a
`git pull`: the list and the settings were there after two.

**A `git pull` by hand does not run the build.** Run it yourself before you restart, or
the site comes back with mail off (`"mail_off_because":"package"`):

```sh
cd ~/sites/xylum.io && git pull && npm ci --omit=dev
```

Then restart the site in the panel and open `/healthz`.

## Retiring this door

When the Xylum app is hosted, route `/api/v1/signups/public/early-access/` to the app, so
the form posts there. Then bring the lines of `private/requests.jsonl` into the app's
`early-access` list, and delete the file. Until the file is deleted, those people's details
are kept here.

## What is not kept

The per-sender brake holds each sender's network address in memory for at most an hour,
to count their tries. It is never written to disk, never sent anywhere, and it is gone on
restart. Nothing else about a visitor is kept: no log of pages read, no cookies.

## The tests

`npm test` (which is `node --test`) runs every file in `test/`: the pages and every way a
request might try to reach a file that is not public, the form's every answer, the brakes,
the settings, a real SMTP conversation, and the program started and stopped as the host
does. `backend/xylum/signups/tests/test_site_server.py` checks that the consent sentence,
the form's address and its three answers still match the app and the page.
