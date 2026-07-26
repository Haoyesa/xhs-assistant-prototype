// common.js — content script 共享工具
// 目的：彻底规避「Extension context invalidated」。
//   MV3 的 service worker 空闲约 30s 会被 Chrome 回收；若 content script 经 service worker 中转请求后端，
//   回收瞬间通道失效就会报该错。改为 content script 直连后端（server 已放开 CORS *）。
//   同时提供保活端口，让 service worker 在页面打开期间不被杀（保证 popup / 背景下发 fillTask 稳定）。
(function () {
  if (window.__xhsCommonLoaded) return;
  window.__xhsCommonLoaded = true;

  async function getXhsServerUrl() {
    return new Promise((resolve) => {
      let url = 'http://127.0.0.1:5199';
      try {
        chrome.storage.local.get({ serverUrl: 'http://127.0.0.1:5199' }, (v) => {
          resolve((v.serverUrl || 'http://127.0.0.1:5199').replace(/\/+$/, ''));
        });
      } catch (e) { resolve(url); }
    });
  }

  // 直连本地后端（绕开 service worker）
  async function xhsFetch(path, opts) {
    opts = opts || {};
    const base = await getXhsServerUrl();
    const url = base + path;
    const init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    const r = await fetch(url, init);
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = { _raw: text }; }
    return { ok: r.ok, status: r.status, data: j };
  }

  // 保活：内容脚本持一个常驻端口，让 service worker 在页面打开期间不被回收。
  // 这是 MV3 官方推荐的保活手段；端口断开（SW 被回收）后自动重连。
  let __kaTimer = null;
  function xhsKeepAlive() {
    try {
      const port = chrome.runtime.connect({ name: 'xhs-keepalive' });
      if (__kaTimer) clearInterval(__kaTimer);
      __kaTimer = setInterval(function () {
        try { port.postMessage({ type: '__ka' }); } catch (e) {}
      }, 15000);
      port.onDisconnect.addListener(function () {
        if (__kaTimer) { clearInterval(__kaTimer); __kaTimer = null; }
        setTimeout(xhsKeepAlive, 1500);
      });
    } catch (e) {}
  }

  window.XhsCommon = { getXhsServerUrl, xhsFetch, xhsKeepAlive };
})();
