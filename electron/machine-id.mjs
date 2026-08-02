import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';

// 机器码：从稳定硬件标识组合做 SHA-256 摘要。
// 优先主板/BIOS/磁盘序列号；取不到时退化为 主机名+用户名 的兜底串（仍稳定于同一台机）。
function getRawIds() {
  const ids = [];
  try {
    const ps =
      '(Get-WmiObject Win32_BaseBoard).SerialNumber; ' +
      '(Get-WmiObject Win32_BIOS).SerialNumber; ' +
      '(Get-WmiObject Win32_DiskDrive | Select-Object -First 1).SerialNumber';
    const out = execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, {
      encoding: 'utf8',
      timeout: 8000,
    });
    out.split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      // 过滤占位序列号：DEFAULT / TOBEFILLED / To Be Filled By O.E.M. 等（常见于未烧录序列号的主板）
      if (s && !/^(default|to be filled|tobefilled|o\.?e\.?m\.?|none|unknown|0+)$/i.test(s)) ids.push(s);
    });
  } catch {
    // 忽略，走兜底
  }
  return ids;
}

let cached = null;

export function getMachineCode() {
  if (cached) return cached;
  const ids = getRawIds();
  const seed = ids.length ? ids.join('|') : `fallback:${os.hostname()}:${os.userInfo().username}`;
  const h = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').toUpperCase();
  cached = h.match(/.{1,4}/g).join('-');
  return cached;
}
