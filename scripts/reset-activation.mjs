// 重置授权状态并弹回激活页（用于反复测试「获取 + 激活」流程）
//
// 原理：Electron 桌面端在启动时读取 userData 目录下的 license.json，
// 若不存在或校验失败则加载 activation.html（激活页）。本脚本等价于
// 解绑流程里的「clearLicense + reload」：清掉本地 license.json，
// 杀掉正在运行的客户端，再重新拉起，使其回到激活页。
//
// 用法：
//   node scripts/reset-activation.mjs                 # 清 license + 杀进程 + 自动重拉起
//   node scripts/reset-activation.mjs --no-relaunch   # 只清 license，不重启
//   node scripts/reset-activation.mjs --exe "D:/x/黑猫智记AI.exe"   # 指定要拉起的 exe
//   node scripts/reset-activation.mjs --with-server   # 顺便把激活服务器(8787)也拉起来
//   node scripts/reset-activation.mjs --dir "D:/mydata"  # 指定 userData 目录（覆盖自动探测）
//   node scripts/reset-activation.mjs --dry-run       # 只打印将要做什么，不执行
//
// 说明：在 Windows 上会自动 taskkill 掉「黑猫智记AI.exe」与开发态的
//       「electron.exe」；重拉起优先用 --exe 指定的路径，否则自动探测
//       dist/win-unpacked 下的 *.exe。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// ---- 解析命令行参数 ----
const argv = process.argv.slice(2);
const opt = {
  noRelaunch: argv.includes('--no-relaunch'),
  withServer: argv.includes('--with-server'),
  dryRun: argv.includes('--dry-run'),
};
const getVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
opt.exe = getVal('--exe');
opt.dir = getVal('--dir');

// ---- 读取候选「应用名」（决定 userData 目录名）----
// 注意：打包后的 app 由 electron-builder 注入顶层 productName（取自 build.productName），
// 故 userData = %APPDATA%\黑猫智记AI；而开发态 electron . 读取顶层 name，故为
// %APPDATA%\heimao-ai-note-assistant。两种都要覆盖，避免删错目录。
function candidateNames() {
  const names = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.build && pkg.build.productName) names.add(pkg.build.productName);
    if (pkg.productName) names.add(pkg.productName);
    if (pkg.name) names.add(pkg.name);
  } catch {
    names.add('黑猫智记AI');
  }
  names.add('Electron'); // 开发态默认兜底
  return [...names];
}
const NAMES = candidateNames();

// ---- 计算候选 userData 目录 ----
function resolveUserDataDirs() {
  if (opt.dir) return [path.resolve(opt.dir)];
  const dirs = [];
  const appData = process.env.APPDATA
    || (isWin ? path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming') : null);
  const localAppData = process.env.LOCALAPPDATA
    || (isWin ? path.join(process.env.USERPROFILE || '', 'AppData', 'Local') : null);
  for (const base of [appData, localAppData]) {
    if (!base) continue;
    for (const name of NAMES) dirs.push(path.join(base, name));
  }
  return [...new Set(dirs)];
}

function log(msg) {
  console.log('[reset-activation] ' + msg);
}

// ---- 1. 清 license.json ----
function clearLicense() {
  const dirs = resolveUserDataDirs();
  let removed = 0;
  for (const dir of dirs) {
    const file = path.join(dir, 'license.json');
    if (fs.existsSync(file)) {
      if (opt.dryRun) {
        log(`[dry-run] 将删除 ${file}`);
      } else {
        try {
          fs.unlinkSync(file);
          log(`已删除 ${file}`);
          removed++;
        } catch (e) {
          log(`删除失败 ${file}: ${e.message}`);
        }
      }
    }
  }
  if (removed === 0 && !opt.dryRun) log('未发现已存在的 license.json（本就处于未激活状态）。');
  return removed;
}

// ---- 2. 杀掉运行中的客户端 ----
function killClients() {
  const images = isWin ? ['黑猫智记AI.exe', 'electron.exe'] : ['黑猫智记AI', 'electron'];
  for (const img of images) {
    if (opt.dryRun) {
      log(`[dry-run] 将结束进程 ${img}`);
      continue;
    }
    try {
      if (isWin) {
        spawn('taskkill', ['/F', '/IM', img], { stdio: 'ignore', windowsHide: true });
      } else {
        spawn('pkill', ['-f', img], { stdio: 'ignore' });
      }
      log(`已请求结束进程 ${img}`);
    } catch (e) {
      log(`结束进程 ${img} 时出错: ${e.message}`);
    }
  }
}

// ---- 3. 探测/拉起客户端 ----
function detectExe() {
  if (opt.exe) return path.resolve(opt.exe);
  const candidates = [];
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    for (const f of fs.readdirSync(unpacked)) {
      if (f.toLowerCase().endsWith('.exe')) {
        const base = f.replace(/\.exe$/i, '');
        if (NAMES.includes(base)) candidates.unshift(path.join(unpacked, f));
        else candidates.push(path.join(unpacked, f));
      }
    }
  }
  return candidates[0] || null;
}

function launchServer() {
  if (opt.dryRun) {
    log('[dry-run] 将后台启动激活服务器 license-server/index.mjs (8787)');
    return;
  }
  const srv = path.join(ROOT, 'license-server', 'index.mjs');
  if (!fs.existsSync(srv)) {
    log(`未找到激活服务器入口 ${srv}，跳过。`);
    return;
  }
  try {
    const p = spawn(process.execPath, [srv], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
    });
    p.unref();
    log('已后台启动激活服务器 (http://127.0.0.1:8787)');
  } catch (e) {
    log(`启动激活服务器失败: ${e.message}`);
  }
}

function relaunchClient() {
  if (opt.noRelaunch) {
    log('已跳过重新拉起（--no-relaunch）。请手动打开客户端，将自动显示激活页。');
    return;
  }
  if (opt.withServer) launchServer();

  const exe = detectExe();
  if (!exe) {
    log('未自动探测到客户端 exe，且未用 --exe 指定。请手动打开客户端。');
    log('（开发态可运行：npm run electron）');
    return;
  }
  if (opt.dryRun) {
    log(`[dry-run] 将拉起 ${exe}`);
    return;
  }
  try {
    const p = spawn(exe, [], {
      cwd: path.dirname(exe),
      stdio: 'ignore',
      detached: true,
      shell: isWin,
    });
    p.unref();
    log(`已拉起客户端：${exe}`);
    log('客户端启动后将因 license.json 不存在而直接显示激活页，可立即测试「获取并激活」。');
  } catch (e) {
    log(`拉起客户端失败: ${e.message}`);
  }
}

// ---- 执行 ----
log(`候选应用名 = ${NAMES.join(', ')}`);
log(`userData 探测目录：`);
for (const d of resolveUserDataDirs()) log(`  - ${d}`);
clearLicense();
killClients();
relaunchClient();
