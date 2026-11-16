# site/ — the Xylum marketing site

Seven static pages that say what Xylum is, show it working, and take requests for an
invitation. It is plain HTML and CSS with one small script and no build step, and it asks
no other host for anything. ADR-0081 records why it lives here and how a signup is stored;
its amendment 2026-11-16 G records the current look ("site v5") and why the site now has a
script, and amendment H the temporary form handler.

| file | what it is |
|---|---|
| `index.html` | the home page: the sentence Xylum opens on, the real screens, four small working pictures, every app in one line |
| `why-xylum.html` | seven strengths, each with the thing in the product that proves it |
| `vs-traditional-erp.html` | Xylum beside a traditional ERP, in one table, and when an ERP is the better choice |
| `who-its-for.html` | four kinds of small business, and a day with Xylum |
| `faq.html` | short answers, each a `details` element the browser opens |
| `signup.html` | **the signup screen.** Invitation only for now: the one form on the site |
| `privacy.html` | what is kept when somebody asks for an invitation, and how to have it removed. Marked as a draft until it is signed off |
| `sitemap.xml`, `robots.txt` | for search engines. Both name `https://xylum.io`, the one address the site is served from |
| `llms.txt` | the short version for AI assistants: what Xylum is, the key facts, the pages |
| `favicon.ico` | a copy of `frontend/public/favicon.ico` |
| `ds/tokens/`, `ds/assets/fonts/` | **the design system.** Byte copies of the bundle's tokens and fonts (`frontend/vendor/design-system/`). Never edit one by hand. `bash scripts/site-ds-sync.sh` re-copies them; a backend test compares the bytes. |
| `styles/fonts.css` | the bundle's `tokens/fonts.css` with its first line replaced and the font paths pointed at `ds/assets/fonts/`. Written by the same script. |
| `styles/site.css` | the layout, built to site kit v5 (`docs/design/site-kit-v5.md`). Every colour, radius, shadow and easing is a `--xy-*` token. It writes no colour of its own, and a test holds it to that. |
| `styles/noscript.css` | linked inside a `<noscript>`: only a browser that runs no script fetches it. It hides the controls that need the script and lays the 23 app lines out as a list. |
| `scripts/site.js` | the one script: it makes the pictures move and the pickers pick. No dependency, not built, asks no server for anything, stores nothing. |
| `api/` | **temporary.** The stand-in for the app's signup door, in PHP (below, "The signup screen") |
| `shots/`, `shots/phone/` | screenshots of the real product, made by `bash scripts/site-shots.sh` (below) |
| `icons/` | app icons, from the 2026-10-15 sales brochure |
| `brand/` | `xylum-duotone.svg`, a byte-for-byte copy of `frontend/public/brand/xylum-duotone.svg`. Never edit it by hand. A backend test compares the bytes. To update it, copy the file again. Pre-commit leaves it alone. `xylum-mark.svg` is the same kind of copy, used as the tab icon. |

## The look: site kit v5

The design project draws the site. Its newest drawing is "xylum site v5" (2026-11-16), a
prototype of all seven pages at 1440 and at 375 wide, and the site is built to it
(ADR-0081 amendment G). The hand-over is copied word for word in
`docs/design/site-kit-v5.md`. **Read that page before changing how anything looks**, and
change nothing the drawing does not show: a new block, crop or sentence is the design
project's to draw. (`docs/design/site-kit-v2.md` is the drawing it replaced.)

How it was checked: every page was opened beside the prototype in a headless browser and
every piece of text compared, its place, size, line height, weight and colour. Nothing is
more than 1 px off at 1440 or at 375. Keep it that way: after a change to a page, measure
again.

The rules that are easy to break:

- **Line height.** A rule sets a `line-height` only where the drawing sets one. Everything
  else inherits `normal`. A stray `1.6` on the small labels once made the home page 90 px
  too tall.
- **Three widths.** From 1000 up, the desktop board: the column is the window less 144,
  at most 1296. Under 1000, the phone board: one column, at most 640 wide, phone type.
  Under 600, the phone board with the phone screenshots. Between the two drawn widths the
  page only has to be sensible and unbroken.
- **The design system's parts are redrawn in plain CSS.** The site cannot import React, so
  Button, Eyebrow, Tag, Plate, DecisionCard and ToneChooser are written out in
  `styles/site.css` from the values the bundle's own components render. When the bundle
  changes one of them, change it here too.
- **A button that does nothing in a picture is a `<span class="btn">`**, not a `<button>`:
  "send", "edit", the plate's actions. A real `<button>` does something.
- **Lowercase** menus, buttons, labels and headings, with the name written `xylum` there.
  Sentences keep capitals, and so do the titles and descriptions in the `<head>`.
- **The dark plate is in two places only:** the hero's sentence on the home page, and the
  invitation block at the foot of a page. The signup screen has no invitation block.
- **A screenshot is a crop** (below). Never a whole screen shrunk.
- **After a new bundle is adopted** (`npm run ds:adopt`), run `bash scripts/site-ds-sync.sh`.
  The site test fails until the copies match again, and CI runs it when the bundle changes.

Blocks marked `holding` in `styles/site.css` are places where the drawing is silent and
something stands in: the hero stage between 1000 and 1279 wide, the form's three answers,
the print block. Do not refine them. When the design project draws one, build to the
drawing.

## The script, and reading the site without it

`scripts/site.js` runs one clock, a tick every 700 ms, as the kit draws it. On the home
page it changes the hero's sentence, lights the app icons that sentence read, runs the
four small pictures and serves the two pickers; on "who it's for" it walks the day.

- **Every picture is written into the HTML in its finished state** (all chores done, the
  whole chain lit, the letter's bars full). The script only moves them.
- **With "reduce motion" switched on, the script does not tick.** The page stays as the
  HTML wrote it.
- **With no script,** `styles/noscript.css` hides the three controls marked
  `needs-script` and shows every app's line as a list. The form and the phone menu never
  needed script.
- **It must not ask any server for anything or store anything.** A test reads the file for
  `fetch`, storage, cookies and any address of another host.

## Rules every page keeps

`backend/xylum/signups/tests/test_site.py` holds all of these, on every page:

- **Plain voice.** Every sentence a person reads is 20 words or fewer, with no banned
  word (`xylum/core/brain/voice.py`). That includes each page's search description.
- **Nothing about running Xylum yourself** (U19), and no claim the product cannot back.
- **One headline, its own title and description, and a canonical address** under
  `https://xylum.io`. `sitemap.xml` lists exactly the pages that exist. A new page means
  a new `<url>` line there.
- **The same header on every page:** the brand lockup, then four links and the invitation
  button; on a phone, a `details` menu with five rows and the button.
- **The one form is on `signup.html`.** Other pages link to it. They never carry a copy of
  the form, so the consent sentence is pinned in one place.
- **One script, the site's own, and no inline script or handler.**
- **No file in `shots/` that no page shows.**

## Screenshots

**How one is shown.** A frame holds the whole capture, scaled and moved so that only one
part shows: `<figure class="shot …"><picture>…<img …></picture></figure>`.
`styles/site.css` gives each frame the kit's numbers as custom properties: `--site-fw` and
`--site-fh` (the frame as drawn), `--site-iw` (the width the capture is drawn at),
`--site-il` and `--site-it` (its left and top), and `--site-fb` / `--site-fr` for a fade
on an edge. The base rule turns them into shares of the frame's width, so a crop holds as
the column grows or shrinks. Under 600 a media query swaps in the phone numbers and the
`<picture>` swaps in the phone capture. The numbers come from the kit's "Screenshots"
tables. Do not invent a crop.

**How they are made.** `bash scripts/site-shots.sh` remakes every file in `shots/`. It
needs `npm ci` to have run in `frontend/` once (it uses that folder's Playwright). It boots
the throwaway end-to-end stack (`deploy/compose.e2e.yaml`) under its own name and random
loopback ports, fills it with the sample business (`seed_demo --wipe`), and runs
`scripts/site-shots.mjs`. That script takes each shot at device scale 2, then prints each
file's size for the `<img>` `width` and `height`. The stack is torn down at the end. It
never touches the shared stack and never reads `deploy/.env`. It takes about five minutes.

It fails on any error response, any request to another host, or a screen with no sample
name on it. Run it after any visible change to the product, then check each crop in the
pages against the new shot: a screen that moved needs its crop drawn again. The hero's
three sentences and the cards' figures are typed into `index.html` from the same sample
book: check those against the new shots too.

**Phone captures.** `SITE_SHOTS_PHONE_DIR=<folder outside site/> bash scripts/site-shots.sh`
also captures the same seven screens at 375 wide, the first screen and the whole page.
The site shows six of the first-screen captures under 600 wide, from `shots/phone/`: copy
those six there by hand. `shots/phone/invoice-letter.png` is the design project's own
slice of the invoice capture (the letter, 1125 x 2100); cut it again from
`invoice-full.png` after a re-shoot.

## Print

The kit lists the A4 brochure as not in this package, and its boards still show the
earlier look. The `@media print` block at the end of the base styles is a holding
position: it leaves the menu, the doors and the invitation block off paper and nothing
more. `node scripts/site-brochure.mjs <out.pdf>` still prints the home page; the result is
not a designed brochure until the design project draws one.

## The signup screen

Xylum is invitation only (Sam, 2026-11-12, decision `signups-stay-invite-only`). So
`signup.html` does not open an account. It takes a request for an invitation, and tells a
person who already has one to use the link in their invitation email.

The form on `signup.html` posts to Xylum's own door,
`POST /api/v1/signups/public/early-access/` (the `signups` module). The door answers a
browser with a redirect to the list's `return_url`, ending in `#joined`, `#check-details`
or `#try-later`. `signup.html` shows the matching sentence with CSS `:target`, so the
list's `return_url` must be the address of `signup.html`. The checkbox label is
`signups.services.DEFAULT_CONSENT_TEXT`, word for word, and
`backend/xylum/signups/tests/test_site.py` holds the two together.

### Until the hosted app exists: the stand-in door

The hosted app is not standing yet, and the site goes live before it (ADR-0081 amendment
H). So `api/v1/signups/public/early-access/index.php` answers at the same address. It
applies the same checks and sends the browser back to the same three answers. For each
good request it:

- appends one line to `api/_private/.ht-requests.jsonl`: time, email, name, the consent
  sentence, the list. No IP address, no browser, no referrer;
- mails the same five facts to `hello@xylum.io`, with the asker as Reply-To.

**The file is the list. The mail is only the notice.** If the line cannot be written, the
person is told "try again later" and no mail goes out. If the line is written and the
mail fails, the person is still on the list, so read the file as well as the inbox. A
second request from the same address mails nobody.

What it cannot do, and what that looks like:

- **It cannot tell people apart.** It keeps no IP address, because the privacy page
  promises only four things are kept. So its flood brake is one count for everybody: more
  than 60 accepted requests in one clock hour, and everyone is told "try again later"
  until the hour turns. **If about 60 request mails arrive within an hour, the door is
  being flooded and real people are being turned away.** Wait it out, change
  `HOURLY_LIMIT`, or remove `api/` until it stops. The app's own door has a brake for each
  address and does not have this weakness.
- **Anyone can put in any address.** As on the app's door, nothing proves the address
  belongs to the person who typed it. Treat a request as a request.
- **Never open the list file in a spreadsheet.** A name may begin with `=` or `+`, which
  a spreadsheet runs as a formula. Read it as text, or load it with a script.
- **`hello@xylum.io` must have no auto-reply.** Each mail's Reply-To is the address that
  was typed in, so an auto-reply would write to whoever a stranger names.

Its settings are five constants at the top of the file: the recipient, the sender (both
`hello@xylum.io`), the page to send people back to, the hourly limit and the private
folder. **The private folder is safest outside the web root**: if the hosting account has
a folder above the site's own (Infomaniak's does), set `PRIVATE_DIR` to a folder there,
and no web address can reach the list at all. Inside the site it is protected by an
`.htaccess` and by file names that start with `.ht`, which Apache refuses to serve; that
holds on Apache and is checked in step 0 below. `backend/xylum/signups/tests/test_site_standin_door.py` holds it to the door's
contract by reading the file, because CI has no PHP. It was run for real, under Apache
and PHP 8.3, when it was written.

**To retire it,** when the app's own door is reachable at this address: add the people in
`api/_private/.ht-requests.jsonl` to the app's `early-access` list, delete the `api/`
folder and `test_site_standin_door.py`, put the sentence about "Xylum's own database" back
on `privacy.html`, and work through "Hosting" steps 2 to 4 below.

## Hosting

Sam hosts this folder. agent_os never deploys it. While the stand-in door is in use, the
host must run PHP 8.1 or newer under Apache (Infomaniak's web hosting does).

**It is not a Node.js app.** The site is plain files: HTML, CSS, pictures and one small
script that runs in the visitor's browser. There is nothing to install, build or start,
and no `package.json`. The only program that runs on the server is the stand-in door, and
that is PHP. A host that serves files only (or runs Node.js only) shows every page, but
the form has nowhere to go there.

**A copy for hosting services to pull.** `scripts/site-publish.sh <git-url>` copies this
folder, as committed on main, into the root of another repository and pushes it as one
commit. Sam's is `git@github.com:sylvarisio/website-xylum.git` (2026-11-16). That
repository is an output: change the site here, publish again, and never edit it there.
When a host pulls it with git, two things matter:

- `.htaccess` in this folder stops Apache serving the `.git` folder and this README.
- The list file `api/_private/.ht-requests.jsonl` is not in git (the folder ignores its
  own contents), so a `git pull` leaves it alone. **A fresh clone, or `git clean`, would
  delete the list.** Copy the file somewhere safe before either, or set `PRIVATE_DIR`
  to a folder outside the site.

Before it goes live, work through this list:

0. **The stand-in door (until the hosted app exists).**
   - Upload the folder, **including the files whose names start with a dot**
     (`api/.htaccess`, `api/_private/.htaccess`). Many upload tools hide them.
     **Leave this `README.md` out of the upload:** it tells a stranger where the list
     file is.
   - `hello@xylum.io` must be a real mailbox on the hosting: the host refuses mail from a
     sender that does not exist.
   - PHP must be able to write in `api/_private/` (folder mode 755, or 775 if PHP runs as
     another user).
   - Test it once: fill in the form on the live `signup.html` with an address of your own.
     Three things must all be true. (1) You land on "Thanks. You are on the list".
     (2) **Your line is in the list file**: open `api/_private/.ht-requests.jsonl` in the
     host's file manager and find your address. A mail alone proves nothing about the
     list. If you land on "try again later" instead, PHP cannot write in `api/_private/`.
     (3) One mail arrives at `hello@xylum.io`. Then send the same address again: you land
     on "Thanks" once more and **no second mail comes**, which proves the door reads its
     list. Then open `https://xylum.io/api/_private/.ht-requests.jsonl` in a browser: it
     must be refused (403 or 404). If the file's text is shown, take the site down and
     move the private folder outside the web root.
   - Check that `hello@xylum.io` has no auto-reply switched on.
   - If every request under `/api/` answers 500, either PHP is older than 8.1 (set the
     site to 8.1 or newer) or the host does not allow `Options` in an `.htaccess`: delete
     `api/.htaccess` (it only switches folder listings off).
   - Delete your test line from `api/_private/.ht-requests.jsonl` afterwards.
   - Steps 2 to 4 below are for the app's own door and wait until the stand-in is retired.
1. **Confirm the removal mailbox.** The privacy note tells people to write to
   `privacy@sylvaris.io` (Sam, 2026-11-02 — it was `privacy@sylvaris.net`, which was never
   confirmed to exist). It is a **Sylvaris** address and not a Xylum one on purpose: the
   person who answers a privacy request is the data controller, which is the company, and
   that stays true if the product is ever renamed or sold. Sam also wants
   `privacy@xylum.io` to reach the same mailbox, so somebody who guesses the product
   address is not writing into a void — forward it, do not print it here as well.
   **CONFIRMED by Sam, 2026-11-02:** *"email works and confirmed as it is already in
   used"* — the mailbox exists, receives, and is already a working address rather than one
   created for this page. So this is no longer a precondition and no later audit should
   re-raise it. It had been carried as an assumption since 2026-10-17 and flagged twice
   without anybody checking; the lesson is that the check cost one email.
2. **Create and enable the list on the Xylum instance.** A list starts disabled.
   - Create it: `signups_create_list` with `slug` `early-access` and `return_url` set to the
     signup screen's own https URL: `https://xylum.io/signup.html`. The three answers a
     person is sent back to live on that page, not on the home page.
   - Turn it on: `signups_update_list` with `enabled=true`.
   - Both work over MCP, or over REST at `POST /api/v1/signups/signup-lists/` and a `PATCH`
     on the list.
3. **If the site is served from a different host than the Xylum instance,** make the form
   `action` in `signup.html` absolute, pointing at that instance:
   `https://<xylum-host>/api/v1/signups/public/early-access/`. A relative action only
   works when the page and the instance share a host.
4. **Body size is already fenced.** The instance's Caddy config limits the signup door's
   request body to 4096 bytes. Nothing to do here; check it is still in place.
5. **Serve it at `https://xylum.io`.** Every page's canonical link, `sitemap.xml`,
   `robots.txt` and `llms.txt` name that address (Sam, 2026-11-02: "Yes, one domain").
   If the site is ever served from another address, change `SITE_ORIGIN` in the test and
   every file the test then fails on.
