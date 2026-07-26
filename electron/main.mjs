// electron/main.mjs
// 桌面外壳：在本进程内启动本地服务，并开一个窗口加载它。
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5199);
const isDev = !app.isPackaged;

// 打包后 asar 内不可写，把数据目录迁到系统用户目录
process.env.XHS_DATA_DIR = app.getPath('userData');

// 动态导入 server.js，确保 DATA_DIR 已设置
const { startServer } = await import('../server.js');

// 在 Electron 主进程内直接拉起本地服务（无需额外 node 进程）
startServer(PORT);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const url = `http://localhost:${PORT}`;
  win.loadURL(url);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
