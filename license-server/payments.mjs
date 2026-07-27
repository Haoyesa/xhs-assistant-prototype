// license-server/payments.mjs — 支付订单 / 回调 / 发卡（兜底）架构
//
// 设计要点：
// 1) 渠道无关：createOrder 只落「订单意图」，真实支付网关（微信/支付宝/聚合）通过
//    provider 配置接入；未配置真实渠道时统一走 manual（兜底，由人工发卡）。
// 2) 发卡时机：订单 paid 后，若已带 machineCode 立即签发令牌；否则等用户补机器码
//    （/api/order/:id/fulfill）再签发。machineCode 必须在签发前确定，因为令牌绑定机器。
// 3) 手动发卡：管理端 /api/admin/issue 直接为某机器码签发，是上线前最稳的兜底路径。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { issue } from './lib.mjs';
import { resolvePlan } from '../electron/plans.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_FILE = path.join(__dirname, 'orders.json');

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveOrders(list) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(list, null, 2));
}
function genOutTradeNo() {
  return 'XHS' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// 价格表（元）。与 electron/plans.mjs 的 yearlyPrice 保持一致口径。
export const PRICE_TABLE = {
  basic: { monthly: 9, yearly: 90 },
  pro: { monthly: 19, yearly: 190 },
  flag: { monthly: 49, yearly: 490 },
  team: { monthly: 99, yearly: 990 },
};

export function planPrice(plan, billing) {
  const t = PRICE_TABLE[plan];
  if (!t) return null;
  return t[billing || 'monthly'] ?? null;
}

// 创建订单。machineCode 可选；method: manual | wechat | alipay | aggregator。
export function createOrder({ plan, billing = 'monthly', machineCode = null, method = 'manual' }) {
  resolvePlan(plan); // 校验套餐存在，非法套餐抛错
  const amount = planPrice(plan, billing);
  if (amount == null) throw new Error('unknown-plan');
  const order = {
    outTradeNo: genOutTradeNo(),
    plan,
    billing,
    machineCode: machineCode || null,
    method,
    amount,
    currency: 'CNY',
    status: 'pending', // pending | paid | fulfilled | closed
    createdAt: Date.now(),
    paidAt: null,
    fulfilledAt: null,
    token: null,
    meta: {},
  };
  const all = loadOrders();
  all.push(order);
  saveOrders(all);
  return order;
}

export function getOrder(outTradeNo) {
  return loadOrders().find((o) => o.outTradeNo === outTradeNo) || null;
}

// 内部：对订单签发令牌并标记 fulfilled。
function fulfill(order, all) {
  const token = issue(order.plan, order.billing, order.machineCode, crypto.randomBytes(8).toString('hex'));
  order.token = token;
  order.status = 'fulfilled';
  order.fulfilledAt = Date.now();
  saveOrders(all);
  return order;
}

// 支付成功回调：标记 paid；若已有 machineCode 立即发卡，否则等待补机器码。
export function markPaid(outTradeNo, { transactionId = null, machineCode = null } = {}) {
  const all = loadOrders();
  const o = all.find((x) => x.outTradeNo === outTradeNo);
  if (!o) return null;
  o.status = 'paid';
  o.paidAt = Date.now();
  if (transactionId) o.meta.transactionId = transactionId;
  if (machineCode) o.machineCode = machineCode;
  if (o.machineCode) return fulfill(o, all);
  saveOrders(all);
  return o;
}

// 用户补机器码完成发卡（pending/paid → fulfilled）。
// 人工模式下订单初始为 pending（线下付款确认后再补机器码），故允许从 pending 发卡。
export function fulfillOrder(outTradeNo, machineCode) {
  if (!machineCode) throw new Error('machineCode required');
  const all = loadOrders();
  const o = all.find((x) => x.outTradeNo === outTradeNo);
  if (!o) return null;
  if (o.status === 'fulfilled') return o; // 已发卡不再重复
  o.machineCode = machineCode;
  return fulfill(o, all);
}

// 手动发卡（管理端兜底）：直接为某 machineCode 签发，并可关联一笔订单。
export function manualIssue({ plan, billing = 'monthly', machineCode, outTradeNo = null }) {
  if (!machineCode) throw new Error('machineCode required');
  resolvePlan(plan);
  const token = issue(plan, billing, machineCode, crypto.randomBytes(8).toString('hex'));
  const all = loadOrders();
  if (outTradeNo) {
    const o = all.find((x) => x.outTradeNo === outTradeNo);
    if (o) {
      o.status = 'fulfilled';
      o.fulfilledAt = Date.now();
      o.token = token;
      o.machineCode = machineCode;
    }
  }
  all.push({
    outTradeNo: outTradeNo || 'MANUAL' + Date.now().toString(36).toUpperCase(),
    plan,
    billing,
    machineCode,
    method: 'manual-admin',
    amount: planPrice(plan, billing),
    currency: 'CNY',
    status: 'fulfilled',
    createdAt: Date.now(),
    paidAt: Date.now(),
    fulfilledAt: Date.now(),
    token,
    meta: { admin: true },
  });
  saveOrders(all);
  return token;
}

// 支付渠道回调签名校验（占位骨架）。真实渠道各自签名算法不同，
// 接入时在此按 provider 实现对应校验（如微信 RSA、支付宝 RSA2、聚合 MD5/HMAC）。
export function verifyProviderCallback(provider, rawBody, signature, secret) {
  if (!secret) return false; // 未配置密钥则拒绝自动验签
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}
