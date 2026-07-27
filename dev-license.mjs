// 一键本地授权联调：同时拉起「激活服务器」+「桌面端(Electron)」。
// 用法：npm run dev:license   （等同于先后手动跑 node license-server/index.mjs + npm run electron）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const nodeBin = process.execPath;
// electron 的 CLI 入口（devDependency，跨平台可靠路径）
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');

// 子进程清单，便于统一清理
const children = [];

function launch(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  p.on('exit', (code, signal) => {
    console.log(`[dev:license] ${name} 退出 (code=${code ?? 'signal:' + signal})`);
  });
  p.on('error', (err) => {
    console.error(`[dev:license] ${name} 启动失败:`, err.message);
  });
  children.push({ name, p });
  return p;
}

console.log('[dev:license] 启动激活服务器 (license-server/index.mjs) ...');
launch('license-server', nodeBin, [path.join(root, 'license-server', 'index.mjs')]);

console.log('[dev:license] 启动桌面端 (electron .) ...');
launch('electron', nodeBin, [electronCli, '.']);

// Ctrl+C / 进程终止时，连带清理两个子进程，避免端口/进程残留
function shutdown(signal) {
  console.log(`\n[dev:license] 收到 ${signal}，正在关闭子进程 ...`);
  for (const { name, p } of children) {
    try {
      if (!p.killed) p.kill(signal === 'SIGINT' ? 'SIGTERM' : signal);
    } catch (_) {}
  }
  // 给一点时间让子进程退出
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
