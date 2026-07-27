// license-server/payments-alipay.mjs — 支付宝（当面付 / 扫码 precreate）集成
//
// 实现要点（支付宝开放平台规范）：
//  1) 请求签名 RSA2(SHA256withRSA)：取除 sign/sign_type 外、非空字段按 ASCII 升序拼成 k=v&k=v，
//     用【应用私钥】签名，sign 以 base64 回传
//  2) 异步通知验签：同样的拼串规则，用【支付宝公钥】验 sign
//  3) 当面付下单 alipay.trade.precreate 返回 qr_code（扫码内容）
//  4) 主动查询 alipay.trade.query 返回 trade_status（TRADE_SUCCESS 表示已支付）
//
// 合规说明：当面付为「单次支付」，适合按周期售卖授权；自动续费(代扣)需商户签约资质，本模块不实现。
import crypto from 'node:crypto';
import { alipayConfig, isAlipayConfigured } from './pay-config.mjs';

function beijingTime() {
  // 支付宝要求 yyyy-MM-dd HH:mm:ss，按 Asia/Shanghai 生成
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(/\//g, '-');
}

function filterSign(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] != null && k !== 'sign' && k !== 'sign_type')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function signAlipay(params, cfg) {
  const str = filterSign(params);
  return crypto.createSign('RSA-SHA256').update(str, 'utf8').sign(cfg.privateKey).toString('base64');
}

export function verifyAlipay(params, cfg) {
  if (!cfg.publicKey || !params.sign) return false;
  const str = filterSign(params);
  try {
    return crypto.createVerify('RSA-SHA256').update(str, 'utf8').verify(cfg.publicKey, Buffer.from(params.sign, 'base64'));
  } catch {
    return false;
  }
}

// 仅构造下单参数（不发送），便于离线测试签名正确性
export function buildAlipayPrecreateParams({ outTradeNo, totalAmount, subject, notifyUrl }, cfg = alipayConfig()) {
  const base = {
    app_id: cfg.appId,
    method: 'alipay.trade.precreate',
    charset: 'UTF-8',
    sign_type: 'RSA2',
    timestamp: beijingTime(),
    version: '1.0',
    notify_url: notifyUrl,
    biz_content: JSON.stringify({ out_trade_no: outTradeNo, total_amount: Number(totalAmount).toFixed(2), subject }),
  };
  base.sign = signAlipay(base, cfg);
  return base;
}

export async function createPrecreate({ outTradeNo, totalAmount, subject, notifyUrl }) {
  if (!isAlipayConfigured()) throw new Error('alipay-not-configured');
  const cfg = alipayConfig();
  const params = buildAlipayPrecreateParams({ outTradeNo, totalAmount, subject, notifyUrl }, cfg);
  const form = new URLSearchParams(params).toString();
  const r = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const text = await r.text();
  const j = JSON.parse(text);
  const resp = j['alipay_trade_precreate_response'];
  if (!resp || resp.code !== '10000') throw new Error(`alipay-precreate-failed:${resp && resp.sub_msg ? resp.sub_msg : text}`);
  return { payUrl: resp.qr_code, raw: j };
}

export async function queryOrder(outTradeNo) {
  if (!isAlipayConfigured()) throw new Error('alipay-not-configured');
  const cfg = alipayConfig();
  const base = {
    app_id: cfg.appId,
    method: 'alipay.trade.query',
    charset: 'UTF-8',
    sign_type: 'RSA2',
    timestamp: beijingTime(),
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: outTradeNo }),
  };
  base.sign = signAlipay(base, cfg);
  const form = new URLSearchParams(base).toString();
  const r = await fetch(cfg.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const text = await r.text();
  const j = JSON.parse(text);
  const resp = j['alipay_trade_query_response'];
  if (!resp) throw new Error(`alipay-query-failed:${text}`);
  return { tradeState: resp.trade_status || 'UNKNOWN', transactionId: resp.trade_no || null };
}
