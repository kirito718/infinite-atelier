import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBridgeToken,
  redactBridgeError,
  requireBridgeRequest,
  terminalTask,
} from './bridge-utils.mjs';

test('requireBridgeRequest rejects non-secret local requests', () => {
  assert.throws(
    () => requireBridgeRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, 'secret'),
    /Unauthorized local bridge request/,
  );
});

test('requireBridgeRequest rejects missing or empty bridge credentials', () => {
  assert.throws(
    () =>
      requireBridgeRequest(
        { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        undefined,
      ),
    /Unauthorized local bridge request/,
  );

  assert.throws(
    () =>
      requireBridgeRequest(
        { headers: { 'x-atelier-bridge-token': '' }, socket: { remoteAddress: '127.0.0.1' } },
        '',
      ),
    /Unauthorized local bridge request/,
  );
});

test('redactBridgeError redacts bearer tokens', () => {
  assert.equal(
    redactBridgeError('request failed Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'),
    'request failed Bearer [redacted]',
  );
});

test('redactBridgeError redacts lowercase bearer and bridge token text', () => {
  assert.equal(
    redactBridgeError(
      'request failed bearer eyJhbGciOiJIUzI1NiJ9.payload.signature x-atelier-bridge-token: secret',
    ),
    'request failed bearer [redacted] [redacted]',
  );
});

test('redactBridgeError redacts serialized bridge headers', () => {
  assert.equal(
    redactBridgeError('{"x-atelier-bridge-token":"verysecretvalue"}'),
    '{"[redacted]":"[redacted]"}',
  );
});

test('terminalTask only accepts terminal states', () => {
  assert.equal(terminalTask('succeeded'), true);
  assert.equal(terminalTask('failed'), true);
  assert.equal(terminalTask('cancelled'), true);
  assert.equal(terminalTask('generating'), false);
});

test('createBridgeToken returns unique url-safe tokens', () => {
  const first = createBridgeToken();
  const second = createBridgeToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
