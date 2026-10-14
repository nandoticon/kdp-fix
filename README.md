# Kindle EPUB Fix (v2.3)

A browser-based tool for checking and repairing EPUBs for Amazon Send to Kindle, with optional Vercel-hosted ebook conversion.

## Features

- Batch processing with limited concurrency to reduce memory pressure.
- UTF-8 normalization for supported EPUB text resources, including UTF-8, UTF-16, and declared legacy encodings on input.
- EPUB 2/3 package metadata and cover editing, including nested package paths and namespaced XML.
- EPUB navigation generation in spine reading order and internal-link validation.
- Large JPEG/PNG compression only when the result is smaller, while preserving the original image format.
- ZIP reader limits of 20,000 entries and 512 MiB total uncompressed content per EPUB.
- Embedded fonts and original CSS are preserved to avoid unexpectedly changing a book's appearance.
- A sandboxed, script-disabled chapter preview with packaged resources embedded locally.
- Explicitly clear processed books and release their in-memory data when finished.
- Validate replacement cover image contents rather than trusting the selected file's extension.
- English, Portuguese, and Spanish UI; light/dark themes; installable PWA support.
- Local SVG/PNG favicon, Apple touch icon, and installable PWA icons cached for offline use.
- Lucide icons identify interface actions and optimization statuses; the Lucide runtime is version-pinned and cached by the service worker.
- EPUB repair remains browser-based and available offline.
- Optional conversion runs Calibre in a Vercel container and supports conversions between EPUB, MOBI, and AZW3. DRM-protected books may not convert.
- Conversion is opt-in and uploads the selected book to Vercel. Upload and converted output are limited to 4 MiB; files are held in temporary storage and deleted after the request. Conversion uses metered Vercel container compute.

Language detection is intentionally conservative: when the package language is missing or invalid, the tool reports that it could not confidently identify the language rather than guessing and changing the book metadata. Missing image descriptions are reported without adding generic, misleading alt text. Chapter splitting and Kindle PageFlip metadata are not implemented and are reported as skipped.

## Run locally

Serve the project over HTTP (ES modules and service workers require a server):

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. The local static server supports offline EPUB repair, but not the Vercel-only conversion API. On the first online visit the app loads its browser libraries from public CDNs; after they are cached by the service worker, the app can work offline while the browser retains its cache.

## Tests

Run the regression tests with Node.js 18 or newer:

```bash
npm test
```

Run the converter validation tests with Python 3:

```bash
python -m unittest discover -s backend -p "test_*.py"
```

## Source layout

- `js/app.js` coordinates file processing and user actions; `js/ui.js` renders statuses and result cards.
- `js/preview.js` builds the sandboxed EPUB preview; `js/epub-engine.js` and `js/utils.js` contain EPUB handling.
- `js/converter-availability.js` checks the optional Vercel converter separately; `backend/` contains the Calibre-backed conversion service and request validation (KFX is out of scope).
- `Dockerfile.vercel` packages the static app and converter service in a Vercel Container Function; `vercel.json` routes the deployment through that service.
- `js/constants.js` assembles the English, Portuguese, and Spanish dictionaries from `js/i18n/`.
- `styles.css` loads the focused stylesheets in `styles/`.
- `index.html` is the page shell; `partials/` contains its UI sections, assembled by `js/bootstrap.js`.
- `sw.js` pre-caches the page fragments, stylesheets, and modules for offline startup.

## Privacy

EPUB repair files remain in browser memory and are not sent to a server. If conversion mode is chosen, the selected book is sent to Vercel, processed in a temporary directory, and not persisted. Conversion is limited to 4 MiB input and output. UI libraries load from public CDNs on first use; book files are never included in those requests.
