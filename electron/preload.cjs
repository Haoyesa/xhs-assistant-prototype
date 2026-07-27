// 预加载脚本（CommonJS）。
// 注意：必须保持为 .cjs —— Electron 对 asar 内 ESM(.mjs) preload 加载不稳，
// 而 require('electron') 的 CJS preload 从 asar 内加载是久经验证的可靠路径。
// 这里不引入任何相对模块（getServerUrl 改走 IPC，复用主进程的 lic:getServerUrl），
// 避免 preload 内的相对 import 在打包后出现路径问题。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getMachineCode: () => ipcRenderer.invoke('lic:getMachineCode'),
  activate: (token) => ipcRenderer.invoke('lic:activate', token),
  getPlan: () => ipcRenderer.invoke('lic:getPlan'),
  getServerUrl: () => ipcRenderer.invoke('lic:getServerUrl'),
  getRawToken: () => ipcRenderer.invoke('lic:getRawToken'),
  clearLicense: () => ipcRenderer.invoke('lic:clearLicense'),
  onRevoked: (cb) => ipcRenderer.on('lic:revoked', () => cb()),
});
