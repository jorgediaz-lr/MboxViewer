# Mbox File Viewer

A simple, web-based viewer for mbox email files exported from Gmail and other email clients.

## Features

- 📧 Parse and display mbox files from Gmail exports
- 🔍 Search through email content, subjects, senders, and recipients
- 📱 Responsive design that works on desktop and mobile
- 🎨 Clean, modern interface inspired by Apple's design language
- ⚡ Fast client-side processing with no server required
- 🔒 Completely private - all processing happens in your browser

## How to Use

1. **Open the viewer**: Open `index.html` in your web browser
2. **Load an mbox file**: Click "Choose Mbox File" and select your exported mbox file
3. **Browse emails**: Click on any email in the left panel to view its content
4. **Search**: Use the search box to find specific emails by content, subject, or sender
5. **Navigate**: Use the responsive interface to browse through your email archive

## Getting Your Gmail Export

1. Go to [Google Takeout](https://takeout.google.com)
2. Select "Mail" 
3. Choose the mbox format
4. Download your archive
5. Extract the mbox files from the downloaded archive
6. Use this viewer to open the mbox files

## File Structure

```
mbox-viewer/
├── index.html      # Main HTML file - open this in your browser
├── styles.css      # Styling and layout
├── script.js       # JavaScript for parsing and displaying emails
└── README.md       # This file
```

## Technical Details

- **Client-side only**: No server required, works entirely in your browser
- **mbox format support**: Handles standard mbox format as used by Gmail, Thunderbird, etc.
- **Email parsing**: Extracts headers (From, To, Subject, Date) and message body
- **Search functionality**: Real-time search across all email fields
- **Responsive design**: Works on both desktop and mobile devices

## Browser Compatibility

This viewer works in all modern browsers:
- Chrome/Edge 80+
- Firefox 75+
- Safari 13+

## Privacy

All email processing happens entirely in your browser. No data is sent to any server, ensuring your emails remain private and secure.

## Limitations

- Very large mbox files (>100MB) may take time to load
- Complex HTML emails are displayed as plain text
- Attachments are not extracted or displayed

## License

This project is open source and licensed under the **GNU Affero General Public License, Version 3 (AGPLv3)**.

Original components from the first commit are licensed under the **MIT License** by the initial author. See the `LICENSE` file for full copyright notices and license text of both components.
