# Mbox File Viewer

A fast, fully client-side viewer for `mbox` email archives — Gmail Takeout, Thunderbird folders, and other clients. Open `index.html`, pick a file, and browse: nothing is uploaded, nothing is installed, and even multi-gigabyte archives open without running out of memory.

## Features

- 📧 View mbox files from Gmail Takeout, Thunderbird (including extensionless folders), and other clients
- 🗂️ Handles very large archives (multi-GB) by building an index and loading each email on demand
- 🧩 Full MIME support: HTML emails (rendered in a sandboxed iframe), inline `cid:` images, attachments (download), correct character-set decoding, and `.eml` export
- 🔍 Full-text search plus filters by sender, Gmail label, and date range
- 🔖 Resumes where you left off (remembers the last-opened email per file)
- 📱 Responsive design that works on desktop and mobile
- ⚡ Fast client-side processing with no server required
- 🔒 Completely private — all processing happens in your browser

## How to Use

1. **Open the viewer**: open `index.html` in your web browser (or serve the folder, e.g. `python3 -m http.server`)
2. **Load an mbox file**: click "Choose Mbox File" and select your file — it is indexed (a progress bar shows), then the email list appears
3. **Browse emails**: click any email in the left panel to view it (or use ↑/↓ / j / k)
4. **Search & filter**: type in the search box for full-text search, or filter by sender, label, or date range
5. **Resume**: reopen the same file later and it returns you to the last email you were reading

## Getting an mbox file

**Gmail** — via [Google Takeout](https://takeout.google.com): select **Mail**, choose the mbox format, download and extract the archive, then open the `.mbox` file here.

**Thunderbird** — mbox folders live under your profile's `Mail`/`ImapMail` directories. They are plain files, often **without an extension** (e.g. `Inbox`, `Sent`); this viewer accepts those.

## How It Works

The viewer is built around an **offset index + lazy loading** so that opening a file never depends on its size fitting in memory.

### Loading model

When you pick a file, it is **streamed once** in 8 MB slices to build an in-memory **index** — one lightweight entry per message holding just its metadata and its byte position in the file. Email bodies, attachments, and raw source are **not** kept in memory; they are read and parsed **on demand** when you open a message (with a small LRU cache for re-clicks). A `Trash`-labeled email is dropped during indexing.

Memory therefore scales with the *number* of emails, not the size of the file. Verified on real archives:

| Size | Emails | Index build | Open one email |
|------|--------|-------------|----------------|
| 103 MB | 961 | < 1 s | ~3 ms |
| 1.04 GB | 58,987 | ~17 s | ~3 ms |
| 2.35 GB | 107,871 | ~47 s | ~3 ms |

(For comparison, the earlier "parse everything into memory" approach retained ~2.5× the file size — ~263 MB for the 103 MB archive — and would exhaust a browser tab's heap well before 2 GB.)

### Streaming and message boundaries

A single primitive, `streamMessages`, reads the file slice by slice and emits each complete mbox message (split on lines beginning with `From `). It carries a partial trailing message in a buffer across slice boundaries, so a message that straddles a slice edge is **never** truncated — a class of bug that fixed-window chunking is prone to. The exact byte offset and length of every message are recorded in the index, which is what makes on-demand loading (`file.slice(offset, length)`) possible.

### Parsing and decoding

The file is read as **raw bytes**, not as UTF-8 text, so each MIME part keeps its original bytes. Parsing then:

- walks the MIME tree recursively (nested multipart; boundary taken from the `Content-Type` header);
- decodes each part's transfer encoding (base64, quoted-printable, 7bit/8bit);
- decodes the bytes with the part's **declared charset** via the browser's `TextDecoder` (utf-8, windows-125x, iso-8859-\*, shift_jis, gb18030, big5, …), so non-UTF-8 8-bit bodies (e.g. `charset=windows-1252` + `Content-Transfer-Encoding: 8bit`) render correctly; encoded-word headers (`=?charset?B/Q?…?=`) decode the same way;
- renders HTML in a **sandboxed `<iframe>`** (scripts, forms, and same-origin access blocked) with a **Content-Security-Policy that blocks every remote subresource** (images, CSS, fonts), so opening an email can't load remote content such as tracking pixels; inline `cid:` images are rewritten to embedded `data:` URLs and still display. Attachments are collected for download, and the whole message can be exported as `.eml`.

### Search, filtering, and bookmarks

- **Metadata filters** (sender, Gmail label, date range) run **instantly** over the index.
- **Full-text search** (subject + body) streams the file again, parsing bodies and matching with a progress bar — bounded memory, at the cost of re-reading the file.
- **Bookmarks**: opening an email records its byte offset in `localStorage`, keyed by file name + size; reopening the same file returns you to that email.

### Architecture

Two ES5 prototype "classes" in `script.js`:

- **`MboxParser`** — parsing/decoding: `parseEmail` / `parseHeaderFields`, recursive `processMimePart`, `decodeBytes` (charset), `attachmentToBlob`, and `matchesCriteria` (the shared filter predicate).
- **`MboxViewer`** — the index + lazy-load UI: `streamMessages`, `buildIndex`, `loadEmail` (on-demand slice + parse with an LRU cache), `renderList`, search/filter, and `saveBookmark`/`restoreBookmark`. It does not retain parsed emails.

Each index entry is small and body-independent:

```js
indexEntry = {
  offset, length,     // byte position of the message in the file
  from, to, subject,  // decoded, for the list + filtering
  date, dateValue,    // display string + sortable timestamp
  messageId,
  gmailLabels
}
```

### Tradeoffs

- Opening an email is a tiny **asynchronous** read (a few ms) rather than an instant in-memory lookup; re-opens hit the cache.
- Full-text search **re-reads the file** each time (bounded memory, with progress) instead of scanning an in-memory array.
- The one-time index build reads the whole file, so open time scales with size (~50–60 MB/s, read-bound).

## File Structure

```
├── index.html          # Main HTML file - open this in your browser
├── styles.css          # Styling and layout
├── script.js    # Parsing, decoding, and UI logic (vanilla ES5)
└── README.md           # This file
```

## Browser Compatibility

Works in modern browsers: Chrome/Edge 80+, Firefox 75+, Safari 13+. (Uses `FileReader`, `File.slice`, `TextDecoder`, `Blob`, and iframe `srcdoc`.)

## Privacy

All processing happens entirely in your browser. No data is sent to any server, so your emails never leave your machine.

## Limitations

- Remote (`http`) images and other external resources in HTML mail are **blocked** by the render iframe's Content-Security-Policy (so opening an email can't phone home); only inline (`cid:`) images, embedded as `data:` URLs, are shown. Thunderbird `<attachment …>` placeholder text left in replies still can't be recovered, since that data isn't in the file
- mbox messages are split on postmark lines (`From … <year>`); a body line that looks like a postmark (begins with `From ` and contains a 4-digit year) could still be mis-detected as a boundary
- Full-text body search re-reads the file each time (bounded memory, shows progress)
- The one-time index build reads the whole file, so opening a very large archive takes a few seconds

## License

This project is open source and licensed under the **GNU Affero General Public License, Version 3 (AGPLv3)**.

Original components from the first commit are licensed under the **MIT License** by the initial author. See the `LICENSE` file for full copyright notices and license text of both components.
