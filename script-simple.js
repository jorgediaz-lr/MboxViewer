// Simple Mbox Viewer - Compatible with older browsers
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
        headers: {},
        raw: rawEmail
    };

    var headerMode = true;
    var bodyLines = [];

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (headerMode) {
            if (line.trim() === '') {
                headerMode = false;
                continue;
            }

            if (line.charAt(0) === ' ' || line.charAt(0) === '\t') {
                continue;
            }

            var colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                var header = line.substring(0, colonIndex).toLowerCase();
                var value = line.substring(colonIndex + 1).replace(/^\s+/, '');
                
                email.headers[header] = value;
                
                if (header === 'from') {
                    email.from = this.parseEmailAddress(this.decodeHeader(value)).replace(/\r?\n/g, '');
                } else if (header === 'to') {
                    email.to = this.parseEmailAddress(this.decodeHeader(value)).replace(/\r?\n/g, '');
                } else if (header === 'subject') {
                    email.subject = this.decodeHeader(value).replace(/\r?\n/g, '');
                } else if (header === 'date') {
                    email.date = this.parseDate(value);
                } else if (header === 'message-id') {
                    email.messageId = value.replace(/\r?\n/g, '');
                } else if (header === 'x-gmail-labels') {
                    email.gmailLabels = this.parseGmailLabels(value);
                } else if (header === 'x-gmail-received') {
                    email.gmailReceived = value;
                } else if (header === 'x-gmail-message-state') {
                    email.gmailState = value;
                } else if (header === 'x-gmail-thread-id') {
                    email.gmailThreadId = value;
                }
            }
        } else {
            bodyLines.push(line);
        }
    }

    email.body = this.decodeEmailBody(bodyLines.join('\n').replace(/^\s+|\s+$/g, ''));
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

MboxParser.prototype.decodeEmailBody = function(body) {
    if (!body) return body;
    
    // Handle MIME multipart messages
    if (body.indexOf('--') === 0 && body.indexOf('Content-Type:') !== -1) {
        return this.extractTextFromMime(body);
    }
    
    // Handle quoted-printable encoding in body
    if (body.indexOf('=') !== -1) {
        try {
            var decoded = body
                // Handle quoted-printable soft line breaks
                .replace(/=\r?\n/g, '')
                // Decode hex sequences
                .replace(/=([0-9A-F]{2})/gi, function(match, hex) {
                    return String.fromCharCode(parseInt(hex, 16));
                });
            return this.decodeUtf8(decoded);
        } catch (e) {
            console.log('Error decoding body:', e);
            return body;
        }
    }
    
    return body;
};

MboxParser.prototype.extractTextFromMime = function(mimeBody) {
    var textContent = '';
    var parts = mimeBody.split(/^--/m);
    
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        
        // Skip boundary markers and empty parts
        if (!part.trim() || part.indexOf('Content-Type:') === -1) {
            continue;
        }
        
        // Look for text/plain parts
        if (part.indexOf('Content-Type: text/plain') !== -1) {
            var bodyStart = part.indexOf('\n\n');
            if (bodyStart === -1) bodyStart = part.indexOf('\r\n\r\n');
            
            if (bodyStart !== -1) {
                var content = part.substring(bodyStart + 2);
                
                // Handle quoted-printable in this part
                if (part.indexOf('Content-Transfer-Encoding: quoted-printable') !== -1) {
                    content = content
                        .replace(/=\r?\n/g, '')
                        .replace(/=([0-9A-F]{2})/gi, function(match, hex) {
                            return String.fromCharCode(parseInt(hex, 16));
                        });
                }
                
                textContent += this.decodeUtf8(content) + '\n\n';
            }
        }
        // If no text/plain found, try text/html and strip tags
        else if (part.indexOf('Content-Type: text/html') !== -1 && textContent === '') {
            var bodyStart = part.indexOf('\n\n');
            if (bodyStart === -1) bodyStart = part.indexOf('\r\n\r\n');
            
            if (bodyStart !== -1) {
                var htmlContent = part.substring(bodyStart + 2);
                
                // Handle quoted-printable in HTML part
                if (part.indexOf('Content-Transfer-Encoding: quoted-printable') !== -1) {
                    htmlContent = htmlContent
                        .replace(/=\r?\n/g, '')
                        .replace(/=([0-9A-F]{2})/gi, function(match, hex) {
                            return String.fromCharCode(parseInt(hex, 16));
                        });
                }
                
                // Basic HTML tag removal
                var textFromHtml = this.decodeUtf8(htmlContent)
                    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]*>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&');
                    
                textContent += textFromHtml + '\n\n';
            }
        }
    }
    
    return textContent.trim() || 'No readable text content found in this email.';
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
    
    if (!this.file) {
        this.showError('Please load an mbox file first');
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
    console.log('displayEmail called with:', email);
    console.log('emailViewer element exists:', !!this.emailViewer);
    console.log('emailViewer innerHTML before:', this.emailViewer ? this.emailViewer.innerHTML.substring(0, 100) : 'N/A');
    
    if (!email) {
        console.log('No email provided');
        if (this.emailViewer) {
            this.emailViewer.innerHTML = '<div class="no-email-selected">No email selected</div>';
        }
        return;
    }

    console.log('Raw email object:', {
        from: email.from,
        subject: email.subject,
        bodyLength: email.body ? email.body.length : 0,
        labels: email.gmailLabels,
        rawFrom: email.headers ? email.headers.from : 'no headers',
        rawSubject: email.headers ? email.headers.subject : 'no headers'
    });

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

    var emailBody = email.body || '(No content)';
    var content = headerInfo + '<div class="email-content">' + this.escapeHtml(emailBody) + '</div>';

    // Make sure we have a valid emailViewer element
    if (!this.emailViewer) {
        this.emailViewer = document.getElementById('emailViewer');
        console.log('Refreshed emailViewer reference:', !!this.emailViewer);
    }
    
    if (!this.emailViewer) {
        console.error('EmailViewer element still not found! DOM might be corrupted.');
        return;
    }
    
    console.log('Setting email viewer content');
    console.log('Content length:', content.length);
    
    try {
        this.emailViewer.innerHTML = content;
        console.log('Email viewer updated successfully');
        console.log('emailViewer innerHTML after:', this.emailViewer.innerHTML.substring(0, 200));
    } catch (error) {
        console.error('Error setting email viewer content:', error);
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
                self.displayEmail(index);
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
                self.displayEmail(index);
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

MboxViewer.prototype.displayEmail = function(index) {
    var emails = this.parser.getFilteredEmails();
    var email = emails[index];
    
    if (!email) return;

    var headerInfo = '<div class="email-header">' +
        '<strong>From:</strong> ' + this.escapeHtml(email.from) + '<br>' +
        '<strong>To:</strong> ' + this.escapeHtml(email.to) + '<br>' +
        '<strong>Subject:</strong> ' + this.escapeHtml(email.subject) + '<br>' +
        '<strong>Date:</strong> ' + this.escapeHtml(email.date) + '<br>' +
        (email.messageId ? '<strong>Message-ID:</strong> ' + this.escapeHtml(email.messageId) + '<br>' : '') +
        '</div>';

    var content = headerInfo + '<div class="email-content">' + this.escapeHtml(email.body) + '</div>';

    this.emailViewer.innerHTML = content;
};

MboxViewer.prototype.highlightSelectedEmail = function(selectedItem) {
    var items = this.emailList.querySelectorAll('.email-item');
    for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('selected');
    }
    selectedItem.classList.add('selected');
};

MboxViewer.prototype.performSearch = function() {
    var query = this.searchInput.value;
    this.parser.searchEmails(query);
    this.displayEmailList();
    this.updateStats();
    this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the search results</div>';
};

MboxViewer.prototype.clearSearch = function() {
    this.searchInput.value = '';
    this.parser.searchEmails('');
    this.displayEmailList();
    this.updateStats();
    this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
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