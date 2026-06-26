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
    var lines = rawEmail.split('\n');
    var email = {
        from: '',
        to: '',
        subject: '',
        date: '',
        messageId: '',
        body: '',
        bodyText: '',
        bodyHtml: '',
        attachments: [],
        headers: {},
        raw: rawEmail
    };

    var headerMode = true;
    var bodyLines = [];
    var lastHeader = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');

        if (headerMode) {
            // Skip the mbox "From " envelope line that precedes the real headers
            if (i === 0 && line.indexOf('From ') === 0) {
                continue;
            }

            // A blank line ends the header block
            if (line === '') {
                headerMode = false;
                continue;
            }

            // Folded continuation lines (leading whitespace) belong to the previous header
            if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && lastHeader !== null) {
                email.headers[lastHeader] += ' ' + line.replace(/^\s+/, '');
                continue;
            }

            var colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                var header = line.substring(0, colonIndex).toLowerCase();
                var value = line.substring(colonIndex + 1).replace(/^\s+/, '');
                email.headers[header] = value;
                lastHeader = header;
            }
        } else {
            bodyLines.push(line);
        }
    }

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
        email.date = this.parseDate(h.date);
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

    // Walk the MIME tree to populate bodyText, bodyHtml and attachments
    var rawBody = bodyLines.join('\n').replace(/^\s+/, '');
    this.processMimePart(
        email,
        h['content-type'] || 'text/plain',
        h['content-transfer-encoding'] || '',
        h['content-disposition'] || '',
        rawBody
    );

    // Plain-text projection used for search and as a display fallback. Combine
    // the text part and the stripped HTML so a search term present in either is
    // matched (e.g. HTML-only marketing mail with a token plain-text part).
    var searchParts = [];
    if (email.bodyText) {
        searchParts.push(email.bodyText);
    }
    var htmlText = this.stripHtml(email.bodyHtml);
    if (htmlText) {
        searchParts.push(htmlText);
    }
    email.body = searchParts.join('\n');

    return email;
};

MboxParser.prototype.parseEmailAddress = function(address) {
    var match = address.match(/^(.+?)\s*<(.+?)>$/) || address.match(/^(.+)$/);
    if (match) {
        return match.length > 2 ? (match[1].replace(/^\s+|\s+$/g, '') + ' <' + match[2] + '>') : match[1].replace(/^\s+|\s+$/g, '');
    }
    return address;
};

MboxParser.prototype.parseDate = function(dateStr) {
    try {
        return new Date(dateStr).toLocaleString();
    } catch (e) {
        return dateStr;
    }
};

MboxParser.prototype.decodeHeader = function(header) {
    if (!header) return header;
    
    // Handle MIME encoded-word format =?charset?encoding?data?=
    if (header.indexOf('=?') !== -1) {
        try {
            return header.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function(match, charset, encoding, data) {
                try {
                    if (encoding.toLowerCase() === 'b') {
                        // Base64 decode
                        var decoded = atob(data);
                        return this.decodeUtf8(decoded);
                    } else if (encoding.toLowerCase() === 'q') {
                        // Quoted-printable decode
                        var decoded = data.replace(/[=]([0-9A-F]{2})/gi, function(m, hex) {
                            return String.fromCharCode(parseInt(hex, 16));
                        }).replace(/_/g, ' ');
                        return this.decodeUtf8(decoded);
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
            // Malformed multipart without a boundary - keep the raw text
            email.bodyText += body;
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

    var decoded = this.decodeTransferEncoding(body, transferEncoding);
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

    var headers = this.parsePartHeaders(headerBlock);
    this.processMimePart(
        email,
        headers['content-type'] || 'text/plain',
        headers['content-transfer-encoding'] || '',
        headers['content-disposition'] || '',
        partBody
    );
};

MboxParser.prototype.parsePartHeaders = function(headerBlock) {
    var headers = {};
    if (!headerBlock) return headers;

    var lines = headerBlock.split('\n');
    var lastHeader = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');

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

    var quoted = new RegExp(paramName + '\\s*=\\s*"([^"]*)"', 'i');
    var match = headerValue.match(quoted);
    if (match) return match[1];

    var unquoted = new RegExp(paramName + '\\s*=\\s*([^;\\r\\n\\s]+)', 'i');
    match = headerValue.match(unquoted);
    if (match) return match[1];

    return '';
};

MboxParser.prototype.decodeTransferEncoding = function(content, encoding) {
    encoding = (encoding || '').toLowerCase().replace(/^\s+|\s+$/g, '');

    if (encoding.indexOf('base64') !== -1) {
        return this.decodeBase64Text(content);
    }

    if (encoding.indexOf('quoted-printable') !== -1) {
        var qp = content
            .replace(/=\r?\n/g, '')
            .replace(/=([0-9A-Fa-f]{2})/g, function(match, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });
        return this.decodeUtf8(qp);
    }

    // 7bit / 8bit / binary: FileReader already decoded the bytes as UTF-8
    return content;
};

MboxParser.prototype.decodeBase64Text = function(data) {
    try {
        var clean = data.replace(/[^A-Za-z0-9+/=]/g, '');
        return this.decodeUtf8(atob(clean));
    } catch (e) {
        return data;
    }
};

MboxParser.prototype.estimateDecodedSize = function(data, encoding) {
    var enc = (encoding || '').toLowerCase();
    if (enc.indexOf('base64') !== -1) {
        var clean = data.replace(/[^A-Za-z0-9+/=]/g, '');
        return Math.floor(clean.length * 3 / 4);
    }
    return data.length;
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
    var bytes;
    var encoding = (attachment.encoding || '').toLowerCase();

    if (encoding.indexOf('base64') !== -1) {
        var clean = attachment.data.replace(/[^A-Za-z0-9+/=]/g, '');
        var binary = atob(clean);
        bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
    } else if (encoding.indexOf('quoted-printable') !== -1) {
        var qp = attachment.data
            .replace(/=\r?\n/g, '')
            .replace(/=([0-9A-Fa-f]{2})/g, function(match, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });
        bytes = new Uint8Array(qp.length);
        for (var j = 0; j < qp.length; j++) {
            bytes[j] = qp.charCodeAt(j) & 0xff;
        }
    } else {
        bytes = new Uint8Array(attachment.data.length);
        for (var k = 0; k < attachment.data.length; k++) {
            bytes[k] = attachment.data.charCodeAt(k) & 0xff;
        }
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

MboxParser.prototype.searchEmails = function(query) {
    if (!query || !query.replace(/^\s+|\s+$/g, '')) {
        this.filteredEmails = this.emails.slice();
        return this.filteredEmails;
    }

    var searchTerm = query.toLowerCase();
    this.filteredEmails = [];
    
    for (var i = 0; i < this.emails.length; i++) {
        var email = this.emails[i];
        if (email.from.toLowerCase().indexOf(searchTerm) !== -1 ||
            email.subject.toLowerCase().indexOf(searchTerm) !== -1 ||
            email.body.toLowerCase().indexOf(searchTerm) !== -1 ||
            email.to.toLowerCase().indexOf(searchTerm) !== -1) {
            this.filteredEmails.push(email);
        }
    }

    return this.filteredEmails;
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
    this.stats = document.getElementById('stats');
    
    console.log('Elements initialized:', {
        fileInput: !!this.fileInput,
        emailList: !!this.emailList,
        emailViewer: !!this.emailViewer,
        stats: !!this.stats
    });
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
};

MboxViewer.prototype.handleFileSelect = function(event) {
    var file = event.target.files[0];
    if (!file) return;

    // Validate file type
    var validExtensions = ['.mbox', '.txt', '.eml'];
    var fileName = file.name.toLowerCase();
    var hasValidExtension = false;

    for (var i = 0; i < validExtensions.length; i++) {
        if (fileName.indexOf(validExtensions[i]) !== -1) {
            hasValidExtension = true;
            break;
        }
    }

    if (!hasValidExtension && fileName.indexOf('mbox') === -1) {
        this.showError('Please select a valid mbox file (.mbox, .txt, or .eml)');
        return;
    }

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

MboxViewer.prototype.processSmallFile = function(file) {
    var self = this;
    var reader = new FileReader();
    
    reader.onload = function(e) {
        var content = e.target.result;
        
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
        reader.readAsText(file, 'utf-8');
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
        var chunkText = e.target.result;
        var emails = self.parseChunkEmails(chunkText);
        
        // Cache the processed chunk
        self.processedChunks[chunkIndex] = emails;
        
        console.log('Chunk', chunkIndex + 1, 'contains', emails.length, 'emails');
        self.displayChunkEmails(emails);
    };
    
    reader.onerror = function() {
        self.showChunkError('Failed to load chunk ' + (chunkIndex + 1));
    };
    
    reader.readAsText(slice, 'utf-8');
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
                console.log('Email clicked at index:', index);
                console.log('Email data:', emails[index]);
                console.log('EmailViewer element:', self.emailViewer);
                
                if (!self.emailViewer) {
                    console.error('EmailViewer element not found!');
                    return;
                }
                
                self.displayEmail(emails[index]);
                self.highlightSelectedEmail(element);
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

MboxViewer.prototype.performSearch = function() {
    var query = this.searchInput.value.trim();
    
    if (!query) {
        this.showError('Please enter a search term');
        return;
    }

    // Small-file mode: every email is already parsed in memory, so filter directly
    if (!this.file) {
        this.parser.searchEmails(this.searchInput.value);
        this.displayEmailList();
        this.updateStats();
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the search results</div>';
        }
        return;
    }

    console.log('Starting search for:', query);
    this.searchResults = [];
    this.currentSearchChunk = 0;
    this.searchQuery = query.toLowerCase();
    this.isSearchMode = true;
    
    // Show search interface
    this.showSearchInterface();
    this.searchNextChunk();
};

MboxViewer.prototype.clearSearch = function() {
    console.log('Clearing search');
    this.searchInput.value = '';

    // Small-file mode: reset the in-memory filter and re-render the full list
    if (!this.file) {
        this.parser.searchEmails('');
        this.displayEmailList();
        this.updateStats();
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
        }
        return;
    }

    this.isSearchMode = false;
    this.searchResults = [];
    this.searchQuery = '';

    // Return to normal chunk view
    this.showChunkNavigation();
    this.loadChunk(0);
};

MboxViewer.prototype.showSearchInterface = function() {
    var searchHtml = '<div class="search-progress">' +
        '<div class="search-header">Search Results for: "' + this.escapeHtml(this.searchQuery) + '"</div>' +
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
        var chunkText = e.target.result;
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
    
    reader.readAsText(slice, 'utf-8');
};

MboxViewer.prototype.emailMatchesSearch = function(email) {
    var query = this.searchQuery;
    
    return (email.from && email.from.toLowerCase().indexOf(query) !== -1) ||
           (email.to && email.to.toLowerCase().indexOf(query) !== -1) ||
           (email.subject && email.subject.toLowerCase().indexOf(query) !== -1) ||
           (email.body && email.body.toLowerCase().indexOf(query) !== -1) ||
           (email.gmailLabels && email.gmailLabels.some(function(label) {
               return label.toLowerCase().indexOf(query) !== -1;
           }));
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
                self.displayEmail(result.email);
                self.highlightSelectedEmail(element);
            });
        })(i, resultElements[i]);
    }
};

MboxViewer.prototype.displayEmail = function(email) {
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
        '</div>';

    // Reset the viewer with the header plus any attachment list
    this.emailViewer.innerHTML = headerInfo + this.buildAttachmentsHtml(email);

    // Render the body: HTML in a sandboxed iframe, otherwise plain text
    var html = email.bodyHtml ? email.bodyHtml.replace(/^\s+|\s+$/g, '') : '';
    if (html) {
        var frame = document.createElement('iframe');
        frame.className = 'email-html-frame';
        // Empty sandbox: render markup/CSS but block scripts, forms and same-origin access
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

    // Prevent redundant renders if we're already showing emails and count hasn't changed much
    var currentEmailItems = this.emailList.querySelectorAll('.email-item').length;
    if (currentEmailItems > 0 && emails.length - currentEmailItems < 100) {
        console.log('Skipping render - not enough new emails since last render');
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
                console.log('Email clicked:', index);
                self.displayEmail(self.parser.getFilteredEmails()[index]);
                self.highlightSelectedEmail(element);
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
                console.log('Email clicked:', index);
                self.displayEmail(self.parser.getFilteredEmails()[index]);
                self.highlightSelectedEmail(element);
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