class MboxParser {
    constructor() {
        this.emails = [];
        this.filteredEmails = [];
        this.currentEmailIndex = -1;
    }

    parseMboxFile(content) {
        this.emails = [];
        const messages = content.split(/^From /m);
        
        for (let i = 1; i < messages.length; i++) {
            const message = 'From ' + messages[i];
            const email = this.parseEmail(message);
            if (email) {
                this.emails.push(email);
            }
        }
        
        this.filteredEmails = [...this.emails];
        return this.emails;
    }

    parseEmail(rawEmail) {
        const lines = rawEmail.split('\n');
        const email = {
            from: '',
            to: '',
            subject: '',
            date: '',
            messageId: '',
            body: '',
            headers: {},
            raw: rawEmail
        };

        let headerMode = true;
        let bodyLines = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (headerMode) {
                if (line.trim() === '') {
                    headerMode = false;
                    continue;
                }

                if (line.startsWith(' ') || line.startsWith('\t')) {
                    continue;
                }

                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    const header = line.substring(0, colonIndex).toLowerCase();
                    const value = line.substring(colonIndex + 1).trim();
                    
                    email.headers[header] = value;
                    
                    switch (header) {
                        case 'from':
                            email.from = this.parseEmailAddress(value);
                            break;
                        case 'to':
                            email.to = this.parseEmailAddress(value);
                            break;
                        case 'subject':
                            email.subject = this.decodeHeader(value);
                            break;
                        case 'date':
                            email.date = this.parseDate(value);
                            break;
                        case 'message-id':
                            email.messageId = value;
                            break;
                    }
                }
            } else {
                bodyLines.push(line);
            }
        }

        email.body = bodyLines.join('\n').trim();
        return email;
    }

    parseEmailAddress(address) {
        const match = address.match(/^(.+?)\s*<(.+?)>$/) || address.match(/^(.+)$/);
        if (match) {
            return match.length > 2 ? `${match[1].trim()} <${match[2]}>` : match[1].trim();
        }
        return address;
    }

    parseDate(dateStr) {
        try {
            return new Date(dateStr).toLocaleString();
        } catch (e) {
            return dateStr;
        }
    }

    decodeHeader(header) {
        if (header.includes('=?')) {
            try {
                return header.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, data) => {
                    if (encoding.toLowerCase() === 'b') {
                        return atob(data);
                    } else if (encoding.toLowerCase() === 'q') {
                        return data.replace(/[=]([0-9A-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
                    }
                    return data;
                });
            } catch (e) {
                return header;
            }
        }
        return header;
    }

    searchEmails(query) {
        if (!query.trim()) {
            this.filteredEmails = [...this.emails];
            return this.filteredEmails;
        }

        const searchTerm = query.toLowerCase();
        this.filteredEmails = this.emails.filter(email => 
            email.from.toLowerCase().includes(searchTerm) ||
            email.subject.toLowerCase().includes(searchTerm) ||
            email.body.toLowerCase().includes(searchTerm) ||
            email.to.toLowerCase().includes(searchTerm)
        );

        return this.filteredEmails;
    }

    getFilteredEmails() {
        return this.filteredEmails;
    }

    getEmailCount() {
        return this.emails.length;
    }

    getFilteredEmailCount() {
        return this.filteredEmails.length;
    }
}

class MboxViewer {
    constructor() {
        this.parser = new MboxParser();
        this.initializeElements();
        this.attachEventListeners();
    }

    initializeElements() {
        this.fileInput = document.getElementById('mboxFile');
        this.fileInfo = document.getElementById('fileInfo');
        this.emailList = document.getElementById('emailList');
        this.emailViewer = document.getElementById('emailViewer');
        this.searchInput = document.getElementById('searchInput');
        this.searchBtn = document.getElementById('searchBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.stats = document.getElementById('stats');
    }

    attachEventListeners() {
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        this.searchBtn.addEventListener('click', () => this.performSearch());
        this.clearBtn.addEventListener('click', () => this.clearSearch());
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performSearch();
            }
        });
    }

    async handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Validate file type
        const validExtensions = ['.mbox', '.txt', '.eml'];
        const fileName = file.name.toLowerCase();
        const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));
        
        if (!hasValidExtension && !fileName.includes('mbox')) {
            this.showError('Please select a valid mbox file (.mbox, .txt, or .eml)');
            return;
        }

        this.fileInfo.textContent = `Selected: ${file.name} (${this.formatFileSize(file.size)})`;

        // For large files, use chunked processing
        if (file.size > 100 * 1024 * 1024) { // 100MB+
            await this.processLargeFile(file);
        } else {
            await this.processSmallFile(file);
        }
    }

    async processSmallFile(file) {
        this.showLoading('Reading file...');
        
        try {
            const content = await this.readFile(file);
            
            // Basic validation that this looks like an mbox file
            if (!content.includes('From ') && !content.includes('Message-ID:')) {
                throw new Error('This does not appear to be a valid mbox file');
            }
            
            this.showLoading('Parsing emails...');
            
            setTimeout(() => {
                try {
                    const emails = this.parser.parseMboxFile(content);
                    if (emails.length === 0) {
                        this.showError('No emails found in this file. Please check if it\'s a valid mbox format.');
                        return;
                    }
                    this.displayEmailList();
                    this.updateStats();
                    this.hideLoading();
                } catch (parseError) {
                    this.showError(`Error parsing emails: ${parseError.message}`);
                }
            }, 100);
        } catch (error) {
            this.showError(error.message);
        }
    }

    async processLargeFile(file) {
        this.showLoading('Processing large file in chunks...');
        
        try {
            this.parser.emails = [];
            this.parser.filteredEmails = [];
            
            let processedSize = 0;
            let buffer = '';
            let emailCount = 0;
            
            const chunkSize = 10 * 1024 * 1024; // 10MB chunks
            const totalChunks = Math.ceil(file.size / chunkSize);
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, file.size);
                const chunk = file.slice(start, end);
                
                this.showLoading(`Processing chunk ${i + 1}/${totalChunks} (${emailCount} emails found)...`);
                
                const chunkText = await this.readFileChunk(chunk);
                buffer += chunkText;
                
                // Process complete emails from buffer
                const { processedEmails, remainingBuffer } = this.processBuffer(buffer);
                
                for (const email of processedEmails) {
                    this.parser.emails.push(email);
                    emailCount++;
                }
                
                buffer = remainingBuffer;
                processedSize += chunkText.length;
                
                // Update UI periodically
                if (i % 10 === 0 || i === totalChunks - 1) {
                    this.parser.filteredEmails = [...this.parser.emails];
                    this.displayEmailList();
                    this.updateStats();
                }
                
                // Small delay to prevent browser freezing
                if (i % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            
            // Process any remaining data in buffer
            if (buffer.trim()) {
                const finalEmails = this.processFinalBuffer(buffer);
                for (const email of finalEmails) {
                    this.parser.emails.push(email);
                }
            }
            
            this.parser.filteredEmails = [...this.parser.emails];
            this.displayEmailList();
            this.updateStats();
            this.hideLoading();
            
            console.log(`Successfully processed ${this.parser.emails.length} emails from ${this.formatFileSize(file.size)} file`);
            
        } catch (error) {
            this.showError(`Error processing large file: ${error.message}`);
        }
    }

    readFileChunk(chunk) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file chunk'));
            reader.readAsText(chunk, 'utf-8');
        });
    }

    processBuffer(buffer) {
        const emails = [];
        const messages = buffer.split(/^From /m);
        
        // Process all complete messages except the last one (might be incomplete)
        for (let i = 1; i < messages.length - 1; i++) {
            const message = 'From ' + messages[i];
            const email = this.parser.parseEmail(message);
            if (email) {
                emails.push(email);
            }
        }
        
        // Return remaining buffer (last incomplete message)
        const remainingBuffer = messages.length > 1 ? 'From ' + messages[messages.length - 1] : buffer;
        
        return { processedEmails: emails, remainingBuffer };
    }

    processFinalBuffer(buffer) {
        const emails = [];
        const messages = buffer.split(/^From /m);
        
        for (let i = 1; i < messages.length; i++) {
            const message = 'From ' + messages[i];
            const email = this.parser.parseEmail(message);
            if (email) {
                emails.push(email);
            }
        }
        
        return emails;
    }

    readFile(file) {
        return new Promise((resolve, reject) => {
            if (!file) {
                reject(new Error('No file selected'));
                return;
            }

            if (file.size === 0) {
                reject(new Error('File is empty'));
                return;
            }

            if (file.size > 10 * 1024 * 1024 * 1024) { // 10GB limit
                reject(new Error('File is too large (max 10GB)'));
                return;
            }

            const reader = new FileReader();
            
            reader.onload = (e) => {
                if (!e.target.result) {
                    reject(new Error('File content is empty'));
                    return;
                }
                resolve(e.target.result);
            };
            
            reader.onerror = (e) => {
                reject(new Error(`Failed to read file: ${reader.error?.message || 'Unknown error'}`));
            };
            
            reader.onabort = () => {
                reject(new Error('File reading was aborted'));
            };

            try {
                reader.readAsText(file, 'utf-8');
            } catch (error) {
                reject(new Error(`Cannot read file: ${error.message}`));
            }
        });
    }

    displayEmailList() {
        const emails = this.parser.getFilteredEmails();
        
        if (emails.length === 0) {
            this.emailList.innerHTML = '<div class="no-file-message">No emails found</div>';
            return;
        }

        const emailItems = emails.map((email, index) => {
            const date = email.date || 'No date';
            const from = email.from || 'Unknown sender';
            const subject = email.subject || '(No subject)';
            
            return `
                <div class="email-item" data-index="${index}">
                    <div class="email-from">${this.escapeHtml(from)}</div>
                    <div class="email-subject">${this.escapeHtml(subject)}</div>
                    <div class="email-date">${this.escapeHtml(date)}</div>
                </div>
            `;
        }).join('');

        this.emailList.innerHTML = emailItems;

        this.emailList.querySelectorAll('.email-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.displayEmail(index);
                this.highlightSelectedEmail(item);
            });
        });
    }

    displayEmail(index) {
        const emails = this.parser.getFilteredEmails();
        const email = emails[index];
        
        if (!email) return;

        const headerInfo = `
            <div class="email-header">
                <strong>From:</strong> ${this.escapeHtml(email.from)}<br>
                <strong>To:</strong> ${this.escapeHtml(email.to)}<br>
                <strong>Subject:</strong> ${this.escapeHtml(email.subject)}<br>
                <strong>Date:</strong> ${this.escapeHtml(email.date)}<br>
                ${email.messageId ? `<strong>Message-ID:</strong> ${this.escapeHtml(email.messageId)}<br>` : ''}
            </div>
        `;

        const content = `
            ${headerInfo}
            <div class="email-content">${this.escapeHtml(email.body)}</div>
        `;

        this.emailViewer.innerHTML = content;
    }

    highlightSelectedEmail(selectedItem) {
        this.emailList.querySelectorAll('.email-item').forEach(item => {
            item.classList.remove('selected');
        });
        selectedItem.classList.add('selected');
    }

    performSearch() {
        const query = this.searchInput.value;
        this.parser.searchEmails(query);
        this.displayEmailList();
        this.updateStats();
        this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the search results</div>';
    }

    clearSearch() {
        this.searchInput.value = '';
        this.parser.searchEmails('');
        this.displayEmailList();
        this.updateStats();
        this.emailViewer.innerHTML = '<div class="no-email-selected">Select an email from the list to view its content</div>';
    }

    updateStats() {
        const total = this.parser.getEmailCount();
        const filtered = this.parser.getFilteredEmailCount();
        
        if (total === 0) {
            this.stats.textContent = '';
            return;
        }

        if (filtered === total) {
            this.stats.textContent = `Total emails: ${total}`;
        } else {
            this.stats.textContent = `Showing ${filtered} of ${total} emails`;
        }
    }

    showLoading(message) {
        this.emailList.innerHTML = `<div class="loading">${message}</div>`;
        this.emailViewer.innerHTML = '<div class="no-email-selected">Loading...</div>';
    }

    hideLoading() {
        // Loading will be hidden when displayEmailList is called
    }

    showError(message) {
        this.emailList.innerHTML = `<div class="error">${message}</div>`;
        this.emailViewer.innerHTML = '<div class="no-email-selected">Error occurred</div>';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MboxViewer();
});