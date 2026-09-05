import { randomBytes } from 'node:crypto';

const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function terminalTask(status) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function redactBridgeError(value) {
  const redactedBearer = String(value).replace(/Bearer\s+\S+/g, 'Bearer [redacted]');

  return redactedBearer.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{8,})\b/g, '[redacted]');
}

export function requireBridgeRequest(req, secret) {
  const remoteAddress = req?.socket?.remoteAddress;

  if (!LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress) && !String(remoteAddress ?? '').startsWith('127.')) {
    throw new Error('Unauthorized local bridge request');
  }

  if (req?.headers?.['x-atelier-bridge-token'] !== secret) {
    throw new Error('Unauthorized local bridge request');
  }

  return true;
}

export function createBridgeToken() {
  return randomBytes(32).toString('base64url');
}
