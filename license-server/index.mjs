import http from 'node:http';
import { signToken, verifyToken, issue, revoke, isRevoked, revokeToken, isTokenRevoked } from './lib.mjs';
import { resolvePlan } from '../electron/plans.mjs';

const PORT = Number(process.env.LICENSE_PORT || 8787);
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY || 'changeme-admin-key';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, service: 'license-server' }));
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'bad-json' }));
    }

    // 在线激活：客户端提交机器码 + 套餐 + 计费周期 → 服务器签发凭证
    if (req.url === '/api/activate' && req.method === 'POST') {
      const { machineCode, plan, billing } = json;
      if (!machineCode || !plan) return r404res(res, 400, { error: 'missing-fields' });
      if (!resolvePlan(plan)) return r404res(res, 400, { error: 'bad-plan' });
      try {
        const token = issue(plan, billing, machineCode);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: true, token, plan, billing }));
      } catch (e) {
        return r404res(res, 500, { error: String(e && e.message || e) });
      }
    }

    // 心跳复核：返回 ok / revoked / expired / invalid
    if (req.url === '/api/verify' && req.method === 'POST') {
      const { machineCode, token } = json;
      if (!machineCode) return r404res(res, 400, { error: 'missing-fields' });
      if (isRevoked(machineCode)) return send(res, { status: 'revoked' });
      const v = verifyToken(token);
      if (!v.ok) {
        const st = v.reason === 'expired' ? 'expired' : (v.reason === 'token-revoked' ? 'revoked' : 'invalid');
        return send(res, { status: st, reason: v.reason === 'token-revoked' ? 'token-revoked' : undefined });
      }
      // token 级吊销（自助解绑后旧 token 失效）
      if (v.payload.jti && isTokenRevoked(v.payload.jti)) {
        return send(res, { status: 'revoked', reason: 'token-revoked' });
      }
      // 必须核对 token 内机器码与上报机器码一致，否则他人可拿你的 token 伪造机器码绕过复核
      if (v.payload.machineCode && v.payload.machineCode !== machineCode) {
        return send(res, { status: 'invalid', reason: 'machine-mismatch' });
      }
      return send(res, { status: 'ok', plan: v.payload.plan, expireAt: v.payload.expireAt });
    }

    // 自助解绑：用本地存的那条 token 证明所有权，吊销该 token（不影响机器码，可换机重激活）
    if (req.url === '/api/self/unbind' && req.method === 'POST') {
      const { token } = json;
      if (!token) return r404res(res, 400, { error: 'missing-token' });
      const v = verifyToken(token);
      if (!v.ok) return r404res(res, 400, { error: 'bad-token', reason: v.reason });
      if (v.payload.jti) revokeToken(v.payload.jti);
      return send(res, { ok: true });
    }

    // 自助状态：供激活窗口判断 正常 / 漂移 / 过期 / 已解绑，并展示套餐与到期
    if (req.url === '/api/self/status' && req.method === 'POST') {
      const { token, machineCode } = json;
      if (!token) return r404res(res, 400, { error: 'missing-token' });
      const v = verifyToken(token);
      if (!v.ok) {
        const st = v.reason === 'expired' ? 'expired' : (v.reason === 'token-revoked' ? 'revoked' : 'invalid');
        return send(res, { status: st, reason: v.reason });
      }
      if (v.payload.jti && isTokenRevoked(v.payload.jti)) {
        return send(res, { status: 'revoked', reason: 'token-revoked' });
      }
      const drift = v.payload.machineCode && v.payload.machineCode !== machineCode;
      return send(res, {
        status: drift ? 'drift' : 'ok',
        plan: v.payload.plan,
        expireAt: v.payload.expireAt,
        machineCode: v.payload.machineCode,
      });
    }

    // 管理：吊销某机器码（需 adminKey）
    if (req.url === '/api/admin/revoke' && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      if (!json.machineCode) return r404res(res, 400, { error: 'missing-fields' });
      revoke(json.machineCode);
      return send(res, { ok: true });
    }

    r404res(res, 404, { error: 'not-found' });
  });
});

function send(res, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}
function r404res(res, code, obj) {
  res.statusCode = code;
  send(res, obj);
}

server.listen(PORT, () => {
  console.log(`[license-server] listening on http://127.0.0.1:${PORT}`);
});
