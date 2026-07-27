import { contextBridge, ipcRenderer } from 'electron';
import { LICENSE_SERVER_URL } from './config.mjs';

// 仅暴露最小、受控的 API 给渲染进程（上下文隔离开启，无法直接触达 Node）。
contextBridge.exposeInMainWorld('api', {
  getMachineCode: () => ipcRenderer.invoke('lic:getMachineCode'),
  activate: (token) => ipcRenderer.invoke('lic:activate', token),
  getPlan: () => ipcRenderer.invoke('lic:getPlan'),
  getServerUrl: () => LICENSE_SERVER_URL,
  onRevoked: (cb) => ipcRenderer.on('lic:revoked', () => cb()),
});
