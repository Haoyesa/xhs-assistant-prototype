import http from 'node:http';
import { signToken, verifyToken, issue, revoke, isRevoked, revokeToken, isTokenRevoked } from './lib.mjs';
import { PLANS, resolvePlan } from '../electron/plans.mjs';
import {
  PRICE_TABLE,
  planPrice,
  createOrder,
  getOrder,
  markPaid,
  fulfillOrder,
  manualIssue,
  verifyProviderCallback,
  prepareCheckout,
  queryProviderStatus,
} from './payments.mjs';
import { verifyWechatWebhook, decryptWechatResource } from './payments-wechat.mjs';
import { verifyAlipay } from './payments-alipay.mjs';
import { wechatConfig, alipayConfig } from './pay-config.mjs';
import { createTeam, teamInfo, activateSeat, revokeSeat } from './teams.mjs';

const PORT = Number(process.env.LICENSE_PORT || 8787);
const HOST = process.env.LICENSE_HOST || '127.0.0.1'; // 默认仅回环；生产公网部署时显式设 LICENSE_HOST=0.0.0.0
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY || 'changeme-admin-key';
if (!process.env.LICENSE_ADMIN_KEY) {
  console.warn('[license-server] ⚠️ LICENSE_ADMIN_KEY 未设置，正在使用默认值（仅限开发/内网，切勿在生产公网暴露此服务）');
}

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
  req.on('end', async () => {
    let json = {};
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'bad-json' }));
      }
    }
    // 非 JSON（如支付宝 webhook 的 form-urlencoded）保留原始 body，由各路由自行解析

    // 在线激活：客户端提交机器码 + 套餐 + 计费周期 → 服务器签发凭证
    // 安全边界：无 adminKey 时仅允许签发 free（免费试用）；付费套餐必须走支付（/api/checkout → 回调/查询自动发卡）。
    // 携带正确 adminKey（开发/内部测试）可签发任意套餐。
    if (req.url === '/api/activate' && req.method === 'POST') {
      const { machineCode, plan, billing } = json;
      if (!machineCode || !plan) return r404res(res, 400, { error: 'missing-fields' });
      if (!PLANS[plan]) return r404res(res, 400, { error: 'bad-plan' });
      if (plan !== 'free' && json.adminKey !== ADMIN_KEY) {
        return r404res(res, 402, { error: 'paid-plan-requires-payment', hint: '付费套餐请通过 /api/checkout 下单并完成支付后自动发卡' });
      }
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
    // method=wechat|alipay 且已配置真实凭证 → 向渠道下单并返回 payUrl(扫码内容)；
    // 未配置/失败 → 回落 manual（人工发卡），payUrl=null。
    if (req.url === '/api/checkout' && req.method === 'POST') {
      const { plan, billing, machineCode, method, notifyUrl } = json;
      if (!plan) return r404res(res, 400, { error: 'missing-plan' });
      try {
        const order = await prepareCheckout({ plan, billing, machineCode, method: method || 'manual', notifyUrl });
        const viaProvider = !!(order.payUrl && (order.method === 'wechat' || order.method === 'alipay'));
        return send(res, {
          ok: true,
          outTradeNo: order.outTradeNo,
          amount: order.amount,
          currency: order.currency,
          status: order.status,
          method: order.method,
          payUrl: order.payUrl || null,
          note: viaProvider
            ? '请使用微信/支付宝扫码完成付款，成功后系统会自动发卡（也可在客户端刷新订单状态）。'
            : '人工发卡模式：完成付款后联系客服并提供机器码，或由管理员在后台手动发卡。',
          providerError: order.meta && order.meta.providerError ? order.meta.providerError : undefined,
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

    // 补机器码完成发卡（paid -> fulfilled）。人工发卡是管理员操作，必须携带 adminKey，防止未支付订单白嫖 token。
    if (req.url.startsWith('/api/order/') && req.url.endsWith('/fulfill') && req.method === 'POST') {
      if (json.adminKey !== ADMIN_KEY) return r404res(res, 401, { error: 'unauthorized' });
      const id = req.url.slice('/api/order/'.length).replace(/\/fulfill$/, '').split('?')[0];
      try {
        const o = fulfillOrder(id, json.machineCode);
        if (!o) return r404res(res, 404, { error: 'order-not-found' });
        return send(res, { ok: true, outTradeNo: o.outTradeNo, status: o.status, token: o.status === 'fulfilled' ? o.token : null });
      } catch (e) {
        return r404res(res, 400, { error: String(e && e.message || e) });
      }
    }

    // 支付渠道回调：微信 / 支付宝 真实验签 + 解密 + 发卡；未知 provider 走 HMAC 骨架兜底
    if (req.url.startsWith('/api/webhook/') && req.method === 'POST') {
      const provider = req.url.slice('/api/webhook/'.length).split('?')[0];

      // ---- 微信支付 v3 ----
      if (provider === 'wechat') {
        const cfg = wechatConfig();
        const ts = req.headers['wechatpay-timestamp'];
        const nonce = req.headers['wechatpay-nonce'];
        const sig = req.headers['wechatpay-signature'];
        if (!verifyWechatWebhook({ timestamp: ts, nonce, body, signature: sig }, cfg)) {
          return r404res(res, 400, { error: 'bad-signature' });
        }
        let evt;
        try {
          evt = JSON.parse(body);
          const dec = decryptWechatResource(evt.resource, cfg.apiV3Key);
          if (dec.trade_state !== 'SUCCESS') return send(res, { ok: true, ignored: true });
          const o = markPaid(dec.out_trade_no, { transactionId: dec.transaction_id });
          if (!o) return r404res(res, 404, { error: 'order-not-found' });
          return send(res, { ok: true, outTradeNo: o.outTradeNo, status: o.status, token: o.status === 'fulfilled' ? o.token : null });
        } catch (e) {
          return r404res(res, 400, { error: 'bad-payload', detail: String((e && e.message) || e) });
        }
      }

      // ---- 支付宝异步通知（form-urlencoded）----
      if (provider === 'alipay') {
        const params = Object.fromEntries(new URLSearchParams(body));
        const cfg = alipayConfig();
        if (!verifyAlipay(params, cfg)) return r404res(res, 400, { error: 'bad-signature' });
        if (params.trade_status !== 'TRADE_SUCCESS') return send(res, { ok: true, ignored: true });
        const o = markPaid(params.out_trade_no, { transactionId: params.trade_no });
        if (!o) return r404res(res, 404, { error: 'order-not-found' });
        return send(res, { ok: true, outTradeNo: o.outTradeNo, status: o.status, token: o.status === 'fulfilled' ? o.token : null });
      }

      // ---- 未知 provider：HMAC 骨架兜底 ----
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

    // 主动查询渠道侧订单状态（webhook 不可达 / 调试时兜底）
    if (req.url.startsWith('/api/order/') && req.url.endsWith('/query') && req.method === 'POST') {
      const id = req.url.slice('/api/order/'.length).replace(/\/query$/, '').split('?')[0];
      try {
        const o = await queryProviderStatus(id);
        if (!o) return r404res(res, 404, { error: 'order-not-found' });
        const token = o.status === 'fulfilled' ? o.token : null;
        const { token: _t, ...rest } = o;
        return send(res, { ok: true, order: { ...rest, token } });
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

server.listen(PORT, HOST, () => {
  console.log(`[license-server] listening on http://${HOST}:${PORT}`);
});
