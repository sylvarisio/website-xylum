<?php
/*
 * The website's invitation door, a TEMPORARY stand-in for the app's.
 *
 * `site/signup.html` posts its form to /api/v1/signups/public/early-access/.
 * One day the hosted Xylum app answers that address (backend/xylum/signups/api.py,
 * PublicSignupView). Until then the static site is served by Apache + PHP, and this
 * file answers at the same address, so the page never changes when the app takes over.
 *
 * It answers like the app's door: a 303 back to the signup page with #joined,
 * #check-details or #try-later. A good request is kept as one JSON line in a private
 * log (time, email, name, the consent sentence, the list), and only once it is kept is
 * the owner mailed. Nothing else is kept: no IP address, no browser, no referrer.
 *
 * The log is the list; the mail is only the notice. If the log cannot be written, the
 * answer is try-later and no mail goes out, so a folder PHP cannot write to shows up
 * at once instead of looking like it works.
 *
 * Needs PHP 8.1 or newer (proved on 8.3). An older PHP 8 is meant to stop at the
 * version check below; PHP 7 cannot parse this file, so on PHP 7 no line of it runs.
 *
 * The private folder (PRIVATE_DIR) is safest above the web root, where no web request
 * can reach it; the default sits inside the web root behind a deny-all .htaccess.
 *
 * Retire it: delete site/api/ from the host and route this same path to the app.
 * Tests: backend/xylum/signups/tests/test_site_standin_door.py.
 */

declare(strict_types=1);

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
    echo "This form needs PHP 8.1 or newer on the server.\n";
    exit;
}

// --- configuration: the one place to change anything --------------------------------

// Who is told about each request.
const RECIPIENT = 'hello@xylum.io';
// From: and the envelope sender. Must be a real mailbox on the hosting.
const SENDER = 'hello@xylum.io';
// Where the browser is sent back to.
const RETURN_PAGE = '/signup.html';
// New requests kept per UTC clock hour, all callers together.
const HOURLY_LIMIT = 60;
// The private folder: the request log and the counter. It must exist and PHP must be
// able to write to it; if not, every request is answered try-later and nothing is
// mailed. Safer, where the host allows it: a folder above the web root, given as an
// absolute path, for example '/home/clients/abc123/xylum-private'. Change only this line.
const PRIVATE_DIR = __DIR__ . '/../../../../_private';

// --- fixed: the app's door says the same ----------------------------------------------

const LIST_SLUG = 'early-access';
// MAX_PUBLIC_SIGNUP_BYTES
const MAX_BYTES = 4096;
// DEFAULT_CONSENT_TEXT, byte for byte (backend/xylum/signups/models.py).
const CONSENT_TEXT = 'Yes, email me when Xylum early access opens. '
    . 'Keep my address and name for that alone, and remove them when I ask.';
// Both start `.ht`: a stock Apache refuses to serve such a file even without .htaccess.
const LOG_FILE = '.ht-requests.jsonl';
const RATE_FILE = '.ht-rate';
const JOINED = '#joined';
const CHECK = '#check-details';
const LATER = '#try-later';

ini_set('display_errors', '0');
header_remove('X-Powered-By');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}
$media = strtolower(trim(explode(';', (string) ($_SERVER['CONTENT_TYPE'] ?? ''), 2)[0]));
if ($media !== 'application/x-www-form-urlencoded') {
    problem(415, 'Unsupported media type', 'Send the form as a form post.');
}
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BYTES) {
    problem(413, 'Delivery too large', 'One delivery may carry at most ' . MAX_BYTES . ' bytes.');
}
$raw = (string) @file_get_contents('php://input', false, null, 0, MAX_BYTES + 1);
if (strlen($raw) > MAX_BYTES) {
    problem(413, 'Delivery too large', 'One delivery may carry at most ' . MAX_BYTES . ' bytes.');
}
try {
    [$fragment, $wait] = decide($raw);
} catch (Throwable) {
    [$fragment, $wait] = [LATER, 600];
}
http_response_code(303);
header('Location: ' . RETURN_PAGE . $fragment);
if ($wait !== null) {
    header('Retry-After: ' . $wait);
}
exit;

/** @return array{0: string, 1: ?int} the fragment, and Retry-After seconds for try-later */
function decide(string $raw): array
{
    if (preg_match('//u', $raw) !== 1) {
        return [CHECK, null];
    }
    $form = form_fields($raw);
    // A filled honeypot is spam: nothing kept, nothing sent, and the success answer.
    if (is_bot($form['website'])) {
        return [JOINED, null];
    }
    if ($form['consent'] !== 'yes') {
        return [CHECK, null];
    }
    $email = clean_email($form['email']);
    $name = clean_name($form['name']);
    if ($email === null || $name === null) {
        return [CHECK, null];
    }

    // The flood brake: one counter for everyone, per UTC clock hour. It fails closed:
    // a counter that cannot be opened, locked or read refuses rather than lets through.
    $existed = is_file(PRIVATE_DIR . '/' . RATE_FILE);
    $rate = @fopen(PRIVATE_DIR . '/' . RATE_FILE, 'c+');
    if ($rate === false) {
        return [LATER, 600];
    }
    if (!flock($rate, LOCK_EX)) {
        fclose($rate);
        return [LATER, 600];
    }
    try {
        $hour = gmdate('Y-m-d\TH');
        $count = hour_count($rate, $hour, $existed);
        if ($count >= HOURLY_LIMIT) {
            return [LATER, 3600 - (time() % 3600)];
        }
        $row = ['time' => gmdate('Y-m-d\TH:i:s\Z'), 'email' => $email, 'name' => $name, 'consent' => CONSENT_TEXT, 'list' => LIST_SLUG];
        [$kept, $already] = keep($row);
        if ($already) {
            // Already asked: the same answer as joined, and no second mail.
            return [JOINED, null];
        }
        if (!$kept) {
            // The log is the list. Not kept means not joined, and no mail.
            return [LATER, 600];
        }
        write_count($rate, $hour, $count + 1);
    } finally {
        flock($rate, LOCK_UN);
        fclose($rate);
    }
    // Kept, so joined, whether or not the notice reaches the owner.
    tell($row);
    return [JOINED, null];
}

/**
 * The four fields the form sends, last value wins (as the app's QueryDict.get).
 * Anything else the body carried is never read.
 *
 * @return array{email: ?string, name: ?string, consent: ?string, website: ?string}
 */
function form_fields(string $raw): array
{
    $fields = ['email' => null, 'name' => null, 'consent' => null, 'website' => null];
    foreach (explode('&', $raw) as $pair) {
        if ($pair === '') {
            continue;
        }
        $parts = explode('=', $pair, 2);
        $key = urldecode($parts[0]);
        if (array_key_exists($key, $fields)) {
            $fields[$key] = urldecode($parts[1] ?? '');
        }
    }
    return $fields;
}

/** The honeypot is filled: any text, or bytes that are not even text. */
function is_bot(?string $website): bool
{
    return $website !== null && (preg_match('//u', $website) !== 1 || strip($website) !== '');
}

/** Leading and trailing whitespace off, Unicode spaces included (Python's str.strip). */
function strip(string $text): string
{
    return preg_replace('/\A[\s\p{Z}]+|[\s\p{Z}]+\z/u', '', $text) ?? $text;
}

/** The address trimmed and lowercased, or null for one the app's door would refuse. */
function clean_email(?string $value): ?string
{
    if ($value === null || preg_match('//u', $value) !== 1) {
        return null;
    }
    $text = strip($value);
    $bare = '/\A[^\s<>,;"\x00-\x1f\x7f]+@[^\s<>,;"\x00-\x1f\x7f]+\z/';
    if (strlen($text) > 254 || preg_match($bare, $text) !== 1) {
        return null;
    }
    // Plain ASCII addresses only, with a dot in the domain (Django wants a top-level domain).
    if (filter_var($text, FILTER_VALIDATE_EMAIL) === false || !str_contains(substr($text, strrpos($text, '@') + 1), '.')) {
        return null;
    }
    return one_line(strtolower($text));
}

/** The name trimmed, '' when absent, or null for one the app's door would refuse. */
function clean_name(?string $value): ?string
{
    if ($value === null) {
        return '';
    }
    if (preg_match('//u', $value) !== 1) {
        return null;
    }
    $text = strip($value);
    // At most 120 characters, and no control, format, private-use, unassigned or
    // line/paragraph separator character (the app's set): CR and LF included.
    if (preg_match('/\A.{0,120}\z/su', $text) !== 1 || preg_match('/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u', $text) === 1) {
        return null;
    }
    return $text;
}

/**
 * This hour's count from the locked counter file. The file holds one fixed-width
 * record, `YYYY-MM-DDTHH NNNNNN`. A file that does not exist yet starts the hour at
 * zero. A file that exists but cannot be read as a record counts as FULL for the hour
 * in which it was last written, so the brake closes, and opens again when the hour turns.
 *
 * @param resource $rate
 */
function hour_count($rate, string $hour, bool $existed): int
{
    $text = stream_get_contents($rate);
    if ($text === '' && !$existed) {
        write_count($rate, $hour, 0);
        return 0;
    }
    if (is_string($text) && preg_match('/\A(\d{4}-\d\d-\d\dT\d\d) (\d{6})\z/', $text, $found) === 1) {
        return $found[1] === $hour ? (int) $found[2] : 0;
    }
    $stat = fstat($rate);
    $written = is_array($stat) ? gmdate('Y-m-d\TH', $stat['mtime']) : $hour;
    return $written === $hour ? HOURLY_LIMIT : 0;
}

/**
 * Write the record over the old one, then cut the file to its length. Every record
 * has the same width, so a write that stops short leaves an unreadable file, which
 * counts as full (see hour_count), never as empty.
 *
 * @param resource $rate
 */
function write_count($rate, string $hour, int $count): bool
{
    $text = sprintf('%s %06d', $hour, min($count, 999999));
    rewind($rate);
    $written = fwrite($rate, $text) === strlen($text) && fflush($rate);
    ftruncate($rate, strlen($text));
    return $written;
}

/**
 * Append the row to the private log unless the address is already there.
 *
 * @param array<string, string> $row
 * @return array{0: bool, 1: bool} [kept in full, already there]
 */
function keep(array $row): array
{
    $log = @fopen(PRIVATE_DIR . '/' . LOG_FILE, 'c+');
    if ($log === false) {
        return [false, false];
    }
    if (!flock($log, LOCK_EX)) {
        fclose($log);
        return [false, false];
    }
    $last = "\n";
    while (($line = fgets($log)) !== false) {
        $last = $line;
        $seen = json_decode($line, true);
        if (is_array($seen) && ($seen['email'] ?? null) === $row['email']) {
            flock($log, LOCK_UN);
            fclose($log);
            return [false, true];
        }
    }
    $line = json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
    // An earlier write that stopped short left a line with no end: start a fresh one.
    if (!str_ends_with($last, "\n")) {
        $line = "\n" . $line;
    }
    fseek($log, 0, SEEK_END);
    $size = ftell($log);
    $kept = fwrite($log, $line) === strlen($line) && fflush($log);
    if (!$kept && is_int($size)) {
        // A short write: take the half line back off, so the log holds whole lines only.
        ftruncate($log, $size);
    }
    flock($log, LOCK_UN);
    fclose($log);
    return [$kept, false];
}

/**
 * Mail the owner one plain-text message. Only the validated address reaches a header.
 *
 * @param array<string, string> $row
 */
function tell(array $row): bool
{
    $body = "time: {$row['time']}\n"
        . "email: {$row['email']}\n"
        . "name: {$row['name']}\n"
        . "consent: {$row['consent']}\n"
        . "list: {$row['list']}\n";
    $headers = [
        'From' => 'Xylum website <' . SENDER . '>',
        'Reply-To' => one_line($row['email']),
        'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=UTF-8',
        'Content-Transfer-Encoding' => '8bit',
    ];
    try {
        return @mail(RECIPIENT, 'Xylum invitation request: ' . one_line($row['email']), $body, $headers, '-f' . SENDER);
    } catch (Throwable) {
        return false;
    }
}

/** The text with every CR and LF removed: nothing can open a new mail header. */
function one_line(string $text): string
{
    return str_replace(["\r", "\n"], '', $text);
}

/** A refusal before the form is read: the app's problem+json shape, a fixed sentence. */
function problem(int $status, string $title, string $detail): never
{
    http_response_code($status);
    header('Content-Type: application/problem+json');
    echo json_encode(['type' => 'about:blank', 'title' => $title, 'status' => $status, 'detail' => $detail]);
    exit;
}
