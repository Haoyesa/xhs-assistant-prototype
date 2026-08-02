// 授权/激活相关配置（客户端与主进程共用）
// 生产环境部署激活服务器后，把 LICENSE_SERVER_URL 指向你的域名（或用环境变量覆盖）。
export const LICENSE_SERVER_URL =
  process.env.LICENSE_SERVER_URL || 'http://127.0.0.1:8787';

// 心跳复核周期（天）。每 N 天回服务器确认订阅未被吊销/退款。
// 非法/非正数环境变量一律回退 7 天，避免 NaN 导致 setInterval 按 0ms 疯狂触发。
const _hb = Number(process.env.HEARTBEAT_INTERVAL_DAYS || 7);
export const HEARTBEAT_INTERVAL_DAYS = Number.isFinite(_hb) && _hb > 0 ? _hb : 7;
