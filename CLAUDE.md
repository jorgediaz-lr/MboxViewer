# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-dependency, client-side mbox viewer for Gmail Takeout exports. Pure static HTML/CSS/JS — no build step, no package manager, no tests, no server. All email parsing happens in the browser; nothing leaves the machine.

## Running it

Open `index.html` directly in a browser, or serve the directory (e.g. `python3 -m http.server`) and open it. There is nothing to build, lint, or test. `test.html` is a throwaway "is JS running" sanity page, not a test suite.

## The single source file

All app logic lives in **`script.js`**, loaded by `index.html`. Its ES5 style is intentional (older-browser compatibility): `var`, prototype methods, no arrow functions, `(function(i, el){...})(i, el)` closures for click handlers, manual `.replace(/^\s+|\s+$/g,'')` instead of `.trim()`. Match that style when editing.

## Architecture

Two prototype "classes":
- **`MboxParser`** — the parsing/decoding engine. `parseMboxFile` splits the raw text on `/^From /m` (the mbox record separator), then `parseEmail` walks line-by-line: header mode (with RFC folded-header unfolding) until the first blank line, then body. It then recursively walks the MIME tree via `processMimePart` (boundary parsed from the `Content-Type` header, nested multipart supported) and fills three fields on each email: **`bodyHtml`**, **`bodyText`**, and **`attachments[]`** (`{filename, contentType, encoding, data, size}`). `email.body` is the plain-text projection (text part, else stripped HTML) used for search (built lazily via `getSearchText`). Decoding: the file is read as **raw bytes** (`readAsArrayBuffer` → `bufferToBinaryString`, one char per byte) rather than as UTF-8, so each part's bytes survive intact; every leaf part — base64, quoted-printable, **and 7bit/8bit** — is then decoded with its declared charset via `decodeBytes` (browser `TextDecoder`: utf-8, windows-125x, iso-8859-*, shift_jis, gb18030, big5, …; falls back to UTF-8). Encoded-word headers (`=?charset?B/Q?...?=`) decode the same way. This is what lets non-UTF-8 8-bit parts (e.g. `charset=windows-1252` + `Content-Transfer-Encoding: 8bit`) display correctly.
- **`MboxViewer`** — UI + the **index + lazy-load** model. It does NOT keep parsed emails in memory. `displayEmail(email)` renders `bodyHtml` in a **sandboxed `<iframe sandbox="">`** (markup/CSS render, scripts/forms/same-origin blocked), falls back to plain text via `textContent`, and lists attachments with Download buttons (`attachmentToBlob` → object URL). `parseMboxFile` is retained only for the Node tests.

Flow: `handleFileSelect` → `processFile` → `buildIndex` (stream the file once) → `renderList` (from the index) → click a row → `openEmail` → `loadEmail` (slice + parse that one message) → `displayEmail`.

## Index-based loading (all file sizes, no chunk navigation)

There is **one** path for every file size — memory stays ~constant regardless of size:
- `streamMessages(file, onMessage, onProgress, onComplete)` is the single streaming primitive: it reads the file in `indexSliceSize` (default 8 MB) slices and calls `onMessage(rawText, offset, length)` per complete mbox message. A **tail buffer carries the partial trailing message across slice boundaries**, so a message straddling a slice edge is never truncated. **Key invariant:** `combined[0]` is a message start whenever it begins with `From ` (true for the first slice and for every carried partial) — that's why the start-of-combined detection is NOT gated on `base === 0`; gating it there drops every message whose start was consumed in a previous slice.
- `buildIndex` uses `streamMessages` to build `this.index`: one lightweight entry per message `{offset, length, from, to, subject, date, dateValue, messageId, gmailLabels}` (headers only, via `parseHeaderFields`/`extractHeaderBlock`), dropping `Trash`-labeled emails for **all** files.
- `loadEmail(entry, cb)` reads `file.slice(offset, offset+length)` on demand and full-parses that one message, with a ~20-entry LRU (`viewCache`/`viewOrder`).
- Search: free-text (`criteria.text`) streams the file again parsing bodies (`matchesCriteria` on full emails, with progress); metadata-only filters (sender/label/date) run instantly over the index (`filterIndex`). `this.filtered` is the currently shown subset of index entries; `renderList`/`loadMore` page it (first 1000 + Load More).

## Gotchas before you edit

- **The viewer renders from the index, not from parsed emails.** `MboxViewer` keeps `this.index` (lightweight metadata + byte offsets) and `this.filtered`; it loads a full email only on click via `loadEmail`. Don't reintroduce an in-memory "all emails" array for rendering/search — that's the ~2.5×-file-size memory blow-up the index design removed.
- **`streamMessages` boundary handling fixes the old chunk-truncation bug — don't regress it.** The carried partial message and the "`From ` at `combined[0]`" detection are load-bearing; the `test-index.js` 7-byte-slice test guards it (tiny slices must yield an identical index to one big slice).
- **HTML bodies render in a sandboxed iframe, not via `innerHTML`.** Email HTML is untrusted — it goes into `<iframe sandbox="">` (no `allow-scripts`/`allow-same-origin`). Never switch it to `innerHTML`. Header fields and attachment names still go through `escapeHtml`; keep that. Inline `cid:` images are rewritten to embedded `data:` URLs before rendering (`inlineCidImages`, matching on each part's `contentId`); the iframe also carries a CSP (`default-src 'none'; img-src data:; …`) that blocks every remote subresource, so external (http) images and tracking pixels never load.

## Tests

Node harnesses in the scratchpad (not committed) shim `document`/`FileReader`/`atob`/`btoa` and `eval` the script: `test-parser.js` (parse/charset/attachments) and `test-index.js` (index offsets, boundary-straddling, lazy load). Run with `node <file>`.

## Project status

Feature-complete: HTML/MIME rendering, charset decoding, attachments, search + sender/label/date filters, keyboard nav, and bookmarking (last-opened email per file, in `localStorage`) are all done. The chunk-boundary truncation bug and the memory/1 GB-threshold issues are resolved by the index design above. See `README.md` ("How It Works") for the user-facing technical overview.
