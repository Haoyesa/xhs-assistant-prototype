// app.js — 前端逻辑
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const callApi = async (method, path, body) => {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 经后端 /api/image 代理加载远程图（绕过防盗链），商品页/笔记缩略图统一走这里
const imgUrl = (u) => (u ? '/api/image?url=' + encodeURIComponent(u) : '');
// 本地图片文件夹的图片：经后端 /api/file 直接暴露（同源），文件夹缩略图用这个
const imgFileUrl = (rel) => (rel ? '/api/file?rel=' + encodeURIComponent(rel) : '');
const thumbStrip = (imgs) => (imgs && imgs.length)
  ? `<div class="thumbs">${imgs.slice(0, 4).map((u) => `<img src="${imgUrl(u)}" onerror="this.style.display='none'"/>`).join('')}${imgs.length > 4 ? `<span class="more">+${imgs.length - 4}</span>` : ''}</div>`
  : '';

let pollTimer = null;
let nextPublishAtAt = 0; // 插件上报的「下一篇最早发布时刻(ms)」，用于批量发布页倒计时
let queueHasPending = false; // 队列是否还有 queued/picked 待发任务（用于决定是否显示倒计时）

// ---- 标签页 ----
const PAGE_TITLES = { products: '素材库', generator: '批量作图', batch: '批量发布', history: '历史', accounts: '账号管理', sensitive: '敏感词检测', settings: '设置' };
$$('.tab-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.tab-btn').forEach((x) => x.classList.remove('active'));
  $$('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $(`.tab[data-tab="${b.dataset.tab}"]`).classList.add('active');
  if ($('#pageTitle')) $('#pageTitle').textContent = PAGE_TITLES[b.dataset.tab] || '';
  if (b.dataset.tab === 'batch') { startPoll(); } else { stopPoll(); }
  if (b.dataset.tab === 'history') loadHistory();
  if (b.dataset.tab === 'products') loadImageFolders();
  if (b.dataset.tab === 'accounts') loadAccounts();
  if (b.dataset.tab === 'sensitive') loadSensitiveMeta();
  loadStats();
}));

// ---- 连接状态 + 概览统计 ----
function setConn(kind, text) {
  const dot = $('#connDot'); const txt = $('#connText');
  if (dot) dot.className = 'conn-dot ' + (kind || '');
  if (txt) txt.textContent = text;
}
async function checkConn() {
  const url = (location.origin || 'http://127.0.0.1:5199') + '/api/settings';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) setConn('ok', '后端已连接');
    else setConn('bad', '后端异常（HTTP ' + r.status + '）');
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? '请求超时(6s)' : (e && e.message ? e.message : String(e));
    setConn('bad', '连接失败：' + reason + ' ｜ ' + url);
    console.error('[checkConn] fetch 失败:', e, 'url=', url, 'origin=', location.origin);
  }
}
async function loadStats() {
  try {
    const [products, queue, history] = await Promise.all([
      callApi('GET', '/api/products'), callApi('GET', '/api/batch/queue'), callApi('GET', '/api/history'),
    ]);
    const tasks = queue.tasks || [];
    const queued = tasks.filter((t) => ['queued', 'picked', 'running', 'submitting', 'waiting_submit', 'manual_hold', 'verify_result'].includes(t.status)).length;
    const published = (history || []).filter((h) => h.status === 'success' || h.status === 'published').length;
    const failed = (history || []).filter((h) => ['failed', 'skipped'].includes(h.status)).length;
    if ($('#statProducts')) $('#statProducts').textContent = products.length;
    if ($('#statQueued')) $('#statQueued').textContent = queued;
    if ($('#statPublished')) $('#statPublished').textContent = published;
    if ($('#statFailed')) $('#statFailed').textContent = failed;
  } catch {}
}
// 每隔一段时间刷新连接与统计
setInterval(() => { checkConn(); if ($('.tab.active')?.dataset.tab !== 'settings') loadStats(); }, 8000);
// 打开即立即探一次连接，并先给出「检测中」状态，避免一直停在「连接中…」且能立刻暴露真实错误
setConn('connecting', '正在检测后端连接…');
checkConn();

// ---- Toast ----
function toast(text, kind = '') {
  const wrap = $('#toast');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 250); }, 2600);
}

// ---- 选品 ----
const SRC_LABEL = { extension: '插件', qianfan: '选品', manual: '手动', import: '导入' };
async function loadProducts() {
  const list = await callApi('GET', '/api/products');
  $('#prodCount').textContent = list.length;
  if (!list.length) {
    $('#productList').innerHTML = '<div class="empty"><span class="em">📦</span>商品库还是空的。<br/>在商品页用插件「采集本页商品」，或上方手动/导入添加。</div>';
    loadStats();
    return;
  }
  $('#productList').innerHTML = list.map((p) => `
    <div class="prod" data-id="${p.id}">
      ${p.source ? `<span class="src">${SRC_LABEL[p.source] || esc(p.source)}</span>` : ''}
      ${p.image ? `<img src="${imgUrl(p.image)}" onerror="this.style.display='none'"/>` : '<div class="noimg">无图</div>'}
      <div class="pname">${esc(p.productName || p.itemId || '未命名')}</div>
      <div class="pmeta">${p.price ? '¥' + esc(p.price) : ''} ${p.itemId ? '· ' + esc(p.itemId) : ''}</div>
      <div class="pacts">
        <button class="mini del" data-id="${p.id}">删除</button>
      </div>
    </div>`).join('');
  $$('#productList .del').forEach((b) => b.addEventListener('click', async () => {
    await callApi('POST', `/api/products/${b.dataset.id}/delete`); loadProducts();
  }));
}

$('#fetchQianfanBtn').addEventListener('click', async () => {
  $('#fetchMsg').textContent = '抓取中…';
  const r = await callApi('POST', '/api/qianfan/fetch', {});
  $('#fetchMsg').textContent = r.ok ? `✅ 抓到 ${r.count} 个商品` : '❌ ' + (r.detail || '失败');
  if (r.ok) { loadProducts(); toast(`已抓取 ${r.count} 个商品`, 'ok'); }
  else toast('商品页抓取失败：' + (r.detail || ''), 'err');
});

$('#addProductBtn').addEventListener('click', async () => {
  const r = await callApi('POST', '/api/products', {
    itemId: $('#mItemId').value, productName: $('#mName').value, price: $('#mPrice').value,
    image: $('#mImage').value, description: $('#mDesc').value, source: 'manual',
  });
  $('#addMsg').textContent = r.id ? '✅ 已添加' : '❌ 失败';
  if (r.id) { toast('已添加商品', 'ok'); loadProducts(); } else toast('添加失败', 'err');
});

$('#importBtn').addEventListener('click', async () => {
  const text = $('#importBox').value.trim();
  let products = [];
  if (text.startsWith('[')) {
    try { products = JSON.parse(text); } catch { $('#importMsg').textContent = '❌ JSON 解析失败'; return; }
  } else {
    products = text.split('\n').filter(Boolean).map((line) => {
      const [productName, price, itemId] = line.split('|');
      return { productName: (productName || '').trim(), price: (price || '').trim(), itemId: (itemId || '').trim() };
    });
  }
  const r = await callApi('POST', '/api/products/import', { products });
  $('#importMsg').textContent = `✅ 导入 ${r.added} 个`;
  toast(`已导入 ${r.added} 个商品`, 'ok'); loadProducts();
});

$('#refreshProdBtn').addEventListener('click', () => { loadProducts(); loadStats(); toast('已刷新商品库', 'ok'); });

// ---- 本地图片文件夹（按 images/<id>/ 读取并发布）----
async function loadImageFolders() {
  const box = $('#imageFolderList'); if (!box) return;
  let data;
  try { data = await callApi('GET', '/api/images-folders'); } catch { return; }
  const prev = $('#imagesRootPreview'); if (prev) prev.textContent = data.root || '—';
  if (!data.exists) {
    box.innerHTML = `<div class="empty"><span class="em">📁</span>图片根目录不存在：<code>${esc(data.root)}</code><br/>请在软件数据目录建一个 <code>images/</code>，其下每个子文件夹（名即 id）放一组笔记图片，然后点「扫描图片文件夹」。</div>`;
    return;
  }
  const folders = data.folders || [];
  if (!folders.length) {
    box.innerHTML = `<div class="empty"><span class="em">📁</span>没有找到含图片的子文件夹。<br/>在 <code>${esc(data.root)}</code> 下建立 <code>&lt;id&gt;/</code> 子目录并放入图片（jpg/png/webp…），再点扫描。</div>`;
    return;
  }
  box.innerHTML = folders.map((f) => `
    <div class="prod ifold" data-id="${esc(f.id)}">
      <label class="pick"><input type="checkbox" class="ifold-check" data-id="${esc(f.id)}" ${f.imported ? 'disabled' : ''}/> ${f.imported ? '已导入' : '选'}</label>
      ${f.images.length ? `<img src="${imgFileUrl(f.images[0])}" onerror="this.style.display='none'"/>` : '<div class="noimg">无图</div>'}
      <div class="pname">${esc(f.name)}</div>
      <div class="pmeta">${f.imageCount} 张图 · 将生成标题：<strong>${esc(f.previewTitle)}</strong></div>
      ${f.matchedProduct
        ? `<div class="pmeta imported">🔗 已匹配商品（按${esc(f.matchedProduct.matchBy)}）</div>${f.nameWarning ? `<div class="pmeta warn">⚠ 商品名疑似就是文件夹名，请到「素材库」页把该商品名改成真实标题</div>` : ''}`
        : `<div class="pmeta warn">⚠ 未匹配到商品 → 标题将是文件夹名。可在文件夹内放 title.txt 指定真实标题，或到「素材库」页添加 itemId=${esc(f.productId)} 的商品</div>`}
      ${f.imported ? '<div class="pmeta imported">✓ 已导入</div>' : ''}
    </div>`).join('');
}
$('#scanAndImportBtn').addEventListener('click', async () => {
  $('#imgFolderMsg').textContent = '扫描并导入中…';
  await loadImageFolders();
  const r = await callApi('POST', '/api/images-folders/import', { matchedOnly: true });
  if (r.ok) {
    $('#imgFolderMsg').textContent = `✅ 已导入 ${r.created} 组（仅「有图片且匹配商品库」）并生成笔记入队`;
    toast(`已导入 ${r.created} 组图片笔记`, 'ok');
    loadImageFolders(); loadStats();
  } else {
    $('#imgFolderMsg').textContent = '❌ ' + (r.detail || '失败');
  }
});


// ---- 批量发布 ----
async function loadQueue() {
  const data = await callApi('GET', '/api/batch/queue');
  const tasks = data.tasks;
  queueHasPending = !!(tasks && tasks.some((t) => t.status === 'queued' || t.status === 'picked'));
  nextPublishAtAt = data.nextPublishAt || 0;
  renderCountdown();
  $('#queueList').innerHTML = tasks.length ? tasks.map((t) => `
    <div class="qitem">
      <span class="badge ${t.status}">${esc(t.status)}</span>
      <span class="qname">${esc(t.product?.productName || t.itemId || '商品')}</span>
      ${thumbStrip(t.images)}
      <span class="qstep">${esc(t.step || '')}</span>
      <span class="qdetail">${esc(t.statusDetail || '')}</span>
      ${t.status === 'queued' ? `<button class="mini cancel" data-id="${t.id}">取消</button>` : ''}
    </div>`).join('') : '<div class="empty"><span class="em">🚀</span>队列为空。<br/>去「素材库」页的本地图片文件夹扫描并导入生成笔记。</div>';
  $$('#queueList .cancel').forEach((b) => b.addEventListener('click', async () => {
    await callApi('POST', `/api/batch/${b.dataset.id}/cancel`); loadQueue();
  }));
}
function startPoll() { stopPoll(); loadQueue(); pollTimer = setInterval(loadQueue, 2000); }
function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---- 批量发布页「下一篇倒计时」：读取插件上报的 nextPublishAt，每秒刷新 ----
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  const m = Math.floor(s / 60), ss = s % 60;
  return (m > 0 ? m + '分' : '') + ss + '秒';
}
function renderCountdown() {
  const el = document.getElementById('nextCountdown');
  if (!el) return;
  // 队列已空（无待发任务）：不再显示倒计时
  if (!queueHasPending) {
    el.style.display = 'none';
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  el.style.display = '';
  if (!nextPublishAtAt || nextPublishAtAt <= Date.now()) {
    el.textContent = '⏳ 距下一篇发布：—（到点即发布）';
    el.classList.remove('active');
  } else {
    el.textContent = '⏳ 距下一篇发布：' + fmtCountdown(nextPublishAtAt);
    el.classList.add('active');
  }
}
setInterval(renderCountdown, 1000); // 每秒走字，loadQueue 每 2s 刷新数据源

$('#pumpBtn').addEventListener('click', async () => {
  const mode = $('#setPublish').value;
  if (mode === 'extension') {
    $('#pumpMsg').textContent = 'ⓘ 插件模式下请到创作者页用浏览器插件「开始批量发布」一键自动发布';
    toast('插件模式：请到创作者发布台用插件拉取发布', 'warn');
    return;
  }
  await callApi('POST', '/api/batch/pump'); $('#pumpMsg').textContent = '▶ 执行中'; startPoll(); toast('已开始批量发布', 'ok');
});
$('#pauseBtn').addEventListener('click', async () => { await callApi('POST', '/api/batch/pause'); $('#pumpMsg').textContent = '⏸ 已暂停'; });
$('#resumeBtn').addEventListener('click', async () => { await callApi('POST', '/api/batch/resume'); $('#pumpMsg').textContent = '⏵ 继续'; });
$('#stopBtn').addEventListener('click', async () => { await callApi('POST', '/api/batch/stop'); $('#pumpMsg').textContent = '⏹ 已停止'; });
$('#retryBtn').addEventListener('click', async () => {
  const r = await callApi('POST', '/api/batch/retry', {});
  if (r.ok) {
    $('#pumpMsg').textContent = `🔁 已重置 ${r.requed || 0} 条失败任务`;
    toast(`已重置 ${r.requed || 0} 条到待发布`, 'ok');
    loadQueue(); loadStats();
  } else toast('重置失败', 'err');
});

// ---- 历史 ----
async function loadHistory() {
  const h = await callApi('GET', '/api/history');
  $('#historyList').innerHTML = h.length ? h.map((r) => `
    <div class="qitem">
      <span class="badge ${r.status}">${esc(r.status)}</span>
      <span class="qname">${esc(r.title || r.itemId || '')}</span>
      <span class="qdetail">${esc(r.detail || '')}</span>
      <span class="qstep">${esc(r.at || '')}</span>
    </div>`).join('') : '<div class="empty"><span class="em">🕘</span>暂无发布历史。</div>';
}

// ---- 账号管理（套餐配额门禁）----
async function loadAccounts() {
  const box = $('#accountList'); if (!box) return;
  let data, st;
  try { data = await callApi('GET', '/api/accounts'); } catch { box.innerHTML = '<div class="empty"><span class="em">⚠️</span>账号列表加载失败，请检查后端连接。</div>'; return; }
  try { st = await callApi('GET', '/api/settings'); } catch { st = {}; }
  const max = (st && st.maxAccounts != null) ? st.maxAccounts : data.max;
  const planLabel = (st && st.plan && st.plan.label) || '免费版';
  const used = (data.accounts || []).length;
  const quota = (max === Infinity || max == null) ? '不限' : `${used}/${max}`;
  const q = $('#accountQuota');
  if (q) q.textContent = `当前套餐：${planLabel} ｜ 已绑定 ${quota} 个账号`;
  if (!used) {
    box.innerHTML = '<div class="empty"><span class="em">👤</span>还没有绑定账号。<br/>添加你的账号（数量受套餐配额限制）。</div>';
    return;
  }
  box.innerHTML = (data.accounts || []).map((a) => `
    <div class="acc" data-id="${esc(a.id)}">
      <div class="acc-info">
        <div class="acc-name">${esc(a.name)}</div>
        <div class="acc-meta">绑定于 ${a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN') : '—'}</div>
      </div>
      <button class="mini danger del-acc" data-id="${esc(a.id)}">解绑</button>
    </div>`).join('');
  $$('#accountList .del-acc').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定解绑该账号吗？\n（仅解除本地绑定记录，不影响该账号本身）')) return;
    const r = await callApi('POST', `/api/accounts/${b.dataset.id}/delete`);
    if (r.ok) { toast('已解绑账号', 'ok'); loadAccounts(); } else toast('解绑失败', 'err');
  }));
}
$('#addAccountBtn').addEventListener('click', async () => {
  const name = $('#accountName').value.trim();
  $('#accountMsg').textContent = '添加中…';
  const r = await callApi('POST', '/api/accounts', { name });
  if (r.ok) {
    $('#accountName').value = '';
    $('#accountMsg').textContent = '✅ 已添加';
    toast('已添加账号', 'ok');
    loadAccounts();
  } else if (r.error === 'account-limit') {
    $('#accountMsg').textContent = '❌ ' + (r.message || '已达套餐账号上限');
    toast('已达套餐账号上限，需解绑或升级', 'err');
  } else {
    $('#accountMsg').textContent = '❌ 添加失败';
    toast('添加失败', 'err');
  }
  setTimeout(() => { const m = $('#accountMsg'); if (m) m.textContent = ''; }, 4000);
});

// ---- 设置 ----
async function loadSettings() {
  const s = await callApi('GET', '/api/settings');
  $('#setProvider').value = s.aiProvider || 'deepseek';
  $('#setKey').value = s.aiApiKey || '';
  $('#setBaseUrl').value = s.aiBaseUrl || '';
  $('#setModel').value = s.aiModel || '';
  $('#setPublish').value = s.publishMode || 'dry-run';
  $('#setQianfanUrl').value = s.qianfanUrl || '';
  $('#setBrowserUrl').value = s.cdpBrowserUrl || '';
  $('#setChromePath').value = s.cdpChromePath || '';
  $('#setImagesRoot').value = s.imagesRoot || '';
  $('#setCsvExportDir').value = s.csvExportDir || '';
  $('#setGenTitle').checked = !!s.generateTitle;
  $('#setGenContent').checked = !!s.generateContent;
  $('#setGenTopics').checked = !!s.enableAiTopics;
  $('#setTopicsCount').value = s.topicsCount || 6;
  $('#setEmoji').value = s.randomEmoji ?? 30;
  $('#setAutoSubmit').checked = !!s.autoSubmit;
  $('#setHumanTyping').checked = !!s.humanTyping;
  $('#setInterval').value = s.publishIntervalSeconds || 500;
  $('#setRandomDelay').value = s.publishIntervalRandomDelaySeconds || 200;
  $('#setRepeat').value = s.singleProductRepeatLimit ?? 0;
  $('#setTitlePrompt').value = s.titlePrompt || '';
  $('#setContentPrompt').value = s.contentPrompt || '';
  $('#setTopicsPrompt').value = s.topicsPrompt || '';
  updatePublishHint();
}
const PUBLISH_HINTS = {
  'dry-run': '当前为「模拟发布」：不会真实发出，仅演示流程，便于先调通前后端与插件。',
  'extension': '「浏览器插件」模式（推荐）：在创作者发布台页面点浏览器插件「开始批量发布」即可自动逐篇填表并发布（默认开启自动提交）。此模式下下方「开始批量发布」无效，由插件驱动。',
  'cdp': '「CDP 真实浏览器」：需先在设置填 CDP 浏览器地址并登录创作者后台，再点「开始批量发布」由本机已登录 Chrome 驱动发布。',
};
function updatePublishHint() {
  const el = $('#publishModeHint');
  if (el) el.textContent = PUBLISH_HINTS[$('#setPublish').value] || '';
}
$('#setPublish').addEventListener('change', updatePublishHint);
$('#saveSetBtn').addEventListener('click', async () => {
  await callApi('POST', '/api/settings', {
    aiProvider: $('#setProvider').value, aiApiKey: $('#setKey').value, aiBaseUrl: $('#setBaseUrl').value, aiModel: $('#setModel').value,
    publishMode: $('#setPublish').value, qianfanUrl: $('#setQianfanUrl').value, cdpBrowserUrl: $('#setBrowserUrl').value, cdpChromePath: $('#setChromePath').value,
    generateTitle: $('#setGenTitle').checked, generateContent: $('#setGenContent').checked, enableAiTopics: $('#setGenTopics').checked,
    topicsCount: +$('#setTopicsCount').value, randomEmoji: +$('#setEmoji').value, autoSubmit: $('#setAutoSubmit').checked,
    publishIntervalSeconds: +$('#setInterval').value, publishIntervalRandomDelaySeconds: +$('#setRandomDelay').value, singleProductRepeatLimit: +$('#setRepeat').value,
    titlePrompt: $('#setTitlePrompt').value, contentPrompt: $('#setContentPrompt').value, topicsPrompt: $('#setTopicsPrompt').value,
    imagesRoot: $('#setImagesRoot').value, csvExportDir: $('#setCsvExportDir').value,
  });
  $('#setMsg').textContent = '✅ 已保存';
  setTimeout(() => ($('#setMsg').textContent = ''), 2000);
});

$('#clearDataBtn').addEventListener('click', async () => {
  if (!confirm('确定清除全部发布数据吗？\n将删除：素材库、发布任务、发布历史、已上传图片。\n（AI 配置与账号设置保留）')) return;
  $('#clearMsg').textContent = '清除中…';
  try {
    const r = await callApi('POST', '/api/data/clear', { targets: ['tasks', 'products', 'history', 'uploads'] });
    if (r.ok) {
      const c = (r.result && r.result.cleared) || [];
      $('#clearMsg').textContent = '✅ 已清除：' + c.join('、');
      if (typeof loadProducts === 'function') loadProducts();
    } else {
      $('#clearMsg').textContent = '❌ 清除失败';
    }
  } catch (e) {
    $('#clearMsg').textContent = '❌ ' + (e.message || '清除失败');
  }
  setTimeout(() => ($('#clearMsg').textContent = ''), 5000);
});
$('#aiTestBtn').addEventListener('click', async () => {
  const r = await callApi('POST', '/api/ai/test', {
    aiProvider: $('#setProvider').value, aiApiKey: $('#setKey').value, aiBaseUrl: $('#setBaseUrl').value, aiModel: $('#setModel').value,
  });
  $('#aiTestMsg').textContent = r.ok ? '✅ ' + (r.detail || '连通') : '❌ ' + (r.detail || '失败');
});
$('#cdpTestBtn').addEventListener('click', async () => {
  const r = await callApi('POST', '/api/cdp/status', { cdpBrowserUrl: $('#setBrowserUrl').value });
  $('#cdpMsg').textContent = r.ok ? '✅ ' + r.detail : '❌ ' + (r.detail || '未连接');
});
$('#cdpLaunchBtn').addEventListener('click', async () => {
  const r = await callApi('POST', '/api/cdp/launch', { cdpChromePath: $('#setChromePath').value });
  $('#cdpMsg').textContent = r.ok ? '✅ ' + r.detail : '❌ ' + (r.detail || '失败');
});

function switchTab(name) {
  $$('.tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
}

// ---- 敏感词 / 合规自检 ----
async function loadSensitiveMeta() {
  const el = $('#sensitiveCover'); if (!el) return;
  try {
    const r = await callApi('GET', '/api/sensitive/categories');
    if (r && r.ok) el.textContent = `词库覆盖 ${r.categories.length} 类 · ${r.totalWords} 词（本地）`;
    else el.textContent = '词库加载失败';
  } catch { el.textContent = '词库加载失败（请检查后端）'; }
}

function severityBadge(sev) {
  const map = { high: ['bad', '高危'], medium: ['warn', '中危'], low: ['muted', '低危'] };
  const [cls, label] = map[sev] || ['muted', sev || '未知'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderSensitive(r, text) {
  const box = $('#sensitiveResult'); if (!box) return;
  if (!r || r.clean) {
    box.innerHTML = '<div class="empty"><span class="em">✅</span>未检出敏感词 / 高风险表述。</div>';
    return;
  }
  const stat = `检出 <b>${r.total}</b> 处风险：高危 ${r.bySeverity.high || 0} ／ 中危 ${r.bySeverity.medium || 0} ／ 低危 ${r.bySeverity.low || 0}`;
  const items = (r.matches || []).map((m) => {
    const start = Math.max(0, m.index - 12);
    const end = Math.min(text.length, m.index + m.word.length + 12);
    const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    return `<div class="sens-item">
      ${severityBadge(m.severity)}
      <span class="sens-cat">${esc(m.category)}</span>
      <span class="sens-word">${esc(m.word)}</span>
      <span class="sens-ctx">${esc(snippet)}</span>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="sens-stat">${stat}</div>${items}`;
}

$('#sensitiveCheckBtn').addEventListener('click', async () => {
  const text = $('#sensitiveInput').value;
  $('#sensitiveMsg').textContent = '检测中…';
  try {
    const r = await callApi('POST', '/api/sensitive/check', { text });
    if (!r || !r.ok) { $('#sensitiveMsg').textContent = '检测失败'; return; }
    renderSensitive(r, text);
    $('#sensitiveMsg').textContent = r.clean ? '✅ 未发现风险' : `检出 ${r.total} 处`;
  } catch { $('#sensitiveMsg').textContent = '检测失败（请检查后端）'; }
});

$('#sensitiveMaskBtn').addEventListener('click', async () => {
  const text = $('#sensitiveInput').value;
  if (!text) { $('#sensitiveMsg').textContent = '请先输入内容'; return; }
  $('#sensitiveMsg').textContent = '检测中…';
  try {
    const r = await callApi('POST', '/api/sensitive/check', { text });
    if (!r || !r.ok) { $('#sensitiveMsg').textContent = '检测失败'; return; }
    const sorted = [...(r.matches || [])].sort((a, b) => b.index - a.index);
    let out = text;
    for (const m of sorted) out = out.slice(0, m.index) + '*'.repeat(m.word.length) + out.slice(m.index + m.word.length);
    $('#sensitiveCleaned').value = out;
    renderSensitive(r, text);
    $('#sensitiveMsg').textContent = sorted.length ? `已打码 ${sorted.length} 处` : '未发现需打码的词';
  } catch { $('#sensitiveMsg').textContent = '检测失败（请检查后端）'; }
});

// 初始化
loadProducts();
loadSettings();
checkConn();
loadStats();
