// content-creator.js — 在创作者发布台(creator.xiaohongshu.com)注入「发布助手」侧栏
// 收到后端任务后：填标题/正文/话题、注入配图、关联商品，交人工点发布。
// 合规：检测到验证挑战即停下并通知；绝不自动破解、不伪造。
console.log('[黑猫] content-creator.js 已注入', new Date().toISOString());
// 保活 service worker（防止长耗时填表/回报期间 SW 被回收导致 Extension context invalidated）
try { window.XhsCommon && window.XhsCommon.xhsKeepAlive(); } catch (e) {}

// 创作者页加载完成后，主动通知后台「本标签已就绪」请求填充。即便后台 SW 此刻被回收，
// 这条消息也会唤醒 SW 去执行填充——不依赖 onUpdated 事件唤醒（比特浏览器对 SW 回收激进，
// onUpdated 常丢导致新标签永不填充、队列卡死）。配合 background 的 tabReady 处理器。
// 关键改进：原实现是「一次性 fire-and-forget」，若消息发出的瞬间 SW 正处于回收/未唤醒窗口期，
// 消息被丢弃 → 标签永不填充 → 后台永远收不到 → 没有任何日志（即「倒计时结束也没日志」）。
// 现改为「带退避重试，直到后台明确回 ack 才停」：后台收到即执行 fillTab，ack 收到即代表填充已触发。
// 重试幂等：awaitingTabId 在后台处理 tabReady 时即置空，后续重试不会重复填充。
function notifyTabReady() {
  let tries = 0;
  const MAX = 10;
  const attempt = () => {
    tries++;
    try {
      chrome.runtime.sendMessage({ type: 'tabReady' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (!err && resp && resp.ok) {
          console.log('[黑猫] tabReady ack 收到（第 ' + tries + ' 次尝试），后台将触发填充');
          return;
        }
        // SW 未唤醒 / 消息被丢弃 / 后台未 ack：指数退避重试
        if (tries < MAX) {
          const wait = Math.min(8000, 500 * Math.pow(1.7, tries));
          console.warn('[黑猫] tabReady 未送达（第 ' + tries + ' 次，' + (err ? err.message : 'no ack') + '），' + Math.round(wait) + 'ms 后重试');
          setTimeout(attempt, wait);
        } else {
          console.error('[黑猫] tabReady 重试耗尽，标签可能未填充；可手动刷新本页或重点「开始批量发布」');
        }
      });
    } catch (e) {
      if (tries < MAX) setTimeout(attempt, 1000);
      else console.error('[黑猫] tabReady 重试耗尽', e && e.message);
    }
  };
  attempt();
}
if (document.readyState === 'complete') setTimeout(notifyTabReady, 800);
else window.addEventListener('load', () => setTimeout(notifyTabReady, 800));

// ---- 顶部居中悬浮 Toast：捕获 [黑猫] 日志 + 实时状态 ----
// 安装 console.log 包装，把 [黑猫] 日志写入环形缓冲，供右上/顶部 Toast 渲染。
window.__xhsToastLog = window.__xhsToastLog || [];
(function installXhsLogCapture() {
  const _log = console.log.bind(console);
  console.log = function (...args) {
    try {
      const s = args.map((a) => (typeof a === 'string' ? a : (a && a.message) ? a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
      if (/\[XHS\]/.test(s)) {
        window.__xhsToastLog.push(s);
        if (window.__xhsToastLog.length > 80) window.__xhsToastLog.shift();
        if (window.__renderXhsToast) window.__renderXhsToast();
      }
    } catch (e) {}
    return _log.apply(console, args);
  };
})();

// ---- 选择器（多级候选，适配小红书改版）----
// 小红书发布页使用 div[contenteditable="true"] 作为标题/正文输入框，
// placeholder 可能是标准属性、data-placeholder、或 CSS 伪元素，需多级匹配。
const SEL = {
  title: [
    'textarea[placeholder*="标题"]', 'textarea[placeholder*="赞"]',
    'input[placeholder*="标题"]', 'input[placeholder*="赞"]',
    '[contenteditable][placeholder*="标题"]', '[contenteditable][placeholder*="赞"]',
    '[contenteditable][data-placeholder*="标题"]', '[contenteditable][data-placeholder*="赞"]',
    '[role="textbox"][placeholder*="标题"]', '[role="textbox"][placeholder*="赞"]',
    '[role="textbox"][aria-label*="标题"]', '[role="textbox"][aria-label*="赞"]',
    'div[contenteditable="true"][class*="title"]', 'div[contenteditable="true"][class*="Title"]',
  ],
  body: [
    'textarea[placeholder*="正文"]', 'textarea[placeholder*="描述"]', 'textarea[placeholder*="分享"]',
    '[contenteditable][placeholder*="正文"]', '[contenteditable][placeholder*="描述"]', '[contenteditable][placeholder*="分享"]',
    '[contenteditable][data-placeholder*="正文"]', '[contenteditable][data-placeholder*="描述"]', '[contenteditable][data-placeholder*="分享"]',
    '[role="textbox"][placeholder*="正文"]', '[role="textbox"][placeholder*="描述"]',
    '[role="textbox"][aria-label*="正文"]', '[role="textbox"][aria-label*="描述"]',
    'div[contenteditable="true"][class*="content"]', 'div[contenteditable="true"][class*="desc"]',
    'div[contenteditable="true"][class*="Content"]', '.ql-editor', '[class*="content-editor"]',
  ],
  topicInput: [
    'input[placeholder*="话题"]', 'input[placeholder*="搜索"]',
    'input[placeholder*="添加话题"]', 'input[placeholder*="参与话题"]', 'input[placeholder*="参与"]',
    'input[placeholder*="大家都在搜"]', 'input[placeholder*="添加"]',
    '[contenteditable][placeholder*="话题"]', '[role="textbox"][placeholder*="话题"]',
    'div[contenteditable="true"][class*="topic"]', 'div[contenteditable="true"][class*="tag"]',
    'input[class*="topic"]', 'input[class*="Tag"]', 'input[class*="Topic"]',
  ],
  challenge: '[class*="verify"], [class*="captcha"], [class*="slider"], [class*="challenge"]',
  goodsSearch: [
    'input[placeholder*="商品"]', 'input[placeholder*="关联"]', 'input[placeholder*="搜索"]',
    '[role="textbox"][placeholder*="商品"]', '[role="textbox"][placeholder*="关联"]',
  ],
};

function q(sel) { return document.querySelector(sel); }

// 标题长度约束：小红书标题上限约 20 个中文字（全中文）= 40 个半角字符。
// 这里以「显示宽度」计（CJK/全角=2，半角=1），超过上限则从尾部截断，避免超长标题禁用「发布」按钮。
const __CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿！-～｡-ﾟ぀-ヿ]/;
function displayWidthOf(s) {
  let w = 0;
  for (const ch of (s || '')) w += __CJK_RE.test(ch) ? 2 : 1;
  return w;
}
function fitTitle(s, maxWidth = 40) {
  s = (s || '').trim();
  if (displayWidthOf(s) <= maxWidth) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const c = __CJK_RE.test(ch) ? 2 : 1;
    if (w + c > maxWidth) break;
    out += ch; w += c;
  }
  return out;
}

// 让 React 等受控组件同步：execCommand 只改了 DOM 文本，不会触发 React 的 onChange，
// 必须手动派发 input/change 事件，让 React 重新读取 textContent 并同步 state，
// 否则点击发布时小红书读的是空 state，标题/正文会“凭空消失”。
function syncContentEditable(el) {
  try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch (e) {}
  try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
}

// 通用写入：input/textarea 走 setNativeValue（原生 setter+事件）；contenteditable 走 textContent+同步
function writeEditable(el, text) {
  if (!el) return;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    setNativeValue(el, text || '');
  } else {
    el.focus();
    try { document.execCommand('selectAll', false, null); } catch (e) {}
    el.textContent = text || '';
    syncContentEditable(el);
  }
}


// 按选择器列表查找第一个匹配的元素
function qAny(selList) {
  for (const sel of selList) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch {}
  }
  return null;
}

// ---------- 标题/正文/话题输入框定位（适配小红书改版）----------
function visibleEl(el) { return el && el.offsetParent !== null && el.clientHeight > 0 && el.clientWidth > 0; }
function phOf(el) {
  return (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || '').toLowerCase();
}
function allFields() {
  return [...document.querySelectorAll('input, textarea, div[contenteditable="true"], [role="textbox"]')].filter(visibleEl);
}
function kwMatch(el, kws) { const p = phOf(el); return kws.some((k) => p.includes(k)); }

// 等待发布页进入可操作状态：出现上传控件 / 标题 / 正文 / 上传按钮之一即认为已加载。
async function waitForFormReady(timeout = 15000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ready = () => Boolean(findFileInput()) || Boolean(qAny(SEL.title)) || Boolean(qAny(SEL.body))
    || [...document.querySelectorAll('button')].some((b) => /上传图片|添加图片|图文/.test(b.textContent || ''));
  const start = Date.now();
  while (Date.now() - start < timeout) { if (ready()) return true; await sleep(500); }
  return ready();
}

// 定位标题或正文输入框：①placeholder/aria 关键词匹配；②集合推断（body 取最大的多行编辑区，
// title 取排除 body 后的首个单行输入框）。小红书标题框 placeholder 常为「填个好标题会有更多赞哦」之类，
// 未必含「标题」二字，故不能只靠关键词，需按结构推断。传图后表单才渲染，故可等待 timeout ms。
async function locateField(type, timeout = 25000, exclude = null) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTitle = type === 'title';
  const kws = isTitle ? ['标题', '赞', '主题', 'title'] : ['正文', '描述', '分享', '内容', 'body', 'desc'];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = allFields().filter((el) => el !== exclude);
    let hit = f.find((el) => kwMatch(el, kws));
    if (hit) return hit;
    const bodyHit = f.find((el) => kwMatch(el, ['正文', '描述', '分享', '内容', 'body', 'desc']));
    if (isTitle) {
      // title：排除 body 后的第一个单行输入框（input 或单行 textarea），或第一个 contenteditable
      const single = f.filter((el) => el !== bodyHit).find((el) => el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && (el.getAttribute('rows') || '1') === '1'));
      if (single) return single;
      const ce = f.filter((el) => el !== bodyHit && (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox'));
      if (ce.length) return ce[0];
    } else {
      // body：最大的多行编辑区（ProseMirror 通常是页面最大的 contenteditable）
      const ce = f.filter((el) => el !== exclude && (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox'));
      if (ce.length) return ce.slice().sort((a, b) => b.clientHeight - a.clientHeight)[0];
      const ta = f.filter((el) => el.tagName === 'TEXTAREA' && el !== exclude);
      if (ta.length) return ta.slice().sort((a, b) => b.clientHeight - a.clientHeight)[0];
    }
    await sleep(500);
  }
  return null;
}

// 调试：打印当前可见编辑字段，便于定位失败时将真实 DOM 结构反馈
function dumpFields() {
  try {
    return allFields().map((el) => ({ tag: el.tagName, ph: phOf(el).slice(0, 30), cls: (el.getAttribute('class') || '').slice(0, 40), h: el.clientHeight }));
  } catch { return []; }
}

function setNativeValue(el, value) {
  const tag = el.tagName;
  const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : tag === 'INPUT' ? HTMLInputElement.prototype : null;
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!desc || !desc.set) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  desc.set.call(el, value);
  ['focus', 'input', 'change', 'keydown', 'keyup', 'keypress'].forEach((name) => {
    el.dispatchEvent(new Event(name, { bubbles: true }));
  });
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  }
}

// 模拟真人逐字输入：每个字符之间加随机延时 + 偶发停顿，避免被识别为机器批量写入。
// contenteditable（如 ProseMirror 正文）逐字 execCommand('insertText')；input/textarea 逐字原生 setter + input 事件。
// 写入前先清空旧内容，避免两篇笔记叠加/乱码。
async function typeText(el, text, opts = {}) {
  if (!el || !text) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const isEditable = el.contentEditable === 'true' || el.isContentEditable || el.classList.contains('ql-editor') || el.getAttribute('role') === 'textbox';
  const newlineIsParagraph = opts.newlineIsParagraph ?? false; // 正文用：\n 用真实 Enter 键断成段落（ProseMirror 不吃 insertText('\n')）
  const perCharMin = opts.perCharMin ?? 28, perCharMax = opts.perCharMax ?? 68;
  const pauseEvery = opts.pauseEvery ?? 18, pauseMin = opts.pauseMin ?? 130, pauseMax = opts.pauseMax ?? 380;
  const rndType = () => rnd(perCharMin, perCharMax);
  // 清空旧内容
  el.focus(); el.click();
  if (isEditable) {
    try { document.execCommand('selectAll', false, null); } catch (e) {}
    try { document.execCommand('insertText', false, ''); } catch (e) {}
    syncContentEditable(el);
  } else {
    setNativeValue(el, '');
  }
  await sleep(120);
  let i = 0;
  for (const ch of text) {
    if (ch === '\r') continue; // 忽略回车符，只处理 \n
    if (ch === '\n' && isEditable && newlineIsParagraph) {
      // ProseMirror：用完整键盘/输入事件序列创建新段落，insertText('\n') 不会换行
      const evOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', evOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', evOpts));
      try { el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })); } catch (e) {}
      try { el.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true })); } catch (e) {}
      el.dispatchEvent(new KeyboardEvent('keyup', evOpts));
      // 给 ProseMirror 较长时间处理断段，再继续下一字符
      await new Promise((r) => setTimeout(r, 220));
      i++;
      if (i % pauseEvery === 0) await sleep(rnd(pauseMin, pauseMax));
      continue;
    }
    if (isEditable) {
      try { document.execCommand('insertText', false, ch); } catch (e) {}
    } else {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, el.value + ch);
      else el.value = el.value + ch;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    i++;
    await sleep(rndType());
    // 每若干字符来一次「思考停顿」，更像真人
    if (i % pauseEvery === 0) await sleep(rnd(pauseMin, pauseMax));
  }
  if (isEditable) syncContentEditable(el);
  // 验证：若正文包含 \n 且期望分段，但 ProseMirror 没产生段落（实际只有 1 段），用「清空 + 逐 \n 走真 Enter」回炉一次
  if (isEditable && newlineIsParagraph && text) {
    const expected = text.split('\n').length;
    await sleep(200);
    const actual = blockCount(el);
    if (text.includes('\n') && actual < expected) {
      // 回炉：用 insertHTML 把整段正文重排为多个 <p>。ProseMirror 通过 mutation observer 把插入的
      // HTML 解析成真实段落，比合成 Enter 键事件可靠得多（合成 Enter 在本环境常常不生效）。
      console.log('[黑猫] 正文段落不足(', actual, '/', expected, ')，触发回炉：用 insertHTML 重排为真实 <p> 段落');
      try {
        el.focus();
        document.execCommand('selectAll', false, null);
        await sleep(60);
        const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = text.split('\n').map((p) => {
          const c = p.replace(/\r/g, '').trim();
          return c ? `<p>${escHtml(c)}</p>` : '<p><br></p>';
        }).join('');
        const okIns = document.execCommand('insertHTML', false, html);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(350);
        console.log('[黑猫] 正文回炉(insertHTML) 结果=', okIns, '段落数=', blockCount(el));
      } catch (e) {
        console.log('[黑猫] 正文回炉失败:', e.message);
      }
    } else if (!text.includes('\n')) {
      console.log('[黑猫] 正文无 \\n 分段符，按原文填入（如需分段，正文需含换行符）');
    }
  }
}

function clickByText(tag, text) {
  const els = [...document.querySelectorAll(tag)];
  return els.find((e) => (e.textContent || '').includes(text));
}

// 把图片转成 File 注入到 type=file 的上传控件。
function fileNameOf(u) {
  try {
    const rel = new URL(u).searchParams.get('rel');
    if (rel) return decodeURIComponent(rel.split('/').pop()) || 'img.jpg';
  } catch {}
  return decodeURIComponent((u.split('?')[0].split('/').pop()) || 'img.jpg');
}
// 在页面中查找图片上传控件（优先可见的）
function findFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  if (!inputs.length) return null;
  // 小红书笔记图片上传框通常是 accept 含 image 且 multiple 的隐藏 input（覆盖在「上传图片」拖拽区之上）。
  // 优先选「multiple + accept 含 image」的笔记上传框；它即使被视觉隐藏，正是 XHS 监听上传 change 事件的目标。
  const imageInputs = inputs.filter((el) => (el.getAttribute('accept') || '').toLowerCase().includes('image'));
  const cand = imageInputs.length ? imageInputs : inputs;
  const multi = cand.find((el) => el.multiple);
  if (multi) return multi;
  const vis = cand.find((el) => el.offsetParent !== null);
  // 都没命中就用第一个（兜底）
  return vis || cand[0];
}
async function injectImages(urls, serverUrl, fileInput) {
  if (!urls || !urls.length) {
    console.log('[黑猫] injectImages: 任务无图片（images 为空）。图文笔记须至少 1 张图，上传区不渲染则标题/正文框不会出现');
    return { ok: true, skipped: true, noImages: true };
  }
  // 同一任务图片已注入过则跳过（防止重复下发 / 重复执行导致同一张图被加两次）
  const taskId = window.__xhsCurrentTaskId;
  if (taskId && window.__xhsInjected && window.__xhsInjected.has(taskId)) {
    console.log('[黑猫] injectImages: 本任务图片已注入，跳过重复注入');
    return { ok: true, skipped: true, detail: '本任务图片已注入，跳过重复注入' };
  }
  let input = fileInput || findFileInput();
  console.log('[黑猫] injectImages: 初始 fileInput=', input ? (input.tagName + (input.multiple ? '[multiple]' : '') + ' .' + (input.getAttribute('class') || '').slice(0, 30)) : 'null', 'accept=', input ? (input.getAttribute('accept') || '') : '-');
  // 上传区可能尚未渲染：轮询等待 file input 出现（最多 10s）
  if (!input) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) { await sleep(500); input = findFileInput(); if (input) break; }
  }
  if (!input) {
    console.log('[黑猫] injectImages: 未找到图片上传控件（请确认已处在「图文」上传模式，URL 需带 target=image）');
    return { ok: false, detail: '未找到图片上传控件（请确认已处在「图文」上传模式）' };
  }
  console.log('[黑猫] injectImages: 选用上传框=', input.tagName, 'multiple=', input.multiple, 'accept=', input.getAttribute('accept') || '', 'class=', (input.getAttribute('class') || '').slice(0, 40), 'serverUrl=', serverUrl || '-', 'urls=', urls.length);
  const base = (serverUrl || '').replace(/\/+$/, '');
  const files = [];
  const fetchWithTimeout = (u, opts, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(u, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
  };
  for (const u of urls.slice(0, 9)) {
    const isLocalServed = /api\/file/.test(u) || (base && u.startsWith(base));
    const proxied = isLocalServed ? u : (base ? `${base}/api/image?url=${encodeURIComponent(u)}` : u);
    try {
      const r = await fetchWithTimeout(proxied, { mode: 'cors' }, 8000);
      if (!r.ok) { console.log('[黑猫] injectImages: 拉取失败', r.status, String(u).slice(0, 60)); continue; }
      const blob = await r.blob();
      const rawName = fileNameOf(u);
      const ext = (rawName.includes('.') ? rawName.split('.').pop() : 'jpg').slice(0, 8).toLowerCase();
      const name = ((rawName.replace(/\.[^.]+$/, '') || 'img').slice(0, 40)) + '.' + ext;
      files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      console.log('[黑猫] injectImages: 已拉取', files.length, name, blob.size, 'bytes');
    } catch (e) { console.log('[黑猫] injectImages: 拉取异常', String(u).slice(0, 60), e.message); /* 跳过单张失败/超时 */ }
  }
  if (!files.length) {
    console.log('[黑猫] injectImages: 没有任何图片拉取成功（代理/网络/防盗链问题），请手动添加');
    return { ok: false, detail: '图片经代理仍拉取失败，请手动添加' };
  }
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
    if (!desc || !desc.set) {
      input.files = dt.files;
    } else {
      desc.set.call(input, dt.files);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[黑猫] injectImages: 已注入', files.length, '张并触发 change 事件');
    if (taskId) { (window.__xhsInjected = window.__xhsInjected || new Set()).add(taskId); }
    // 注入后验证：轮询等待标题/正文表单出现（XHS 上传成功后才渲染）。最多 20s。
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let appeared = false;
    for (let i = 0; i < 40; i++) {
      const f = allFields();
      if (f.length) { appeared = true; console.log('[黑猫] injectImages: 注入后表单已渲染，可见字段', f.length, '个'); break; }
      await sleep(500);
    }
    if (!appeared) console.log('[黑猫] injectImages: 注入后 20s 表单仍未渲染（上传可能未生效，标题/正文将无法定位）');
    return { ok: true, count: files.length, formAppeared: appeared };
  } catch (e) {
    console.log('[黑猫] injectImages: 注入异常', e.message);
    return { ok: false, detail: '注入失败：' + e.message };
  }
}

// 查找当前最可能的商品选择面板/弹窗根元素。
// 关键：只认「真正的浮层/弹窗」容器，绝不能返回整页 body 或发布页表单（否则会把页面标题/正文、
// 「添加地点」输入框当成商品搜索框）。排序优先级：含商品搜索框 > modal-like > 遮罩层；同档位选
// 「面积最小」的最具体容器，避免误选整页发布表单（整页表单更大，且含标题输入框/正文，必须排除）。
function findGoodsPickerRoot() {
  const markers = ['选择商品', '添加商品', '我店铺内的商品', '关联商品', '选择我店铺内的商品', '商品选择', '我的商品', '请选择商品', '店内商品', '搜索商品ID', '商品ID', '关联'];
  const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
  const vis = [...document.querySelectorAll('body *')].filter((e) => {
    if (e.tagName === 'BODY' || e.tagName === 'HTML') return false;
    return isVisibleEl(e);
  });
  const cand = [];
  for (const e of vis) {
    const txt = (e.textContent || '').replace(/\s+/g, ' ').trim();
    if (!markers.some((m) => txt.includes(m))) continue;
    // 关键排除：发布页「内联商品选择区」(publish-page-content-business / goods-selection-plugin)
    // 只是表单里的一个区块（含「选择我店铺内的商品」空状态），并非弹窗。
    // 只有当它真的含商品搜索框或商品卡(checkbox)时才可能是弹窗，否则一律排除，避免误把它当面板。
    if (e.closest('.publish-page-content-business, .goods-selection-plugin, .publish-page-content, .publish-page, .publish-page-content-business-content')) {
      const hasSearch = e.querySelector('input[placeholder*="商品"], input[placeholder*="搜索"], input[placeholder*="ID"]');
      const hasCard = /商品ID/.test(txt) || e.querySelector('input[type="checkbox"]');
      if (!hasSearch && !hasCard) continue; // 纯空状态区块，排除
    }
    const r = e.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 8000) continue;                  // 太小不可能是面板（排除触发按钮等）
    if (area > vw * vh * 0.98) continue;        // 几乎整页（body 级容器）排除，绝不返回整页
    // 排除整页发布表单：含标题输入框(placeholder 含「标题」)或 ProseMirror 正文 → 这是发布页本身而非商品弹窗
    if (e.querySelector('input[placeholder*="标题"], .tiptap, .ProseMirror, [class*="title"] input, [class*="editor"]')) continue;
    const cs = getComputedStyle(e);
    const isModalLike =
      e.getAttribute('role') === 'dialog'
      || /modal|dialog|mask|Mask|overlay|Overlay|popup|Popup|drawer|Drawer|dialog-wrap|modal-wrap|dialog-container/i.test(e.className || '')
      || cs.position === 'fixed' || cs.position === 'absolute';
    const coversMost = area > vw * vh * 0.55;  // 遮罩层覆盖大半屏
    if (!isModalLike && !coversMost) continue;
    const hasSearch = !!e.querySelector('input[placeholder*="商品"], input[placeholder*="搜索"], input[placeholder*="ID"]');
    const hasCard = /商品ID/.test(txt) || !!e.querySelector('input[type="checkbox"]');
    cand.push({ el: e, area, coversMost, isModalLike, hasSearch, hasCard });
  }
  if (cand.length) {
    // 排序：含搜索框(4) > 含商品卡(2) > modal-like(2) > 遮罩层(1)；同档位选面积最小（最具体的弹窗）
    const rank = (c) => Number(c.hasSearch) * 4 + Number(c.hasCard) * 2 + Number(c.isModalLike) * 2 + Number(c.coversMost) * 1;
    cand.sort((a, b) => (rank(b) - rank(a)) || (a.area - b.area));
    const root = cand[0].el;
    console.log('[黑猫] 商品面板容器:', root.tagName, '.', (root.className || '').slice(0, 24), 'coversMost=', cand[0].coversMost, 'area=', Math.round(cand[0].area), 'modalLike=', cand[0].isModalLike, 'hasSearch=', cand[0].hasSearch);
    return root;
  }
  // 兜底：含商品搜索框的最小容器（即便无 marker 文案，只要里面是商品搜索框就一定是弹窗）
  const bySearch = vis.filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width * r.height > 8000 && e.querySelector('input[placeholder*="商品"], input[placeholder*="搜索"], input[placeholder*="ID"]');
  }).sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  if (bySearch[0]) { console.log('[黑猫] 商品面板容器(搜索框兜底):', bySearch[0].tagName, '.', (bySearch[0].className || '').slice(0, 24)); return bySearch[0]; }
  return null;
}
// 全文档查找「商品搜索框」：placeholder / aria-label 命中商品搜索特征。即使面板定位不准，也能以此锚定真正的弹窗。
function findGoodsSearchInput() {
  const SEARCH_PH_RE = /搜索.*商品|搜索.*ID|商品.*ID|商品.*名称|搜索.*名称|搜索商品|search.*product|search.*goods/i;
  const cands = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')]
    .filter(isVisibleEl)
    .filter((e) => {
      if (e.tagName === 'INPUT') {
        const t = (e.type || 'text').toLowerCase();
        if (['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'file'].includes(t)) return false;
      }
      const ph = ((e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
      return SEARCH_PH_RE.test(ph) || /商品/.test(ph);
    });
  return cands[0] || null;
}
// 全文档查找「关联商品」弹窗确认按钮（保存/确定/完成/确认/选好了）。
// 该弹窗「保存」按钮常在独立 footer portal，未必在 picker(=closestModal(searchInput)) 子树内，
// 故用「全文档 + 限定弹窗内」最稳妥；并排除「保存草稿」等页面按钮。
function findGoodsConfirmBtn() {
  const NEG = /添加组件|添加模块|插入|插入组件|草稿|存草稿/;
  const isInsideModal = (el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      const cs = getComputedStyle(cur);
      const cls = (cur.className || '');
      if ((cur.getAttribute && cur.getAttribute('role') === 'dialog')
          || /modal|dialog|mask|overlay|popup|drawer|panel/i.test(cls)
          || cs.position === 'fixed' || cs.position === 'absolute') return true;
      cur = cur.parentElement;
    }
    return false;
  };
  const cands = [...document.querySelectorAll('button, [role="button"]')].filter(isVisibleEl);
  const txt = (x) => (x.textContent || '').trim();
  const pool = cands.filter((x) => {
    const t = txt(x);
    if (NEG.test(t)) return false;
    if (!/保存|确定|完成|确认|选好了/.test(t)) return false;
    return isInsideModal(x);
  });
  // 优先精确「保存/确定/完成/确认/选好了」，其次含关键字且较短（兼容「保存(1)」「保存选中的商品」）
  const exact = pool.find((x) => /^(保存|确定|完成|确认|选好了)$/.test(txt(x)));
  if (exact) return exact;
  const near = pool.find((x) => txt(x).length <= 8);
  return near || null;
}
// 从搜索框 / 任意元素向上找最近的「弹窗根」（modal-like 且面积足够），用于界定面板范围
function closestModal(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    const cs = getComputedStyle(cur);
    const cls = (cur.className || '');
    const modalClass = /modal|dialog|mask|Mask|overlay|Overlay|popup|Popup|drawer|Drawer|panel|Panel|dialog-wrap|modal-wrap|dialog-container/i.test(cls);
    if (cur.getAttribute('role') === 'dialog' || modalClass || cs.position === 'fixed' || cs.position === 'absolute') {
      const r = cur.getBoundingClientRect();
      if (r.width * r.height > 20000) return cur;
    }
    cur = cur.parentElement;
  }
  // 找不到严格弹窗则退而求其次：向上找到含「保存/确定」按钮或商品 checkbox 的最近祖先
  let p = el.parentElement;
  while (p && p !== document.body) {
    if (p.querySelector('input[type="checkbox"], button')) return p;
    p = p.parentElement;
  }
  return el;
}
// 关闭商品选择面板：优先 Esc，再点遮罩/空白处，再找「取消/关闭/X」按钮
async function closeGoodsPicker(status) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = () => {
    const ae = document.activeElement;
    if (ae && ae !== document.body) {
      ae.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      ae.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  };
  // 弹窗「是否仍打开」以「商品搜索框是否可见」为准——搜索框消失即弹窗已关，避免把发布页内联空状态误判为打开
  const isOpen = () => !!findGoodsSearchInput();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!isOpen()) break;
    esc();
    await sleep(350);
    if (!isOpen()) break;
    // 关闭按钮：取消/关闭/返回/收起/×/X，或 class 含 close/cancel/modal-close
    const picker = findGoodsPickerRoot();
    const scope = picker || document;
    const rawBtns = [...scope.querySelectorAll('button, [role="button"], div, span, i, svg, a')].filter((b) => {
      if (!isVisibleEl(b)) return false;
      const t = (b.textContent || '').trim();
      // 关闭按钮 = × / 取消 / 关闭 / 返回 / 收起 / 暂不 / 以后再说 / 含 close|cancel class。
      // 注意：绝不包含「保存/确定/确认/选好了」——它们是确认动作，点击不会关闭面板（反而可能在 0 选中时 disabled 卡住）。
      return /^[×X✕]$/.test(t)
        || (/取消|关闭|暂不|以后再说|返回|收起/.test(t) && t.length <= 6)
        || (b.getAttribute && /close|cancel|modal-close|dialog-close/i.test(b.getAttribute('class') || ''));
    });
    // 优先 × ，其次 取消/关闭/返回/收起
    const rank = (b) => { const t = (b.textContent || '').trim(); if (/^[×X✕]$/.test(t)) return 0; if (/取消|关闭|返回|收起|暂不|以后再说/.test(t)) return 1; return 2; };
    const closeBtns = rawBtns.sort((a, b) => rank(a) - rank(b));
    if (closeBtns[0]) { try { closeBtns[0].click(); } catch (e) {} await sleep(400); }
    if (!isOpen()) break;
    // 遮罩点击：在四个角落附近点击，尝试命中面板外遮罩
    if (picker) {
      const r = picker.getBoundingClientRect();
      const pts = [[6, 6], [r.right - 6, 6], [6, r.bottom - 6], [r.right - 6, r.bottom - 6], [r.left + 3, r.top + 3]];
      for (const [x, y] of pts) {
        ['mousedown', 'mouseup', 'click'].forEach((type) => {
          const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
          (picker.ownerDocument || document).dispatchEvent(ev);
        });
        await sleep(150);
        if (!isOpen()) break;
      }
    }
    await sleep(200);
  }
  if (isOpen()) console.log('[黑猫] 商品面板仍未关闭（请手动关闭或把面板按钮文字发我）');
  else console.log('[黑猫] 商品面板已关闭');
  status && status('已关闭商品选择面板，继续发布');
}

async function associateGoods(product) {
  const status = (window.__xhsHelper?.status) || (() => {});
  if (!product) return { ok: true, skipped: true };
  const name = product.productName || '';
  const itemId = product.itemId || '';
  if (!name && !itemId) return { ok: true, skipped: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 先把页面滚到底部：关联商品入口在「内容设置/更多设置」底部，不滚动可能点到错误元素或面板错位（用户反馈的关键点）
  try { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); } catch (e) { try { window.scrollTo(0, document.body.scrollHeight); } catch (e2) {} }
  await sleep(400);
  // 1) 点「关联商品 / 添加商品」入口按钮（用户实锤 DOM：.multi-good-select-empty-btn > button）
  // 关键：必须点真正的 <button>，不能点内部 <span>（之前误点 span 导致弹窗根本没开）。
  const findTrigger = () => {
    // 优先：商品选择插件内的「添加商品」按钮（最精确，避免误点页面其它「添加xx」）
    let btn = document.querySelector('.multi-good-select-empty-btn button')
      || document.querySelector('.goods-selection-plugin button');
    if (!btn) {
      // 退而求其次：任意可见 button 其文本为「添加商品」
      btn = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
        if (!isVisibleEl(b)) return false;
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
        return t === '添加商品' || (t.includes('添加商品') && b.tagName === 'BUTTON');
      });
    }
    if (!btn) {
      // 再退：含「添加商品/关联商品」文本且自身无子元素的可点击元素，取其最近 button
      const el = [...document.querySelectorAll('div, span, a, label')].find((e) => {
        if (!isVisibleEl(e)) return false;
        const t = (e.textContent || '').trim();
        return (t === '添加商品' || t === '关联商品') && e.children.length === 0;
      });
      btn = el ? (el.closest('button') || el) : null;
    }
    return btn;
  };
  let trigger = findTrigger();
  if (trigger) {
    // 重试最多 3 次：每次点击后轮询是否弹出带「商品搜索框」的弹窗；未弹出再点（兼容首次点击仅聚焦/展开的情况）
    for (let attempt = 0; attempt < 3; attempt++) {
      try { trigger.scrollIntoView({ block: 'center' }); } catch (e) {}
      await sleep(300);
      console.log('[黑猫] 点击关联商品入口:', (trigger.textContent || '').trim().slice(0, 12), '(尝试', attempt + 1, ')');
      try { trigger.click(); } catch (e) {}
      // 补一次真实鼠标事件，确保 React 合成事件稳定触发
      try {
        const rr = trigger.getBoundingClientRect();
        const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
        ['mousedown', 'mouseup', 'click'].forEach((type) => trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })));
      } catch (e) {}
      await sleep(1600);
      if (findGoodsSearchInput()) break;   // 弹窗已开（搜索框出现）即停
      trigger = findTrigger();             // 否则重新定位（DOM 可能重渲染）
    }
    if (!findGoodsSearchInput()) console.log('[黑猫] 已点击添加商品，但弹窗未出现（搜索框未定位）');
  } else {
    console.log('[黑猫] 未找到「关联商品」入口按钮');
  }
  // 2) 找商品选择面板，并在面板内定位搜索框
  let picker = findGoodsPickerRoot();
  let input = null;
  // 先锁定已知页面输入框（标题/正文/话题），用于后面排除
  const knownPageInputs = new Set();
  [qAny(SEL.title), qAny(SEL.body), qAny(SEL.topicInput)].forEach((el) => el && knownPageInputs.add(el));
  const SEARCH_PH_RE = /搜索.*商品|搜索.*ID|商品.*ID|商品.*名称|搜索.*名称|^搜索$|search.*product|search.*goods/i;
  // 排除 checkbox/radio/hidden/submit/button 等不可输入文本的 input（关键：商品卡前有 checkbox，会污染搜索框判定）
  const isRealTextInput = (e) => {
    if (e.tagName === 'INPUT') {
      const t = (e.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'file') return false;
    }
    return true;
  };
  const realTextInputs = (scope) => [...(scope || document).querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')].filter(isVisibleEl).filter(isRealTextInput);
  const isGoodsSearchInput = (e) => {
    if (!isRealTextInput(e)) return false;
    const p = ((e.placeholder || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
    return SEARCH_PH_RE.test(p);
  };
  // 多轮探测：优先用「商品搜索框 placeholder」在全文档锚定真正的弹窗；再退而用 findGoodsPickerRoot 定位面板。
  // 每轮都重新探测，避免早期误锁到整页表单里的输入框而错过真正弹窗。
  for (let i = 0; i < 20; i++) {
    // 1) 直接全文档找商品搜索框（最可靠锚点）：命中即得到真正的弹窗搜索框与所属面板
    const sIn = findGoodsSearchInput();
    if (sIn) {
      input = sIn;
      picker = closestModal(sIn);
      console.log('[黑猫] 命中商品搜索框(全文档):', input.tagName, 'ph=', (input.placeholder || input.getAttribute('aria-label') || '').slice(0, 16), '｜目标 itemId=', itemId.slice(0, 12));
      break;
    }
    // 2) 用面板根定位（已排除整页表单、优先 modal-like 最小容器）
    picker = picker || findGoodsPickerRoot();
    if (picker) {
      const allInPicker = [...picker.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')].filter(isVisibleEl);
      const inPicker = allInPicker.filter(isRealTextInput);
      if (i === 0) {
        const cbCount = allInPicker.filter((e) => e.tagName === 'INPUT' && (e.type || '').toLowerCase() === 'checkbox').length;
        console.log('[黑猫] 面板内输入框总数=', allInPicker.length, '其中checkbox=', cbCount, '文本类=', inPicker.length,
          JSON.stringify(inPicker.map((e) => `${e.tagName}.${(e.className || '').slice(0, 14)}|type=${(e.type || '').slice(0, 8)}|ph=${(e.placeholder || '').slice(0, 14)}`)));
      }
      input = inPicker.find(isGoodsSearchInput)
        || inPicker.find((e) => !knownPageInputs.has(e) && e.tagName === 'INPUT')
        || inPicker.find((e) => !knownPageInputs.has(e));
      if (!input) {
        const searchIcon = [...picker.querySelectorAll('svg, i, [class*="search"], [class*="Search"], div, span')].find((e) => {
          if (!isVisibleEl(e)) return false;
          return /search|Search|搜索|放大镜/.test(e.getAttribute('class') || '') || /搜索/.test((e.textContent || '').trim());
        });
        if (searchIcon) { try { searchIcon.click(); } catch (e) {} await sleep(600); }
      }
    }
    // 3) 仍无输入框且面板也未定位到：重试点击「添加商品」入口（弹窗可能需重复触发）
    if (!input && !picker && (i === 5 || i === 12) && trigger) {
      try { trigger.click(); } catch (e) {}
      console.log('[黑猫] 重试点击关联商品入口:', (trigger.textContent || '').trim().slice(0, 12));
      await sleep(900);
    }
    if (input) break;
    await sleep(400);
  }
  if (!input) {
    // 兜底：全文档找一个匹配商品搜索 placeholder 或不在已知页面字段内的输入框
    const all = realTextInputs(document);
    input = findGoodsSearchInput()
      || all.find(isGoodsSearchInput)
      || all.find((e) => !knownPageInputs.has(e) && e.tagName === 'INPUT');
  }
  if (!input) {
    const visInputs = realTextInputs(document).map((e) => `${e.tagName}.${(e.className || '').slice(0, 16)}|type=${(e.type || '').slice(0, 8)}|ph=${(e.placeholder || e.getAttribute('aria-label') || '').slice(0, 12)}`);
    console.log('[黑猫] 关联商品：未找到搜索框；文本类输入框=', JSON.stringify(visInputs));
    await closeGoodsPicker(status);
    return { ok: false, detail: '未找到关联商品搜索框' };
  }
  console.log('[黑猫] 关联商品搜索框:', input.tagName, 'ph=', (input.placeholder || input.getAttribute('aria-label') || '').slice(0, 16), '｜目标 itemId=', itemId.slice(0, 12));
// ---- 检索策略（截图实锤：搜索框 placeholder「搜索商品ID 或 商品名称」+ 商品卡显示「商品ID: xxx」）----
  const cjkSeg = (name || '').replace(/[^\u4e00-\u9fa5]/g, '');
  const nameHint = cjkSeg.length >= 4 ? cjkSeg.slice(0, Math.min(8, cjkSeg.length)) : (name || '').slice(0, 8);
  const TAB_RE = /普通商品|高求购品|店内爆品|最新上架|热门搜索|潜力热卖|首页|暂无商品|没有找到|加载中|请稍后|去上架|选择商品|全部商品|返回/;
  // 命中判断：卡片文本/html 含 itemId（卡上显示「商品ID: xxx」），或含 nameHint
  const hitById = (e) => {
    if (!itemId) return false;
    const t = (e.textContent || '');
    const h = (e.outerHTML || '').toLowerCase();
    return t.includes(itemId) || h.includes(itemId.toLowerCase());
  };
  // 给候选打分：itemId 命中最高分；商品名命中次之；含图/价格更像商品卡；命中标签/页头负分
  function scoreItem(el) {
    let s = 0;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (hitById(el)) s += 200;
    if (nameHint && t.includes(nameHint)) s += 60;
    if (cjkSeg && t.includes(cjkSeg.slice(0, 6))) s += 30;
    if (el.querySelector('img')) s += 20;
    if (/[¥￥]\s*\d/.test(t)) s += 10;
    if (TAB_RE.test(t)) s -= 200;
    return s;
  }
  // 检索词优先级：itemId（搜索框支持按 ID 检索，最精确）→ 商品名片段（长→短）→ 全名
  const frag = cjkSeg.length >= 2 ? cjkSeg : (name || '');
  const terms = [];
  if (itemId) terms.push(itemId);
  if (frag) {
    const lens = [...new Set([Math.min(10, frag.length), 8, 6, 4].filter((n) => n <= frag.length && n >= 2))];
    for (const n of lens) { const seg = frag.slice(0, n); if (!terms.includes(seg)) terms.push(seg); }
  }
  if (name && !terms.includes(name)) terms.push(name);
  let picked = null, pickedTerm = '', pickWhy = '';
  let searchTriggeredEver = false;
  const phOf = (el) => (el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('aria-label'))) || el.placeholder || '';
  const typeIntoSearch = async (el, value) => {
    try { el.click(); } catch (e) {}
    el.focus();
    await sleep(150);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') setNativeValue(el, '');
    else { try { document.execCommand('selectAll', false, null); } catch (e) {} try { document.execCommand('insertText', false, ''); } catch (e) {} }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') setNativeValue(el, value);
    else { try { document.execCommand('insertText', false, value); } catch (e) {} }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    const cur = (el.value !== undefined ? el.value : (el.textContent || '')).slice(0, 30);
    // 回读不一致则补一次逐字键入，确保受控组件真正收到输入
    if (cur.replace(/\s/g, '') !== String(value).replace(/\s/g, '').slice(0, 30)) {
      for (const ch of String(value)) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
        try { document.execCommand('insertText', false, ch); } catch (e) {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await sleep(12);
      }
    }
    console.log('[黑猫] 关联商品检索框已写入:', (el.value !== undefined ? el.value : (el.textContent || '')).slice(0, 24), '（目标=', String(value).slice(0, 16), '）');
    return true;
  };
  // 在 picker 面板内收集「真实商品卡」：带图或含价格/销量，排除标签/页头/导航与列表容器本身
  const itemSel = '[role="option"], li, [class*="goods-item"], [class*="goodsItem"], [class*="product-item"], [class*="productItem"], [class*="sku-item"], [class*="skuItem"], [class*="item"], [class*="card"], [class*="Card"], [class*="row"], [class*="option"], [class*="cell"], [class*="Cell"]';
  function collectProductCards() {
    const scope = picker || document;
    let items = [...scope.querySelectorAll(itemSel)].filter((e) => {
      if (!isVisibleEl(e)) return false;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 200) return false;
      if (TAB_RE.test(t)) return false;
      const looksProduct = e.querySelector('img') || /[¥￥]\s*\d/.test(t) || /销量|库存|已售|已售卖|￥|¥/.test(t);
      if (!looksProduct) return false;
      const childCands = e.querySelectorAll(itemSel).length;
      if (childCands > 2) return false;
      return true;
    });
    if (!items.length) {
      items = [...scope.querySelectorAll('*')].filter((e) => {
        if (!isVisibleEl(e)) return false;
        if (e.children.length > 4) return false;
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 2 || t.length > 120) return false;
        if (TAB_RE.test(t)) return false;
        return e.querySelector('img') && (e.tagName === 'DIV' || e.tagName === 'LI' || e.getAttribute('role') === 'option');
      });
    }
    return items;
  }
  const sigOf = () => collectProductCards().map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)).join('‖');

  // —— 探测真正的商品搜索框：把面板内每个文本输入框都试一遍，写入 itemId 看候选是否随写随变 ——
  if (input) {
    const probeCands = realTextInputs(picker).filter((e) => !knownPageInputs.has(e));
    console.log('[黑猫] 探测候选输入框数=', probeCands.length,
      JSON.stringify(probeCands.map((e) => `${e.tagName}.${(e.className || '').slice(0, 16)}|type=${(e.type || '').slice(0, 8)}|ph=${(phOf(e) || '').slice(0, 12)}`)));
    const base = sigOf();
    let found = null;
    for (const el of probeCands) {
      await typeIntoSearch(el, itemId);
      await sleep(1400);
      const sig = sigOf();
      await typeIntoSearch(el, '');
      await sleep(300);
      const changed = sig !== base;
      console.log('[黑猫] 探测输入框', `${el.tagName}.${(el.className || '').slice(0, 14)}|ph=${(phOf(el) || '').slice(0, 12)}`, '候选变化=', changed);
      if (changed) { found = el; console.log('[黑猫] 命中搜索框(写入后候选变化):', `${el.tagName}.${(el.className || '').slice(0, 18)}|ph=${(phOf(el) || '').slice(0, 16)}`); break; }
    }
    if (found) input = found;
    else console.log('[黑猫] 未探测到随写随变的搜索框，沿用首个输入框');
  }

  // 记录默认候选基线（面板刚打开时的店铺商品列表），用于判断搜索���否真的触发
  const baselineSig = sigOf();
  console.log('[黑猫] 默认候选基线样本=', JSON.stringify(collectProductCards().slice(0, 4).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16) + (e.querySelector('img') ? '[图]' : ''))));

  for (const term of terms) {
    await typeIntoSearch(input, term);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await sleep(300);
    // 轮询：等到候选「相对基线变化」（说明搜索触发了），或明确「无结果」
    let items = [];
    let triggered = false, noResult = false;
    for (let w = 0; w < 18; w++) {
      await sleep(500);
      const list = collectProductCards();
      const sig = list.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)).join('‖');
      if (w >= 2 && sig !== baselineSig) triggered = true;
      // 命中：itemId 检索时优先 hitById（卡上显示「商品ID: xxx」可精确匹配）；名称检索时按「含 term 或 hitById」
      const hit = term === itemId
        ? list.find((e) => hitById(e) && !TAB_RE.test(e.textContent || ''))
        : list.find((e) => ((e.textContent || '').includes(term) || hitById(e)) && scoreItem(e) > 0 && !TAB_RE.test(e.textContent || ''));
      if (hit) { items = [hit]; triggered = true; break; }
      const bodyTxt = (document.body.innerText || '').replace(/\s+/g, '');
      if (w >= 3 && /没有找到|无相关商品|暂无商品|没有匹配|未找到相关|暂无相关|没有搜到/.test(bodyTxt)) { noResult = true; triggered = true; break; }
      if (list.length) items = list;
    }
    if (triggered) searchTriggeredEver = true;
    if (noResult) { console.log('[黑猫] 关联商品检索词无结果，换下一词:', term.slice(0, 16)); continue; }
    if (!items.length) { console.log('[黑猫] 关联商品检索词:', term.slice(0, 16), '→ 面板内无商品卡（换下一检索词）'); continue; }
    console.log('[黑猫] 关联商品检索词:', term.slice(0, 16), '→ 候选数=', items.length,
      '样本=', JSON.stringify(items.slice(0, 6).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) + (e.querySelector('img') ? '[图]' : ''))));
    // 命中：卡片文本包含检索词或 itemId（卡上显示「商品ID: xxx」可强校验）
    const byMatch = items.find((e) => ((e.textContent || '').includes(term) || hitById(e)) && !TAB_RE.test(e.textContent || ''));
    if (byMatch) { picked = byMatch; pickedTerm = term; pickWhy = hitById(byMatch) ? '命中商品ID' : '命中商品名'; console.log('[黑猫] 关联商品命中:', (byMatch.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), '（方式=', pickWhy, '）'); break; }
    console.log('[黑猫] 关联商品检索词未命中正确商品，换下一词:', term.slice(0, 16));
  }
  // 兜底：若任一检索词触发了搜索但都没匹配到，再在「触发后的结果」里按名称/itemId 强匹配；仍无则不强选默认项
  if (!picked && searchTriggeredEver) {
    const shop = collectProductCards();
    const byName = shop.slice().sort((a, b) => scoreItem(b) - scoreItem(a))
      .find((e) => scoreItem(e) > 0 && !TAB_RE.test(e.textContent || '') && ((e.textContent || '').includes(nameHint) || hitById(e)));
    if (byName) { picked = byName; pickedTerm = '(搜索结果名/ID匹配)'; pickWhy = hitById(byName) ? '搜索结果命中商品ID' : '搜索结果名匹配'; console.log('[黑猫] 在搜索结果中命中:', (byName.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), '（方式=', pickWhy, '）'); }
    else console.log('[黑猫] 兜底：搜索已触发但无与「' + nameHint + '」/itemId 匹配者，不强选默认项');
  } else if (!picked) {
    console.log('[黑猫] 关联商品：搜索似乎未触发（输入框可能不对），不强选默认项');
  }
  if (picked) {
    const card = picked;
    const scope = picker || document;
    // 截图实锤：选中方式 = 勾选商品卡前的 checkbox（小红书该面板是「多选 + 保存」模式；0 选中时「保存」按钮 disabled，所以面板一直没关、发布一直被卡）
    const checkbox = card.querySelector('input[type="checkbox"]')
      || (card.parentElement ? card.parentElement.querySelector('input[type="checkbox"]') : null);
    if (checkbox) {
      try {
        const proto = HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
        desc && desc.set ? desc.set.call(checkbox, true) : (checkbox.checked = true);
      } catch (e) { try { checkbox.checked = true; } catch (e2) {} }
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      try { checkbox.click(); } catch (e) {}
      console.log('[黑猫] 勾选商品checkbox');
    } else {
      console.log('[黑猫] 未找到商品checkbox，改为点卡片本体');
      try { card.click(); } catch (e) {}
    }
    // 兜底再点一下整行（部分面板是点行选中）
    try { card.click(); } catch (e) {}
    await sleep(700);
    // 确认按钮：优先「保存」（截图实锤），其次 确定/完成/确认/选好了。
    // 该弹窗「保存」按钮常在独立 footer portal，未必在 picker 子树内 → 用全文档 + 限定弹窗的 findGoodsConfirmBtn()。
    let okBtn = findGoodsConfirmBtn();
    if (okBtn) {
      const isDisabled = okBtn.disabled || okBtn.getAttribute('aria-disabled') === 'true'
        || /disabled|is-disabled/.test((okBtn.getAttribute('class') || '') + ' ' + (okBtn.getAttribute('disabled') || ''));
      if (isDisabled && checkbox) { try { checkbox.click(); } catch (e) {} await sleep(500); }
      try { okBtn.click(); } catch (e) {}
      console.log('[黑猫] 点击关联商品确认按钮:', (okBtn.textContent || '').trim().slice(0, 8), isDisabled ? '（disabled，已重勾后点击）' : '');
      await sleep(700);
      // 校验面板是否关闭（保存后应自动关闭）；未关则再勾一次 + 再点一次保存
      if (findGoodsSearchInput()) {
        console.log('[黑猫] 保存后面板仍在，重试勾选+点击确认');
        if (checkbox) { try { checkbox.click(); } catch (e) {} await sleep(300); }
        try { okBtn.click(); } catch (e) {}
        await sleep(600);
      }
    } else {
      console.log('[黑猫] 未找到关联商品确认按钮（依赖面板自动关闭）');
    }
    const cardTxt = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const cardItemId = (card.textContent || '').match(/商品ID[:：\s]*([0-9a-f]{20,})/i)?.[1] || '';
    console.log('[黑猫] 已选择关联商品:', cardTxt, '商品ID=', cardItemId || '(未解析)', '（方式=', pickWhy || '', '）');
    status('✓ 已关联商品：' + cardTxt.slice(0, 16));
    await closeGoodsPicker(status);
    return { ok: true };
  }
  status('⚠ 关联商品：未匹配到商品，已关闭面板继续发布');
  console.log('[黑猫] 关联商品：未匹配到商品（不强行选默认项），关闭面板');
  await closeGoodsPicker(status);
  return { ok: false, detail: '未匹配到商品' };
}

// 话题不足时兜底派生：从商品名/标题抽取核心词组合，保证兜底话题也「与内容相关」（绝不用通用种草词）
function deriveTopics(task, have, need) {
  const set = new Set(have.map((s) => s.replace(/^#+/, '').replace(/#+$/, '').toLowerCase()));
  const name = String(task?.product?.productName || task?.title || '').trim();
  const cand = [];
  const add = (s) => {
    s = String(s || '').replace(/^#+/, '').replace(/#+$/, '').trim();
    if (s && s.length <= 8 && !set.has(s.toLowerCase())) { cand.push(s); set.add(s.toLowerCase()); }
  };
  // 抽取 CJK 核心词（去掉常见通用后缀），再组合出相关话题
  const cjk = (name.match(/[一-鿿]+/g) || []).join('');
  const strip = /(文化墙|服务中心|中心|设计|素材|模板|课件|图片|照片|实拍|ppt|PPT|分享|好物|种草|小红书|笔记|推荐|必备)+/g;
  const core = cjk.replace(strip, '') || cjk;
  if (core) add(core.slice(0, 6));
  const mods = ['文化墙', '设计', '素材', '布置', '实拍', '灵感'];
  for (const m of mods) { if (core) add(core.slice(0, 4) + m); }
  // 再按常见分隔把商品名切成若干片段作为话题候选
  for (const seg of cjk.split(/(文化墙|服务中心|中心|设计|素材|模板|课件|图片|走廊|大厅|护士站|医院|医疗)/).filter((x) => x && x.length >= 2 && x.length <= 6)) {
    add(seg);
  }
  // 实在不足才用极少量通用词兜底
  for (const s of ['好物分享', '种草']) { if (cand.length >= need) break; add(s); }
  return cand.slice(0, Math.max(0, need - have.length));
}

// 把光标移到可编辑元素末尾
function caretToEnd(el) {
  try {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}
}
// 估算正文「块」数量（用于判断空行/分段是否真的插入成功）
function blockCount(el) {
  const kids = [...el.children].filter((c) => /^(P|DIV|BR|LI|H[1-6]|SECTION|ARTICLE)$/.test(c.tagName));
  if (kids.length >= 2) return kids.length;
  if (kids.length === 1) {
    const brs = kids[0].querySelectorAll('br').length;
    if (brs > 0) return brs + 1;
  }
  const plain = (el.textContent || '').split(/\n/).length;
  return Math.max(plain, kids.length || 1);
}
// 在正文末尾插入一个「空行」，让话题落在其下方（可见的换行间隔）。
// 方式：caret 移到正文末尾 → 连续两次真实 Enter（ProseMirror 靠 keydown 处理换行）：
//   第一次 Enter 产生一个空段落（即空白行），第二次 Enter 再产生一个空段落并把光标移入（话题将写在这里）。
// 若两次 Enter 仍未新增块，再退用 execCommand('insertParagraph') 兜底。
async function insertBlankParagraph(el) {
  try {
    el.focus();
    await new Promise((r) => setTimeout(r, 120));
    caretToEnd(el);
    await new Promise((r) => setTimeout(r, 160));
    const before = blockCount(el);
    const pressEnter = () => {
      const evOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', evOpts));
      el.dispatchEvent(new KeyboardEvent('keypress', evOpts));
      try { el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true })); } catch (e) {}
      try { el.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true })); } catch (e) {}
      el.dispatchEvent(new KeyboardEvent('keyup', evOpts));
    };
    pressEnter(); await new Promise((r) => setTimeout(r, 200));
    pressEnter(); await new Promise((r) => setTimeout(r, 200)); // 两次回车：上方留空行，话题落在第二个空段
    if (blockCount(el) <= before) {
      // 兜底 execCommand
      try { document.execCommand('insertParagraph', false, null); } catch (e) {}
      await new Promise((r) => setTimeout(r, 180));
      try { document.execCommand('insertParagraph', false, null); } catch (e) {}
      await new Promise((r) => setTimeout(r, 180));
    }
    console.log('[黑猫] 正文块数(空行前后):', before, '→', blockCount(el), '（应在话题上方出现一个空段落）');
  } catch (e) {}
}

// 填话题（适配新平台：话题是「话题」按钮，不能直接键盘输入 #）。
// 流程：聚焦正文 → 点「话题」按钮（平台插入 # 并弹出搜索下拉）→ 逐字输入关键词 → 等下拉 → 点第一个建议变蓝 chip。
// 默认补齐到 6 个话题，并在话题与正文之间留一个空行。
async function injectTopics(task, humanTyping, status, bodyEl) {
  let topics = Array.isArray(task.topics) ? task.topics.slice() : [];
  topics = topics.map((s) => String(s || '').replace(/^#+/, '').replace(/#+$/, '').trim()).filter(Boolean);
  // 默认 6 个话题：不足则派生补齐
  const NEED = 6;
  if (topics.length < NEED) {
    const extra = deriveTopics(task, topics, NEED);
    topics = topics.concat(extra);
  }
  if (!topics.length) return { ok: true, skipped: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  let added = 0;

  // 正文编辑器（话题会作为内联 chip 插入正文），优先用 fillTask 已定位到的真实 body，
  // 否则回退到选择器查找。ProseMirror 的正文 class 是 tiptap ProseMirror，不匹配 SEL.body，故必须靠传入。
  if (!bodyEl) bodyEl = qAny(SEL.body);

  // 找「话题」按钮（新平台话题=按钮；可能文字为「话题」或 # / ＃）
  function findTopicButton() {
    const els = [...document.querySelectorAll('button, [role="button"], [class*="toolbar"] *, [class*="toolbar-item"], [class*="editor-bar"] *, [class*="bar"] *')];
    return els.find((e) => {
      if (!isVisibleEl(e)) return false;
      const t = (e.textContent || '').trim();
      if (t === '话题' || t === '＃' || t === '#') return true;
      return /话题/.test(t) && e.children.length === 0;
    }) || null;
  }
  // 话题模式激活后，输入框可能是聚焦中的正文编辑器，也可能是独立搜索框
  function findTopicInput() {
    const active = document.activeElement;
    if (active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.getAttribute('role') === 'textbox')) return active;
    return qAny(SEL.topicInput);
  }
  async function waitSuggestion(timeout = 4500) {
    const sel = '[class*="suggest"], [class*="dropdown"], [class*="popover"], [class*="hashtag"], [class*="topic"] [class*="list"], [class*="search"] [class*="list"], li[class*="item"], [class*="complete"]';
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const box = [...document.querySelectorAll(sel)].find((e) => isVisibleEl(e) && e.children.length >= 1);
      if (box) return box;
      await sleep(250);
    }
    return null;
  }
  function clickFirstSuggestion(box) {
    if (!box) return false;
    const item = box.querySelector('div, li, [class*="item"], [class*="option"], [class*="row"]');
    if (item) { item.click(); return true; }
    return false;
  }

  let isFirstTopic = true;
  for (const raw of topics) {
    const kw = String(raw || '').replace(/^#+/, '').replace(/#+$/, '').trim();
    if (!kw) continue;
    // 仅在「首个有效话题」前插入一次空行（正文与话题之间留一个可见间隔）；
    // 其余话题紧接其后，不再插空行（避免每个话题前后都留空行、显得很散）。
    if (isFirstTopic) {
      if (bodyEl) {
        console.log('[黑猫] 话题前插入空行：body=', bodyEl.tagName + '.' + (bodyEl.getAttribute('class') || '').slice(0, 24));
        caretToEnd(bodyEl); await sleep(150); await insertBlankParagraph(bodyEl); await sleep(220);
      }
      isFirstTopic = false;
    }
    const btn = findTopicButton();
    console.log('[黑猫] 话题按钮:', btn ? (btn.tagName + ' ' + (btn.textContent || '').trim().slice(0, 12)) : '未找到');
    if (btn) { try { btn.click(); } catch (e) {} await sleep(500); }
    else if (bodyEl && (bodyEl.isContentEditable || bodyEl.getAttribute('role') === 'textbox')) {
      // 兜底：往正文 insertText 一个 # 触发话题模式
      try { document.execCommand('insertText', false, '#'); } catch (e) {} await sleep(300);
    }
    const ti = findTopicInput();
    console.log('[黑猫] 话题输入框:', ti ? (ti.tagName + ' .' + (ti.getAttribute('class') || '').slice(0, 24)) : '未找到');
    if (!ti) { status('⚠ 未找到话题输入框/按钮，跳过后续话题'); break; }
    ti.focus(); try { ti.click(); } catch (e) {}
    // 逐字输入关键词（模拟真人），唤起下拉
    if (humanTyping) {
      for (const ch of kw) {
        if (ti.isContentEditable || ti.getAttribute('role') === 'textbox') {
          try { document.execCommand('insertText', false, ch); } catch (e) {}
        } else {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(ti, ti.value + ch); else ti.value = ti.value + ch;
          ti.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await sleep(rnd(40, 90));
      }
    } else {
      if (ti.isContentEditable || ti.getAttribute('role') === 'textbox') {
        try { document.execCommand('selectAll', false, null); } catch (e) {}
        try { document.execCommand('insertText', false, kw); } catch (e) {}
      } else setNativeValue(ti, kw);
    }
    if (ti.isContentEditable) syncContentEditable(ti);
    await sleep(600);
    // 等下拉并选第一个建议（变蓝 chip）
    const box = await waitSuggestion();
    console.log('[黑猫] 话题下拉:', box ? '出现' : '未出现');
    let picked = box ? clickFirstSuggestion(box) : false;
    if (!picked) {
      // 兜底：ArrowDown + Enter 选中首项
      ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
      await sleep(150);
      ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    await sleep(450);
    added++;
    status(`已添加话题（${added}/${topics.length}）：#${kw}`);
  }
  return { ok: true, count: added };
}

// 判断一个元素是否像「真正的模态弹窗/遮罩」：尺寸够大、在视口中央或覆盖大部、z-index 较高，
// 避免把侧边栏「编辑」菜单、页面标题等误判为弹窗。
function isRealModal(el) {
  if (!el || !isVisibleEl(el)) return false;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const area = r.width * r.height;
  const viewportArea = vw * vh;
  if (area > viewportArea * 0.1) return true;
  const centered = r.left > vw * 0.15 && r.right < vw * 0.85 && r.top > vh * 0.1 && r.bottom < vh * 0.9;
  if (centered && r.width > vw * 0.3 && r.height > vh * 0.2) return true;
  // 小型居中确认弹窗（常见 300×160 左右）
  if (centered && r.width > 120 && r.height > 80) return true;
  const cs = getComputedStyle(el);
  if ((cs.position === 'fixed' || cs.position === 'absolute') && (cs.zIndex !== 'auto' && parseInt(cs.zIndex) > 100)) {
    if (r.width > vw * 0.25 && r.height > vh * 0.15) return true;
    if (centered && r.width > 120 && r.height > 80) return true;
  }
  return false;
}

// 在对话框/弹层中寻找「主操作（确认类）」按钮。
// 关键：绝不返回「取消/关闭」类按钮，否则会误点取消导致发布失败。只在找不到正向按钮时返回 null。
function findPrimaryConfirm(exclude) {
  const NEG = /取消|关闭|暂不|以后再说|拒绝|返回/;
  const isGood = (b) => {
    if (!isVisibleEl(b) || isDisabledEl(b)) return false;
    if (exclude && b === exclude) return false; // 排除发布主控件，避免把「发布笔记」当确认键反复点
    const t = (b.textContent || '').trim();
    return t.length > 0 && t.length < 24;
  };
  // 1) 优先在疑似弹窗内找确认键（role=dialog / 常见弹窗 class）
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popup"], [class*="Mask"], [class*="mask"], [class*="overlay"], [class*="Overlay"], [class*="Modal"], [class*="Confirm"], [class*="Drawer"]')]
    .find(isRealModal);
  if (modal) {
    const els = [...modal.querySelectorAll('button, [role="button"], a, div, span')].filter(isGood);
    let c = els.find((b) => /确认发布|确认并发布|立即发布/.test((b.textContent || '').trim()) && !NEG.test((b.textContent || '').trim()));
    if (c) return c;
    c = els.find((b) => /确认|确定|发布|发表|提交|完成/.test((b.textContent || '').trim()) && !NEG.test((b.textContent || '').trim()));
    if (c) return c;
  }
  // 2) 无弹窗（或弹窗未带标准 modal class）：直接全文档找第一处「确认发布/确认并发布/立即发布」，用于确认框漏检的情况
  const any = [...document.querySelectorAll('button, [role="button"], a, div, span')].filter((b) => {
    if (!isGood(b)) return false;
    const t = (b.textContent || '').trim();
    return /确认发布|确认并发布|立即发布/.test(t) && !NEG.test(t);
  });
  if (any[0]) return any[0];
  return null;
}

// 元素是否真实可见：用 getBoundingClientRect + computedStyle 判断，
// 不能用 offsetParent（fixed 定位元素 offsetParent===null 但其实是可见的，这正是之前「发布按钮找不到」的根因）。
function isVisibleEl(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'META' || tag === 'LINK' || tag === 'NOSCRIPT') return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
}
function isDisabledEl(b) {
  if (!b) return false;
  if (b.disabled) return true;
  if (b.getAttribute && (b.getAttribute('aria-disabled') === 'true' || b.getAttribute('disabled') !== null)) return true;
  if (b.classList && (b.classList.contains('disabled') || /disable/i.test(b.className || ''))) return true;
  try {
    const cs = getComputedStyle(b);
    if (cs.pointerEvents === 'none') return true;
    if (cs.cursor === 'not-allowed' && cs.opacity && parseFloat(cs.opacity) < 0.7) return true;
    if (cs.opacity && parseFloat(cs.opacity) < 0.25) return true;
  } catch (e) {}
  // 祖先带禁用态
  if (b.closest && b.closest('[aria-disabled="true"],[disabled],.disabled')) return true;
  return false;
}

// 真实点击：小红书用 React，仅靠 el.click() 有时不触发合成事件/原生 pointer 监听。
// v0.2.51 关键修复：之前只发 pointerdown/mousedown/mouseup/click，【漏掉 pointerup】——
// 现代 React 按钮（尤其用 PointerEvents 的）常绑在 pointerup 上，缺它则整个手势被当成「按下未松开」而作废，
// 发布 handler 永不触发（这正是「已点击发布控件 但 published=false、无任何弹窗」的根因）。
// 现在补全完整手势：hover → pointerdown → pointerup → mousedown → mouseup → click，并带完整坐标。
function realClick(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
  const pbase = Object.assign({}, base, { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 });
  const PE = window.PointerEvent || MouseEvent;
  const fire = (type, Ctor, opts) => { try { el.dispatchEvent(new Ctor(type, opts)); } catch (e) {} };
  try { el.focus({ preventScroll: true }); } catch (e) {}
  // 悬停
  fire('pointerover', PE, Object.assign({}, pbase, { buttons: 0 }));
  fire('pointerenter', PE, Object.assign({}, pbase, { buttons: 0 }));
  fire('mouseover', MouseEvent, Object.assign({}, base, { buttons: 0 }));
  fire('mouseenter', MouseEvent, Object.assign({}, base, { buttons: 0 }));
  fire('mousemove', MouseEvent, Object.assign({}, base, { buttons: 0 }));
  // 按下
  fire('pointerdown', PE, Object.assign({}, pbase, { buttons: 1 }));
  fire('mousedown', MouseEvent, Object.assign({}, base, { buttons: 1 }));
  // 松开（关键：pointerup 不能漏）
  fire('pointerup', PE, Object.assign({}, pbase, { buttons: 0 }));
  fire('mouseup', MouseEvent, Object.assign({}, base, { buttons: 0 }));
  fire('click', MouseEvent, Object.assign({}, base, { buttons: 0, detail: 1 }));
  try { el.click(); } catch (e) {}
}

// 向上找「最近的真正可点击祖先」（button/a/role=button/cursor:pointer/btn class）。
function nearestClickable(el) {
  let c = el;
  while (c && c !== document.body) {
    let cs; try { cs = getComputedStyle(c); } catch (e) { cs = {}; }
    if (c.tagName === 'BUTTON' || c.tagName === 'A' || (c.getAttribute && c.getAttribute('role') === 'button')
        || cs.cursor === 'pointer' || /(^|[\s_-])btn|button|publish/i.test(c.className || '')) return c;
    c = c.parentElement;
  }
  return el;
}

// 判断元素（或其最近可点击祖先）背景是否为「红色系」。
// 小红书发布页底部：右侧红色「发布笔记」是主操作，左侧灰色「暂存离开」是次操作；
// 二者并排，必须区分，绝不能把灰色暂存当发布点掉（否则只存草稿）。
function isRedBg(el) {
  let c = el;
  for (let i = 0; i < 5 && c && c !== document.body; i++) {
    try {
      const cs = getComputedStyle(c);
      const bg = cs.backgroundColor || '';
      const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
      if (m) {
        const r = +m[1], g = +m[2], b = +m[3];
        if (r > 110 && r > g + 25 && r > b + 25) return true; // 明显偏红
      }
    } catch (e) {}
    c = c.parentElement;
  }
  return false;
}

// 深度点击：只点【最内层文案元素】+【最近 button/role=button 容器】（+ 兄弟兜底），**绝不**点 elementFromPoint 命中的任意顶层元素——
// 那种做法会误命中隔壁按钮：右侧红色「发布笔记」热区中心坐标实际落到了左侧灰色「暂存离开」按钮上，
// 导致点到的是暂存而非发布（这正是 v0.2.51「published=true 却只存草稿」的根因）。
// v0.2.54：覆盖 React handler 挂载位置不确定的三种情况——①handler 在最内层 span（点 span）②handler 在 button 容器（点 button）
// ③span 与发布 button 是兄弟（点父容器内红色「发布」按钮兜底）；避免只点 span 却因 handler 在别处而无效、被误判为点了暂存。
function realClickDeep(el) {
  if (!el) return;
  realClick(el); // 最内层文案元素（handler 可能挂在这）
  const btn = el.closest && el.closest('button, [role="button"]');
  if (btn && btn !== el) { realClick(btn); return; } // 命中真正的 button 容器
  // 无 button 祖先（可能与发布 button 是兄弟）：在父容器内找红色含「发布」的兄弟按钮兜底
  if (el.parentElement) {
    const sib = [...el.parentElement.children].find((n) =>
      n !== el && /发布/.test((n.textContent || '').trim()) && isRedBg(n) && isVisibleEl(n) && !isDisabledEl(n));
    if (sib) { realClick(sib); return; }
    realClick(el.parentElement); // 最后兜底：点直接父节点
  }
}

// 返回 el 内「文本精确等于 text」的最深层元素。
// 关键：小红书把 onClick 挂在最具体的那个节点（常是承载「发布笔记」文案的 <span>/<div> 子节点），
// 而不是外层容器。若直接在容器上派发 click，React 事件系统只会从「事件目标」向上找 handler，
// 永远触不到位于目标【之下】的子节点 handler —— 点击被吞掉、发布无反应。点最里层元素即可冒泡命中。
function innermostByText(el, text) {
  if (!el) return el;
  const all = [...el.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === text);
  if (!all.length) return el;
  all.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length); // 后代最少者最具体
  return all[0];
}

// 全文档扫描「发布」主操作控件：不局限于 button/a，div/span 也能通过「最近可点击祖先」定位，
// 兼容小红书把发布做成 div[role=button] 或包了 span 的按钮的情况。
// 注意：最终点击目标取【最内层】承载文案的元素（见 innermostByText），否则 React onClick 不触发。
// v0.2.56 关键修复：v0.2.55 的「必须在可点击容器内(inButton)」硬条件把真正的红色「发布笔记」按钮杀掉了——
// 实测该按钮是个 <div>（非 <button>、无 role=button 祖先，日志里「最近button=无」即此），而「定时发布」是真正的
// <button> 反而通过筛选，导致脚本点到「定时发布」(预约≠立即发布) 而发不出去。现改为：①去掉 inButton 硬条件
// （顶部「发布笔记」标题已被 bottom<vh*0.5 排除，不再需要它）；②把「定时发布/定时/预约」加入排除（预约非立即发布）；
// ③排序以【红色】为第一优先（发布主按钮是红色，这是最决定性特征），其次底部发布栏、其次靠右。
function findPublishControl() {
  const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  const W = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;

  // 排除我们自己的插件面板（id=xhs-creator-helper / class xhs-h-*）：它含「发布助手」文案，
  // 否则会被误当成「发布」按钮点掉（v0.2.57 实测就误点了它而非真发布按钮）。
  const isOwnPanel = (el) => {
    let n = el;
    while (n && n !== document.body) {
      if (n.id === 'xhs-creator-helper') return true;
      const cl = typeof n.className === 'string' ? n.className : '';
      if (/(^|[\s])xhs-h-/.test(cl)) return true;
      n = n.parentElement;
    }
    return false;
  };

  const hosts = [...document.querySelectorAll('xhs-publish-btn')].filter((h) => !isOwnPanel(h));

  // ① 真正的「发布」按钮在 <xhs-publish-btn> 的 Shadow 内（实测 shadowrootmode="closed"，
  //    声明式 shadow DOM）。对 closed shadow，JS 的 textContent / elementFromPoint 都取不到内部按钮
  //    —— elementFromPoint 直接返回 host 本身（诊断已证实：中心点elementFromPoint=XHS-PUBLISH-BTN）。
  //    a) 若 shadow 被强制 open（扩展早期 patch 过 attachShadow）→ 直接 querySelector 取到红按钮；
  //    b) 否则：返回 host 本身作为「坐标目标」，由 clickPublishControl() 用 chrome.debugger 在
  //       计算出的屏幕坐标发真实鼠标事件（真实输入穿透 closed shadow 命中红「发布」按钮）。
  try {
    for (const host of hosts) {
      const sr = host.shadowRoot;
      if (!sr) continue;
      const red = sr.querySelector('button.ce-btn.bg-red')
              || [...sr.querySelectorAll('button')].find((b) => /发布/.test(b.textContent) && !/暂存|草稿|离开|定时|预约/.test(b.textContent))
              || null;
      if (red) {
        console.log('[黑猫] 命中 Shadow 内发布按钮(直接): <' + red.tagName + ' class="' + (red.className || '').trim() + '"> "' + (red.textContent || '').trim() + '"');
        return red;
      }
    }
  } catch (e) {}

  if (hosts.length) {
    const host = hosts[0];
    const r = host.getBoundingClientRect();
    console.log('[黑猫] 发布控件= xhs-publish-btn host（closed shadow，改由 CDP 坐标点击）: hostRect(top=' + Math.round(r.top) + ',bottom=' + Math.round(r.bottom) + ',left=' + Math.round(r.left) + ',right=' + Math.round(r.right) + ') vh=' + vh + ' W=' + W);
    return host;
  }

  // ② 兜底（极少数旧页面无 xhs-publish-btn）：全文档几何扫描，排除左侧导航与我们自己的面板
  const cand = [];
  const all = [...document.querySelectorAll('button, a, [role="button"], [class*="publish"], [class*="Publish"], div, span')];
  for (const el of all) {
    if (!isVisibleEl(el) || isOwnPanel(el)) continue;
    const t = (el.textContent || '').trim();
    if (!/发布/.test(t)) continue;
    if (/暂存|存草稿|离开|草稿|保存|保存草稿|定时发布|定时|预约|须知|规则|指南|公约|规范|条款|公告|帮助|声明|协议|预览|设置|首页|笔记管理/.test(t)) continue;
    let rr; try { rr = el.getBoundingClientRect(); } catch (e) { rr = { top: 0, bottom: 0, left: 0, width: 0 }; }
    if (rr.bottom < vh * 0.5) continue;
    const anc = nearestClickable(el);
    cand.push({ el: innermostByText(el, t), red: isRedBg(anc), right: Math.round(rr.left + rr.width / 2), bottom: Math.round(rr.bottom) });
  }
  if (cand.length) {
    console.log('[黑猫] 发布候选(' + cand.length + '): ' + cand.map((c) =>
      (c.el.tagName + '.' + String(c.el.className || '').slice(0, 10) + ' "'
        + (c.el.textContent || '').trim().slice(0, 8) + '" bottom=' + c.bottom + ' right=' + c.right + ' red=' + c.red)).join(' | '));
  }
  const uniq = []; const seen = new Set();
  for (const c of cand) { if (seen.has(c.el)) continue; seen.add(c.el); uniq.push(c); }
  if (!uniq.length) return null;
  const enabled = uniq.filter((c) => !isDisabledEl(c.el));
  const pool = enabled.length ? enabled : uniq;
  pool.sort((a, b) => (b.red ? 1 : 0) - (a.red ? 1 : 0) || (b.bottom - a.bottom) || (b.right - a.right));
  return pool[0].el;
}

// 由 xhs-publish-btn host 的矩形推算红「发布」按钮的多个候选屏幕坐标（真实输入点此坐标即可命中，穿透 closed shadow）。
// 原策略只算一个固定偏移（栏中心 +72），在小红书底部栏实际尺寸/间距变化时容易 miss，导致点了但按钮还在、空等 60s。
// 现改为在 host 右半区取 5 个候选点，每点点击后 1.2s 验证按钮是否消失/跳转/出成功文案/出确认弹窗；命中即停，全部 miss 再 fallback JS 点击。
function publishButtonPoints(host) {
  const r = host.getBoundingClientRect();
  const w = r.width || 0;
  const h = r.height || 0;
  const left = r.left;
  const right = r.right;
  const top = r.top;
  const bottom = r.bottom;
  const cy = top + h / 2;
  return [
    { x: left + w * 0.75, y: cy, note: '右半区75%' },
    { x: left + w * 0.80, y: cy, note: '右半区80%' },
    { x: right - 50, y: cy, note: '右缘-50' },
    { x: left + w * 0.70, y: top + h * 0.65, note: '右下65%' },
    { x: left + w * 0.75, y: bottom - 20, note: '右下底-20' },
  ];
}

// 经 background service worker 用 chrome.debugger 发真实鼠标事件到 (x,y)（真实输入会穿透 closed shadow）。
async function cdpClickPublish(x, y) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'xhs-real-click', x, y }, (resp) => {
        if (chrome.runtime.lastError) { console.log('[黑猫] CDP点击失败: ' + chrome.runtime.lastError.message); resolve(false); }
        else { console.log('[黑猫] CDP真实点击发布按钮 → ' + JSON.stringify(resp)); resolve(!!(resp && resp.ok)); }
      });
    } catch (e) { console.log('[黑猫] CDP点击异常: ' + e.message); resolve(false); }
  });
}

// 点击发布控件：真实按钮（shadow 可取到）→ 深度点击；xhs-publish-btn host（closed shadow）→ CDP 坐标真实点击。
// v0.2.60 关键改进：CDP 单点坐标容易因底部栏实际尺寸/间距变化而 miss；现多候选点 + 命中验证，命中即停。
async function clickPublishControl(ctrl) {
  if (!ctrl) return false;
  const isHost = (ctrl.tagName || '').toLowerCase() === 'xhs-publish-btn';
  if (isHost) {
    // 确保发布栏吸底在视口（sticky bottom:0）：把最近的可滚动祖先 / 整窗滚到底
    try {
      const r0 = ctrl.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      if (r0.bottom > vh || r0.top < 0) {
        let sc = ctrl.parentElement;
        while (sc && sc !== document.body) {
          const cs = getComputedStyle(sc);
          if (/auto|scroll|overlay/.test(cs.overflowY || cs.overflow || '')) { sc.scrollTop = sc.scrollHeight; break; }
          sc = sc.parentElement;
        }
        try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) {}
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {}
    const points = publishButtonPoints(ctrl);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const pt of points) {
      console.log('[黑猫] 尝试发布点击: x=' + Math.round(pt.x) + ' y=' + Math.round(pt.y) + ' (' + pt.note + ')');
      const ok = await cdpClickPublish(pt.x, pt.y);
      if (!ok) { console.log('[黑猫] CDP点击命令未成功'); continue; }
      await sleep(1200);
      const stillThere = !!findPublishControl();
      const navigated = !/publish/i.test(location.href);
      const bodyText = document.body.innerText || '';
      const hasSuccess = /发布成功|已发布/.test(bodyText);
      const hasConfirm = !!findPrimaryConfirm();
      if (!stillThere || navigated || hasSuccess || hasConfirm) {
        console.log('[黑猫] 发布点击命中 (' + pt.note + ')');
        return true;
      }
      console.log('[黑猫] 点击未命中，按钮仍在，换候选点');
    }
    console.log('[黑猫] CDP 全部候选点未命中，fallback realClickDeep');
    realClickDeep(ctrl);
    return true;
  }
  realClickDeep(ctrl);
  return true;
}



// 等待图片上传完成：小红书发布前若图片仍在上传/审核，点击发布会被忽略或弹提示。
// 轮询页面文案，待「上传中/处理中/审核中」等消失后再点发布。
async function waitForUploadDone(status, timeout = 90000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const txt = document.body.innerText || '';
    if (/上传中|上传失败|图片处理中|处理中|审核中|解析中|图片上传中|请等待图片/.test(txt)) {
      if (status) status('⏳ 等待图片上传完成…');
      await sleep(1500);
      continue;
    }
    return true;
  }
  return true; // 超时也继续（仍尝试点发布）
}

// 自动发布：等待图片审核放开 → 点击发布 → 处理二次确认弹窗 → 识别发布成功
async function autoPublish(status, summary, task) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logCandidates = () => {
    try {
      const btns = [...document.querySelectorAll('button, a, [role="button"]')].filter(isVisibleEl);
      const info = btns.slice(0, 30).map((b) => `${b.tagName}.${String(b.className || '').slice(0, 14)}|"${(b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 16)}"|dis=${isDisabledEl(b) ? 1 : 0}`);
      console.log('[黑猫] 可视点击元素(' + btns.length + '):', JSON.stringify(info));
    } catch (e) {}
  };
  const isPublishHost = (el) => (el && (el.tagName || '').toLowerCase() === 'xhs-publish-btn');
  const ctrl = findPublishControl();
  console.log('[黑猫] 发布控件:', ctrl ? (ctrl.tagName + (isPublishHost(ctrl) ? '[xhs-publish-btn host]' : '.' + String(ctrl.className || '').slice(0, 18)) + ' "' + (ctrl.textContent || '').trim().slice(0, 12) + '" dis=' + (isDisabledEl(ctrl) ? 1 : 0)) : '未找到');
  if (ctrl) {
    try {
      const rr = ctrl.getBoundingClientRect();
      console.log('[黑猫] 发布控件几何: bottom=' + Math.round(rr.bottom) + ' centerX=' + Math.round(rr.left + rr.width / 2) + ' red=' + isRedBg(ctrl) + ' vh=' + (window.innerHeight || 0));
    } catch (e) {}
  }
  if (!ctrl) { logCandidates(); status(summary + '｜未找到「发布」按钮，请手动点发布'); return { clicked: false }; }
  // 发布控件禁用判定（host 用其 submit-disabled / submit-loading 属性判断内部按钮是否可点）
  const ctrlDisabled = () => isDisabledEl(ctrl) || (isPublishHost(ctrl) && (ctrl.getAttribute('submit-disabled') === 'true' || ctrl.getAttribute('submit-loading') === 'true'));
  if (ctrlDisabled()) {
    status(summary + '｜发布按钮暂不可点（可能图片审核中），等待放开…');
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      await sleep(1500);
      const c2 = findPublishControl();
      const c2Disabled = c2 && (isDisabledEl(c2) || (isPublishHost(c2) && (c2.getAttribute('submit-disabled') === 'true' || c2.getAttribute('submit-loading') === 'true')));
      if (c2 && !c2Disabled) { ctrl = c2; console.log('[黑猫] 发布按钮已放开'); break; }
      const hint = (document.body.innerText.match(/图片上传中[^\n]*|审核中[^\n]*|上传失败[^\n]*|请先上传[^\n]*/) || [''])[0];
      if (hint) console.log('[黑猫] 上传提示:', hint.slice(0, 30));
    }
    if (ctrlDisabled()) { status(summary + '｜图片审核超时仍未放开，请手动点发布'); return { clicked: false }; }
  }
  if (detectChallenge()) {
    status(summary + '｜检测到验证挑战，已停下，请人工处理');
    await reportDone(task.id, 'manual_hold', '验证挑战，转人工');
    return { clicked: false, hold: true, detail: '验证挑战' };
  }
  dismissModal(status); // 发布前再清一次纯提示弹窗（hasAction 守卫已确保不会误点取消）
  await waitForUploadDone(status); // 等图片上传完成，否则点击发布会被忽略
  await clickPublishControl(ctrl);
  console.log('[黑猫] 已点击发布控件（' + (isPublishHost(ctrl) ? 'CDP 坐标点击 xhs-publish-btn' : (ctrl.textContent || '').trim().slice(0, 16)) + '）');
  status(summary + '｜已点击「发布」，等待结果…');
  await sleep(600);
  logCandidates(); // 点发布后立即快照所有可视按钮，若出现「确认发布」等确认键便于诊断
  const SUCCESS_RE = /发布成功|发布成功啦|发布成功咯|发布成功！|发布成功~|已发布成功|笔记已发布|作品已发布|内容已发布|发布成功，/;
  // 排除「存草稿」提示：v0.2.51 曾因点到灰色暂存按钮、只存草稿却被误判为发布成功，故发布成功必须排除存草稿场景。
  const DRAFT_RE = /存为草稿|已存草稿|草稿已保存|保存草稿|已保存草稿|存草稿/;
  const logDialog = () => {
    try {
      const dlg = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popup"], [class*="overlay"], [class*="Mask"], [class*="mask"]')]
        .filter((e) => isRealModal(e) && (e.textContent || '').trim().length > 0);
      if (!dlg.length) return;
      dlg.slice(0, 2).forEach((d) => {
        const txt = (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const btns = [...d.querySelectorAll('button, [role="button"], a, div, span')]
          .filter((b) => isVisibleEl(b) && (b.textContent || '').trim().length > 0 && (b.textContent || '').trim().length < 24)
          .map((b) => (b.textContent || '').trim());
        console.log('[黑猫] 弹窗:', txt, '｜按钮:', JSON.stringify(btns.slice(0, 8)));
      });
    } catch (e) {}
  };
  const clickTime = Date.now();
  let published = false;
  const until2 = Date.now() + 60000; // v0.2.53：延长到 60s，覆盖发布成功后跳转/渲染较慢的情况
  let reclickedCount = 0;
  const startUrl = location.href; // 记录发布前 URL，用于判定「是否跳离发布页」（跳离=已发布的最强信号）
  logDialog(); // 点发布后立即记录一次弹窗状态（确认框往往此时出现）
  while (Date.now() < until2) {
    await sleep(500);
    logDialog(); // 每轮记录可见弹窗（确认框/成功提示都看得到），便于排查
    dismissModal(status); // 只关纯提示弹窗，绝不会点「取消」发布确认框
    const bodyText = document.body.innerText || '';
    // 信号①：成功文案（最直接）
    if (SUCCESS_RE.test(bodyText)) {
      published = true; console.log('[黑猫] 检测到发布成功文案'); status(summary + '｜✓ 已发布成功'); break;
    }
    // 信号②：页面已跳离发布页（URL 不再含 publish）→ 小红书发布成功后必跳转，这是最可靠的成功信号
    const navigated = !/publish/i.test(location.href);
    if (navigated) {
      published = true;
      console.log('[黑猫] 页面已跳离发布页，判定发布成功（url=' + location.href.slice(0, 64) + '）');
      status(summary + '｜✓ 已发布成功（页面已跳转）'); break;
    }
    // 信号③：发布控件从 DOM 消失且已过点按钮后缓冲期（编辑器被卸载=成功态），排除「发布中」瞬时隐藏误判
    const ctrlNow = findPublishControl();
    const elapsed = Date.now() - clickTime;
    if (!ctrlNow && elapsed > 3000 && !DRAFT_RE.test(bodyText)) {
      published = true;
      console.log('[黑猫] 发布控件已从页面消失，判定发布成功（url=' + location.href.slice(0, 64) + '）');
      status(summary + '｜✓ 已发布成功'); break;
    }
    if (DRAFT_RE.test(bodyText)) { console.log('[黑猫] 检测到「存草稿」提示，尚未发布成功'); }
    // 信号④：二次确认弹窗（确认发布/确认并发布/立即发布）
    const c = findPrimaryConfirm(ctrl);
    if (c) {
      const ct = (c.textContent || '').trim();
      realClickDeep(c); // v0.2.53：确认键也是 React 组件，用深度点击更稳
      console.log('[黑猫] 点击确认按钮：', ct.slice(0, 16));
      status(summary + '｜已点击确认：' + ct + ' ✓');
      await sleep(2000);
      continue;
    }
    logDialog(); // 无确认框也无成功：记录当前可见弹窗，供下次排查
    // 首点被页面吞掉/按钮重渲染/React handler 在子节点：每 4s 补点一次，最多 3 次。
    // 每次补点同时点「最内层元素」及其「父元素」，覆盖 handler 挂在内层或外层两种情况。
    if (reclickedCount < 3 && elapsed > 4000) {
      const again = findPublishControl();
      if (again && !isDisabledEl(again)) {
        await clickPublishControl(again);
        reclickedCount++;
        console.log('[黑猫] 补点发布控件（第 ' + reclickedCount + ' 次，目标=' + (again.tagName + '.' + String(again.className || '').slice(0, 12)) + '）');
        if (reclickedCount === 1) logCandidates(); // 补点后再快照一次按钮，捕捉迟出现的确认弹窗
        await sleep(2000);
        const t2 = document.body.innerText || '';
        if (DRAFT_RE.test(t2)) { console.log('[黑猫] 补点后仍只是存草稿'); }
        else if (SUCCESS_RE.test(t2) || !/publish/i.test(location.href) || !findPublishControl()) { published = true; console.log('[黑猫] 补点后判定发布成功'); break; }
      }
    }
  }
  console.log('[黑猫] 自动发布结束 published=', published, 'clicked=true ｜url=' + location.href.slice(0, 64) + ' ｜发布控件仍在=' + (!!findPublishControl()) + ' ｜含publish路径=' + (/publish/i.test(location.href)));
  return { clicked: true, published };
}

async function fillTask(task, autoSubmit, serverUrl, humanTyping = true) {
  const status = (window.__xhsHelper?.status) || (() => {});
  console.log('[黑猫] fillTask 开始 task=', (task.title || '').slice(0, 24), 'bodyLen=', (task.body || '').length, 'autoSubmit=', autoSubmit, 'humanTyping=', humanTyping, 'images=', Array.isArray(task.images) ? task.images.length : 0, 'firstImg=', Array.isArray(task.images) && task.images[0] ? String(task.images[0]).slice(0, 80) : '-', 'serverUrl=', serverUrl || '-');
  const FILL_TOTAL_MS = 150 * 1000;
  const withDeadline = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms)),
  ]);
  try {
    const work = (async () => {
      window.__xhsCurrentTaskId = task.id;
      const filled = [];

      // 关闭风险提示等阻塞弹窗，并二次确认不是真实验证挑战
      if (detectChallenge()) {
        status('检测到验证挑战，已停下，请人工处理');
        return { ok: false, hold: true, detail: '验证挑战，转人工' };
      }
      dismissModal(status);

      // 等待发布页进入可操作状态（上传控件/标题/正文/上传按钮出现）
      status('等待发布页加载…');
      await waitForFormReady();

      // 先确保上传区就绪并注入图片（小红书图文页：传图后标题/正文表单才渲染出现）
      status('正在准备上传区并注入图片…');
      const uploadInput = await ensureUploadReady(status);
      const img = await injectImages(task.images, serverUrl, uploadInput);
      if (img.noImages) status('⚠ 该笔记无图片：图文必须至少 1 张图，请回到创建笔记处补充图片/封面图');
      else if (!img.ok && !img.skipped) status('⚠ ' + (img.detail || '图片注入失败'));
      else if (img.ok && img.count) status(`已注入 ${img.count} 张图片` + (img.formAppeared ? '，表单已渲染' : '（表单未渲染，可能上传未生效）'));

      // 传图后等待标题/正文表单出现，再填充
      status('正在查找标题输入框…');
      const t = await locateField('title', 25000);
      console.log('[黑猫] 标题元素:', t ? (t.tagName + ' .' + (t.getAttribute('class') || '').slice(0, 30)) : '未找到', 'ph=', t ? phOf(t) : '');
      if (t) {
        const title = fitTitle(task.title || '');
        status(`正在填标题（${title.length}字 / 上限约20中文字）…`);
        if (humanTyping) await withDeadline(typeText(t, title), 30000, '填标题');
        else writeEditable(t, title);
        const written = t.value != null ? t.value : (t.textContent || '').trim();
        if (!written) throw new Error('标题输入框未写入内容');
        filled.push('标题');
      } else {
        status('⚠ 未找到标题输入框（页面可能未加载完或发布平台改版）');
        console.log('[黑猫] 可见编辑字段:', JSON.stringify(dumpFields()));
      }

      status('正在查找正文输入框…');
      const b = await locateField('body', 20000, t || undefined);
      console.log('[黑猫] 正文元素:', b ? (b.tagName + ' .' + (b.getAttribute('class') || '').slice(0, 30)) : '未找到', 'ph=', b ? phOf(b) : '');
      if (b) {
        status('正在填正文…');
        if (humanTyping) await withDeadline(typeText(b, task.body || '', { newlineIsParagraph: true }), 60000, '填正文');
        else writeEditable(b, task.body || '');
        const isEditable = b.contentEditable === 'true' || b.isContentEditable || b.classList.contains('ql-editor') || b.getAttribute('role') === 'textbox';
        const written = isEditable ? (b.textContent || '').trim() : (b.value || '');
        if (!written) throw new Error('正文编辑器未写入内容');
        filled.push('正文');
      } else {
        status('⚠ 未找到正文输入框（页面可能未加载完或发布平台改版）');
        console.log('[黑猫] 可见编辑字段:', JSON.stringify(dumpFields()));
      }

      // 话题（点击「话题」按钮 → 逐字输入关键词 → 下拉选第一个变蓝 chip；默认补齐到 6 个）
      status('正在填话题（6个）…');
      const tpRes = await injectTopics(task, humanTyping, status, b);
      if (tpRes.ok && tpRes.count) filled.push(tpRes.count + '个话题');
      else if (tpRes.detail) status('⚠ ' + tpRes.detail);

      status('正在关联商品…');
      console.log('[黑猫] 关联商品：product=', JSON.stringify(task.product ? { name: task.product.productName, itemId: task.product.itemId } : null));
      const goods = await associateGoods(task.product);
      const summary = '已填：' + (filled.length ? filled.join('、') : '（标题/正文未匹配到输入框，请检查页面）')
        + (img.ok ? `、图${img.count || 0}张` : (img.detail && !img.skipped ? `、${img.detail}` : ''))
        + (goods.ok ? '、商品✓' : (goods.detail ? `、${goods.detail}` : ''));
      if (!filled.length) throw new Error('未找到标题或正文输入框，请检查页面');
      status(summary);
      let clicked = false, published = false;
      if (autoSubmit) {
        status(summary + ' ｜ 准备自动发布…');
        const res = await withDeadline(autoPublish(status, summary, task), 60000, '自动发布');
        clicked = res.clicked;
        published = !!res.published;
        if (res.hold) return { ok: true, clicked: false, hold: true, detail: res.detail };
      }
      return { ok: true, clicked, published };
    })();
    return await Promise.race([
      work,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`填充总时长超过 ${Math.round(FILL_TOTAL_MS / 1000)}s，已强制标记失败`)), FILL_TOTAL_MS)),
    ]);
  } catch (e) {
    status('填充异常：' + e.message);
    return { ok: false, detail: e.message };
  }
}

// 仅在出现「可见的验证挑战弹窗」时判定，杜绝宽泛 class 误判（如含 slider/verify 字样的普通组件）。
// 真实验证码通常以弹窗/遮罩出现，且文案含「验证/滑动/安全/人机/请完成/拖动」等，并带滑块/拼图等挑战元素。
function detectChallenge() {
  const boxes = [...document.querySelectorAll(
    '[role="dialog"], [class*="modal"], [class*="dialog"], [class*="overlay"], [class*="popup"], [class*="Mask"], [class*="mask"], [class*="captcha"], [class*="geetest"], [class*="slide"], [class*="verify"], [class*="challenge"]'
  )].filter((e) => e.offsetParent !== null);
  for (const el of boxes) {
    const t = (el.innerText || '').slice(0, 300);
    if (/验证|滑动|拼图|安全验证|人机|请完成|拖动|滑块|安全/i.test(t)) return true;
  }
  return false;
}

// 关闭非验证类的阻塞弹窗（风险提示 / 发布须知 / 规范提醒等），返回是否处理过。
// 验证挑战类弹窗不自动处理（交由人工），避免误触。
function dismissModal(status) {
  const modal = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="Mask"], [class*="mask"], [class*="overlay"], [class*="Overlay"]')]
    .find(isRealModal);
  if (!modal) return false;
  if (detectChallenge()) return false;
  // 同时扫描 div/span/a（小红书弹窗按钮常是 div），且绝不包含「取消/关闭」类按钮：
  // 凡含「确认发布」等正向动作的弹窗（确认发布/取消）一律不自动关，交给 autoPublish 的 findPrimaryConfirm 处理。
  const all = [...modal.querySelectorAll('button, [role="button"], a, div, span')].filter((b) => {
    if (b.offsetParent === null || b.disabled) return false;
    try { if (isDisabledEl(b)) return false; } catch (e) {}
    return (b.textContent || '').trim().length > 0;
  });
  const hasAction = all.some((b) => /确认发布|确认并发布|发布笔记|发布内容|确认提交|提交发布/.test((b.textContent || '').trim()));
  if (hasAction) return false;
  const NEG = /取消|关闭|暂不|以后再说|拒绝|返回/;
  const safe = all.find((b) => /知道了|我已知晓|好的|同意|继续|不再提醒|稍后|确定|确认/.test((b.textContent || '').trim()) && !NEG.test((b.textContent || '').trim()));
  if (safe) { safe.click(); status && status('已关闭页面提示弹窗，继续…'); return true; }
  return false;
}

// 进入图文发布页时，确保：①关闭风险提示等阻塞弹窗 ②处于图文上传模式 ③上传区已展开并出现 file input
async function ensureUploadReady(status) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 1) 关掉任何阻塞弹窗（例如进入发布页时的「风险提示」）
  dismissModal(status);
  await sleep(400);
  // 2) 确认在「图文」上传模式：找不到 file input 时说明确实还在别的状态，尝试点「图文 / 上传图文」tab
  let input = findFileInput();
  if (!input) {
    const tab = clickByText('[role="tab"], [class*="tab"]', '图文')
            || clickByText('button', '上传图文')
            || clickByText('[role="tab"], [class*="tab"]', '图片');
    if (tab) { tab.click(); status && status('已切换到图文上传模式'); await sleep(900); dismissModal(status); }
    input = findFileInput();
  }
  // 3) 若仍无 file input，说明上传区未展开：点击「上传图片 / 添加图片」按钮展开上传区。
  //    注意：点这类按钮通常会触发 <input type=file>.click() 弹出系统文件框，这里临时屏蔽该 click，
  //    只让「展开上传区」的逻辑执行，避免弹出系统选择框卡住。
  if (!input) {
    const up = clickByText('button', '上传图片')
            || clickByText('button', '添加图片')
            || clickByText('[class*="upload"], [class*="drop"]', '上传图片')
            || clickByText('[class*="upload"], [class*="drop"]', '添加图片');
    if (up) {
      status && status('点击「上传图片」展开上传区…');
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {}; // 临时屏蔽，避免弹出系统文件选择框
      try { up.click(); } catch (e) {}
      HTMLInputElement.prototype.click = origClick;
      for (let i = 0; i < 20 && !findFileInput(); i++) await sleep(300);
      dismissModal(status);
    }
    input = findFileInput();
  }
  return input;
}

// 监听「人工点发布成功」后回报 published 并续链队列（autoSubmit 关闭人工复核 / 验证挑战转人工后，用户手动点「发布」时触发）
let __manualWatch = null;
function armManualSuccessWatch(taskId) {
  if (__manualWatch) return;
  const status = (window.__xhsHelper?.status) || (() => {});
  const RE = /发布成功|已发布|内容已提交|提交成功|发布成功啦/;
  const deadline = Date.now() + 6 * 60 * 1000;
  const started = Date.now();
  let sawSuccess = RE.test(document.body.innerText);
  __manualWatch = setInterval(() => {
    if (Date.now() > deadline) { clearInterval(__manualWatch); __manualWatch = null; return; }
    const has = RE.test(document.body.innerText);
    if (has && (Date.now() - started > 4000) && !sawSuccess) {
      clearInterval(__manualWatch); __manualWatch = null;
      status('检测到已发布 ✓，正在续下一篇…');
      chrome.runtime.sendMessage({ type: 'reportDone', taskId, status: 'published', detail: '人工点击发布成功', delayMs: window.__xhsLastDelayMs || 0 });
    }
    sawSuccess = has;
  }, 1500);
}

// 回报发布结果：优先直连后端（绕开 MV3 service worker，避免 Extension context invalidated）；
// 直连失败才兜底走 service worker 消息。
async function reportDone(taskId, statusVal, detail, delayMs) {
  try {
    const r = await window.XhsCommon.xhsFetch('/api/ext/done', { method: 'POST', body: { taskId, status: statusVal, detail } });
    return r.data;
  } catch (e) {
    try { return await chrome.runtime.sendMessage({ type: 'reportDone', taskId, status: statusVal, detail, delayMs: delayMs || 0 }); } catch (e2) {}
    return null;
  }
}
// 同时给 background service worker 发完成信号（快速通道），避免只靠轮询/SW 回收兜底导致延迟
function notifyBgDone(taskId, statusVal, detail, delayMs) {
  try {
    chrome.runtime.sendMessage({ type: 'reportDone', taskId, status: statusVal, detail, delayMs: delayMs || 0 }).catch(() => {});
  } catch (e) {}
}

// 取「两篇之间的间隔(ms)」：优先用后端设置里的「发布间隔 + 随机延迟」，取不到则用兜底值
async function getIntervalMs() {
  try {
    const r = await window.XhsCommon.xhsFetch('/api/settings');
    const s = (r && r.data) || {};
    const base = Number(s.publishIntervalSeconds) || 500;
    const rand = Number(s.publishIntervalRandomDelaySeconds) || 200;
    return (base + Math.random() * rand) * 1000;
  } catch (e) {
    return 30000 + Math.random() * 20000;
  }
}
// 把真实间隔回报给后台调度器（手动拉取路径没走 fillTab，不回报就会用默认 ~11.6 分钟）
function sendDelay(delayMs) {
  try { chrome.runtime.sendMessage({ type: 'reportDelay', delayMs: Math.round(Number(delayMs) || 0) }); } catch (e) {}
}
// 长时间填充时定期心跳，防止服务端 120s 超时把任务标失败
function startTaskHeartbeat(taskId) {
  if (window.__xhsHeartbeatTimer) clearInterval(window.__xhsHeartbeatTimer);
  window.__xhsHeartbeatTimer = setInterval(async () => {
    try {
      await window.XhsCommon.xhsFetch('/api/ext/heartbeat?id=' + encodeURIComponent(taskId), { method: 'POST' });
      console.log('[黑猫] heartbeat task=', taskId);
    } catch (e) { console.log('[黑猫] heartbeat failed', e); }
  }, 25000);
}
function stopTaskHeartbeat() {
  if (window.__xhsHeartbeatTimer) { clearInterval(window.__xhsHeartbeatTimer); window.__xhsHeartbeatTimer = null; }
}
// 把「下一篇最早发布时刻」上报给后端，供桌面批量发布页同步显示倒计时
async function reportSchedule(at) {
  try {
    const r = await window.XhsCommon.xhsFetch('/api/ext/schedule', { method: 'POST', body: { nextPublishAt: at } });
    console.log('[黑猫] reportSchedule ok=', r.ok, 'status=', r.status, 'at=', at, 'delta=', at ? (at - Date.now()) + 'ms' : 0);
  } catch (e) {
    console.error('[黑猫] reportSchedule failed', e);
  }
}

// 统一执行：校验挑战 → 填表 → 回报结果。供 background 下发调用。
// 同一任务在 30s 内的重复下发直接跳过（防止 MV3 重复注入 content script 导致 onMessage 监听器注册两遍、一次下发触发两次填充/重复传图）。
const __fillLock = (window.__xhsFillLock = window.__xhsFillLock || new Set());
async function runFill(task, autoSubmit, serverUrl, humanTyping) {
  const status = (window.__xhsHelper?.status) || (() => {});
  console.log('[黑猫] runFill', (task.title || '').slice(0, 24), 'autoSubmit=', autoSubmit, 'humanTyping=', humanTyping);
  startTaskHeartbeat(task.id);
  // 取真实间隔并回报后台调度器（手动拉取路径没走 fillTab，不回报就会用默认 ~11.6 分钟）
  const __delayMs = await getIntervalMs();
  window.__xhsLastDelayMs = __delayMs;
  sendDelay(__delayMs);
  // 开始新任务前，撤销上一条可能仍在监听「人工发布成功」的 watch，
  // 否则提早开始下一篇会导致把新任务误报成上一条已发布。
  if (__manualWatch) { clearInterval(__manualWatch); __manualWatch = null; }
  if (__fillLock.has(task.id)) {
    console.log('[黑猫] 跳过重复 fillTask（同一任务进行中）', task.id);
    status('该任务正在填充中，跳过重复下发');
    return;
  }
  if (detectChallenge()) {
    status('检测到验证挑战，已停下，请人工处理');
    await reportDone(task.id, 'manual_hold', '验证挑战，转人工', __delayMs);
    return;
  }
  __fillLock.add(task.id);
  window.__xhsPublish.publishing = true;
  updateStartBtn();
  try {
    const r = await fillTask(task, autoSubmit, serverUrl, humanTyping);
    console.log('[黑猫] fillTask 结果:', JSON.stringify(r));
    if (r.hold) {
      // 验证挑战：转人工（合规红线，绝不自动破解）。挂接监听，用户解决并手动发布后回报 published，恢复队列。
      await reportDone(task.id, 'manual_hold', r.detail || '验证挑战，转人工', __delayMs);
      notifyBgDone(task.id, 'manual_hold', r.detail || '验证挑战，转人工', __delayMs);
      status('检测到验证挑战，已停下，请人工处理；解决后手动点「发布」将自动继续下一篇');
      armManualSuccessWatch(task.id);
    } else if (!r.ok) {
      status('填充异常：' + r.detail);
      await reportDone(task.id, 'failed', r.detail, __delayMs);
      notifyBgDone(task.id, 'failed', r.detail, __delayMs);
    } else if (r.published) {
      // 真正发布成功：补写「下一篇倒计时」并上报后端，供桌面批量发布页同步显示。
      // 优先用后台已算好的 nextPublishAt；没有则用 runFill 开头已取到的 delayMs 计算，
      // 避免再调一次 getIntervalMs() 产生新的随机值，导致插件调度器与桌面端倒计时不一致。
      try {
        const cur = await new Promise((res) => chrome.storage.local.get({ nextPublishAt: 0 }, (r) => res(r.nextPublishAt || 0)));
        let at = 0;
        if (cur > Date.now()) {
          at = cur;
          console.log('[黑猫] 使用后台已写 countdown:', at, 'delta=', (at - Date.now()) + 'ms');
        } else {
          const d = window.__xhsLastDelayMs || await getIntervalMs();
          at = Date.now() + d;
          chrome.storage.local.set({ nextPublishAt: at });
          console.log('[黑猫] 重新计算 countdown:', at, 'delta=', (at - Date.now()) + 'ms');
        }
        if (at) reportSchedule(at);
      } catch (e) { console.error('[黑猫] 写 countdown 异常', e); }
      await reportDone(task.id, 'published', '已自动发布成功', __delayMs);
      notifyBgDone(task.id, 'published', '已自动发布成功', __delayMs);
      status('✓ 已发布，下一篇倒计时见上方 ↑');
    } else if (r.clicked) {
      // 点了发布但未确认成功：转失败待重试，不前进队列、不写倒计时（避免误判已发）
      await reportDone(task.id, 'failed', '已点击发布但未确认成功', __delayMs);
      notifyBgDone(task.id, 'failed', '已点击发布但未确认成功', __delayMs);
      status('已点击发布但未确认成功，已转失败待重试 —— 你也可手动点「确认发布」');
    } else if (autoSubmit) {
      await reportDone(task.id, 'failed', '想自动发布但未找到发布按钮，请手动发布或在 app 重试', __delayMs);
      notifyBgDone(task.id, 'failed', '想自动发布但未找到发布按钮，请手动发布或在 app 重试', __delayMs);
      status('已填好但未找到发布按钮，已转失败待重试 —— 你也可手动点发布');
    } else {
      await reportDone(task.id, 'waiting_submit', '表单已填好，等待人工点击发布', __delayMs);
      notifyBgDone(task.id, 'waiting_submit', '表单已填好，等待人工点击发布', __delayMs);
      status('已填好，请人工复核后点击「发布」');
      armManualSuccessWatch(task.id);
    }
  } finally {
    stopTaskHeartbeat();
    window.__xhsPublish.publishing = false;
    updateStartBtn();
    refreshQueue(); // 任务结束 → 重新统计本账号队列（决定按钮是否仍可用）
    // 30s 后解锁，允许后续重试（如用户手动点重试 / 下次批量）
    setTimeout(() => __fillLock.delete(task.id), 30 * 1000);
  }
}

// 接收 background 下发的任务（监听器只注册一次，避免 MV3 重复注入导致双监听 → 一次消息触发两次 runFill）
if (!window.__xhsBound) {
  window.__xhsBound = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'state') {
      const st = (window.__xhsHelper?.status) || (() => {});
      if (msg.state && msg.state.msg) st(msg.state.msg);
      return;
    }
    if (msg?.type === 'fillTask') {
      // 立即同步回复，避免 Chrome MV3 消息通道在长时间异步操作中断开；
      // 填充结果通过 reportDone 主动回报（已改为直连后端，不受 service worker 回收影响）。
      sendResponse({ ok: true, detail: 'started' });
      console.log('[黑猫] 收到 fillTask，autoSubmit=', msg.autoSubmit, 'humanTyping=', msg.humanTyping, 'title=', (msg.task.title || '').slice(0, 24));
      runFill(msg.task, msg.autoSubmit, msg.serverUrl, msg.humanTyping);
      return; // 已同步回复，不需要 return true
    }
  });
}

// 顶部居中悬浮 Toast：展示实时发布状态 + 最近日志（点「日志」展开/收起）
function buildToast() {
  if (document.getElementById('xhs-toast')) return;
  const style = document.createElement('style');
  style.id = 'xhs-toast-css';
  style.textContent = `
#xhs-toast{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
  font-size:12px;max-width:92vw;pointer-events:none;}
.xhs-toast-bar{display:flex;align-items:center;gap:8px;background:rgba(18,18,26,.92);color:#fff;
  padding:6px 12px;border-radius:20px;box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:auto;
  border:1px solid rgba(255,255,255,.08);}
.xhs-toast-dot{width:8px;height:8px;border-radius:50%;background:#36d399;box-shadow:0 0 8px #36d399;flex:0 0 auto;}
#xhs-toast-status{max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#xhs-toast-countdown{color:#ffd166;margin-left:6px;white-space:nowrap;font-variant-numeric:tabular-nums;}
#xhs-toast-toggle{background:#3b82f6;color:#fff;border:none;border-radius:12px;padding:2px 10px;
  cursor:pointer;font-size:11px;flex:0 0 auto;}
.xhs-toast-logs{margin:6px auto 0;background:rgba(18,18,26,.94);color:#cfd2dc;padding:10px 12px;
  border-radius:10px;max-height:42vh;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:1.6;white-space:pre-wrap;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,.4);
  border:1px solid rgba(255,255,255,.08);} `;
  document.head.appendChild(style);
  const t = document.createElement('div');
  t.id = 'xhs-toast';
  t.innerHTML = `
    <div class="xhs-toast-bar">
      <span class="xhs-toast-dot"></span>
      <span id="xhs-toast-status">就绪</span>
      <span id="xhs-toast-countdown"></span>
      <button id="xhs-toast-toggle" type="button">日志</button>
    </div>
    <div class="xhs-toast-logs" id="xhs-toast-logs" style="display:none"></div>`;
  document.body.appendChild(t);
  const toggle = t.querySelector('#xhs-toast-toggle');
  const logs = t.querySelector('#xhs-toast-logs');
  toggle.addEventListener('click', () => { logs.style.display = logs.style.display === 'none' ? 'block' : 'none'; });
  window.__renderXhsToast = function () {
    const st = document.getElementById('xhs-toast-status');
    const lg = document.getElementById('xhs-toast-logs');
    if (st && window.__xhsToastStatus) st.textContent = window.__xhsToastStatus;
    if (lg) { lg.textContent = (window.__xhsToastLog || []).slice(-30).join('\n'); lg.scrollTop = lg.scrollHeight; }
  };
  if (window.__xhsToastStatus) window.__renderXhsToast();
  startToastCountdown();
}

// Toast 倒计时：读取后台写入 storage 的 nextPublishAt，读秒到「下一篇」发布时刻
function startToastCountdown() {
  if (window.__xhsCountdownTimer) return;
  const el = document.getElementById('xhs-toast-countdown');
  if (!el) return;
  window.__xhsLastCountdownAt = 0;
  window.__xhsCountdownTimer = setInterval(async () => {
    try {
      const v = await new Promise((res) => chrome.storage.local.get({ nextPublishAt: 0 }, (r) => res(r)));
      const at = v.nextPublishAt || 0;
      window.__xhsLastCountdownAt = at;
      if (at > Date.now()) {
        const s = Math.ceil((at - Date.now()) / 1000);
        const m = Math.floor(s / 60), ss = s % 60;
        el.textContent = '⏳ 下一篇：' + (m > 0 ? m + '分' : '') + ss + '秒';
      } else if (at > 0 && Date.now() - at > 5000) {
        // 已过期 5 秒以上仍未更新，可能 background 的 alarm 没被触发/SW 回收丢了，主动唤醒推进
        el.textContent = '⏳ 正在启动下一篇…';
        console.log('[黑猫] 倒计时已过期，主动唤醒 schedulerStep');
        try { chrome.runtime.sendMessage({ type: 'schedulerStep' }).catch(() => {}); } catch (e) {}
      } else {
        el.textContent = ''; // 已过期（本篇正在发/已发完），不显示
      }
    } catch (e) {}
  }, 1000);
}


// 侧栏「开始批量发布」按钮状态：发布中 / 批次进行中 / 有待发队列 三者共同决定可用性
//  - publishing：正在填+发某一篇（runFill 期间）
//  - batchActive：本批次已开始且仍有任务（防止重复点开始导致重复开标签）
//  - hasQueue：本账号在后台有待发任务（由 background getQueue 按账号统计）
window.__xhsPublish = window.__xhsPublish || { publishing: false, batchActive: false, hasQueue: false };

function updateStartBtn() {
  const btn = document.getElementById('xhs-h-start');
  if (!btn) return;
  const p = window.__xhsPublish || { publishing: false, batchActive: false, hasQueue: false };
  const disabled = p.publishing || p.batchActive || !p.hasQueue;
  btn.disabled = disabled;
  if (p.publishing || p.batchActive) btn.textContent = '发布中…';
  else if (!p.hasQueue) btn.textContent = '无待发队列';
  else btn.textContent = '开始批量发布';
  btn.classList.toggle('xhs-h-start-busy', p.publishing || p.batchActive);
}

// 向 background 查询本账号待发队列数量，刷新 hasQueue / batchActive
async function refreshQueue() {
  try {
    const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'getQueue' }, (resp) => res(resp)));
    const queued = (r && r.ok && typeof r.queued === 'number') ? r.queued : 0;
    const p = window.__xhsPublish;
    p.hasQueue = queued > 0;
    if (queued === 0) p.batchActive = false; // 队列空了，批次自然结束
    updateStartBtn();
  } catch (e) { /* 网络/背景断开时保持现状，下次刷新再试 */ }
}

// 注入侧栏 UI + 顶部 Toast
function buildPanel() {
  if (!document.getElementById('xhs-helper-css')) {
    const link = document.createElement('link');
    link.id = 'xhs-helper-css';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    document.head.appendChild(link);
  }
  buildToast();
  const box = document.createElement('div');
  box.id = 'xhs-creator-helper';
  box.setAttribute('data-xhs-helper', '1');
  box.innerHTML = `
    <div class="xhs-h-head">
      <img class="xhs-h-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="黑猫智记AI" />
      <div class="xhs-h-title">黑猫智记AI</div>
      <div class="xhs-h-drag" title="拖动">⋮⋮</div>
    </div>
    <div class="xhs-h-body">
      <span class="xhs-h-dot" id="xhs-h-dot"></span>
      <span class="xhs-h-status" id="xhs-c-status">就绪</span>
    </div>
    <div class="xhs-h-actions">
      <button class="xhs-h-start" id="xhs-h-start" type="button" disabled>无待发队列</button>
    </div>`;
  document.body.appendChild(box);
  // 侧栏「开始批量发布」按钮：等价于扩展弹窗的同一按钮（发 startPublish 给 background 调度器）
  const startBtn = box.querySelector('#xhs-h-start');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (startBtn.disabled) return;
      const status = (window.__xhsHelper && window.__xhsHelper.status) || (() => {});
      window.__xhsPublish.batchActive = true;
      updateStartBtn();
      chrome.runtime.sendMessage({ type: 'startPublish' }, (r) => {
        const ok = !!(r && r.ok);
        status(ok ? '已开始批量发布（每篇开新标签，自动发布）' : '开始失败：' + ((r && r.msg) || '未知'));
        if (!ok) { window.__xhsPublish.batchActive = false; }
        updateStartBtn();
        refreshQueue();
      });
    });
    updateStartBtn();
    refreshQueue();
    if (!window.__xhsQueueTimer) {
      window.__xhsQueueTimer = setInterval(() => { refreshQueue(); }, 15000);
    }
  }
  // 让头部可拖动整个浮窗
  if (window.XhsCommon && window.XhsCommon.xhsMakeDraggable) {
    window.XhsCommon.xhsMakeDraggable(box, box.querySelector('.xhs-h-head'));
  }
  // 统一状态输出：同时更新侧栏状态 + 顶部 Toast + 状态点颜色
  const setStatus = (t) => {
    window.__xhsToastStatus = t;
    const side = document.getElementById('xhs-c-status');
    if (side) side.textContent = t;
    if (window.__renderXhsToast) window.__renderXhsToast();
    const dot = document.getElementById('xhs-h-dot');
    if (dot) {
      dot.className = 'xhs-h-dot';
      if (/失败|错误|异常|fail|error|timeout|timed out/i.test(t)) dot.classList.add('bad');
      else if (/发布|成功|完成|ok|✓|published|已发/i.test(t)) dot.classList.add('ok');
      else if (/等待|倒计|暂停|manual|验证|挑战|识别|填表|拉取|续|计时|处理|发布中/i.test(t)) dot.classList.add('wait');
    }
  };
  window.__xhsHelper = { status: setStatus };
  setStatus('就绪');
}

if (!document.getElementById('xhs-creator-helper')) {
  if (document.body) buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);
}
