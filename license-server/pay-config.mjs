// license-server/pay-config.mjs — 支付渠道凭证配置（仅从环境变量 / 文件读取，绝不入库）
//
// 凭证来源优先级：
//   1) 内联 PEM（值含 "-----BEGIN"）→ 直接使用
//   2) file:// 前缀 → 读该文件
//   3) 作为文件路径存在 → 读取
//   4) 否则视为 base64 / 原文（base64 解码，解码失败则原文）
//
// 微信支付 v3 必填：WX_MCH_ID / WX_APP_ID / WX_API_V3_KEY(32字节) /
//   WX_SERIAL_NO(商户证书序列号) / WX_PRIVATE_KEY(商户 API 私钥 PEM) /
//   WX_PLATFORM_PUBLIC_KEY(微信平台公钥 PEM，用于验签回调)
// 支付宝必填：ALI_APP_ID / ALI_PRIVATE_KEY(应用私钥 PEM) /
//   ALI_PUBLIC_KEY(支付宝公钥 PEM，用于验签异步通知)
// 通知地址：LICENSE_PUBLIC_URL=https://你的域名 （用于拼 notify_url，缺省则回调收不到，靠主动轮询兜底）
import fs from 'node:fs';

function resolveKey(name, fileEnv) {
  const v = process.env[name];
  if (v) {
    if (v.includes('-----BEGIN')) return v;
    if (/^file:\/\//.test(v)) return fs.readFileSync(v.slice('file://'.length), 'utf8');
    try {
      if (fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
    } catch {
      /* fallthrough */
    }
    // 尝试 base64 解码（PEM 很适合 base64 存储到 env，避免换行问题）
    try {
      const dec = Buffer.from(v, 'base64').toString('utf8');
      if (dec.includes('-----BEGIN')) return dec;
    } catch {
      /* not base64 */
    }
    return v;
  }
  const p = fileEnv ? process.env[fileEnv] : null;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

export function wechatConfig() {
  return {
    mchId: process.env.WX_MCH_ID || null,
    appId: process.env.WX_APP_ID || null,
    apiV3Key: process.env.WX_API_V3_KEY || null,
    serialNo: process.env.WX_SERIAL_NO || null,
    privateKey: resolveKey('WX_PRIVATE_KEY', 'WX_PRIVATE_KEY_PATH'),
    platformPublicKey: resolveKey('WX_PLATFORM_PUBLIC_KEY', 'WX_PLATFORM_PUBLIC_KEY_PATH'),
  };
}

export function alipayConfig() {
  return {
    appId: process.env.ALI_APP_ID || null,
    privateKey: resolveKey('ALI_PRIVATE_KEY', 'ALI_PRIVATE_KEY_PATH'),
    publicKey: resolveKey('ALI_PUBLIC_KEY', 'ALI_PUBLIC_KEY_PATH'),
    gateway: process.env.ALI_GATEWAY || 'https://openapi.alipay.com/gateway.do',
  };
}

export function isWechatConfigured() {
  const c = wechatConfig();
  return !!(c.mchId && c.appId && c.apiV3Key && c.serialNo && c.privateKey && c.platformPublicKey);
}

export function isAlipayConfigured() {
  const c = alipayConfig();
  return !!(c.appId && c.privateKey && c.publicKey);
}

// 拼通知地址：优先请求体传入，否则用 LICENSE_PUBLIC_URL 拼出标准 webhook 路径
export function notifyUrlFor(method, override) {
  if (override) return override;
  const base = process.env.LICENSE_PUBLIC_URL;
  if (!base) return '';
  return `${base.replace(/\/$/, '')}/api/webhook/${method}`;
}
