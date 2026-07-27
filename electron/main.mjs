// electron/main.mjs
// 桌面外壳：在本进程内启动本地服务，先做授权校验，再开窗口加载主界面或激活页。
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLicense, saveLicense, clearLicense, currentPlan, readRawToken } from './license.mjs';
import { getMachineCode } from './machine-id.mjs';
import { startHeartbeat } from './heartbeat.mjs';
import { LICENSE_SERVER_URL } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5199);
const isDev = !app.isPackaged;

const userDataDir = app.getPath('userData');
// 打包后 asar 内不可写，把数据目录迁到系统用户目录
process.env.XHS_DATA_DIR = userDataDir;

const MAIN_URL = `http://127.0.0.1:${PORT}`;
const ACTIVATION_FILE = path.join(__dirname, 'activation.html');
const PRELOAD = path.join(__dirname, 'preload.cjs');

let mainWin = null;

// 窗口图标
function resolveAppIcon() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.ico'));
  }
  candidates.push(path.join(__dirname, '..', 'assets', 'icon.ico'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
const APP_ICON = resolveAppIcon();

// ---- 授权相关 IPC ----
ipcMain.handle('lic:getMachineCode', () => getMachineCode());
ipcMain.handle('lic:getPlan', () => currentPlan(userDataDir));
ipcMain.handle('lic:getServerUrl', () => LICENSE_SERVER_URL);
ipcMain.handle('lic:activate', (_e, token) => {
  const r = saveLicense(userDataDir, token);
  if (r.ok) switchToMain();
  return r;
});
// 读取本地原始 token（不校验，供漂移时解绑旧设备）
ipcMain.handle('lic:getRawToken', () => readRawToken(userDataDir));
// 清除本地授权（解绑后由激活窗口触发）
ipcMain.handle('lic:clearLicense', () => {
  clearLicense(userDataDir);
  return { ok: true };
});

function switchToMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  startHeartbeat({ userDataDir, win: mainWin });
  mainWin.loadURL(MAIN_URL);
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  });

  const licensed = loadLicense(userDataDir);
  if (licensed) {
    startHeartbeat({ userDataDir, win: mainWin });
    mainWin.loadURL(MAIN_URL);
  } else {
    mainWin.loadFile(ACTIVATION_FILE);
  }

  if (isDev) mainWin.webContents.openDevTools({ mode: 'detach' });
}

// 动态导入 server.js，确保 DATA_DIR 已设置
const { startServer } = await import('../server.js');

const srv = startServer(PORT);
srv.on('error', (err) => {
  const msg =
    err && err.code === 'EADDRINUSE'
      ? `端口 ${PORT} 已被占用。\n通常是另一个「黑猫智记AI」实例、旧版本 exe，或命令行 node server.js 正在运行。\n请先在任务管理器结束这些进程，再重新打开本软件。`
      : String((err && err.message) || err);
  try {
    dialog.showErrorBox('后端启动失败', msg);
  } catch {}
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
