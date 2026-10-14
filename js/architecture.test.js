import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('every HTML fragment is mounted by the bootstrap module and cached offline', async () => {
    const bootstrap = await readFile(new URL('./bootstrap.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const serviceWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const fragments = [...bootstrap.matchAll(/\['([^']+)',\s*'\.\.\/partials\/([^']+)'\]/g)];

    assert.ok(fragments.length > 0, 'Expected at least one mounted HTML fragment');
    for (const [, mountId, filename] of fragments) {
        assert.match(html, new RegExp(`id="${mountId}"`), `Missing mount point #${mountId}`);
        await readFile(new URL(`../partials/${filename}`, import.meta.url));
        assert.ok(serviceWorker.includes(`'partials/${filename}'`), `Fragment ${filename} is not cached offline`);
    }
});

test('every stylesheet imported by the CSS entrypoint exists', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
    const imports = [...styles.matchAll(/@import url\("([^"]+)"\);/g)].map(match => match[1]);

    assert.ok(imports.length > 0, 'Expected styles.css to import modular stylesheets');
    for (const path of imports) {
        await readFile(new URL(`../${path}`, import.meta.url));
    }
});

test('favicon and installable app icons are local assets', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const serviceWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const faviconPaths = [...html.matchAll(/href="(icons\/[^"]+)"/g)].map(match => match[1]);

    assert.ok(faviconPaths.includes('icons/favicon.svg'), 'Expected an SVG favicon');
    assert.ok(faviconPaths.includes('icons/apple-touch-icon.png'), 'Expected an Apple touch icon');
    for (const path of faviconPaths) {
        await readFile(new URL(`../${path}`, import.meta.url));
        assert.ok(serviceWorker.includes(`'${path}'`), `Favicon ${path} is not cached offline`);
    }
    for (const icon of manifest.icons) {
        assert.ok(!/^https?:/i.test(icon.src), `App icon should be local: ${icon.src}`);
        await readFile(new URL(`../${icon.src}`, import.meta.url));
        assert.ok(serviceWorker.includes(`'${icon.src}'`), `App icon ${icon.src} is not cached offline`);
    }
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'), 'Expected a dedicated maskable icon');
});

test('optional converter health requests bypass service-worker caching', async () => {
    const serviceWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const checker = await readFile(new URL('./converter-availability.js', import.meta.url), 'utf8');
    const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
    const partials = await readFile(new URL('../partials/workspace.html', import.meta.url), 'utf8');

    assert.match(serviceWorker, /pathname\.startsWith\(converterApiPath\)\) return/);
    assert.match(checker, /cache:\s*'no-store'/);
    assert.match(app, /showConverterAvailability\(/);
    assert.match(partials, /id="conversion-status"/);
    assert.match(partials, /EPUB repair still works offline/);
    assert.ok(serviceWorker.includes("'js/converter-availability.js'"), 'Converter status module is not cached offline');
    assert.match(app, /void showConverterAvailability\(/, 'Converter status check must not block EPUB app startup');
});
