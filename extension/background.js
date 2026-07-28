// background.js — MV3 service worker
// 职责：插件与本地后端(server.js)的桥接、消息路由、周期 pump、状态广播。
// 设计：本插件是「浏览器内自动化层」，后端是「桌面编排层」（即原有的 server.js 原型）。
//
// v0.2.31 调度模型（按用户要求）：
//   - 默认自动发布（autoSubmit，服务端已是 true），不进入人工待发布。
//   - 队列串行：同一时刻只允许「一个账号的一篇笔记」在发布（并发=1）。
//   - 每篇笔记都「重新打开一个新标签」去填+发（不再复用同一个标签页），
//     发布完成后关闭旧标签，等配置延时( publishIntervalSeconds + 随机 )后再开下一篇。
//   - 完成信号以「服务端任务状态」为准（轮询 /api/ext/task?id=），不依赖可能失效的消息通道，
//     这样即使 SW 被回收、content script 直连后端回报，调度器也能可靠地推进到下一篇。
//   - 遇验证挑战：标记 manual_hold 并暂停队列，等人工处理；content script 监听人工发布成功后回报 published，恢复队列。

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:5199',
  autoConnect: true,
};

// 创作者图文发布页（每篇都开一个全新的标签页，地址固定为此）
const CREATOR_URL = 'https://creator.xiaohongshu.com/publish/publish?source=&published=true&from=tab_switch&target=image';

function storageGet() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (v) => resolve(v));
  });
}
function storageSet(patch) {
  return new Promise((resolve) => chrome.storage.local.set(patch, resolve));
}

async function api(path, opts = {}) {
  const { serverUrl } = await storageGet();
  const url = serverUrl.replace(/\/+$/, '') + path;
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(url, init);
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = { _raw: text }; }
  return { ok: r.ok, status: r.status, data: j };
}

// 推商品到后端（选品 content script 采到后调用）
async function pushProducts(products) {
  const r = await api('/api/ext/products', { method: 'POST', body: { products } });
  return r.data;
}

// 取一条待发笔记给创作者 content script
async function pullNext() {
  const r = await api('/api/ext/next', { method: 'GET' });
  return r.data;
}

// 回报发布结果
async function reportDone(taskId, status, detail) {
  const r = await api('/api/ext/done', { method: 'POST', body: { taskId, status, detail } });
  return r.data;
}

// 广播状态给 popup / 页面
function broadcast(state) {
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
  chrome.storage.local.set({ lastState: state, scheduler: schedulerState() }).catch(() => {});
}

// 用 chrome.debugger 在指定标签页的 (x,y) 处发「真实」鼠标点击。
// 用途：发布平台发布按钮在 <xhs-publish-btn> 的 closed shadow DOM 内，JS 的 elementFromPoint / querySelector
// 都取不到内部按钮（elementFromPoint 对 closed shadow 仅返回 host）；但「真实输入事件」的命中测试会穿透
// closed shadow，落到红「发布」按钮上。CDP Input.dispatchMouseEvent 即真实输入，故可点中。
function sendDebug(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}
async function realDebugClick(tabId, x, y) {
  if (tabId == null) return { ok: false, msg: 'no tabId' };
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
  } catch (e) {
    // 已 attach 或失败都继续尝试，sendCommand 会报错再兜底
  }
  try {
    await sendDebug(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 });
    await sendDebug(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 });
    return { ok: true, msg: 'clicked@' + Math.round(x) + ',' + Math.round(y) };
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} }
  }
}

// ---------------- 调度器状态 ----------------
let schedulerActive = false;     // 是否开启「队列自动发布」（由 popup「开始批量发布」控制）
let busy = false;                // 当前是否有一篇笔记正在发布中（并发=1 的保护）
let paused = false;              // 遇到验证挑战等需人工，暂停队列（解决后由 content script 回报 published 恢复）
let current = null;              // { tabId, taskId, resolved } 当前正在发布的任务
let awaitingTabId = null;        // 刚开的新标签，等其加载完成后再填充
let lastPublishedTabId = null;   // 刚发布成功的标签页：先保留用于显示「下一篇倒计时」，开下一篇时再关
let nextAllowedAt = 0;           // 下一篇最早可开标签的时间戳（ms），用于保证「发布后延时」
let lastDelayMs = 500 * 1000 + 200 * 1000; // 上一次取的间隔（默认 500s+200s），按服务端返回覆盖
let pollTimer = null;

// ---- 调度状态持久化：MV3 的 Service Worker 会随时被回收，内存里的 schedulerActive / paused /
// nextAllowedAt 都会重置，导致「发布完一篇后队列停住、不再自动发下一篇」。把这些状态落盘到
// chrome.storage.local，SW 重启时恢复，并用 pump 闹钟(每分钟)持续推进，保证自动发布不中断。
const SCHED_KEYS = { sched_running: false, sched_paused: false, nextPublishAt: 0, lastDelayMs: 500 * 1000 + 200 * 1000 };
function persistSched() {
  chrome.storage.local.set({
    sched_running: schedulerActive,
    sched_paused: paused,
    nextPublishAt: nextAllowedAt,
    lastDelayMs: lastDelayMs,
  }).catch(() => {});
}
(async () => {
  try {
    const s = await new Promise((res) => chrome.storage.local.get(SCHED_KEYS, (r) => res(r || SCHED_KEYS)));
    schedulerActive = !!s.sched_running;
    paused = !!s.sched_paused;
    nextAllowedAt = s.nextPublishAt || 0;
    lastDelayMs = Number(s.lastDelayMs) || lastDelayMs;
    // SW 重启后：若之前在跑队列且已到/接近发布时刻，重新挂定时器推进下一篇
    if (schedulerActive && !paused && nextAllowedAt) armNextTimer();
  } catch (e) {}
})();

function schedulerState() {
  return { schedulerActive, busy, paused, hasCurrent: !!current, awaiting: !!awaitingTabId, nextAllowedAt };
}

// 计算两篇之间的延时（ms）= publishIntervalSeconds + [0, publishIntervalRandomDelaySeconds)
function computeDelay(next) {
  const base = (next && Number(next.publishIntervalSeconds)) || 500;
  const rand = (next && Number(next.publishIntervalRandomDelaySeconds)) || 200;
  return (base + Math.random() * rand) * 1000;
}

// 开一个全新的图文发布标签（每篇一个），标记 awaitingTabId，等 onUpdated 加载完再填充
function openNextTab() {
  if (busy || paused || !schedulerActive || current || awaitingTabId) return;
  // 关掉所有残留的创作者标签（含刚发布完保留的倒计时标签 / SW 回收遗留的标签），每篇都开新标签，
  // 避免标签堆积，也让「下一篇倒计时」自然转移到新标签上继续读秒。
  chrome.tabs.query({ url: 'https://creator.xiaohongshu.com/*' }, (tabs) => {
    for (const t of (tabs || [])) { if (t.id != null) chrome.tabs.remove(t.id).catch(() => {}); }
    lastPublishedTabId = null;
    chrome.tabs.create({ url: CREATOR_URL, active: true }, (tab) => {
      if (!tab || tab.id == null) return;
      awaitingTabId = tab.id;
      broadcast({ kind: 'info', msg: '已打开新的发布标签，等待加载…' });
    });
  });
}

// 把一条任务填充到指定标签（拉取前先上锁，杜绝并发重复拉取/双填）
async function fillTab(tabId) {
  if (busy || paused || !schedulerActive || current || awaitingTabId) return;
  busy = true; // 同步上锁，防止 pump/onUpdated 并发再拉一条
  try {
    const next = await pullNext();
    if (!next || !next.ok) { busy = false; return; }
    if (!next.task) {
      // 队列已空：停掉调度并清除倒计时（storage + 后端），两侧不再显示读秒
      busy = false;
      schedulerActive = false;
      clearSchedule();
      broadcast({ kind: 'idle', msg: '队列已空，没有待发任务了 ✓' });
      return;
    }
    lastDelayMs = computeDelay(next);
    current = { tabId, taskId: next.task.id, resolved: false };
    // 转发给创作者页 content script 填充+自动发布
    let sendErr = null;
    const sendOnce = (cb) => new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'fillTask', task: next.task, autoSubmit: next.autoSubmit, serverUrl: next.serverUrl, humanTyping: next.humanTyping }, (resp) => {
        if (chrome.runtime.lastError) sendErr = chrome.runtime.lastError.message;
        resolve();
      });
    });
    await sendOnce();
    // content script 未注入（安装后未刷新/ SPA 切页/ SW 回收）→ 重新注入再发一次
    if (sendErr && /Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(sendErr)) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-creator.js'] });
        await new Promise((r) => setTimeout(r, 600));
        sendErr = null;
        await sendOnce();
      } catch (e) { sendErr = e.message; }
    }
    if (sendErr && /Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(sendErr)) {
      // 完全无法注入：释放锁并标失败，否则任务永远卡 picked
      busy = false; current = null;
      try { await reportDone(next.task.id, 'failed', '创作者页未响应：' + sendErr); } catch {}
      broadcast({ kind: 'error', msg: '创作者页未就绪（任务已标失败）：' + sendErr });
      return;
    }
    // 已下发：启动对该任务的轮询，作为「完成」的可靠信号
    broadcast({ kind: 'busy', msg: '已下发任务：' + (next.task.product?.productName || next.task.itemId || next.task.title || '笔记') });
    startPolling(next.task.id);
  } catch (e) {
    busy = false; current = null;
    broadcast({ kind: 'error', msg: '与后端通信失败：' + e.message });
  }
}

// 轮询服务端该任务状态，作为「发布完成」的可靠信号（不依赖 content script 的消息通道）
function startPolling(taskId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!current || current.taskId !== taskId || current.resolved) { clearInterval(pollTimer); pollTimer = null; return; }
    try {
      const r = await api('/api/ext/task?id=' + encodeURIComponent(taskId), { method: 'GET' });
      const t = r.data && r.data.task;
      const st = t && t.status;
      if (st === 'published') resolveCurrent('published', t.statusDetail || '已发布');
      else if (st === 'manual_hold') resolveCurrent('manual_hold', t.statusDetail || '验证挑战');
      else if (st === 'failed') resolveCurrent('failed', t.statusDetail || '失败');
      // queued/picked 继续等
    } catch {}
  }, 3000);
}

// 结束当前任务并推进队列（one-time，由轮询或 content script 消息触发）
// reportTabId：content script 回报时所在标签 id（手动拉取路径后台未跟踪 current，用它兜底）
// delayMs：content script 回报时携带的真实间隔（手动拉取路径没走 fillTab，用它覆盖默认 lastDelayMs）
function resolveCurrent(kind, detail, reportTabId, delayMs) {
  const hadCurrent = !!current && !current.resolved;
  if (!hadCurrent) {
    // 手动拉取路径：后台未通过 fillTab 跟踪 current，但只要调度器在跑（或发布成功）就继续下一篇
    if (!schedulerActive && kind !== 'published') return;
    if (busy) return; // 别的任务进行中，等它自己回报
  } else {
    current.resolved = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    busy = false;
  }
  const tabId = hadCurrent ? current.tabId : (reportTabId || null);
  if (hadCurrent) current = null;
  // 手动拉取路径未走 fillTab，用 content script 回报的真实间隔覆盖默认 lastDelayMs
  if (delayMs && Number(delayMs) > 0) lastDelayMs = Number(delayMs);

  if (kind === 'published') {
    paused = false; // 若之前因人工恢复，解除暂停
    if (!schedulerActive) schedulerActive = true; // 手动拉取也启动自动链（倒计时+自动下一篇）
    broadcast({ kind: 'ok', msg: '✓ 已发布：' + (detail || '') });
    // 保留刚发布的标签页用于显示「下一篇倒计时」，开下一篇时（openNextTab）再关闭，避免标签堆积
    lastPublishedTabId = tabId;
    scheduleNext();
  } else if (kind === 'manual_hold') {
    paused = true; // 暂停队列，保留该标签等人工处理验证
    broadcast({ kind: 'warn', msg: '⚠ 遇到验证挑战，已暂停队列，请人工处理；解决后点「发布」将自动继续' });
    // 不关标签、不开下一篇
  } else { // failed 等
    broadcast({ kind: 'error', msg: '✗ 任务结束（' + (detail || '失败') + '），继续下一篇' });
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    scheduleNext();
  }
  persistSched(); // 持久化 paused 等状态变化，抗 SW 回收
}

// 等配置延时后开下一篇（用 nextAllowedAt 保证延时，并每次 SW 唤醒都重新 arm 定时器，抗 SW 回收）
async function scheduleNext() {
  if (!schedulerActive || paused) return;
  // 先写好「下一篇最早发布时刻」：即便本批已空也先写，保证「最后一篇」的倒计时能完整走完，
  // 避免 content script 的 reportSchedule 刚把倒计时打出来几秒、这里又立刻 clearSchedule 把它清掉（两侧误以为没生效）。
  nextAllowedAt = Date.now() + lastDelayMs;
  // 写入 storage，供创作者页 Toast 显示「下一篇倒计时」（同时持久化调度状态，抗 SW 回收）
  chrome.storage.local.set({ nextPublishAt: nextAllowedAt }).catch(() => {});
  persistSched();
  // 上报给后端，供桌面「批量发布」页同步显示倒计时
  notifyServerSchedule(nextAllowedAt);
  // 确认是否还有待发任务
  let hasPending = true;
  try {
    const q = await api('/api/batch/queue', { method: 'GET' });
    hasPending = !!(q && q.tasks && q.tasks.some((t) => t.status === 'queued' || t.status === 'picked'));
  } catch (e) { hasPending = true; } // 查不到时保守继续，最终由 fillTab 空路径兜底清除
  if (!hasPending) {
    // 队列已空：停止自动链（不再开新标签），但「下一篇倒计时」保留到当前间隔走完再清除，
    // 用一次性闹钟兜底（SW 回收也能可靠触发），避免倒计时刚出现就被清掉。
    schedulerActive = false;
    persistSched();
    broadcast({ kind: 'idle', msg: '队列已空，没有待发任务了 ✓' });
    const remain = Math.max(1000, nextAllowedAt - Date.now());
    chrome.alarms.create('clearSchedule', { when: Date.now() + remain + 1500 });
    return;
  }
  // 真正挂定时器（每次都会重新计算剩余时间，SW 回收后由 pump/schedulerStep 重新 arm）
  armNextTimer();
}
// 清除「下一篇倒计时」：重置内存态、清 storage、上报后端 0（两侧都不再显示读秒）
function clearSchedule() {
  nextAllowedAt = 0;
  chrome.alarms.clear('nextPublish').catch(() => {}); // 撤销待发的「开下一篇」闹钟
  chrome.storage.local.set({ nextPublishAt: 0 }).catch(() => {});
  notifyServerSchedule(0);
}
// 把「下一篇最早发布时刻」上报给后端（桌面批量发布页需要它做倒计时）
async function notifyServerSchedule(at) {
  try {
    const r = await api('/api/ext/schedule', { method: 'POST', body: { nextPublishAt: at } });
    console.log('[黑猫][BG] notifyServerSchedule ok=', r.ok, 'status=', r.status, 'at=', at, 'delta=', at ? (at - Date.now()) + 'ms' : 0);
  } catch (e) {
    console.error('[黑猫][BG] notifyServerSchedule failed', e);
  }
}
// 重新挂「开下一篇」的定时器：改用 chrome.alarms 一次性闹钟（可靠跨 SW 回收）。
// MV3 的 Service Worker 空闲约 30s 会被系统回收，setTimeout 长延时必然丢失；
// 而 chrome.alarms 由浏览器持久维护，即使 SW 被回收也能在到点时唤醒 SW 触发 tryAdvance。
function armNextTimer() {
  if (!schedulerActive || paused) return;
  const when = Math.max(Date.now() + 1500, nextAllowedAt);
  chrome.alarms.create('nextPublish', { when });
}
// 推进到下一篇：满足所有安全条件才真正 openNextTab（倒计时到点后由 pump/定时器调用）
function tryAdvance() {
  if (!schedulerActive || paused || busy || current || awaitingTabId) {
    // 还没准备好（正忙/有进行中任务/等待新标签加载）：稍后由 pump 或本函数重试
    if (schedulerActive && !paused) armNextTimer();
    return;
  }
  if (Date.now() < nextAllowedAt) { armNextTimer(); return; }
  openNextTab();
}

// 调度步进：由 pump 闹钟/start 调用。规则：
//   - 暂停或正忙 → 不动
//   - 还没到 nextAllowedAt → 继续等（保证「发布后延时」，nextAllowedAt 已在 SW 启动时从 storage 恢复）
//   - 冷却结束 → 直接开下一篇（openNextTab 内部先清理残留标签，不依赖 onUpdated，抗 SW 回收）
async function schedulerStep() {
  const s = await storageGet();
  if (!s.autoConnect) return;
  if (!schedulerActive || paused) return;
  // 到点则直接开下一篇（pump 闹钟可靠，抗 SW 回收）；未到点则挂一次性闹钟兜底。
  if (Date.now() >= nextAllowedAt) tryAdvance();
  else armNextTimer();
}

// 周期 pump：每分钟尝试推进队列（同时兜底 SW 回收后丢失的延时定时器）
chrome.alarms.create('pump', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'pump') schedulerStep();
  // 队列已空后的兜底清理：间隔走完再清除倒计时（仅当没重新开始新批次时）
  else if (a.name === 'clearSchedule') { if (!schedulerActive) clearSchedule(); }
  // 到点开下一篇：由可靠闹钟唤醒（抗 SW 回收）。临近即触发，真正校验在 tryAdvance 内做。
  else if (a.name === 'nextPublish') { if (Date.now() >= nextAllowedAt - 3000) tryAdvance(); else armNextTimer(); }
});

// 创作者页加载完成：仅填充「本调度器刚开的新标签页」（awaitingTabId 路径）。
// 不再「接管」任意已打开的创作者页：发布成功后 XHS 会让同一标签页跳转到结果页
// （如 ?published=true&from=tab_switch），onUpdated 会再次触发；若还走接管分支，就会把已发布的
// 结果页当成空白表单重复拉取任务并填充，随后该标签页被关闭导致 busy/current 悬空、调度器永久卡死。
// 现在每篇笔记都只由 openNextTab 显式打开的全新标签页承载，彻底杜绝复用/重复填充。
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!/^https:\/\/creator\.xiaohongshu\.com\//.test(tab.url || '')) return;
  if (awaitingTabId === tabId) {
    awaitingTabId = null;
    fillTab(tabId);
  }
});

// 标签页被关闭（发布后 XHS 可能自动关闭结果页 / 用户手关）：清理引用并兜底释放锁，
// 避免 current/busy 悬空导致调度器卡死、下一篇永远不开。
chrome.tabs.onRemoved.addListener((tabId) => {
  if (awaitingTabId === tabId) awaitingTabId = null;
  if (lastPublishedTabId === tabId) lastPublishedTabId = null;
  if (current && current.tabId === tabId) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!current.resolved) {
      // 进行中的标签被关：释放锁，让调度器开新标签续发下一篇
      // （当前 picked 任务留在服务端，不重复本篇，避免重复发布同一笔记）
      current = null;
      busy = false;
      broadcast({ kind: 'warn', msg: '发布标签页被关闭，已释放并准备续发下一篇' });
      if (schedulerActive && !paused) scheduleNext();
    } else {
      current = null;
    }
  }
});

// content script 回报结果：作为「完成」的快速信号（轮询是兜底）。仅处理来自创作者页的回报。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'reportDone') {
    const s = (sender.tab && sender.tab.url || '');
    if (/creator\.xiaohongshu\.com/.test(s)) {
      const rid = sender.tab && sender.tab.id;
      if (msg.status === 'published') resolveCurrent('published', msg.detail, rid, msg.delayMs);
      else if (msg.status === 'manual_hold') resolveCurrent('manual_hold', msg.detail, rid, msg.delayMs);
      else if (msg.status === 'failed') resolveCurrent('failed', msg.detail, rid, msg.delayMs);
    }
  }
});

// ---------------- 消息路由 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    try {
      if (msg.type === 'reportDelay') {
        const d = Number(msg.delayMs);
        if (d > 0) { lastDelayMs = d; persistSched(); }
        sendResponse({ ok: true });
        return;
      } else if (msg.type === 'pushProducts') {
        const r = await pushProducts(msg.products || []);
        sendResponse({ ok: true, data: r });
      } else if (msg.type === 'ping') {
        const s = await storageGet();
        try {
          const r = await api('/api/settings');
          sendResponse({ ok: r.ok, serverUrl: s.serverUrl, msg: r.ok ? 'ok' : 'bad' });
        } catch (e) {
          sendResponse({ ok: false, serverUrl: s.serverUrl, msg: e.message });
        }
      } else if (msg.type === 'pullNext') {
        sendResponse({ ok: true, data: await pullNext() });
      } else if (msg.type === 'reportDone') {
        sendResponse({ ok: true, data: await reportDone(msg.taskId, msg.status, msg.detail) });
      } else if (msg.type === 'getConfig') {
        const s = await storageGet();
        const r = await api('/api/settings');
        sendResponse({ ok: true, serverUrl: s.serverUrl, settings: r.data });
      } else if (msg.type === 'getQueue') {
        try {
          const r = await api('/api/batch/queue', { method: 'GET' });
          const tasks = (r.data && r.data.tasks) || [];
          const queued = tasks.filter((t) => t.status === 'queued' || t.status === 'picked').length;
          sendResponse({ ok: r.ok, queued, total: tasks.length });
        } catch (e) {
          sendResponse({ ok: false, queued: 0, total: 0, msg: e.message });
        }
      } else if (msg.type === 'setAutoSubmit') {
        try {
          const r = await api('/api/settings', { method: 'POST', body: { autoSubmit: !!msg.value } });
          sendResponse({ ok: r.ok, data: r.data });
        } catch (e) {
          sendResponse({ ok: false, msg: e.message });
        }
      } else if (msg.type === 'startPublish') {
        // 开启队列自动发布：始终直接打开图文上传页（CREATOR_URL）再填充，不依赖/不接管当前已打开的（可能非上传页的）创作者页
        schedulerActive = true; paused = false;
        chrome.alarms.clear('clearSchedule').catch(() => {}); // 撤销上次批次遗留的兜底清理，避免误清新批次倒计时
        chrome.alarms.clear('nextPublish').catch(() => {});  // 撤销上一批次遗留的「开下一篇」闹钟
        persistSched();
        openNextTab();
        sendResponse({ ok: true, ...schedulerState(), msg: '已开启批量发布' });
      } else if (msg.type === 'pausePublish') {
        // 暂停：不再开新标签（当前正在发的那篇会发完，但不会自动续下一篇）
        schedulerActive = false;
        persistSched();
        sendResponse({ ok: true, ...schedulerState(), msg: '已暂停批量发布' });
      } else if (msg.type === 'resumePublish') {
        // 继续（从「暂停」恢复；若因验证挑战暂停，需先在标签页解决验证并发布）：同样直接打开图文上传页
        schedulerActive = true; paused = false;
        chrome.alarms.clear('clearSchedule').catch(() => {}); // 撤销上次批次遗留的兜底清理，避免误清新批次倒计时
        chrome.alarms.clear('nextPublish').catch(() => {});  // 撤销上一批次遗留的「开下一篇」闹钟
        persistSched();
        openNextTab();
        sendResponse({ ok: true, ...schedulerState(), msg: '已继续批量发布' });
      } else if (msg.type === 'stopNow') {
        // 立即停止并清理当前（用于紧急停止）
        schedulerActive = false; paused = false; nextAllowedAt = 0;
        chrome.alarms.clear('nextPublish').catch(() => {}); // 立即停止待发的「开下一篇」闹钟
        persistSched();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (current && current.tabId != null) chrome.tabs.remove(current.tabId).catch(() => {});
        if (awaitingTabId != null) chrome.tabs.remove(awaitingTabId).catch(() => {});
        if (lastPublishedTabId != null) chrome.tabs.remove(lastPublishedTabId).catch(() => {});
        current = null; awaitingTabId = null; lastPublishedTabId = null; busy = false;
        sendResponse({ ok: true, ...schedulerState(), msg: '已停止' });
      } else if (msg.type === 'getSched') {
        sendResponse({ ok: true, ...schedulerState() });
      } else if (msg.type === 'xhs-real-click') {
        // 由创作者页 content script 调用：在发布按钮的计算坐标处发真实鼠标点击（穿透 closed shadow）
        try {
          const tabId = (msg.tabId != null) ? msg.tabId : (sender.tab && sender.tab.id);
          const res = await realDebugClick(tabId, msg.x, msg.y);
          sendResponse({ ok: res.ok, msg: res.msg });
        } catch (e) {
          sendResponse({ ok: false, msg: e.message });
        }
      } else {
        sendResponse({ ok: false, msg: 'unknown' });
      }
    } catch (e) {
      sendResponse({ ok: false, msg: e.message });
    }
  })();
  return true; // 异步 sendResponse
});

// 安装/更新时打开设置提示
chrome.runtime.onInstalled.addListener(() => {
  broadcast({ kind: 'info', msg: '已安装。请在 popup 中确认后端地址，并打开商品页/创作者发布台使用。' });
});

// 保活心跳：内容脚本持常驻端口时，service worker 不会被回收
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {});
});
