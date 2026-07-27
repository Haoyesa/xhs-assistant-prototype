// 激活页逻辑（运行在浏览器上下文，仅通过 window.api 与主进程通信）
const $ = (id) => document.getElementById(id);
const status = (msg, kind) => {
  const s = $('status');
  s.textContent = msg;
  s.className = kind || '';
};

async function init() {
  try {
    const mc = await window.api.getMachineCode();
    $('mc').textContent = mc;
  } catch (e) {
    $('mc').textContent = '获取失败';
    status('无法读取机器码：' + e.message, 'err');
  }
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
