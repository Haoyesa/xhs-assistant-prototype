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
          if (a.bitProfile) parts.push('[' + a.bitProfile + ']');
          opt.textContent = parts.join(' ');
          sel.appendChild(opt);
        }
      }
    } catch (e) { /* 服务端不可用时仍允许保存本地设置 */ }
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
    } catch (e) {
      $('status').textContent = '已保存，但注册实例失败：' + (e && e.message ? e.message : e);
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    $('saveBtn').addEventListener('click', save);
    load();
  });
})();
