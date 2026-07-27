import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlan } from '../electron/plans.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIV = fs.readFileSync(path.join(__dirname, 'keys', 'private.pem'), 'utf8');
const PUB = fs.readFileSync(path.join(__dirname, 'keys', 'public.pem'), 'utf8');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
};

// 凭证格式与客户端一致：base64url(JSON) + '.' + base64url(RS256 签名)
export function signToken(payload) {
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(p, 'utf8'), PRIV);
  return p + '.' + b64url(sig);
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'empty' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad-format' };
  const [payloadB64, sigB64] = parts;
  let valid = false;
  try {
    const sig = b64urlDecode(sigB64);
    valid = crypto.verify('RSA-SHA256', Buffer.from(payloadB64, 'utf8'), PUB, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  const now = Date.now();
  if (payload.expireAt && payload.expireAt < now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// 吊销名单（持久化）。心跳复核时查此集合。
const REVOKED_FILE = path.join(__dirname, 'revoked.json');
function loadRevoked() {
  try {
    return new Set(JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}
function saveRevoked(set) {
  fs.writeFileSync(REVOKED_FILE, JSON.stringify([...set], null, 2));
}
export function revoke(mc) {
  const s = loadRevoked();
  s.add(mc);
  saveRevoked(s);
}
export function isRevoked(mc) {
  return loadRevoked().has(mc);
}

// 按套餐 + 计费周期签发（monthly=30天, yearly=365天）。
export function issue(plan, billing, machineCode) {
  resolvePlan(plan); // 校验 plan 存在
  const days = billing === 'yearly' ? 365 : 30;
  const expireAt = Date.now() + days * 86400000;
  return signToken({
    machineCode,
    plan,
    billing: billing || 'monthly',
    issuedAt: Date.now(),
    expireAt,
  });
}
