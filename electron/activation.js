// 激活页逻辑（运行在浏览器上下文，仅通过 window.api 与主进程通信）
const $ = (id) => document.getElementById(id);
const status = (msg, kind) => {
  const s = $('status');
  s.textContent = msg;
  s.className = kind || '';
};

const PLAN_LABELS = { free: '免费试用', basic: '基础版', pro: '专业版', flag: '旗舰版', team: '团队版' };
const short = (s) => (s ? s.slice(0, 8) + '…' : '—');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// preload 未注入（如打包后 asar 内 ESM preload 未能加载）时，给出明确提示而非未捕获异常
const needApi = () => {
  if (window.api) return true;
  status('授权模块未加载：扩展桥(preload)未注入。请重新构建安装包（npm run dist），或先用开发模式 npm run electron 测试。', 'err');
  return false;
};

async function init() {
  // 开发测试入口（直接激活免支付）仅开发模式可见，避免生产安装包被白嫖付费套餐
  let dev = false;
  try { dev = !!(window.api && (await window.api.isDev())); } catch { dev = false; }
  const devSection = document.getElementById('dev-section');
  if (devSection) devSection.style.display = dev ? 'block' : 'none';

  if (!needApi()) {
    $('mc').textContent = '未就绪';
    return;
  }
  try {
    const mc = await window.api.getMachineCode();
    $('mc').textContent = mc;
  } catch (e) {
    $('mc').textContent = '获取失败';
    status('无法读取机器码：' + e.message, 'err');
    return;
  }

  // 读取本地原始 token（漂移时 loadLicense 会因机器码不符返回 null，必须用 raw）
  let raw = null;
  try { raw = await window.api.getRawToken(); } catch { /* ignore */ }

  if (raw) {
    await showExisting(raw, $('mc').textContent);
  } else {
    showFresh();
  }
}

// 已有本地 token：向服务端查询状态，分别给出 正常 / 漂移 / 过期 / 已解绑 的 UI
async function showExisting(raw, mc) {
  const url = (await window.api.getServerUrl()) + '/api/self/status';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw, machineCode: mc }),
    });
    const d = await r.json();

    if (d.status === 'ok') {
      renderStatus(d);
      status('本机授权正常（如需换设备，可解绑后在新设备重激活）。', 'ok');
      showUnbind('解绑此设备（可转移到新设备）', raw);
    } else if (d.status === 'drift') {
      renderStatus(d);
      status(`检测到机器码已变更（原：${short(d.machineCode)}），需解绑旧设备后在本机重新激活。`, 'err');
      showUnbind('解绑旧设备并重新激活', raw);
    } else if (d.status === 'expired') {
      renderStatus(d);
      status('授权已过期，请重新获取激活码。', 'err');
      showFresh();
    } else if (d.status === 'revoked') {
      status('该设备已解绑，请重新激活。', 'err');
      showFresh();
    } else {
      status('本地授权无效（' + (d.reason || '未知') + '），请重新激活。', 'err');
      showFresh();
    }
  } catch (e) {
    // 连不上服务器也允许本地清理，避免用户卡死
    status('无法连接激活服务器校验（' + e.message + '）。你可先解绑本机本地授权，稍后联网重新激活。', 'err');
    showUnbind('解绑本机本地授权', raw);
  }
}

function renderStatus(d) {
  const el = $('info');
  el.style.display = 'block';
  $('info-plan').textContent = PLAN_LABELS[d.plan] || d.plan || '—';
  $('info-exp').textContent = fmtDate(d.expireAt);
}

function showFresh() {
  $('form').style.display = 'block';
}

// 接线「解绑」按钮：吊销本地那条 token，清本地授权，重载回激活表单
function showUnbind(label, raw) {
  const btn = $('unbind');
  btn.style.display = 'block';
  btn.textContent = label;
  btn.onclick = async () => {
    const url = (await window.api.getServerUrl()) + '/api/self/unbind';
    status('正在解绑…');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: raw }),
      });
      const d = await r.json();
      if (d.ok) {
        await window.api.clearLicense();
        status('已解绑，请重新激活本机或在新设备激活。', 'ok');
        setTimeout(() => location.reload(), 800);
      } else {
        status('解绑失败：' + JSON.stringify(d), 'err');
      }
    } catch (e) {
      status('解绑请求失败：' + e.message, 'err');
    }
  };
}

$('copy').onclick = async () => {
  const mc = $('mc').textContent;
  try {
    await navigator.clipboard.writeText(mc);
    status('机器码已复制');
  } catch {
    status('复制失败，请手动选择复制');
  }
};

$('online').onclick = async () => {
  if (!needApi()) return;
  const mc = $('mc').textContent;
  const plan = $('plan').value;
  const billing = $('billing').value;
  const url = (await window.api.getServerUrl()) + '/api/activate';
  status('正在向激活服务器请求…');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineCode: mc, plan, billing }),
    });
    const d = await r.json();
    if (d.ok) {
      $('token').value = d.token;
      doActivate(d.token);
    } else {
      status('获取激活码失败：' + JSON.stringify(d), 'err');
    }
  } catch (e) {
    status('网络错误，请确认激活服务器可达：' + e.message, 'err');
  }
};

$('activate').onclick = () => {
  if (!needApi()) return;
  const t = $('token').value.trim();
  if (!t) {
    status('请先粘贴激活码，或点「获取并激活」', 'err');
    return;
  }
  doActivate(t);
};

// ===== 客户端收银台：下单 → 渲染二维码 → 轮询 → 自动激活 =====
let pollTimer = null;
let pollStart = 0;
let pollCount = 0;

$('buy').onclick = async () => {
  if (!needApi()) return;
  const mc = $('mc').textContent;
  const plan = $('plan').value;
  const billing = $('billing').value;
  const method = $('method').value;
  status('正在创建订单…');
  $('buy').disabled = true;
  try {
    const url = (await window.api.getServerUrl()) + '/api/checkout';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, billing, machineCode: mc, method, notifyUrl: null }),
    });
    const d = await r.json();
    if (!d.ok) {
      status('创建订单失败：' + JSON.stringify(d), 'err');
      $('buy').disabled = false;
      return;
    }
    showCheckout(d, method);
  } catch (e) {
    status('下单请求失败：' + e.message, 'err');
    $('buy').disabled = false;
  }
};

function showCheckout(d, method) {
  $('form').style.display = 'none';
  const co = $('checkout');
  co.style.display = 'block';
  const methodName = method === 'wechat' ? '微信支付' : (method === 'alipay' ? '支付宝' : method);
  $('co-method').textContent = '请使用' + methodName + '扫码支付';
  $('co-amount').textContent = (d.amount != null) ? '¥' + d.amount + ' ' + (d.currency || 'CNY') : '';
  $('co-order').textContent = '订单号：' + d.outTradeNo;

  if (d.payUrl) {
    renderQR(d.payUrl);
    $('co-payurl').innerHTML = '扫码内容（若扫码失败可复制下方链接手动打开）：<br><code>' + escapeHtml(d.payUrl) + '</code>';
    $('co-refresh').style.display = 'none';
    startPolling(d.outTradeNo);
  } else {
    $('qrcode').innerHTML = '';
    $('co-payurl').innerHTML = '<div style="color:var(--err);font-size:13px;line-height:1.6;">' +
      escapeHtml(d.note || '当前未接入自动支付渠道，已进入人工发卡流程。') + '</div>';
    status('已进入人工发卡流程：完成付款后由管理员发卡，或点「刷新状态」查询是否已发卡。', 'err');
    $('co-refresh').style.display = 'inline-block';
  }
}

function renderQR(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    $('qrcode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
  } catch (e) {
    $('qrcode').innerHTML = '<div style="color:var(--err);font-size:12px;">二维码生成失败，请复制下方链接手动支付。</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startPolling(outTradeNo) {
  stopPolling();
  pollStart = Date.now();
  pollCount = 0;
  status('订单已创建，等待支付…（扫码完成付款后将自动激活）');
  pollTimer = setInterval(async () => {
    pollCount++;
    const waited = Math.round((Date.now() - pollStart) / 1000);
    try {
      const base = await window.api.getServerUrl();
      const r = await fetch(base + '/api/order/' + encodeURIComponent(outTradeNo));
      const d = await r.json();
      if (d.ok && d.order && d.order.status === 'fulfilled' && d.order.token) {
        stopPolling();
        doActivate(d.order.token);
        return;
      }
      // 每 ~10s 主动查询渠道侧状态（webhook 不可达时的兜底）
      if (pollCount % 4 === 0) {
        try {
          await fetch(base + '/api/order/' + encodeURIComponent(outTradeNo) + '/query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
        } catch { /* ignore */ }
      }
      status('等待支付…（已等待 ' + waited + ' 秒）');
    } catch (e) {
      status('查询订单状态失败：' + e.message, 'err');
    }
    // 10 分钟超时，停止自动轮询，提示手动刷新
    if (Date.now() - pollStart > 10 * 60 * 1000) {
      stopPolling();
      status('支付等待超时，可重新打开本页或点「刷新状态」继续查询。', 'err');
      $('co-refresh').style.display = 'inline-block';
    }
  }, 2500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

$('co-refresh').onclick = async () => {
  const outTradeNo = ($('co-order').textContent || '').replace('订单号：', '').trim();
  if (!outTradeNo) return;
  status('正在刷新订单状态…');
  try {
    const base = await window.api.getServerUrl();
    try {
      await fetch(base + '/api/order/' + encodeURIComponent(outTradeNo) + '/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
    } catch { /* ignore */ }
    const r = await fetch(base + '/api/order/' + encodeURIComponent(outTradeNo));
    const d = await r.json();
    if (d.ok && d.order && d.order.status === 'fulfilled' && d.order.token) {
      doActivate(d.order.token);
    } else {
      status('订单尚未完成支付/发卡（状态：' + (d.order ? d.order.status : '未知') + '）。完成付款后请稍候或再次刷新。', 'err');
    }
  } catch (e) {
    status('刷新失败：' + e.message, 'err');
  }
};

async function doActivate(token) {
  status('正在校验激活码…');
  try {
    const r = await window.api.activate(token);
    if (r.ok) {
      status('激活成功，正在进入…', 'ok');
      // 主进程会在成功后把窗口切到主界面，无需本页跳转
    } else {
      status('激活失败：' + (r.reason || '未知错误'), 'err');
    }
  } catch (e) {
    status('激活过程出错：' + e.message, 'err');
  }
}

window.api.onRevoked(() => {
  status('授权已失效，请重新激活', 'err');
});

init();
