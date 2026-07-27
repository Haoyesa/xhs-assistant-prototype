import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMachineCode } from './machine-id.mjs';
import { loadLicense, clearLicense } from './license.mjs';
import { LICENSE_SERVER_URL, HEARTBEAT_INTERVAL_DAYS } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVATION_FILE = path.join(__dirname, 'activation.html');

let timer = null;

// 主进程心跳：定期回激活服务器复核订阅状态。
// revoked/expired/invalid → 清除本地授权并弹回激活页。
// 网络异常 → 宽容跳过，下次再试（不立即锁死）。
export function startHeartbeat({ userDataDir, win }) {
  stopHeartbeat();
  const tick = async () => {
    const lic = loadLicense(userDataDir);
    if (!lic) return;
    try {
      const r = await fetch(`${LICENSE_SERVER_URL}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineCode: getMachineCode(), token: lic.token }),
      });
      const data = await r.json();
      if (data.status === 'revoked' || data.status === 'expired' || data.status === 'invalid') {
        clearLicense(userDataDir);
        if (win && !win.isDestroyed()) {
          win.loadFile(ACTIVATION_FILE);
          win.webContents.send('lic:revoked');
        }
      }
    } catch {
      // 网络错误：跳过本次
    }
  };
  tick(); // 启动即复核一次
  timer = setInterval(tick, HEARTBEAT_INTERVAL_DAYS * 86400000);
}

export function stopHeartbeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
