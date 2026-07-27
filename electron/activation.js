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
