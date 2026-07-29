// options.js — 扩展身份设置页（比特多账号并行）
// 让用户为每个扩展窗口绑定一个后台「账号」(accountId) + 比特配置名(bitProfile)，
// 保存时把身份写回 chrome.storage.local，并把 bitProfile PATCH 到服务端账号、立即注册在线实例。
(function () {
  const $ = (id) => document.getElementById(id);

  function api(path, opts = {}) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get({ serverUrl: 'http://127.0.0.1:5199' }, (s) => {
        const url = (s.serverUrl || '').replace(/\/+$/, '') + path;
        const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
        if (opts.body) init.body = JSON.stringify(opts.body);
        fetch(url, init)
          .then((r) => r.json().then((j) => resolve({ ok: r.ok, data: j })))
          .catch(reject);
      });
    });
  }

  function ensureInstanceId() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ instanceId: '' }, (s) => {
        if (s.instanceId) return resolve(s.instanceId);
        const id = 'ext_' + (crypto && crypto.randomUUID
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10));
        chrome.storage.local.set({ instanceId: id }, () => resolve(id));
      });
    });
  }

  async function refreshAccounts(serverUrl, selected) {
    const sel = $('accountId');
    sel.innerHTML = '<option value="">（未绑定 · 旧单账号模式）</option>';
    try {
      const r = await api('/api/accounts');
      if (r.ok && r.data && Array.isArray(r.data.accounts)) {
        for (const a of r.data.accounts) {
          const opt = document.createElement('option');
          opt.value = a.id;
          const parts = [a.name];
          if (a.online) parts.push('●在线');
          if (a.bitProfile) parts.push('[已配ID]');
          opt.textContent = parts.join(' ');
          sel.appendChild(opt);
        }
      } else {
        sel.innerHTML = '<option value="">账号加载失败</option>';
      }
    } catch (e) {
      sel.innerHTML = '<option value="">账号加载失败：' + (e && e.message ? e.message : '连接失败') + '</option>';
    }
    sel.value = selected || '';
  }

  async function load() {
    const s = await new Promise((res) => chrome.storage.local.get(
      { serverUrl: 'http://127.0.0.1:5199', extAccount: '', extProfile: '', instanceId: '' }, res));
    $('serverUrl').value = s.serverUrl || '';
    $('bitProfile').value = s.extProfile || '';
    await refreshAccounts(s.serverUrl, s.extAccount);
  }

  async function save() {
    const serverUrl = $('serverUrl').value.trim();
    const accountId = $('accountId').value;
    const bitProfile = $('bitProfile').value.trim();
    if (!accountId) {
      $('status').textContent = '⚠️ 请先选择一个后台账号，否则扩展只处于「旧单账号兼容模式」，不会被多账号路由。';
      return;
    }
    await new Promise((res) => chrome.storage.local.set(
      { serverUrl, extAccount: accountId, extProfile: bitProfile }, res));
    $('status').textContent = '已保存本地设置。';
    // 绑定了账号则把比特配置名写回服务端账号，并立即注册在线实例
    if (accountId) {
      try { await api('/api/accounts/' + encodeURIComponent(accountId) + '/patch', { method: 'POST', body: { bitProfile } }); }
      catch (e) { /* 忽略 */ }
    }
    try {
      const r = await api('/api/ext/register', {
        method: 'POST',
        body: {
          instanceId: await ensureInstanceId(),
          accountId,
          profileName: bitProfile,
          extVersion: (chrome.runtime.getManifest() || {}).version || '',
          serverUrl,
        },
      });
      const pending = r.data && r.data.pending != null ? r.data.pending : null;
      $('status').textContent = '已保存并注册实例'
        + (pending != null ? '（该账号待发 ' + pending + ' 篇）' : '');
      // 刷新下拉，显示在线状态变化
      await refreshAccounts(serverUrl, accountId);
      if (!bitProfile && accountId) {
        $('status').textContent += '；注意：未填比特窗口 ID，后台无法通过按钮打开本窗口。';
      }
    } catch (e) {
      $('status').textContent = '已保存，但注册实例失败：' + (e && e.message ? e.message : e);
    }
  }

  // 测试 chrome.debugger 是否可用（比特浏览器是否允许 debugger attach）
  async function testDebugger() {
    const st = $('status');
    st.textContent = '正在测试 debugger…';
    let tabId = null;
    try {
      // 在该比特窗口里找「普通网页」标签（http/https），而不是盯死当前活动标签——
      // 因为选项页本身就是 chrome-extension:// 内置页，不能作为 attach 目标。
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ currentWindow: true }, (t) => resolve(t || []));
      });
      const normal = tabs.find((t) => t.id != null && t.url && /^https?:\/\//i.test(t.url));
      if (!normal) {
        throw new Error('未找到普通网页标签。请在该窗口另开一个普通网页（如 https://creator.xiaohongshu.com）并保持打开，再点测试');
      }
      tabId = normal.id;
      // 1) attach
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || 'attach 失败'));
          resolve();
        });
      });
      // 2) 发一条真实 CDP 命令验证可读可写（证明后续能驱动发布按钮）
      const r = await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1+1' }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || 'sendCommand 失败'));
          resolve(res);
        });
      });
      if (!r || !r.result || r.result.value !== 2) {
        throw new Error('debugger 已连接，但 CDP 命令未返回预期结果');
      }
      // 3) 稳妥 detach（不管怎样都要把调试器摘掉，否则标签会被锁住）
      await new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => resolve());
      });
      tabId = null;
      st.textContent = '✅ debugger 权限正常（可注入并驱动页面），可以自动点发布按钮。目标页：' + (normal.title || normal.url || '');
    } catch (e) {
      const msg = e && e.message ? e.message : e;
      st.textContent = '❌ debugger 测试失败：' + msg;
      // 比特若禁用 debugger：报错通常含 Cannot access / not allowed / disabled
      if (/cannot access|not allowed|disabled|permission/i.test(msg)) {
        st.textContent += '（比特浏览器可能未放开 debugger，需改用 CDP 远程驱动方案）';
      }
      // 兜底：无论如何尝试摘掉调试器，避免标签被锁
      if (tabId != null) {
        try { await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    $('saveBtn').addEventListener('click', save);
    $('dbgTestBtn').addEventListener('click', testDebugger);
    load();
  });
})();
