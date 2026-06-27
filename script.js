// Copyright (C) 2026 chauyan wang <wang.chauyan@gmail.com>
// Copyright (C) 2026 Jorge Díaz <jorge.diaz@liferay.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
function MboxParser() {
    this.emails = [];
    this.filteredEmails = [];
}

// Split mbox content into individual raw message strings (each starting "From ").
MboxParser.prototype.splitMessages = function(content) {
    var parts = content.split(/^From /m);
    var messages = [];
    // parts[0] is the preamble before the first "From " separator
    for (var i = 1; i < parts.length; i++) {
        messages.push('From ' + parts[i]);
    }
    return messages;
};

MboxParser.prototype.parseMboxFile = function(content) {
    this.emails = [];
    var messages = this.splitMessages(content);
    for (var i = 0; i < messages.length; i++) {
        var email = this.parseEmail(messages[i]);
        if (email) {
            this.emails.push(email);
        }
    }
    this.filteredEmails = this.emails.slice();
    return this.emails;
};

MboxParser.prototype.parseEmail = function(rawEmail) {
    // Normalize line endings once, then split the message into its header block
    // and body at the first blank line (after the mbox "From " envelope line).
    var normalized = rawEmail.replace(/\r\n/g, '\n');
    var headerStart = (normalized.indexOf('From ') === 0) ? normalized.indexOf('\n') + 1 : 0;
    var blankLine = normalized.indexOf('\n\n', headerStart);

    var headerBlock, rawBody;
    if (blankLine === -1) {
        headerBlock = normalized.substring(headerStart);
        rawBody = '';
    } else {
        headerBlock = normalized.substring(headerStart, blankLine);
        rawBody = normalized.substring(blankLine + 2).replace(/^\s+/, '');
    }

    var email = this.parseHeaderFields(headerBlock);
    email.bodyText = '';
    email.bodyHtml = '';
    email.attachments = [];
    email.raw = rawEmail;

    // Walk the MIME tree to populate bodyText, bodyHtml and attachments. The
    // searchable plain-text projection (email.body) is built lazily on first
    // search via getSearchText, since most emails are never searched.
    var h = email.headers;
    this.processMimePart(
        email,
        h['content-type'] || 'text/plain',
        h['content-transfer-encoding'] || '',
        h['content-disposition'] || '',
        rawBody,
        h['content-id'] || ''
    );

    return email;
};

// Extract the metadata fields from a header block (no body/MIME parsing). Shared
// by parseEmail (full parse) and the index builder (metadata + offset only).
MboxParser.prototype.parseHeaderFields = function(headerBlock) {
    var h = this.parseHeaders(headerBlock);
    var email = {
        from: '',
        to: '',
        subject: '',
        date: '',
        dateValue: null,
        messageId: '',
        headers: h
    };
    if (h.from) {
        email.from = this.parseEmailAddress(this.decodeHeader(h.from)).replace(/\r?\n/g, '');
    }
    if (h.to) {
        email.to = this.parseEmailAddress(this.decodeHeader(h.to)).replace(/\r?\n/g, '');
    }
    if (h.subject) {
        email.subject = this.decodeHeader(h.subject).replace(/\r?\n/g, '');
    }
    if (h.date) {
        // Parse once; derive both the display string and the filterable timestamp
        var parsedDate = new Date(h.date);
        var dateTime = parsedDate.getTime();
        email.dateValue = isNaN(dateTime) ? null : dateTime;
        try {
            email.date = parsedDate.toLocaleString();
        } catch (e) {
            email.date = h.date;
        }
    }
    if (h['message-id']) {
        email.messageId = h['message-id'].replace(/\r?\n/g, '');
    }
    if (h['x-gmail-labels']) {
        email.gmailLabels = this.parseGmailLabels(h['x-gmail-labels']);
    }
    if (h['x-gmail-received']) {
        email.gmailReceived = h['x-gmail-received'];
    }
    if (h['x-gmail-message-state']) {
        email.gmailState = h['x-gmail-message-state'];
    }
    if (h['x-gmail-thread-id']) {
        email.gmailThreadId = h['x-gmail-thread-id'];
    }
    return email;
};

// Header block of a raw message (\n-normalized), without scanning the body.
MboxParser.prototype.extractHeaderBlock = function(rawMessage) {
    var firstNl = rawMessage.indexOf('\n');
    var start = (rawMessage.indexOf('From ') === 0 && firstNl !== -1) ? firstNl + 1 : 0;
    var lf = rawMessage.indexOf('\n\n', start);
    var crlf = rawMessage.indexOf('\r\n\r\n', start);
    var end;
    if (lf === -1) {
        end = (crlf === -1) ? rawMessage.length : crlf;
    } else if (crlf === -1) {
        end = lf;
    } else {
        end = Math.min(lf, crlf);
    }
    return rawMessage.substring(start, end).replace(/\r\n/g, '\n');
};

MboxParser.prototype.hasTrashLabel = function(labels) {
    if (!labels) return false;
    for (var i = 0; i < labels.length; i++) {
        if (labels[i].toLowerCase() === 'trash') return true;
    }
    return false;
};

MboxParser.prototype.parseEmailAddress = function(address) {
    var match = address.match(/^(.+?)\s*<(.+?)>$/) || address.match(/^(.+)$/);
    if (match) {
        return match.length > 2 ? (match[1].replace(/^\s+|\s+$/g, '') + ' <' + match[2] + '>') : match[1].replace(/^\s+|\s+$/g, '');
    }
    return address;
};

MboxParser.prototype.decodeHeader = function(header) {
    if (!header) return header;
    
    // Handle MIME encoded-word format =?charset?encoding?data?=
    if (header.indexOf('=?') !== -1) {
        try {
            return header.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function(match, charset, encoding, data) {
                try {
                    if (encoding.toLowerCase() === 'b') {
                        // Base64 -> bytes -> charset
                        return this.decodeBytes(atob(data), charset);
                    } else if (encoding.toLowerCase() === 'q') {
                        // Quoted-printable -> bytes -> charset ('_' means space)
                        var decoded = data.replace(/[=]([0-9A-F]{2})/gi, function(m, hex) {
                            return String.fromCharCode(parseInt(hex, 16));
                        }).replace(/_/g, ' ');
                        return this.decodeBytes(decoded, charset);
                    }
                } catch (e) {
                    console.log('Error decoding header part:', match, e);
                    return data;
                }
                return data;
            }.bind(this));
        } catch (e) {
            console.log('Error decoding header:', header, e);
            return header;
        }
    }
    
    // Handle quoted-printable encoding without MIME wrapper
    if (header.indexOf('=') !== -1) {
        try {
            return header.replace(/=([0-9A-F]{2})/gi, function(match, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });
        } catch (e) {
            return header;
        }
    }
    
    return header;
};

MboxParser.prototype.decodeUtf8 = function(str) {
    try {
        // Try to decode as UTF-8
        return decodeURIComponent(escape(str));
    } catch (e) {
        // If that fails, return as-is
        return str;
    }
};

// Decode a raw byte string (chars 0-255) using the declared charset. Uses the
// browser's TextDecoder, which covers the WHATWG encodings (utf-8, iso-8859-*,
// windows-125*, shift_jis, euc-jp/kr, gb18030, big5, koi8-*, ...). Falls back
// to UTF-8 for unknown labels, and to decodeUtf8 where TextDecoder is missing.
MboxParser.prototype.decodeBytes = function(binary, charset) {
    charset = (charset || 'utf-8').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (typeof TextDecoder !== 'undefined') {
        try {
            return new TextDecoder(charset).decode(this.stringToBytes(binary));
        } catch (e) {
            try {
                return new TextDecoder('utf-8').decode(this.stringToBytes(binary));
            } catch (e2) {
                // fall through
            }
        }
    }
    return this.decodeUtf8(binary);
};

MboxParser.prototype.processMimePart = function(email, contentType, transferEncoding, disposition, body, contentId) {
    contentType = contentType || 'text/plain';
    var lowerType = contentType.toLowerCase();

    // Multipart container: split on its declared boundary and recurse into each part
    if (lowerType.indexOf('multipart/') !== -1) {
        var boundary = this.getMimeParameter(contentType, 'boundary');
        if (boundary) {
            var parts = this.splitMimeParts(body, boundary);
            for (var i = 0; i < parts.length; i++) {
                this.parseMimePartString(email, parts[i]);
            }
        } else {
            // Malformed multipart without a boundary - decode the raw bytes as text
            email.bodyText += this.decodeBytes(body, this.getMimeParameter(contentType, 'charset'));
        }
        return;
    }

    // Leaf part: a non-text part (image/application/...) is always stored as a
    // resource — whether its disposition is inline, attachment or absent — so
    // inline images resolve via cid: and others can be downloaded. text/* is the
    // displayable body unless it's explicitly an attachment.
    var lowerDisp = (disposition || '').toLowerCase();
    var isAttachment = lowerDisp.indexOf('attachment') !== -1 ||
        lowerType.indexOf('text/') === -1;

    if (isAttachment) {
        var filename = this.getMimeParameter(disposition, 'filename') ||
            this.getMimeParameter(contentType, 'name') ||
            'attachment';
        email.attachments.push({
            filename: this.decodeHeader(filename),
            contentType: contentType.split(';')[0].replace(/^\s+|\s+$/g, ''),
            encoding: (transferEncoding || '').toLowerCase().replace(/^\s+|\s+$/g, ''),
            // Content-ID (angle brackets stripped) lets HTML cid: refs resolve to this part
            contentId: (contentId || '').replace(/^\s+|\s+$/g, '').replace(/^<|>$/g, ''),
            data: body,
            size: this.estimateDecodedSize(body, transferEncoding)
        });
        return;
    }

    var charset = this.getMimeParameter(contentType, 'charset');
    var decoded = this.decodeTransferEncoding(body, transferEncoding, charset);
    if (lowerType.indexOf('text/html') !== -1) {
        email.bodyHtml += decoded;
    } else {
        email.bodyText += decoded;
    }
};

MboxParser.prototype.parseMimePartString = function(email, partString) {
    // A sub-part carries its own headers, then a blank line, then its body
    var separator = partString.indexOf('\n\n');
    var headerBlock = '';
    var partBody = partString;

    if (separator !== -1) {
        headerBlock = partString.substring(0, separator);
        partBody = partString.substring(separator + 2);
    }

    var headers = this.parseHeaders(headerBlock);
    this.processMimePart(
        email,
        headers['content-type'] || 'text/plain',
        headers['content-transfer-encoding'] || '',
        headers['content-disposition'] || '',
        partBody,
        headers['content-id'] || ''
    );
};

// Parse an RFC 822 header block (newline-normalized) into a lowercased-name map,
// merging folded continuation lines. Shared by the message and its MIME parts.
MboxParser.prototype.parseHeaders = function(headerBlock) {
    var headers = {};
    if (!headerBlock) return headers;

    var lines = headerBlock.split('\n');
    var lastHeader = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && lastHeader !== null) {
            headers[lastHeader] += ' ' + line.replace(/^\s+/, '');
            continue;
        }

        var colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            var name = line.substring(0, colonIndex).toLowerCase();
            var value = line.substring(colonIndex + 1).replace(/^\s+/, '');
            headers[name] = value;
            lastHeader = name;
        }
    }

    return headers;
};

MboxParser.prototype.splitMimeParts = function(body, boundary) {
    var delimiter = '--' + boundary;
    var rawParts = body.split(delimiter);
    var parts = [];

    for (var i = 0; i < rawParts.length; i++) {
        // Index 0 is the preamble before the first boundary - ignore it
        if (i === 0) continue;

        var part = rawParts[i];

        // The closing delimiter is "--boundary--", so a part starting with "--"
        // marks the end of this multipart block
        if (part.charAt(0) === '-' && part.charAt(1) === '-') {
            break;
        }

        // Drop the line break that immediately follows the boundary delimiter
        parts.push(part.replace(/^\r?\n/, ''));
    }

    return parts;
};

MboxParser.prototype.getMimeParameter = function(headerValue, paramName) {
    if (!headerValue) return '';

    // Match param="quoted value" or param=bare-value in a single pass; cache the
    // compiled regex per parameter name (a tiny fixed set: boundary/filename/name).
    var cache = this._paramRegexCache || (this._paramRegexCache = {});
    var re = cache[paramName] ||
        (cache[paramName] = new RegExp(paramName + '\\s*=\\s*(?:"([^"]*)"|([^;\\r\\n\\s]+))', 'i'));

    var match = headerValue.match(re);
    if (!match) return '';
    return match[1] !== undefined ? match[1] : match[2];
};

// --- Transfer-encoding primitives (shared by the text and byte decode paths) ---

MboxParser.prototype.cleanBase64 = function(data) {
    return data.replace(/[^A-Za-z0-9+/=]/g, '');
};

// Quoted-printable -> raw byte string: drop soft line breaks, turn =XX into a byte.
MboxParser.prototype.decodeQuotedPrintable = function(content) {
    return content
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, function(match, hex) {
            return String.fromCharCode(parseInt(hex, 16));
        });
};

MboxParser.prototype.stringToBytes = function(binary) {
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    return bytes;
};

MboxParser.prototype.decodeTransferEncoding = function(content, encoding, charset) {
    encoding = (encoding || '').toLowerCase().replace(/^\s+|\s+$/g, '');

    if (encoding.indexOf('base64') !== -1) {
        try {
            return this.decodeBytes(atob(this.cleanBase64(content)), charset);
        } catch (e) {
            return content;
        }
    }

    if (encoding.indexOf('quoted-printable') !== -1) {
        return this.decodeBytes(this.decodeQuotedPrintable(content), charset);
    }

    // 7bit / 8bit / binary: content is the raw bytes (read verbatim), so decode
    // them with the part's declared charset.
    return this.decodeBytes(content, charset);
};

MboxParser.prototype.estimateDecodedSize = function(data, encoding) {
    if ((encoding || '').toLowerCase().indexOf('base64') !== -1) {
        return Math.floor(this.cleanBase64(data).length * 3 / 4);
    }
    return data.length;
};

// Lazily build and cache the searchable plain-text projection: the text part
// plus the stripped HTML, so a search term present in either body is matched.
MboxParser.prototype.getSearchText = function(email) {
    if (typeof email.body !== 'string') {
        var parts = [];
        if (email.bodyText) {
            parts.push(email.bodyText);
        }
        var htmlText = this.stripHtml(email.bodyHtml);
        if (htmlText) {
            parts.push(htmlText);
        }
        email.body = parts.join('\n');
    }
    return email.body;
};

MboxParser.prototype.stripHtml = function(html) {
    if (!html) return '';
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/^\s+|\s+$/g, '');
};

// Decode an attachment's transfer encoding to a raw byte string (chars 0-255).
// Single dispatch shared by the Blob (download) and data-URL (inline) paths.
// attachment.encoding is already lowercased/trimmed at parse time.
MboxParser.prototype.attachmentBytes = function(attachment) {
    var encoding = attachment.encoding || '';
    if (encoding.indexOf('base64') !== -1) {
        return atob(this.cleanBase64(attachment.data));
    }
    if (encoding.indexOf('quoted-printable') !== -1) {
        return this.decodeQuotedPrintable(attachment.data);
    }
    return attachment.data;
};

MboxParser.prototype.attachmentToBlob = function(attachment) {
    return new Blob([this.stringToBytes(this.attachmentBytes(attachment))], {
        type: attachment.contentType || 'application/octet-stream'
    });
};

MboxParser.prototype.parseGmailLabels = function(labelString) {
    if (!labelString) return [];
    
    // Gmail labels can be comma-separated and may be quoted
    var labels = [];
    var parts = labelString.split(',');
    
    for (var i = 0; i < parts.length; i++) {
        var label = parts[i].replace(/^\s+|\s+$/g, '').replace(/^"(.*)"$/, '$1');
        if (label) {
            labels.push(label);
        }
    }
    
    return labels;
};

// Does an email satisfy the (possibly empty) filter criteria? All fields are
// ANDed; an empty/omitted field is ignored. Shared by the in-memory and
// cross-chunk filtering paths. Criteria: { text, sender, label, dateFrom, dateTo }
// where text/sender/label are lowercased and dateFrom/dateTo are timestamps.
MboxParser.prototype.matchesCriteria = function(email, c) {
    if (c.text) {
        var t = c.text;
        var inText = (email.from && email.from.toLowerCase().indexOf(t) !== -1) ||
            (email.to && email.to.toLowerCase().indexOf(t) !== -1) ||
            (email.subject && email.subject.toLowerCase().indexOf(t) !== -1) ||
            (this.getSearchText(email).toLowerCase().indexOf(t) !== -1) ||
            (email.gmailLabels && email.gmailLabels.some(function(l) {
                return l.toLowerCase().indexOf(t) !== -1;
            }));
        if (!inText) return false;
    }
    if (c.sender) {
        if (!email.from || email.from.toLowerCase().indexOf(c.sender) === -1) return false;
    }
    if (c.label) {
        var hasLabel = email.gmailLabels && email.gmailLabels.some(function(l) {
            return l.toLowerCase() === c.label;
        });
        if (!hasLabel) return false;
    }
    if (c.dateFrom != null || c.dateTo != null) {
        if (email.dateValue == null) return false;
        if (c.dateFrom != null && email.dateValue < c.dateFrom) return false;
        if (c.dateTo != null && email.dateValue > c.dateTo) return false;
    }
    return true;
};

// MboxViewer class
function MboxViewer() {
    this.parser = new MboxParser();
    this.initializeElements();
    this.attachEventListeners();
}

MboxViewer.prototype.initializeElements = function() {
    this.fileInput = document.getElementById('mboxFile');
    this.fileInfo = document.getElementById('fileInfo');
    this.emailList = document.getElementById('emailList');
    this.emailViewer = document.getElementById('emailViewer');
    this.searchInput = document.getElementById('searchInput');
    this.searchBtn = document.getElementById('searchBtn');
    this.clearBtn = document.getElementById('clearBtn');
    this.searchSection = document.getElementById('searchSection');
    this.searchToggle = document.getElementById('searchToggle');
    this.senderInput = document.getElementById('senderFilter');
    this.labelFilter = document.getElementById('labelFilter');
    this.dateFromInput = document.getElementById('dateFrom');
    this.dateToInput = document.getElementById('dateTo');
    this.stats = document.getElementById('stats');
};

MboxViewer.prototype.attachEventListeners = function() {
    var self = this;
    this.fileInput.addEventListener('change', function(e) {
        self.handleFileSelect(e);
    });
    this.searchBtn.addEventListener('click', function() {
        self.performSearch();
    });
    this.clearBtn.addEventListener('click', function() {
        self.clearSearch();
    });
    this.searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            self.performSearch();
        }
    });
    if (this.searchToggle) {
        this.searchToggle.addEventListener('click', function() {
            self.toggleSearchSection();
        });
    }
    document.addEventListener('keydown', function(e) {
        self.handleKeydown(e);
    });
};

MboxViewer.prototype.toggleSearchSection = function() {
    if (!this.searchSection) return;
    var collapsed = this.searchSection.classList.toggle('collapsed');
    this.searchToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
};

MboxViewer.prototype.handleKeydown = function(e) {
    // Ignore navigation keys while typing in a field
    var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
    }

    if (e.key === 'ArrowDown' || e.key === 'j') {
        this.moveSelection(1);
        e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
        this.moveSelection(-1);
        e.preventDefault();
    }
};

// Move the highlighted email up/down the currently rendered list.
MboxViewer.prototype.moveSelection = function(delta) {
    var items = this.emailList.querySelectorAll('.email-item');
    if (!items.length) {
        return;
    }

    var index = -1;
    for (var i = 0; i < items.length; i++) {
        if (items[i].classList.contains('selected')) {
            index = i;
            break;
        }
    }

    var next = (index === -1) ? (delta > 0 ? 0 : items.length - 1) : index + delta;
    next = Math.max(0, Math.min(items.length - 1, next));

    var target = items[next];
    target.click();
    target.scrollIntoView({ block: 'nearest' });
};

MboxViewer.prototype.handleFileSelect = function(event) {
    var file = event.target.files[0];
    if (!file) return;

    // Validate file type. Accept known extensions, anything with "mbox" in the
    // name, and extensionless files (Thunderbird stores mbox folders as plain
    // files like "Inbox" / "Sent"). Files with an unrelated extension (.pdf,
    // .zip, ...) are rejected; the content check on load is the real guard.
    var validExtensions = ['.mbox', '.txt', '.eml'];
    var fileName = file.name.toLowerCase();
    var dotIndex = fileName.lastIndexOf('.');
    var extension = dotIndex > 0 ? fileName.substring(dotIndex) : '';
    var hasNoExtension = (extension === '');
    var hasValidExtension = (validExtensions.indexOf(extension) !== -1);
    var looksLikeMbox = (fileName.indexOf('mbox') !== -1);

    if (!hasNoExtension && !hasValidExtension && !looksLikeMbox) {
        this.showError('Please select an mbox file (.mbox, .txt, .eml, or a Thunderbird file with no extension)');
        return;
    }

    // Loading a new file resets any active search and filters
    this.searchInput.value = '';
    this.resetFilterInputs();
    this.populateLabelFilter([]);

    this.fileInfo.textContent = 'Selected: ' + file.name + ' (' + this.formatFileSize(file.size) + ')';
    this.showLoading('Reading file…');

    var self = this;
    setTimeout(function() {
        self.processFile(file);
    }, 100);
};

// All file sizes go through one path: stream the file once to build a lightweight
// index (metadata + byte offsets), then render the list and load each email's full
// body on demand. Memory stays ~constant regardless of file size.
MboxViewer.prototype.processFile = function(file) {
    var self = this;
    this.file = file;
    this.viewCache = {};
    this.viewOrder = [];

    this.buildIndex(file, function(index) {
        if (index.length === 0) {
            self.showError('No emails found in this file. Please check if it\'s a valid mbox format.');
            return;
        }
        self.populateLabelFilter(self.collectIndexLabels());
        self.filtered = index.slice();
        self.renderList();
        self.updateStats();
        self.hideLoading();
        if (self.emailViewer) {
            self.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
        }
        self.restoreBookmark();
    });
};

// Convert an ArrayBuffer into a byte-preserving string (one char per byte,
// 0-255), so each MIME part can later be decoded with its own declared charset.
// Reading the file as UTF-8 up front would corrupt non-UTF-8 8-bit parts.
MboxViewer.prototype.bufferToBinaryString = function(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000; // bound String.fromCharCode argument count
    var chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return chunks.join('');
};

// Stream the file once, invoking onMessage(rawText, offset, length) for every
// complete mbox message. A tail buffer carries the partial trailing message
// across slice boundaries, so a message straddling a slice edge is never
// truncated (this is what fixes the old 5 MB chunk-boundary bug). The async
// FileReader reads yield to the UI between slices.
MboxViewer.prototype.streamMessages = function(file, onMessage, onProgress, onComplete) {
    var self = this;
    var sliceSize = this.indexSliceSize || (8 * 1024 * 1024);
    var carry = '';        // partial trailing message not yet finalized
    var carryOffset = 0;   // file byte offset where `carry` begins
    var fileOffset = 0;    // next byte to read

    function readNext() {
        if (fileOffset >= file.size) {
            if (carry.indexOf('From ') === 0) {
                onMessage(carry, carryOffset, carry.length);
            }
            onComplete();
            return;
        }
        var end = Math.min(fileOffset + sliceSize, file.size);
        var reader = new FileReader();
        reader.onload = function(e) {
            var combined = carry + self.bufferToBinaryString(e.target.result);
            var base = carryOffset; // file offset of combined[0]

            // message start positions within `combined`. combined[0] is a message
            // start whenever it begins with "From " — that's true for the first
            // slice (file starts with "From ") and for every carried partial
            // message thereafter (carry always begins at a boundary). Without
            // this, a message whose start was consumed in a previous slice would
            // be dropped when the next boundary arrived.
            var starts = [];
            if (combined.indexOf('From ') === 0) {
                starts.push(0);
            }
            var idx = combined.indexOf('\nFrom ');
            while (idx !== -1) {
                starts.push(idx + 1);
                idx = combined.indexOf('\nFrom ', idx + 1);
            }

            // all but the last start are complete; the last is carried forward
            for (var k = 0; k + 1 < starts.length; k++) {
                onMessage(combined.substring(starts[k], starts[k + 1]), base + starts[k], starts[k + 1] - starts[k]);
            }
            if (starts.length > 0) {
                var last = starts[starts.length - 1];
                carry = combined.substring(last);
                carryOffset = base + last;
            } else {
                carry = combined; // no boundary yet — keep accumulating
            }

            fileOffset = end;
            if (onProgress) {
                onProgress(file.size ? fileOffset / file.size : 1);
            }
            setTimeout(readNext, 0);
        };
        reader.onerror = function() {
            self.showError('Failed to read the file. Please try again.');
        };
        reader.readAsArrayBuffer(file.slice(fileOffset, end));
    }

    readNext();
};

// Build the in-memory index: one lightweight entry per message (metadata + byte
// offset/length), parsing headers only. Drops Trash-labeled emails.
MboxViewer.prototype.buildIndex = function(file, onComplete) {
    var self = this;
    var parser = this.parser;
    this.index = [];

    this.streamMessages(file, function(text, offset, length) {
        if (text.indexOf('From ') !== 0) return;
        var f = parser.parseHeaderFields(parser.extractHeaderBlock(text));
        if (parser.hasTrashLabel(f.gmailLabels)) return;
        self.index.push({
            offset: offset,
            length: length,
            from: f.from,
            to: f.to,
            subject: f.subject,
            date: f.date,
            dateValue: f.dateValue,
            messageId: f.messageId,
            gmailLabels: f.gmailLabels
        });
    }, function(fraction) {
        self.updateProgress(fraction, 'Indexing… ' + self.index.length + ' emails (' + Math.round(fraction * 100) + '%)');
    }, function() {
        onComplete(self.index);
    });
};

// Distinct, sorted Gmail labels across the index, for the label dropdown.
MboxViewer.prototype.collectIndexLabels = function() {
    var seen = {};
    var labels = [];
    for (var i = 0; i < this.index.length; i++) {
        var ls = this.index[i].gmailLabels;
        if (!ls) continue;
        for (var j = 0; j < ls.length; j++) {
            var key = ls[j].toLowerCase();
            if (!seen[key]) {
                seen[key] = true;
                labels.push(ls[j]);
            }
        }
    }
    labels.sort();
    return labels;
};

// Read and fully parse a single email's bytes on demand, with a small LRU cache
// so re-clicks / raw-toggle / download don't re-read the slice.
MboxViewer.prototype.loadEmail = function(entry, callback) {
    var self = this;
    if (this.viewCache && this.viewCache[entry.offset]) {
        callback(this.viewCache[entry.offset]);
        return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
        var email = self.parser.parseEmail(self.bufferToBinaryString(e.target.result));
        self.cacheEmail(entry.offset, email);
        callback(email);
    };
    reader.onerror = function() {
        self.showError('Failed to read the selected email.');
    };
    reader.readAsArrayBuffer(this.file.slice(entry.offset, entry.offset + entry.length));
};

MboxViewer.prototype.cacheEmail = function(offset, email) {
    if (!this.viewCache) { this.viewCache = {}; this.viewOrder = []; }
    if (!this.viewCache[offset]) this.viewOrder.push(offset);
    this.viewCache[offset] = email;
    while (this.viewOrder.length > 20) {
        delete this.viewCache[this.viewOrder.shift()];
    }
};

MboxViewer.prototype.listItemHtml = function(entry, position) {
    var labelsHtml = '';
    if (entry.gmailLabels && entry.gmailLabels.length > 0) {
        labelsHtml = '<div class="email-labels">';
        for (var j = 0; j < entry.gmailLabels.length; j++) {
            labelsHtml += '<span class="gmail-label">' + this.escapeHtml(entry.gmailLabels[j]) + '</span>';
        }
        labelsHtml += '</div>';
    }
    return '<div class="email-item" data-index="' + position + '">' +
        '<div class="email-from">' + this.escapeHtml(entry.from || 'Unknown sender') + '</div>' +
        '<div class="email-subject">' + this.escapeHtml(entry.subject || '(No subject)') + '</div>' +
        '<div class="email-date">' + this.escapeHtml(entry.date || 'No date') + '</div>' +
        labelsHtml +
        '</div>';
};

// Render the current filtered index (first 1000 + Load More).
MboxViewer.prototype.renderList = function() {
    var entries = this.filtered || [];
    if (entries.length === 0) {
        this.emailList.innerHTML = '<div class="no-file-message">No emails found</div>';
        return;
    }

    var maxInitial = 1000;
    var show = Math.min(entries.length, maxInitial);
    var items = [];
    for (var i = 0; i < show; i++) {
        items.push(this.listItemHtml(entries[i], i));
    }
    if (entries.length > maxInitial) {
        items.push('<div class="load-more-btn" id="loadMoreBtn">Load More (' + (entries.length - maxInitial) + ' remaining)</div>');
    }
    this.emailList.innerHTML = items.join('');

    this.wireListItems();
    var self = this;
    var more = document.getElementById('loadMoreBtn');
    if (more) {
        more.addEventListener('click', function() { self.loadMore(); });
    }
};

MboxViewer.prototype.loadMore = function() {
    var entries = this.filtered || [];
    var shown = this.emailList.querySelectorAll('.email-item').length;
    var next = Math.min(1000, entries.length - shown);

    var items = [];
    for (var i = shown; i < shown + next; i++) {
        items.push(this.listItemHtml(entries[i], i));
    }

    var oldMore = document.getElementById('loadMoreBtn');
    if (oldMore) oldMore.remove();
    if (shown + next < entries.length) {
        items.push('<div class="load-more-btn" id="loadMoreBtn">Load More (' + (entries.length - shown - next) + ' remaining)</div>');
    }
    this.emailList.insertAdjacentHTML('beforeend', items.join(''));

    this.wireListItems();
    var self = this;
    var more = document.getElementById('loadMoreBtn');
    if (more) {
        more.addEventListener('click', function() { self.loadMore(); });
    }
};

// Attach click handlers to any list rows that don't have one yet.
MboxViewer.prototype.wireListItems = function() {
    var self = this;
    var rows = this.emailList.querySelectorAll('.email-item:not(.has-handler)');
    for (var i = 0; i < rows.length; i++) {
        (function(row) {
            row.classList.add('has-handler');
            row.addEventListener('click', function() {
                self.openEmail(parseInt(row.getAttribute('data-index'), 10), row);
            });
        })(rows[i]);
    }
};

// Load (lazily) and show the email at a position in the filtered index.
MboxViewer.prototype.openEmail = function(position, element) {
    var entry = this.filtered[position];
    if (!entry) return;
    this.saveBookmark(entry);
    var self = this;
    this.loadEmail(entry, function(email) {
        self.selectEmail(email, element);
    });
};

// --- Bookmarking: remember the last-opened email per file (name+size), so
// reopening the same file resumes where you left off. ---

MboxViewer.prototype.bookmarkKey = function() {
    return this.file ? ('mboxBookmark:' + this.file.name + ':' + this.file.size) : null;
};

MboxViewer.prototype.saveBookmark = function(entry) {
    var key = this.bookmarkKey();
    if (!key) return;
    try {
        localStorage.setItem(key, JSON.stringify({ offset: entry.offset, messageId: entry.messageId }));
    } catch (e) {
        // localStorage unavailable (private mode / disabled) — bookmarking is best-effort
    }
};

MboxViewer.prototype.restoreBookmark = function() {
    var key = this.bookmarkKey();
    if (!key || !this.filtered) return;

    var saved;
    try {
        var raw = localStorage.getItem(key);
        if (!raw) return;
        saved = JSON.parse(raw);
    } catch (e) {
        return;
    }

    // Locate the bookmarked email in the current list (match on byte offset,
    // verified by Message-ID when present).
    var position = -1;
    for (var i = 0; i < this.filtered.length; i++) {
        if (this.filtered[i].offset === saved.offset &&
            (!saved.messageId || this.filtered[i].messageId === saved.messageId)) {
            position = i;
            break;
        }
    }
    if (position === -1) return;

    // Re-open it; highlight + scroll its row into view if it's already rendered
    // (rows past the initial 1000 aren't, so only the viewer is restored there).
    var row = this.emailList.querySelector('.email-item[data-index="' + position + '"]');
    this.openEmail(position, row);
    if (row) {
        row.scrollIntoView({ block: 'center' });
    }
};

// Filter the index by metadata criteria (no body). Used when there's no
// free-text term — instant, since everything needed is in the index entries.
MboxViewer.prototype.filterIndex = function(criteria) {
    var out = [];
    for (var i = 0; i < this.index.length; i++) {
        if (this.parser.matchesCriteria(this.index[i], criteria)) {
            out.push(this.index[i]);
        }
    }
    return out;
};

// Read the free-text search box plus the advanced filter controls into one
// criteria object (text/sender/label lowercased, dates as timestamps).
MboxViewer.prototype.gatherCriteria = function() {
    var fromVal = this.dateFromInput ? this.dateFromInput.value : '';
    var toVal = this.dateToInput ? this.dateToInput.value : '';
    return {
        text: this.searchInput.value.replace(/^\s+|\s+$/g, '').toLowerCase(),
        sender: this.senderInput ? this.senderInput.value.replace(/^\s+|\s+$/g, '').toLowerCase() : '',
        label: this.labelFilter ? this.labelFilter.value : '',
        dateFrom: fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null,
        dateTo: toVal ? new Date(toVal + 'T23:59:59.999').getTime() : null
    };
};

MboxViewer.prototype.hasCriteria = function(c) {
    return !!(c.text || c.sender || c.label || c.dateFrom != null || c.dateTo != null);
};

MboxViewer.prototype.resetFilterInputs = function() {
    if (this.senderInput) this.senderInput.value = '';
    if (this.dateFromInput) this.dateFromInput.value = '';
    if (this.dateToInput) this.dateToInput.value = '';
    if (this.labelFilter) this.labelFilter.value = '';
};

// Fill the label dropdown with the given labels (option value = lowercased,
// to match matchesCriteria). Populated for in-memory files; in chunked mode the
// full label set isn't known up front, so the dropdown stays at "All labels"
// (label names are still matched by the free-text search there).
MboxViewer.prototype.populateLabelFilter = function(labels) {
    if (!this.labelFilter) return;
    this.labelFilter.innerHTML = '<option value="">All labels</option>';
    for (var i = 0; i < labels.length; i++) {
        var option = document.createElement('option');
        option.value = labels[i].toLowerCase();
        option.textContent = labels[i];
        this.labelFilter.appendChild(option);
    }
};

MboxViewer.prototype.performSearch = function() {
    var criteria = this.gatherCriteria();
    if (!this.hasCriteria(criteria)) {
        this.showError('Enter a search term or set a filter');
        return;
    }
    if (!this.index) return;

    var self = this;
    if (criteria.text) {
        // Free-text search needs message bodies → stream-scan the file once.
        this.showLoading('Searching…');
        var results = [];
        this.streamMessages(this.file, function(text, offset, length) {
            if (text.indexOf('From ') !== 0) return;
            var email = self.parser.parseEmail(text);
            if (self.parser.hasTrashLabel(email.gmailLabels)) return;
            if (self.parser.matchesCriteria(email, criteria)) {
                results.push({
                    offset: offset, length: length,
                    from: email.from, to: email.to, subject: email.subject,
                    date: email.date, dateValue: email.dateValue,
                    messageId: email.messageId, gmailLabels: email.gmailLabels
                });
            }
        }, function(fraction) {
            self.updateProgress(fraction, 'Searching… ' + results.length + ' matches');
        }, function() {
            self.filtered = results;
            self.renderList();
            self.updateStats();
            self.hideLoading();
            if (self.emailViewer) {
                self.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the results</div>';
            }
        });
    } else {
        // Metadata-only filter (sender / label / date) → instant over the index.
        this.filtered = this.filterIndex(criteria);
        this.renderList();
        this.updateStats();
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the results</div>';
        }
    }
};

MboxViewer.prototype.clearSearch = function() {
    this.searchInput.value = '';
    this.resetFilterInputs();
    if (!this.index) return;
    this.filtered = this.index.slice();
    this.renderList();
    this.updateStats();
    if (this.emailViewer) {
        this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
    }
};

MboxViewer.prototype.displayEmail = function(email) {
    // New selection: remember it and reset to the formatted view
    this.currentEmail = email;
    this.showRawSource = false;
    this.renderEmail();
};

MboxViewer.prototype.renderEmail = function() {
    var email = this.currentEmail;

    if (!this.emailViewer) {
        this.emailViewer = document.getElementById('emailViewer');
    }
    if (!this.emailViewer) {
        return;
    }
    if (!email) {
        this.emailViewer.innerHTML = '<div class="no-email-selected">No email selected</div>';
        return;
    }

    // Build Gmail labels section
    var labelsSection = '';
    if (email.gmailLabels && email.gmailLabels.length > 0) {
        labelsSection = '<strong>Gmail Labels:</strong> ';
        for (var i = 0; i < email.gmailLabels.length; i++) {
            labelsSection += '<span class="gmail-label-detail">' + this.escapeHtml(email.gmailLabels[i]) + '</span>';
        }
        labelsSection += '<br>';
    }

    // Build additional Gmail info
    var gmailInfo = '';
    if (email.gmailThreadId) {
        gmailInfo += '<strong>Thread ID:</strong> ' + this.escapeHtml(email.gmailThreadId) + '<br>';
    }
    if (email.gmailState) {
        gmailInfo += '<strong>State:</strong> ' + this.escapeHtml(email.gmailState) + '<br>';
    }

    var headerInfo = '<div class="email-header">' +
        '<strong>From:</strong> ' + this.escapeHtml(email.from || 'Unknown sender') + '<br>' +
        '<strong>To:</strong> ' + this.escapeHtml(email.to || 'Unknown recipient') + '<br>' +
        '<strong>Subject:</strong> ' + this.escapeHtml(email.subject || '(No subject)') + '<br>' +
        '<strong>Date:</strong> ' + this.escapeHtml(email.date || 'No date') + '<br>' +
        labelsSection +
        gmailInfo +
        (email.messageId ? '<strong>Message-ID:</strong> ' + this.escapeHtml(email.messageId) + '<br>' : '') +
        '<div class="email-actions">' +
            '<button type="button" class="email-download">⬇ Download .eml</button>' +
            '<button type="button" class="email-raw-toggle">' +
                (this.showRawSource ? 'View formatted' : 'View raw') +
            '</button>' +
        '</div>' +
        '</div>';

    // Reset the viewer with the header plus any attachment list
    this.emailViewer.innerHTML = headerInfo + this.buildAttachmentsHtml(email);

    if (this.showRawSource) {
        // Raw view: the original message source, as plain text
        var rawPre = document.createElement('pre');
        rawPre.className = 'email-content email-raw';
        rawPre.textContent = email.raw || email.bodyText || '(No content)';
        this.emailViewer.appendChild(rawPre);
    } else if (email.bodyHtml && email.bodyHtml.replace(/^\s+|\s+$/g, '')) {
        // HTML body in a sandboxed iframe (scripts/forms/same-origin blocked)
        var frame = document.createElement('iframe');
        frame.className = 'email-html-frame';
        frame.setAttribute('sandbox', '');
        frame.srcdoc = this.inlineCidImages(email);
        this.emailViewer.appendChild(frame);
    } else {
        var contentDiv = document.createElement('div');
        contentDiv.className = 'email-content';
        contentDiv.textContent = email.bodyText || email.body || '(No content)';
        this.emailViewer.appendChild(contentDiv);
    }

    this.wireAttachmentDownloads(email);

    var self = this;
    var downloadButton = this.emailViewer.querySelector('.email-download');
    if (downloadButton) {
        downloadButton.addEventListener('click', function() {
            self.downloadEmail(email);
        });
    }
    var rawToggle = this.emailViewer.querySelector('.email-raw-toggle');
    if (rawToggle) {
        rawToggle.addEventListener('click', function() {
            self.showRawSource = !self.showRawSource;
            self.renderEmail();
        });
    }
};

// Rewrite cid: references in the HTML body to data: URLs built from the matching
// inline part, so embedded images render inside the sandboxed iframe.
MboxViewer.prototype.inlineCidImages = function(email) {
    var html = email.bodyHtml;
    if (!html || !email.attachments || email.attachments.length === 0 || html.indexOf('cid:') === -1) {
        return html;
    }

    var self = this;
    var atts = email.attachments;
    return html.replace(/cid:([^"'\s>)]+)/gi, function(match, cid) {
        var key = cid.toLowerCase();
        for (var i = 0; i < atts.length; i++) {
            if ((atts[i].contentId || '').toLowerCase() === key) {
                var url = self.attachmentDataUrl(atts[i]);
                return url || match;
            }
        }
        return match;
    });
};

// Build (and cache) a data: URL for an inline part, base64-encoding its decoded
// bytes. Cached so re-renders (e.g. the raw-view toggle) don't re-encode.
MboxViewer.prototype.attachmentDataUrl = function(attachment) {
    if (attachment._dataUrl == null) {
        try {
            var type = attachment.contentType || 'application/octet-stream';
            attachment._dataUrl = 'data:' + type + ';base64,' + btoa(this.parser.attachmentBytes(attachment));
        } catch (e) {
            attachment._dataUrl = '';
        }
    }
    return attachment._dataUrl;
};

MboxViewer.prototype.downloadEmail = function(email) {
    try {
        // Strip the leading mbox "From " envelope line to produce a clean .eml
        var raw = (email.raw || '').replace(/^From .*\r?\n/, '');
        var blob = new Blob([raw], { type: 'message/rfc822' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = this.emailFilename(email);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function() {
            URL.revokeObjectURL(url);
        }, 1000);
    } catch (e) {
        alert('Could not prepare this email for download: ' + e.message);
    }
};

MboxViewer.prototype.emailFilename = function(email) {
    var base = (email.subject || 'email')
        .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\s+|\s+$/g, '')
        .substring(0, 80);
    return (base || 'email') + '.eml';
};

MboxViewer.prototype.buildAttachmentsHtml = function(email) {
    if (!email.attachments || email.attachments.length === 0) {
        return '';
    }

    var items = [];
    for (var i = 0; i < email.attachments.length; i++) {
        var attachment = email.attachments[i];
        var name = attachment.filename || 'attachment';
        var meta = (attachment.contentType || 'application/octet-stream') +
            ' · ' + this.formatFileSize(attachment.size || 0);

        items.push('<div class="attachment-item">' +
            '<span class="attachment-icon">📎</span>' +
            '<span class="attachment-name">' + this.escapeHtml(name) + '</span>' +
            '<span class="attachment-meta">' + this.escapeHtml(meta) + '</span>' +
            '<button class="attachment-download" data-att-index="' + i + '">Download</button>' +
            '</div>');
    }

    return '<div class="email-attachments">' +
        '<div class="attachments-title">Attachments (' + email.attachments.length + ')</div>' +
        items.join('') +
        '</div>';
};

MboxViewer.prototype.wireAttachmentDownloads = function(email) {
    if (!email.attachments || email.attachments.length === 0) {
        return;
    }

    var self = this;
    var buttons = this.emailViewer.querySelectorAll('.attachment-download');
    for (var i = 0; i < buttons.length; i++) {
        (function(button) {
            button.addEventListener('click', function() {
                var index = parseInt(button.getAttribute('data-att-index'), 10);
                self.downloadAttachment(email.attachments[index]);
            });
        })(buttons[i]);
    }
};

MboxViewer.prototype.downloadAttachment = function(attachment) {
    try {
        var blob = this.parser.attachmentToBlob(attachment);
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = attachment.filename || 'attachment';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function() {
            URL.revokeObjectURL(url);
        }, 1000);
    } catch (e) {
        alert('Could not prepare this attachment for download: ' + e.message);
    }
};

// Show an email in the viewer and highlight its row. Shared by row clicks and
// keyboard navigation.
MboxViewer.prototype.selectEmail = function(email, element) {
    this.displayEmail(email);
    this.highlightSelectedEmail(element);
};

MboxViewer.prototype.highlightSelectedEmail = function(selectedItem) {
    var items = this.emailList.querySelectorAll('.email-item');
    for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('selected');
    }
    // selectedItem may be null when restoring a bookmark whose row isn't rendered
    if (selectedItem) {
        selectedItem.classList.add('selected');
    }
};

MboxViewer.prototype.updateStats = function() {
    if (!this.index || this.index.length === 0) {
        this.stats.textContent = '';
        return;
    }
    var total = this.index.length;
    var shown = this.filtered ? this.filtered.length : total;
    this.stats.textContent = (shown === total)
        ? ('Total emails: ' + total)
        : ('Showing ' + shown + ' of ' + total + ' emails');
};

MboxViewer.prototype.showLoading = function(message) {
    this.emailList.innerHTML =
        '<div class="loading">' +
            '<div class="loading-message" id="loadingMessage">' + this.escapeHtml(message) + '</div>' +
            '<div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>' +
        '</div>';
    this.emailViewer.innerHTML = '<div class="no-email-selected">Loading...</div>';
};

// Update the loading progress bar (fraction 0..1) and optional message.
MboxViewer.prototype.updateProgress = function(fraction, message) {
    var fill = document.getElementById('progressFill');
    if (fill) {
        var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
        fill.style.width = pct + '%';
    }
    if (message) {
        var label = document.getElementById('loadingMessage');
        if (label) {
            label.textContent = message;
        }
    }
};

MboxViewer.prototype.hideLoading = function() {
    // Loading is replaced when renderList paints the list
};

MboxViewer.prototype.showError = function(message) {
    this.emailList.innerHTML = '<div class="error">' + message + '</div>';
    this.emailViewer.innerHTML = '<div class="no-email-selected">Error occurred</div>';
};

MboxViewer.prototype.formatFileSize = function(bytes) {
    if (bytes === 0) return '0 Bytes';
    var k = 1024;
    var sizes = ['Bytes', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

MboxViewer.prototype.escapeHtml = function(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    new MboxViewer();
});