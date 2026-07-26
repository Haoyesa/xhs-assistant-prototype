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

  // 让固定浮窗可拖动（header/handle 触发），限制在视口内，并持久化位置。
  function xhsMakeDraggable(el, handle = el) {
    if (!el || el.dataset.xhsDragBound) return;
    el.dataset.xhsDragBound = '1';
    let dragging = false, startX, startY, startL, startT, rafId;

    const setPos = (left, top) => {
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('left', left + 'px', 'important');
      el.style.setProperty('top', top + 'px', 'important');
    };
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    const onDown = (e) => {
      if (e.button !== 0) return;
      // 避免点击面板内部按钮/输入框/链接时触发拖动
      const interactive = e.target.closest('button, input, textarea, select, a, label, [role="button"]');
      if (interactive && interactive !== handle && interactive !== el) return;
      const rect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startL = rect.left;
      startT = rect.top;
      dragging = true;
      setPos(startL, startT);
      handle.setPointerCapture(e.pointerId);
      handle.style.setProperty('cursor', 'grabbing', 'important');
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setPos(clamp(startL + dx, 0, vw - rect.width), clamp(startT + dy, 0, vh - rect.height));
      });
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      handle.style.removeProperty('cursor');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      const rect = el.getBoundingClientRect();
      try {
        chrome.storage.local.set({ ['xhs_pos_' + el.id]: { left: rect.left, top: rect.top } });
      } catch (_) {}
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);

    // 恢复上次位置
    try {
      chrome.storage.local.get(['xhs_pos_' + el.id], (v) => {
        const p = v['xhs_pos_' + el.id];
        if (!p) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        setPos(clamp(p.left, 0, vw - rect.width), clamp(p.top, 0, vh - rect.height));
      });
    } catch (_) {}
  }

  window.XhsCommon = { getXhsServerUrl, xhsFetch, xhsKeepAlive, xhsMakeDraggable };
})();
