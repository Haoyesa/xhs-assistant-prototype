// 授权/激活相关配置（客户端与主进程共用）
// 生产环境部署激活服务器后，把 LICENSE_SERVER_URL 指向你的域名（或用环境变量覆盖）。
export const LICENSE_SERVER_URL =
  process.env.LICENSE_SERVER_URL || 'http://127.0.0.1:8787';

// 心跳复核周期（天）。每 N 天回服务器确认订阅未被吊销/退款。
export const HEARTBEAT_INTERVAL_DAYS = Number(
  process.env.HEARTBEAT_INTERVAL_DAYS || 7
);

// 管理员吊销接口密钥（仅服务器端使用；客户端无需此值）。
export const LICENSE_ADMIN_KEY = process.env.LICENSE_ADMIN_KEY || 'changeme-admin-key';
