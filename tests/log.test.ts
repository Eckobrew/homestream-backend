import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/log';
test('logs redact upstream locations, credential fields and bearer values', () => {
  const original = console.warn;
  let output = '';
  console.warn = (...values: unknown[]) => { output = JSON.stringify(values); };
  try {
    log.warn('failed https://upstream.test/stream?api_key=secret Bearer other-secret', { accessToken: 'private', password: 'private' }, new Error('https://secret.test/token'));
    assert.ok(!output.includes('secret'));
    assert.ok(!output.includes('private'));
    assert.match(output, /redacted/);
    assert.match(output, /Error/);
  } finally { console.warn = original; }
});
