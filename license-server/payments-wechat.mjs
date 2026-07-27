// license-server/payments-wechat.mjs — 微信支付 v3（Native 扫码支付）集成
//
// 实现要点（均为微信支付 v3 官方规范）：
//  1) 商户→微信 请求签名：Authorization: WECHATPAY2-SHA256-RSA2048 mchid,nonce_str,signature,timestamp,serial_no
//     签名串 = METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n（BODY 后保留一个换行）
//  2) 微信→商户 回调验签：用【微信平台公钥】验 WECHATPAY-Signature
//     签名串 = TIMESTAMP\nNONCE\nBODY\n（BODY 为原始 JSON 文本）
//  3) 回调体解密：resource 用 APIv3Key 做 AES-256-GCM 解密得到 transaction_id/out_trade_no/trade_state
//  4) 订单查询：GET /v3/pay/transactions/out-trade-no/{no}?mchid=...（需签名）
//
// 合规说明：Native 扫码为「单次支付」，适合按周期(月/年)售卖授权；真正的自动续费(签约/代扣)
// 需商户具备相应资质，本模块不实现代扣，续费由到期前重新下单完成。
import crypto from 'node:crypto';
import { wechatConfig, isWechatConfigured } from './pay-config.mjs';

const WX_BASE = 'https://api.mch.weixin.qq.com';

function nonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

// 构造商户侧请求签名头（method 大写，urlPath 含 query）
export function signWechatRequest(method, urlPath, body, cfg) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = nonceStr();
  const msg = `${method.toUpperCase()}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(msg).sign(cfg.privateKey).toString('base64');
  const auth =
    `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",` +
    `nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${cfg.serialNo}"`;
  return { auth, ts, nonce };
}

// 仅构造下单请求（不发送），便于离线测试签名正确性
export function buildWechatNativeRequest({ outTradeNo, description, amount, notifyUrl }, cfg = wechatConfig()) {
  const urlPath = '/v3/pay/transactions/native';
  const bodyObj = {
    appid: cfg.appId,
    mchid: cfg.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: Math.round(amount * 100), currency: 'CNY' },
  };
  const body = JSON.stringify(bodyObj);
  const { auth } = signWechatRequest('POST', urlPath, body, cfg);
  return { url: WX_BASE + urlPath, headers: { 'Content-Type': 'application/json', Authorization: auth }, body };
}

export async function createNativeOrder({ outTradeNo, description, amount, notifyUrl }) {
  if (!isWechatConfigured()) throw new Error('wechat-not-configured');
  const req = buildWechatNativeRequest({ outTradeNo, description, amount, notifyUrl });
  const r = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const text = await r.text();
  if (!r.ok) throw new Error(`wechat-create-failed:${r.status} ${text}`);
  const j = JSON.parse(text);
  if (!j.code_url) throw new Error(`wechat-no-code-url: ${text}`);
  return { payUrl: j.code_url, raw: j };
}

// 校验微信回调签名（使用微信平台公钥，防止伪造回调）
export function verifyWechatWebhook({ timestamp, nonce, body, signature }, cfg = wechatConfig()) {
  if (!cfg.platformPublicKey || !signature) return false;
  const msg = `${timestamp}\n${nonce}\n${body}\n`;
  try {
    return crypto.createVerify('RSA-SHA256').update(msg).verify(cfg.platformPublicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

// 解密回调 resource（AES-256-GCM，key=APIv3Key 32字节）
export function decryptWechatResource(resource, apiV3Key) {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('apiV3Key must be 32 bytes');
  const data = Buffer.from(resource.ciphertext, 'base64');
  const authTag = data.subarray(data.length - 16);
  const cipherBytes = data.subarray(0, data.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  d.setAuthTag(authTag);
  if (resource.associated_data) d.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const plain = Buffer.concat([d.update(cipherBytes), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// 主动查询订单状态（webhook 不可达时兜底）
export async function queryOrder(outTradeNo) {
  if (!isWechatConfigured()) throw new Error('wechat-not-configured');
  const cfg = wechatConfig();
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(cfg.mchId)}`;
  const { auth } = signWechatRequest('GET', urlPath, '', cfg);
  const r = await fetch(WX_BASE + urlPath, { headers: { Authorization: auth } });
  const text = await r.text();
  if (!r.ok) throw new Error(`wechat-query-failed:${r.status} ${text}`);
  const j = JSON.parse(text);
  return { tradeState: j.trade_state, transactionId: j.transaction_id || null };
}
