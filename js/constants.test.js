import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { I18N } from './constants.js';

test('every visible interface label has a translation in each supported language', async () => {
    const partialDirectory = new URL('../partials/', import.meta.url);
    const partials = await readdir(partialDirectory);
    const html = (await Promise.all(partials.map(path => readFile(new URL(path, partialDirectory), 'utf8')))).join('\n');
    const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map(match => match[1]);
    for (const [language, translations] of Object.entries(I18N)) {
        for (const key of keys) {
            assert.ok(key in translations, `Missing ${language} translation for ${key}`);
        }
    }
});

test('every EPUB processing status has a translation in each supported language', async () => {
    const engine = await readFile(new URL('./epub-engine.js', import.meta.url), 'utf8');
    const keys = [...engine.matchAll(/addOptimization\('([^']+)'/g)].map(match => match[1]);
    for (const [language, translations] of Object.entries(I18N)) {
        for (const key of keys) {
            assert.ok(key in translations, `Missing ${language} translation for ${key}`);
        }
    }
});
