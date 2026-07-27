import http from 'node:http';
import { signToken, verifyToken, issue, revoke, isRevoked, revokeToken, isTokenRevoked } from './lib.mjs';
import { resolvePlan } from '../electron/plans.mjs';
import {
  PRICE_TABLE,
  planPrice,
  createOrder,
  getOrder,
  markPaid,
  fulfillOrder,
  manualIssue,
  verifyProviderCallback,
} from './payments.mjs';
import { createTeam, teamInfo, activateSeat, revokeSeat } from './teams.mjs';

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

    // 价格表（公开，供收银台展示）
    if (req.url === '/api/prices' && req.method === 'GET') {
      return send(res, { ok: true, prices: PRICE_TABLE });
    }

    // 创建支付订单：客户端提交 plan/billing/machineCode/method
    if (req.url === '/api/checkout' && req.method === 'POST') {
      const { plan, billing, machineCode, method } = json;
      if (!plan) return r404res(res, 400, { error: 'missing-plan' });
      try {
        const order = createOrder({ plan, billing, machineCode, method: method || 'manual' });
        return send(res, {
          ok: true,
          outTradeNo: order.outTradeNo,
          amount: order.amount,
          currency: order.currency,
          status: order.status,
          method: order.method,
          payUrl: null, // 真实渠道由 provider 返回；未配置时为 null
          note:
            order.method === 'manual'
              ? '人工发卡模式：完成付款后联系客服并提供机器码，或由管理员在后台手动发卡。'
              : '请在支付网关完成付款，成功后系统会自动回调发卡。',
        });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 订单查询：fulfilled 时一并返回 token（客户端可自动激活）
    if (req.url.startsWith('/api/order/') && req.method === 'GET' && !req.url.endsWith('/fulfill')) {
      const id = req.url.slice('/api/order/'.length).split('?')[0];
      const o = getOrder(id);
      if (!o) return r404res(res, 404, { error: 'order-not-found' });
      const token = o.status === 'fulfilled' ? o.token : null;
      const { token: _t, ...rest } = o;
      return send(res, { ok: true, order: { ...rest, token } });
    }

    // 补机器码完成发卡（paid -> fulfilled）
    if (req.url.startsWith('/api/order/') && req.url.endsWith('/fulfill') && req.method === 'POST') {
      const id = req.url.slice('/api/order/'.length).replace(/\/fulfill$/, '').split('?')[0];
      try {
        const o = fulfillOrder(id, json.machineCode);
        if (!o) return r404res(res, 404, { error: 'order-not-found' });
        return send(res, { ok: true, outTradeNo: o.outTradeNo, status: o.status, token: o.status === 'fulfilled' ? o.token : null });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 支付渠道回调（验签骨架，接入真实渠道时补全 secret 与算法）
    if (req.url.startsWith('/api/webhook/') && req.method === 'POST') {
      const provider = req.url.slice('/api/webhook/'.length).split('?')[0];
      const secret = process.env['PAY_SECRET_' + provider.toUpperCase()] || process.env.PAY_SECRET;
      const sig = req.headers['x-pay-signature'] || json.signature;
      if (!verifyProviderCallback(provider, body, sig, secret)) {
        return r404res(res, 400, { error: 'bad-signature' });
      }
      try {
        const o = markPaid(json.outTradeNo, { transactionId: json.transactionId, machineCode: json.machineCode });
        if (!o) return r404res(res, 404, { error: 'order-not-found' });
        return send(res, { ok: true, outTradeNo: o.outTradeNo, status: o.status, token: o.status === 'fulfilled' ? o.token : null });
      } catch (e) {
        return r404res(res, 500, { error: String(e && e.message || e) });
      }
    }

    // 管理端手动发卡（兜底）：需 adminKey
    if (req.url === '/api/admin/issue' && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      try {
        const token = manualIssue({ plan: json.plan, billing: json.billing, machineCode: json.machineCode, outTradeNo: json.outTradeNo });
        return send(res, { ok: true, token });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 团队版：创建团队（管理员）
    if (req.url === '/api/team/create' && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      try {
        const team = createTeam({ plan: json.plan || 'team', billing: json.billing, seats: json.seats });
        return send(res, { ok: true, team: { teamId: team.teamId, plan: team.plan, seats: team.seats } });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 团队版：成员激活（占一个席位，发绑定机器码的令牌）
    if (req.url === '/api/team/activate' && req.method === 'POST') {
      try {
        const r = activateSeat(json.teamId, json.machineCode);
        return send(res, { ok: true, token: r.token, used: r.used, available: r.available, seats: r.seats });
      } catch (e) {
        const msg = String(e && e.message || e);
        const code = msg === 'seats-exhausted' ? 409 : (msg === 'team-not-found' ? 404 : 400);
        return r404res(res, code, { error: msg });
      }
    }

    // 团队版：查询席位使用情况（管理员）
    if (req.url === '/api/team/status' && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      const info = teamInfo(json.teamId);
      if (!info) return r404res(res, 404, { error: 'team-not-found' });
      return send(res, { ok: true, team: info });
    }

    // 团队版：回收席位（同时吊销成员令牌）
    if (req.url === '/api/team/revoke-seat' && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      try {
        const okk = revokeSeat(json.teamId, json.machineCode);
        return send(res, { ok: okk });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
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
