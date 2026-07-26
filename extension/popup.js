// popup.js
const $ = (id) => document.getElementById(id);
const status = (t) => ($('status').textContent = t);
const diag = (t) => ($('diag').textContent = t);

function setAutoLabel(on) { $('autoToggle').textContent = on ? '自动提交：开' : '自动提交：关'; }

// 后端地址固定为本地桌面程序（http://127.0.0.1:5199），自动连接默认开启，弹窗不再手动配置。

// 诊断：后端连通性 + 待发任务数 + 当前自动提交开关
function refresh() {
  diag('后端：检测中… ｜ 待发：—');
  chrome.runtime.sendMessage({ type: 'ping' }, () => {
    chrome.runtime.sendMessage({ type: 'getQueue' }, (q) => {
      const queued = q && typeof q.queued === 'number' ? q.queued : '—';
      const ok = q && q.ok;
      diag(`后端：${ok ? '已连接 ✓' : '未连接 ✗'} ｜ 待发：${queued}`);
    });
  });
  chrome.runtime.sendMessage({ type: 'getConfig' }, (c) => {
    if (c && c.settings) setAutoLabel(!!c.settings.autoSubmit);
  });
}

$('autoToggle').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'getConfig' }, (c) => {
    const cur = !!(c && c.settings && c.settings.autoSubmit);
    const next = !cur;
    chrome.runtime.sendMessage({ type: 'setAutoSubmit', value: next }, (r) => {
      if (r && r.ok) {
        setAutoLabel(next);
        status('自动提交：' + (next ? '开（拉到即自动点发布）' : '关（填好待你手动发布）'));
      } else {
        status('设置失败：' + ((r && r.msg) || '未知'));
      }
      refresh();
    });
  });
});

$('refresh').addEventListener('click', () => { refresh(); status('已刷新状态'); });

// ---- 批量发布队列控制 ----
function schedLabel(s) {
  if (!s) return '队列：未开始';
  if (s.paused) return '队列：⏸ 已暂停（验证挑战，需人工处理后继续）';
  if (s.busy || s.hasCurrent) return '队列：▶ 正在发布一篇…';
  if (s.awaiting) return '队列：⏳ 正在打开新标签…';
  if (s.schedulerActive) return '队列：▶ 运行中（等待延时后开下一篇）';
  return '队列：未开始';
}
function refreshSched() {
  chrome.runtime.sendMessage({ type: 'getSched' }, (s) => {
    if (s && s.ok) $('sched').textContent = schedLabel(s);
  });
}
$('start').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'startPublish' }, (r) => {
    status((r && r.ok) ? '已开始批量发布（每篇开新标签，自动发布）' : '开始失败');
    refreshSched(); refresh();
  });
});
$('pause').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'pausePublish' }, () => { status('已暂停（当前这篇发完不再续）'); refreshSched(); });
});
$('resume').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'resumePublish' }, (r) => {
    status((r && r.ok) ? '已继续批量发布' : '继续失败');
    refreshSched(); refresh();
  });
});
$('stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stopNow' }, () => { status('已停止并清理当前标签'); refreshSched(); });
});

refresh();
setInterval(refresh, 5000);
setInterval(refreshSched, 2000);
refreshSched();
