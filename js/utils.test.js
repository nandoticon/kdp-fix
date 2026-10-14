import test from 'node:test';
import assert from 'node:assert/strict';
import {
    basename,
    decodeEpubText,
    encodeEpubPath,
    normalizeEpubPath,
    normalizeTextEncoding,
    relativeEpubPath,
    resolveEpubPath,
    sniffImageMimeType,
    simplifyLanguage
} from './utils.js';

test('normalizes archive paths and prevents walking above the EPUB root', () => {
    assert.equal(normalizeEpubPath('OPS/text/../chapter 1.xhtml'), 'OPS/chapter 1.xhtml');
    assert.equal(normalizeEpubPath('../../OPS/chapter.xhtml'), 'OPS/chapter.xhtml');
    assert.equal(basename('OPS/chapter.xhtml'), 'chapter.xhtml');
});

test('resolves relative and root-relative EPUB links including escaped spaces', () => {
    assert.equal(resolveEpubPath('OPS/text/chapter.xhtml', '../images/cover%20art.png'), 'OPS/images/cover art.png');
    assert.equal(resolveEpubPath('OPS/text/chapter.xhtml', '/Images/cover.png#cover'), 'Images/cover.png');
});

test('creates links relative to the containing XHTML document', () => {
    assert.equal(relativeEpubPath('OPS/nav.xhtml', 'OPS/text/chapter.xhtml'), 'text/chapter.xhtml');
    assert.equal(relativeEpubPath('OPS/text/chapter.xhtml', 'OPS/images/cover.png'), '../images/cover.png');
    assert.equal(encodeEpubPath('../OPS/chapter 1.xhtml'), '../OPS/chapter%201.xhtml');
});

test('handles missing language values safely', () => {
    assert.equal(simplifyLanguage(undefined), '');
    assert.equal(simplifyLanguage('pt-BR'), 'pt');
});

test('identifies supported cover formats from their file signatures', () => {
    assert.equal(sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
    assert.equal(sniffImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(sniffImageMimeType(new Uint8Array([0x00, 0x01, 0x02])), '');
});

test('decodes UTF-16 EPUB text and legacy XML-declared encodings', () => {
    assert.equal(decodeEpubText(new Uint8Array([0xff, 0xfe, 0x41, 0, 0xe9, 0])), 'Aé');
    const declaration = new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><title>caf');
    const bytes = new Uint8Array([...declaration, 0xe9, ...new TextEncoder().encode('</title>')]);
    assert.equal(decodeEpubText(bytes), '<?xml version="1.0" encoding="windows-1252"?><title>café</title>');

    const htmlPrefix = new TextEncoder().encode('<html><head><meta charset="windows-1252"></head><body>caf');
    const htmlBytes = new Uint8Array([...htmlPrefix, 0xe9, ...new TextEncoder().encode('</body></html>')]);
    assert.equal(decodeEpubText(htmlBytes), '<html><head><meta charset="windows-1252"></head><body>café</body></html>');
});

test('detects UTF-16 XML without a byte-order mark', () => {
    const xml = '<?xml version="1.0"?><title>Book</title>';
    const bytes = new Uint8Array([...xml].flatMap(character => [character.charCodeAt(0), 0]));
    assert.equal(decodeEpubText(bytes), xml);
});

test('rejects unsupported or malformed text encodings instead of silently corrupting text', () => {
    const unsupported = new TextEncoder().encode('<?xml version="1.0" encoding="not-a-real-encoding"?>');
    assert.throws(() => decodeEpubText(unsupported), /Unable to decode EPUB text using not-a-real-encoding/);
    assert.throws(() => decodeEpubText(new Uint8Array([0xc3, 0x28])), /Unable to decode EPUB text using utf-8/);
});

test('normalizes declarations when exporting all supported text formats as UTF-8', () => {
    assert.equal(
        normalizeTextEncoding('\uFEFF<?xml version="1.0" encoding="ISO-8859-1"?><title>é</title>', 'OPS/book.opf'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<title>é</title>'
    );
    assert.equal(
        normalizeTextEncoding('<html><head><meta charset="windows-1252"></head></html>', 'OPS/chapter.xhtml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<html><head><meta charset="utf-8"></head></html>'
    );
    assert.equal(normalizeTextEncoding('@charset "ISO-8859-1"; body {}', 'OPS/book.css'), '@charset "UTF-8"; body {}');
    assert.equal(normalizeTextEncoding('plain text', 'OPS/readme.txt'), 'plain text');
});
