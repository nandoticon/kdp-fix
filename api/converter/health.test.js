import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './health.js';

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('health endpoint reports conversion unavailable until an engine exists', () => {
  const response = createResponse();
  handler({ method: 'GET' }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store, max-age=0');
  assert.deepEqual(response.body, {
    available: false,
    reason: 'conversion_engine_not_configured'
  });
});

test('health endpoint rejects methods other than GET', () => {
  const response = createResponse();
  handler({ method: 'POST' }, response);

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET');
  assert.deepEqual(response.body, { error: 'Method not allowed' });
});
