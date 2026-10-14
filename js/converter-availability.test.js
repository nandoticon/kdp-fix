import test from 'node:test';
import assert from 'node:assert/strict';
import { isConverterAvailable } from './converter-availability.js';

test('detects a healthy optional conversion service', async () => {
    const available = await isConverterAvailable({
        fetchImpl: async (_url, options) => {
            assert.equal(options.cache, 'no-store');
            return { ok: true, json: async () => ({ available: true }) };
        }
    });
    assert.equal(available, true);
});

test('reports unavailable for missing, unhealthy, or unreachable conversion services', async () => {
    assert.equal(await isConverterAvailable({
        fetchImpl: async () => ({ ok: true, json: async () => ({ available: false }) })
    }), false);
    assert.equal(await isConverterAvailable({
        fetchImpl: async () => ({ ok: false, json: async () => ({ available: true }) })
    }), false);
    assert.equal(await isConverterAvailable({
        fetchImpl: async () => { throw new TypeError('offline'); }
    }), false);
    assert.equal(await isConverterAvailable({
        fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })
    }), false);
});

test('times out a converter health check without blocking EPUB repair', async () => {
    const available = await isConverterAvailable({
        timeoutMs: 5,
        fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })
    });
    assert.equal(available, false);
});
