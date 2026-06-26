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

MboxParser.prototype.parseMboxFile = function(content) {
    this.emails = [];
    var messages = content.split(/^From /m);
    
    for (var i = 1; i < messages.length; i++) {
        var message = 'From ' + messages[i];
        var email = this.parseEmail(message);
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

    var email = {
        from: '',
        to: '',
        subject: '',
        date: '',
        messageId: '',
        bodyText: '',
        bodyHtml: '',
        attachments: [],
        headers: this.parseHeaders(headerBlock),
        raw: rawEmail
    };

    // Resolve convenience fields from the fully-unfolded headers
    var h = email.headers;
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

    // Walk the MIME tree to populate bodyText, bodyHtml and attachments. The
    // searchable plain-text projection (email.body) is built lazily on first
    // search via getSearchText, since most emails are never searched.
    this.processMimePart(
        email,
        h['content-type'] || 'text/plain',
        h['content-transfer-encoding'] || '',
        h['content-disposition'] || '',
        rawBody
    );

    return email;
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

MboxParser.prototype.processMimePart = function(email, contentType, transferEncoding, disposition, body) {
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

    // Leaf part: classify as an attachment or as displayable body text/html
    var lowerDisp = (disposition || '').toLowerCase();
    var isAttachment = lowerDisp.indexOf('attachment') !== -1 ||
        (lowerType.indexOf('text/') === -1 && lowerDisp.indexOf('inline') === -1);

    if (isAttachment) {
        var filename = this.getMimeParameter(disposition, 'filename') ||
            this.getMimeParameter(contentType, 'name') ||
            'attachment';
        email.attachments.push({
            filename: this.decodeHeader(filename),
            contentType: contentType.split(';')[0].replace(/^\s+|\s+$/g, ''),
            encoding: (transferEncoding || '').toLowerCase().replace(/^\s+|\s+$/g, ''),
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
        partBody
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

MboxParser.prototype.attachmentToBlob = function(attachment) {
    // attachment.encoding is already lowercased/trimmed at parse time
    var encoding = attachment.encoding || '';
    var bytes;

    if (encoding.indexOf('base64') !== -1) {
        bytes = this.stringToBytes(atob(this.cleanBase64(attachment.data)));
    } else if (encoding.indexOf('quoted-printable') !== -1) {
        bytes = this.stringToBytes(this.decodeQuotedPrintable(attachment.data));
    } else {
        bytes = this.stringToBytes(attachment.data);
    }

    return new Blob([bytes], {
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

MboxParser.prototype.applyFilters = function(criteria) {
    this.filteredEmails = [];
    for (var i = 0; i < this.emails.length; i++) {
        if (this.matchesCriteria(this.emails[i], criteria)) {
            this.filteredEmails.push(this.emails[i]);
        }
    }
    return this.filteredEmails;
};

// Distinct Gmail labels across all parsed emails, for the label filter dropdown.
MboxParser.prototype.collectLabels = function() {
    var seen = {};
    var labels = [];
    for (var i = 0; i < this.emails.length; i++) {
        var ls = this.emails[i].gmailLabels;
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

MboxParser.prototype.getFilteredEmails = function() {
    return this.filteredEmails;
};

MboxParser.prototype.getEmailCount = function() {
    return this.emails.length;
};

MboxParser.prototype.getFilteredEmailCount = function() {
    return this.filteredEmails.length;
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
    } else if (e.key === ']') {
        this.gotoAdjacentChunk(1);
    } else if (e.key === '[') {
        this.gotoAdjacentChunk(-1);
    }
};

// Move the highlighted email up/down the currently rendered list (works in the
// normal list, chunk view and search results since all render .email-item).
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

// In chunked mode, [ / ] move between chunks via the existing nav buttons.
MboxViewer.prototype.gotoAdjacentChunk = function(delta) {
    var button = document.getElementById(delta > 0 ? 'nextChunk' : 'prevChunk');
    if (button && !button.disabled) {
        button.click();
    }
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
    this.isSearchMode = false;
    this.searchResults = [];
    this.criteria = null;

    this.fileInfo.textContent = 'Selected: ' + file.name + ' (' + this.formatFileSize(file.size) + ')';

    // For large files, warn user
    if (file.size > 100 * 1024 * 1024) { // 100MB+
        this.showLoading('Loading large file - this may take several minutes...');
    } else {
        this.showLoading('Reading file...');
    }

    var self = this;
    setTimeout(function() {
        self.processFile(file);
    }, 100);
};

MboxViewer.prototype.processFile = function(file) {
    var self = this;
    
    // For very large files, use chunked processing
    if (file.size > 1024 * 1024 * 1024) { // 1GB+
        this.processLargeFileChunked(file);
    } else {
        this.processSmallFile(file);
    }
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

MboxViewer.prototype.processSmallFile = function(file) {
    var self = this;
    var reader = new FileReader();

    reader.onload = function(e) {
        var content = self.bufferToBinaryString(e.target.result);

        if (!content || (!content.indexOf || (content.indexOf('From ') === -1 && content.indexOf('Message-ID:') === -1))) {
            self.showError('This does not appear to be a valid mbox file');
            return;
        }
        
        self.showLoading('Parsing emails...');
        
        setTimeout(function() {
            try {
                var emails = self.parser.parseMboxFile(content);
                if (emails.length === 0) {
                    self.showError('No emails found in this file. Please check if it\'s a valid mbox format.');
                    return;
                }
                self.populateLabelFilter(self.parser.collectLabels());
                self.displayEmailList();
                self.updateStats();
                self.hideLoading();
            } catch (parseError) {
                self.showError('Error parsing emails: ' + parseError.message);
            }
        }, 100);
    };
    
    reader.onerror = function() {
        self.showError('Failed to read file. Please try again.');
    };
    
    try {
        reader.readAsArrayBuffer(file);
    } catch (error) {
        self.showError('Cannot read file: ' + error.message);
    }
};

MboxViewer.prototype.processLargeFileChunked = function(file) {
    var self = this;
    
    // Store file info for chunk-based viewing
    this.file = file;
    this.chunkSize = 5 * 1024 * 1024; // 5MB chunks
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.currentChunkIndex = 0;
    this.chunkEmails = []; // Store emails by chunk
    this.processedChunks = {}; // Cache processed chunks
    
    console.log('File has', this.totalChunks, 'chunks of', this.formatFileSize(this.chunkSize), 'each');
    
    // Show chunk navigation instead of processing all at once
    this.showChunkNavigation();
    this.loadChunk(0);
};

MboxViewer.prototype.showChunkNavigation = function() {
    var navHtml = '<div class="chunk-navigation">' +
        '<button id="prevChunk" disabled>◀ Previous Chunk</button>' +
        '<span id="chunkInfo">Chunk 1 of ' + this.totalChunks + '</span>' +
        '<button id="nextChunk">Next Chunk ▶</button>' +
        '</div>';
    
    this.emailList.innerHTML = navHtml + '<div id="chunkEmails"></div>';
    
    var self = this;
    document.getElementById('prevChunk').addEventListener('click', function() {
        if (self.currentChunkIndex > 0) {
            self.loadChunk(self.currentChunkIndex - 1);
        }
    });
    
    document.getElementById('nextChunk').addEventListener('click', function() {
        if (self.currentChunkIndex < self.totalChunks - 1) {
            self.loadChunk(self.currentChunkIndex + 1);
        }
    });
};

MboxViewer.prototype.loadChunk = function(chunkIndex) {
    var self = this;
    this.currentChunkIndex = chunkIndex;
    
    // Update navigation
    document.getElementById('chunkInfo').textContent = 'Chunk ' + (chunkIndex + 1) + ' of ' + this.totalChunks;
    document.getElementById('prevChunk').disabled = (chunkIndex === 0);
    document.getElementById('nextChunk').disabled = (chunkIndex === this.totalChunks - 1);
    
    // Check if chunk is already processed
    if (this.processedChunks[chunkIndex]) {
        console.log('Loading cached chunk', chunkIndex + 1);
        this.displayChunkEmails(this.processedChunks[chunkIndex]);
        return;
    }
    
    // Load and process chunk
    console.log('Processing chunk', chunkIndex + 1, 'of', this.totalChunks);
    this.showChunkLoading('Loading chunk ' + (chunkIndex + 1) + '...');
    
    var offset = chunkIndex * this.chunkSize;
    var end = Math.min(offset + this.chunkSize, this.file.size);
    var slice = this.file.slice(offset, end);
    
    var reader = new FileReader();
    reader.onload = function(e) {
        var chunkText = self.bufferToBinaryString(e.target.result);
        var emails = self.parseChunkEmails(chunkText);

        // Cache the processed chunk
        self.processedChunks[chunkIndex] = emails;
        
        console.log('Chunk', chunkIndex + 1, 'contains', emails.length, 'emails');
        self.displayChunkEmails(emails);
    };
    
    reader.onerror = function() {
        self.showChunkError('Failed to load chunk ' + (chunkIndex + 1));
    };

    reader.readAsArrayBuffer(slice);
};

MboxViewer.prototype.parseChunkEmails = function(chunkText) {
    var emails = [];
    var messages = chunkText.split(/^From /m);
    
    for (var i = 1; i < messages.length; i++) {
        var message = 'From ' + messages[i];
        var email = this.parser.parseEmail(message);
        if (email) {
            // Filter out emails in Trash
            if (email.gmailLabels && email.gmailLabels.length > 0) {
                var hasTrash = false;
                for (var j = 0; j < email.gmailLabels.length; j++) {
                    if (email.gmailLabels[j].toLowerCase() === 'trash') {
                        hasTrash = true;
                        break;
                    }
                }
                if (!hasTrash) {
                    emails.push(email);
                }
            } else {
                // Include emails without labels (they're probably not in trash)
                emails.push(email);
            }
        }
    }
    
    return emails;
};

MboxViewer.prototype.displayChunkEmails = function(emails) {
    var chunkEmailsDiv = document.getElementById('chunkEmails');
    
    if (emails.length === 0) {
        chunkEmailsDiv.innerHTML = '<div class="no-file-message">No complete emails found in this chunk</div>';
        return;
    }
    
    var emailItems = [];
    for (var i = 0; i < emails.length; i++) {
        var email = emails[i];
        var date = email.date || 'No date';
        var from = email.from || 'Unknown sender';
        var subject = email.subject || '(No subject)';
        
        // Add Gmail labels if available
        var labelsHtml = '';
        if (email.gmailLabels && email.gmailLabels.length > 0) {
            labelsHtml = '<div class="email-labels">';
            for (var j = 0; j < email.gmailLabels.length; j++) {
                labelsHtml += '<span class="gmail-label">' + this.escapeHtml(email.gmailLabels[j]) + '</span>';
            }
            labelsHtml += '</div>';
        }
        
        emailItems.push('<div class="email-item" data-index="' + i + '">' +
            '<div class="email-from">' + this.escapeHtml(from) + '</div>' +
            '<div class="email-subject">' + this.escapeHtml(subject) + '</div>' +
            '<div class="email-date">' + this.escapeHtml(date) + '</div>' +
            labelsHtml +
            '</div>');
    }
    
    chunkEmailsDiv.innerHTML = emailItems.join('');
    
    // Add click handlers
    var self = this;
    var emailElements = chunkEmailsDiv.querySelectorAll('.email-item');
    console.log('Adding click handlers to', emailElements.length, 'email elements');
    
    for (var i = 0; i < emailElements.length; i++) {
        (function(index, element) {
            element.addEventListener('click', function() {
                self.selectEmail(emails[index], element);
            });
        })(i, emailElements[i]);
    }
    
    // Update stats
    this.stats.textContent = 'Chunk ' + (this.currentChunkIndex + 1) + ': ' + emails.length + ' emails';
};

MboxViewer.prototype.showChunkLoading = function(message) {
    var chunkEmailsDiv = document.getElementById('chunkEmails');
    chunkEmailsDiv.innerHTML = '<div class="loading">' + message + '</div>';
};

MboxViewer.prototype.showChunkError = function(message) {
    var chunkEmailsDiv = document.getElementById('chunkEmails');
    chunkEmailsDiv.innerHTML = '<div class="error">' + message + '</div>';
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

MboxViewer.prototype.describeCriteria = function(c) {
    var parts = [];
    if (c.text) parts.push('text "' + c.text + '"');
    if (c.sender) parts.push('from "' + c.sender + '"');
    if (c.label) parts.push('label "' + c.label + '"');
    if (c.dateFrom != null || c.dateTo != null) parts.push('date range');
    return parts.join(', ');
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

    // Small-file mode: every email is already parsed in memory, so filter directly
    if (!this.file) {
        this.parser.applyFilters(criteria);
        this.displayEmailList();
        this.updateStats();
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the results</div>';
        }
        return;
    }

    // Chunked mode: scan every chunk applying the same criteria
    this.criteria = criteria;
    this.searchResults = [];
    this.currentSearchChunk = 0;
    this.isSearchMode = true;
    this.showSearchInterface();
    this.searchNextChunk();
};

MboxViewer.prototype.clearSearch = function() {
    this.searchInput.value = '';
    this.resetFilterInputs();

    // Small-file mode: reset the in-memory filter and re-render the full list
    if (!this.file) {
        this.parser.applyFilters({});
        this.displayEmailList();
        this.updateStats();
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
        }
        return;
    }

    this.isSearchMode = false;
    this.searchResults = [];
    this.criteria = null;

    // Return to normal chunk view
    this.showChunkNavigation();
    this.loadChunk(0);
};

MboxViewer.prototype.showSearchInterface = function() {
    var searchHtml = '<div class="search-progress">' +
        '<div class="search-header">Results for: ' + this.escapeHtml(this.describeCriteria(this.criteria || {}) || 'all emails') + '</div>' +
        '<div class="search-status" id="searchStatus">Searching...</div>' +
        '<button id="cancelSearch">Cancel Search</button>' +
        '</div>' +
        '<div id="searchResults"></div>';
    
    this.emailList.innerHTML = searchHtml;
    
    var self = this;
    document.getElementById('cancelSearch').addEventListener('click', function() {
        self.clearSearch();
    });
};

MboxViewer.prototype.searchNextChunk = function() {
    if (this.currentSearchChunk >= this.totalChunks) {
        this.displaySearchResults();
        return;
    }
    
    var self = this;
    var chunkIndex = this.currentSearchChunk;
    
    // Update progress
    document.getElementById('searchStatus').textContent = 
        'Searching chunk ' + (chunkIndex + 1) + ' of ' + this.totalChunks + 
        ' (' + this.searchResults.length + ' results found)';
    
    // Load and search chunk
    var offset = chunkIndex * this.chunkSize;
    var end = Math.min(offset + this.chunkSize, this.file.size);
    var slice = this.file.slice(offset, end);
    
    var reader = new FileReader();
    reader.onload = function(e) {
        var chunkText = self.bufferToBinaryString(e.target.result);
        var emails = self.parseChunkEmails(chunkText);

        // Search through emails in this chunk
        for (var i = 0; i < emails.length; i++) {
            var email = emails[i];
            if (self.emailMatchesSearch(email)) {
                self.searchResults.push({
                    email: email,
                    chunkIndex: chunkIndex,
                    emailIndex: i
                });
            }
        }
        
        self.currentSearchChunk++;
        
        // Continue searching with a small delay
        setTimeout(function() {
            self.searchNextChunk();
        }, 10);
    };
    
    reader.onerror = function() {
        self.showError('Error searching chunk ' + (chunkIndex + 1));
    };

    reader.readAsArrayBuffer(slice);
};

MboxViewer.prototype.emailMatchesSearch = function(email) {
    return this.parser.matchesCriteria(email, this.criteria || {});
};

MboxViewer.prototype.displaySearchResults = function() {
    var searchResultsDiv = document.getElementById('searchResults');
    document.getElementById('searchStatus').textContent = 
        'Search complete: ' + this.searchResults.length + ' results found';
    
    if (this.searchResults.length === 0) {
        searchResultsDiv.innerHTML = '<div class="no-file-message">No emails found matching your search</div>';
        return;
    }
    
    var resultItems = [];
    for (var i = 0; i < this.searchResults.length; i++) {
        var result = this.searchResults[i];
        var email = result.email;
        var date = email.date || 'No date';
        var from = email.from || 'Unknown sender';
        var subject = email.subject || '(No subject)';
        
        // Add Gmail labels if available
        var labelsHtml = '';
        if (email.gmailLabels && email.gmailLabels.length > 0) {
            labelsHtml = '<div class="email-labels">';
            for (var j = 0; j < email.gmailLabels.length; j++) {
                labelsHtml += '<span class="gmail-label">' + this.escapeHtml(email.gmailLabels[j]) + '</span>';
            }
            labelsHtml += '</div>';
        }
        
        resultItems.push('<div class="email-item search-result" data-result-index="' + i + '">' +
            '<div class="search-result-header">' +
                '<span class="chunk-indicator">Chunk ' + (result.chunkIndex + 1) + '</span>' +
            '</div>' +
            '<div class="email-from">' + this.escapeHtml(from) + '</div>' +
            '<div class="email-subject">' + this.escapeHtml(subject) + '</div>' +
            '<div class="email-date">' + this.escapeHtml(date) + '</div>' +
            labelsHtml +
            '</div>');
    }
    
    searchResultsDiv.innerHTML = resultItems.join('');
    
    // Add click handlers for search results
    var self = this;
    var resultElements = searchResultsDiv.querySelectorAll('.search-result');
    for (var i = 0; i < resultElements.length; i++) {
        (function(index, element) {
            element.addEventListener('click', function() {
                var result = self.searchResults[index];
                console.log('Search result clicked:', result);
                self.selectEmail(result.email, element);
            });
        })(i, resultElements[i]);
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
        frame.srcdoc = email.bodyHtml;
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

MboxViewer.prototype.displayEmailList = function() {
    var emails = this.parser.getFilteredEmails();
    
    console.log('displayEmailList called with', emails.length, 'emails');
    
    if (emails.length === 0) {
        this.emailList.innerHTML = '<div class="no-file-message">No emails found</div>';
        return;
    }

    // For large numbers of emails, show the first 1000 initially
    var maxInitialDisplay = 1000;
    var emailsToShow = Math.min(emails.length, maxInitialDisplay);
    
    console.log('Displaying first', emailsToShow, 'emails out of', emails.length);

    var emailItems = [];
    for (var i = 0; i < emailsToShow; i++) {
        var email = emails[i];
        var date = email.date || 'No date';
        var from = email.from || 'Unknown sender';
        var subject = email.subject || '(No subject)';
        
        emailItems.push('<div class="email-item" data-index="' + i + '">' +
            '<div class="email-from">' + this.escapeHtml(from) + '</div>' +
            '<div class="email-subject">' + this.escapeHtml(subject) + '</div>' +
            '<div class="email-date">' + this.escapeHtml(date) + '</div>' +
            '</div>');
    }

    // Add load more button if there are more emails
    if (emails.length > maxInitialDisplay) {
        emailItems.push('<div class="load-more-btn" id="loadMoreBtn">Load More (' + (emails.length - maxInitialDisplay) + ' remaining)</div>');
    }

    try {
        this.emailList.innerHTML = emailItems.join('');
        console.log('Successfully set innerHTML');
    } catch (error) {
        console.error('Error setting innerHTML:', error);
        this.showError('Error displaying emails: ' + error.message);
        return;
    }

    var self = this;
    
    // Add click handlers for email items
    var emailElements = this.emailList.querySelectorAll('.email-item');
    console.log('Adding click handlers to', emailElements.length, 'email elements');
    
    for (var i = 0; i < emailElements.length; i++) {
        (function(index, element) {
            element.addEventListener('click', function() {
                self.selectEmail(self.parser.getFilteredEmails()[index], element);
            });
        })(i, emailElements[i]);
    }

    // Add load more handler
    var loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function() {
            console.log('Load more clicked');
            self.loadMoreEmails();
        });
    }
    
    console.log('displayEmailList completed successfully');
};

MboxViewer.prototype.loadMoreEmails = function() {
    console.log('loadMoreEmails called');
    var emails = this.parser.getFilteredEmails();
    var currentlyShown = this.emailList.querySelectorAll('.email-item').length;
    var nextBatch = Math.min(1000, emails.length - currentlyShown);
    
    console.log('Loading', nextBatch, 'more emails, starting from index', currentlyShown);
    
    var emailItems = [];
    for (var i = currentlyShown; i < currentlyShown + nextBatch; i++) {
        var email = emails[i];
        var date = email.date || 'No date';
        var from = email.from || 'Unknown sender';
        var subject = email.subject || '(No subject)';
        
        emailItems.push('<div class="email-item" data-index="' + i + '">' +
            '<div class="email-from">' + this.escapeHtml(from) + '</div>' +
            '<div class="email-subject">' + this.escapeHtml(subject) + '</div>' +
            '<div class="email-date">' + this.escapeHtml(date) + '</div>' +
            '</div>');
    }
    
    // Remove old load more button
    var oldLoadMoreBtn = document.getElementById('loadMoreBtn');
    if (oldLoadMoreBtn) {
        oldLoadMoreBtn.remove();
    }
    
    // Add new load more button if needed
    if (currentlyShown + nextBatch < emails.length) {
        emailItems.push('<div class="load-more-btn" id="loadMoreBtn">Load More (' + (emails.length - currentlyShown - nextBatch) + ' remaining)</div>');
    }
    
    // Append new items
    this.emailList.insertAdjacentHTML('beforeend', emailItems.join(''));
    
    // Add click handlers for new items
    var self = this;
    var newEmailElements = this.emailList.querySelectorAll('.email-item[data-index]:not(.has-handler)');
    for (var i = 0; i < newEmailElements.length; i++) {
        (function(element) {
            var index = parseInt(element.getAttribute('data-index'));
            element.classList.add('has-handler');
            element.addEventListener('click', function() {
                self.selectEmail(self.parser.getFilteredEmails()[index], element);
            });
        })(newEmailElements[i]);
    }
    
    // Re-add load more handler
    var newLoadMoreBtn = document.getElementById('loadMoreBtn');
    if (newLoadMoreBtn) {
        newLoadMoreBtn.addEventListener('click', function() {
            console.log('Load more clicked again');
            self.loadMoreEmails();
        });
    }
    
    console.log('loadMoreEmails completed');
};

// Show an email in the viewer and highlight its row. The single selection
// operation shared by every list/chunk/search click handler and keyboard nav.
MboxViewer.prototype.selectEmail = function(email, element) {
    this.displayEmail(email);
    this.highlightSelectedEmail(element);
};

MboxViewer.prototype.highlightSelectedEmail = function(selectedItem) {
    var items = this.emailList.querySelectorAll('.email-item');
    for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('selected');
    }
    selectedItem.classList.add('selected');
};

MboxViewer.prototype.updateStats = function() {
    var total = this.parser.getEmailCount();
    var filtered = this.parser.getFilteredEmailCount();
    
    if (total === 0) {
        this.stats.textContent = '';
        return;
    }

    if (filtered === total) {
        this.stats.textContent = 'Total emails: ' + total;
    } else {
        this.stats.textContent = 'Showing ' + filtered + ' of ' + total + ' emails';
    }
};

MboxViewer.prototype.showLoading = function(message) {
    this.emailList.innerHTML = '<div class="loading">' + message + '</div>';
    this.emailViewer.innerHTML = '<div class="no-email-selected">Loading...</div>';
};

MboxViewer.prototype.hideLoading = function() {
    // Loading will be hidden when displayEmailList is called
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