import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { I18N } from './constants.js';

test('every visible interface label has a translation in each supported language', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
    for (const [language, translations] of Object.entries(I18N)) {
        for (const key of keys) {
            assert.ok(key in translations, `Missing ${language} translation for ${key}`);
        }
    }
});
