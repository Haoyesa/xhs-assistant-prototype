import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMachineCode } from './machine-id.mjs';
import { PLANS, resolvePlan } from './plans.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB_KEY = fs.readFileSync(path.join(__dirname, 'license.pub.pem'), 'utf8');

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// 凭证格式：base64url(JSON) + '.' + base64url(RS256 签名)
// 签名的字节 = base64url(JSON) 串本身（与服务器端一致）。
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'empty' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'bad-format' };
  const [payloadB64, sigB64] = parts;

  let valid = false;
  try {
    const sig = b64urlDecode(sigB64);
    valid = crypto.verify('RSA-SHA256', Buffer.from(payloadB64, 'utf8'), PUB_KEY, sig);
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

  // 必须携带 machineCode 且与本机一致（fail-closed）：缺字段或不符均判失败，
  // 杜绝「签名有效但 machineCode 为空」的令牌在任意机器上通行、或绕过机器码黑名单。
  if (!payload.machineCode || payload.machineCode !== getMachineCode())
    return { ok: false, reason: 'machine-mismatch' };
  const now = Date.now();
  if (payload.expireAt && payload.expireAt < now) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

// ---- 时钟回拨防护 ----
// 记录「历史见过的最大本地时间」，校验过期时以 max(当前时间, 历史最大值) 为有效 now 下界。
// 这样本地时钟被人为回拨时，已过期令牌不会被错误地当作未过期（防回拨续期）。
const STATE_FILE = 'licstate.json';
function readGuard(userDataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataDir, STATE_FILE), 'utf8'));
    return { lastVerifiedAt: Number(s && s.lastVerifiedAt) || 0 };
  } catch { return { lastVerifiedAt: 0 }; }
}
function writeGuard(userDataDir, lastVerifiedAt) {
  try { fs.writeFileSync(path.join(userDataDir, STATE_FILE), JSON.stringify({ lastVerifiedAt }), 'utf8'); } catch {}
}

export function verifyLicense(userDataDir, token) {
  const r = verifyToken(token);
  if (!r.ok) return r;
  const now = Date.now();
  const guard = readGuard(userDataDir);
  const effNow = Math.max(now, guard.lastVerifiedAt);
  if (r.payload.expireAt && r.payload.expireAt < effNow) return { ok: false, reason: 'expired' };
  writeGuard(userDataDir, Math.max(guard.lastVerifiedAt, now));
  return r;
}

export function loadLicense(userDataDir) {
  const file = path.join(userDataDir, 'license.json');
  if (!fs.existsSync(file)) return null;
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    const r = verifyLicense(userDataDir, token);
    return r.ok ? { token, payload: r.payload } : null;
  } catch {
    return null;
  }
}

export function saveLicense(userDataDir, token) {
  const r = verifyLicense(userDataDir, token);
  if (!r.ok) return r;
  // 原子写：先写 .tmp 再 rename，避免崩溃/断电写坏 license.json 导致下次需重新激活
  const file = path.join(userDataDir, 'license.json');
  const tmp = file + '.tmp';
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(tmp, token, 'utf8');
  try { fs.renameSync(tmp, file); } catch {
    // rename 失败（如杀软占用）则退回直写，尽力而为
    fs.writeFileSync(file, token, 'utf8');
    try { fs.unlinkSync(tmp); } catch {}
  }
  return r;
}

export function clearLicense(userDataDir) {
  const file = path.join(userDataDir, 'license.json');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// 读取本地存储的原始 token 字符串（不校验），用于漂移时把旧 token 交给服务端解绑。
export function readRawToken(userDataDir) {
  const file = path.join(userDataDir, 'license.json');
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

// 解析出当前生效的套餐配置对象（无效/缺省→免费试用）。
export function currentPlan(userDataDir) {
  const lic = loadLicense(userDataDir);
  if (!lic) return resolvePlan('free');
  return resolvePlan(lic.payload.plan);
}
