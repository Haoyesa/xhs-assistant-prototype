import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMachineCode } from './machine-id.mjs';
import { loadLicense, clearLicense } from './license.mjs';
import { LICENSE_SERVER_URL, HEARTBEAT_INTERVAL_DAYS } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVATION_FILE = path.join(__dirname, 'activation.html');

let timer = null;
let generation = 0; // 心跳代际：stopHeartbeat 后旧 tick 的迟到结果不再处理

// 主进程心跳：定期回激活服务器复核订阅状态。
// revoked/expired/invalid → 清除本地授权并弹回激活页。
// 网络异常 → 宽容跳过，下次再试（不立即锁死）。
export function startHeartbeat({ userDataDir, win }) {
  stopHeartbeat();
  const myGen = ++generation;
  const tick = async () => {
    if (myGen !== generation) return; // 已被新一轮 start/stop 取代
    const lic = loadLicense(userDataDir);
    if (!lic) return;
    let r;
    try {
      r = await fetch(`${LICENSE_SERVER_URL}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineCode: getMachineCode(), token: lic.token }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      if (myGen !== generation) return; // 等待期间心跳已被重启 → 丢弃迟到结果
      if (data.status === 'revoked' || data.status === 'expired' || data.status === 'invalid') {
        clearLicense(userDataDir);
        if (win && !win.isDestroyed()) {
          win.loadFile(ACTIVATION_FILE);
          win.webContents.send('lic:revoked');
        }
      }
    } catch (e) {
      // 网络错误/超时：跳过本次，宽容处理
      console.warn('[heartbeat] 复核失败（跳过本次）:', e && e.name === 'TimeoutError' ? '请求超时' : (e && e.message) || e);
    }
  };
  tick(); // 启动即复核一次
  timer = setInterval(tick, HEARTBEAT_INTERVAL_DAYS * 86400000);
}

export function stopHeartbeat() {
  generation++; // 使在途 tick 的结果作废
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
