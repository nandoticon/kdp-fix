# Version history

## v2.2 — October 14, 2026

- Add a clear-results action that closes previews, revokes cover object URLs, and releases processed book data.
- Correct the wide-screen layout so the status, controls, and results flow together in one results panel.
- Reject unsupported or malformed text encodings instead of silently falling back to UTF-8 and altering book content.
- Validate cover image signatures and reject file types that do not match their contents.
- Keep EPUB repair independent of the optional conversion service; report converter unavailability without blocking offline repair.
- Add regression coverage for strict encoding and image-signature validation.

## v2.1 — October 14, 2026

- Decode EPUB text according to byte-order marks and declared XML encodings; normalize supported text declarations to UTF-8 before export.
- Close ZIP readers after errors and reject malformed/missing package documents with a clear per-file error.
- Preserve CSS, embedded fonts, and original image accessibility content rather than applying potentially damaging guesses.
- Generate navigation in OPF spine order and support namespaced package documents and Dublin Core metadata.
- Limit concurrent batch processing to two EPUBs and summarize partial failures.
- Reject archives with more than 20,000 entries or 512 MiB of declared uncompressed content.
- Split the app, UI, preview, and translation dictionaries into JavaScript modules; organize CSS in layers and page markup in cached HTML fragments.
- Add regression coverage for encoding, path handling, and translations across all page fragments.

## v2.0

- Modular ES module application and service-worker-based offline caching.
- Batch processing, metadata editing, cover replacement, and chapter preview.
- English, Portuguese, and Spanish translations; light and dark themes.

## v1.5

- Initial batch support, metadata editor, EPUB preview, and responsive visual redesign.
