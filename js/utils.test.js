import test from 'node:test';
import assert from 'node:assert/strict';
import {
    basename,
    encodeEpubPath,
    normalizeEpubPath,
    relativeEpubPath,
    resolveEpubPath,
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
