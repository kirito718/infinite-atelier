import { randomBytes, timingSafeEqual } from 'node:crypto';

const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function terminalTask(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function redactBridgeError(value) {
  const redactedBearer = String(value).replace(/\b(bearer)\s+\S+/gi, '$1 [redacted]');

  return redactedBearer
    .replace(/x-atelier-bridge-token(?:\s*:\s*[^\s'"]+)?/gi, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{8,})\b/g, '[redacted]');
}

export function requireBridgeRequest(req, secret) {
  const remoteAddress = req?.socket?.remoteAddress;

  if (!LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress) && !String(remoteAddress ?? '').startsWith('127.')) {
    throw new Error('Unauthorized local bridge request');
  }

  const presentedToken = req?.headers?.['x-atelier-bridge-token'];

  if (!isNonEmptyString(secret) || !isNonEmptyString(presentedToken)) {
    throw new Error('Unauthorized local bridge request');
  }

  if (Buffer.byteLength(secret) !== Buffer.byteLength(presentedToken)) {
    throw new Error('Unauthorized local bridge request');
  }

  if (!timingSafeEqual(Buffer.from(secret), Buffer.from(presentedToken))) {
    throw new Error('Unauthorized local bridge request');
  }

  return true;
}

export function createBridgeToken() {
  return randomBytes(32).toString('base64url');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
