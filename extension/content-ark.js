// content-ark.js — 在商家后台注入「选品助手」面板
// 职责：扫描本页商品 → 用户勾选 → 推送到本地后端商品库。
// 设计：纯读取 + 人工触发，不注入反检测、不模拟点击、不破解。
// 健壮性：自动识别失败时，提供「手动添加」兜底，保证一定能把商品推到后端。

// ---- 可配置选择器（发布平台改版时在此调校）----
const SEL = {
  title: ['h1', '.product-title', '.goods-title', '[class*="title"]', 'input[class*="title"]', 'textarea[class*="title"]', '[class*="Title"]'],
  price: ['[class*="price"]', '[class*="Price"]', '.price', 'span[class*="price"]', '[class*="amount"]', '[class*="Amount"]'],
  image: ['.product-img img', '.goods-img img', '[class*="gallery"] img', '[class*="album"] img', '.swiper-slide img', '[class*="img"] img', '[class*="pic"] img'],
  itemIdFromUrl: /item[_-]?id[=/=]([\w-]+)/i,
};

// 用户手动「忽略」的条目签名（持久化在 chrome.storage.local.xhIgnore）
let IGNORED = new Set();
// 最近一次扫描统计（用于面板提示「已过滤 N 个无效项」）
let LAST_SCAN_STATS = { cards: 0, kept: 0, junk: 0 };
// 一条识别结果的唯一签名（用于去重 / 自动轮询比对「是否有新商品」）
function itemSignature(t) { return (t.itemId || t.image || t.productName || '').toString(); }

function txtIn(root, selList) {
  for (const s of selList) {
    const el = root.querySelector(s);
    if (el) {
      const v = (el.value ?? el.textContent ?? '').trim();
      if (v) return v;
    }
  }
  return '';
}
function imgIn(root, selList) {
  for (const s of selList) {
    const el = root.querySelector(s);
    if (el && el.src) return el.src;
  }
  return '';
}
function itemIdIn(root) {
  // 1) URL（商品详情页整页 URL，或卡片内任意链接的 href）
  const urlIds = [];
  const tryUrl = (href) => {
    if (!href) return;
    const m = href.match(/(?:item|spu|product|goods)[_-]?id[=/=]([\w-]+)/i) || href.match(/[?&](?:id)=([\w-]+)/i);
    if (m) urlIds.push(m[1]);
  };
  tryUrl(location.href);
  try {
    root.querySelectorAll('a[href]').forEach((a) => tryUrl(a.getAttribute('href')));
  } catch (e) {}
  if (urlIds.length) return urlIds[0];
  // 2) data 属性（覆盖选品各种命名：kebab / camel / 纯 id）
  const ATTRS = [
    'data-item-id', 'data-itemId', 'data-product-id', 'data-productId',
    'data-spu-id', 'data-spuId', 'data-goods-id', 'data-goodsId',
    'data-sku-id', 'data-skuId', 'data-id',
  ];
  for (const sel of ATTRS) {
    try {
      const el = root.querySelector(sel);
      if (el) {
        const v = el.getAttribute(sel);
        if (v) return String(v).trim();
      }
    } catch (e) {}
  }
  // 3) 卡片 outerHTML 中 key=value 形式的 id（兼容任意属性命名暴露 id）
  const html = (root && root.outerHTML) || '';
  const kv = html.match(/(?:id|itemId|item_id|goodsId|goods_id|productId|product_id|spuId|spu_id|skuId|sku_id)["'=:\s]+["']?([0-9a-zA-Z_-]{10,40})/i);
  if (kv) return kv[1];
  // 4) 兜底：24 位 hex（选品商品 ObjectId 风格，如 686673d41ea4cb001553c6da），取首个
  const hex = html.match(/\b[0-9a-fA-F]{24}\b/);
  if (hex) return hex[0];
  return '';
}

// 从容器抽取「商品详情链接」：优先 href 含 itemId 的详情链；兜底首个商品型链接 / 卡片内首个链接；绝对化。
// 用于「一键复制链接」功能；若页面未暴露详情链接则返回空串（复制时提示用户手动复制）。
function linkIn(root, itemId) {
  const anchors = [];
  // 自身就是 <a> 时（策略2 兜底扫描的 root 即 anchor）也要纳入
  if (root && root.tagName && root.tagName.toLowerCase() === 'a' && root.getAttribute('href')) {
    anchors.push(root);
  }
  try { root.querySelectorAll('a[href]').forEach((a) => anchors.push(a)); } catch (e) {}
  const abs = (href) => { try { return new URL(href, location.href).href; } catch (e) { return href; } };
  // 1) href 内含 itemId → 基本就是该商品详情页
  if (itemId) {
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (href && href.includes(itemId)) return abs(href);
    }
  }
  // 2) 兜底：首个商品型链接（含 item/spu/product/goods/detail 之一）
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (href && /item|spu|product|goods|detail/i.test(href)) return abs(href);
  }
  // 3) 再兜底：卡片内首个任意链接（绝对化）
  if (anchors[0]) {
    const href = anchors[0].getAttribute('href') || '';
    if (href) return abs(href);
  }
  return '';
}

// 从容器抽取「名称」：优先已知标题选择器，兜底取最长文本节点（适配改版后的 class 名）
function pickName(root) {
  const t = txtIn(root, SEL.title);
  if (t && t.length <= 60) return t;
  let best = '';
  const walk = (n) => {
    if (n.nodeType === 3) {
      const v = n.textContent.replace(/\s+/g, ' ').trim();
      if (v.length > best.length && v.length >= 2 && v.length <= 60) best = v;
    } else if (n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'img' || tag === 'svg') return;
      const role = (n.getAttribute('role') || '').toLowerCase();
      if (role === 'button' || role === 'link') return; // 避免抓到按钮/链接文字
      n.childNodes.forEach(walk);
    }
  };
  walk(root);
  return best;
}
// 从容器抽取「价格」：优先已知价格选择器，兜底正则匹配 ¥/元 后数字
function pickPrice(root) {
  const p = txtIn(root, SEL.price);
  if (p) return p.replace(/[^\d.]/g, '');
  const txt = root.textContent || '';
  const m = txt.match(/[¥￥]\s*(\d[\d,]*\.?\d*)/) || txt.match(/(\d[\d,]*\.?\d*)\s*元/)
    || txt.match(/(?:RMB|price)[:\s]*(\d[\d,]*\.?\d*)/i);
  return m ? m[1].replace(/,/g, '') : '';
}
// 从某个容器元素里读出一个商品（img 优先用传入的 bestImg，避免多图重复）
function readProductFrom(el, bestImg) {
  let image = '';
  if (bestImg) {
    image = bestImg.getAttribute('src') || bestImg.getAttribute('data-src') || bestImg.src || '';
    if (/^data:image\/(gif|png);base64,(R0lGOD|iVBOR)/.test(image)) image = (bestImg.getAttribute('data-src') || '');
  }
  if (!image) image = imgIn(el, SEL.image);
  const itemId = itemIdIn(el);
  return {
    itemId,
    productName: pickName(el),
    price: pickPrice(el),
    image: (image || '').trim(),
    link: linkIn(el, itemId), // 商品详情链接，供「一键复制」使用（未暴露则为空串）
  };
}

// 在多个候选图里挑「最佳」：优先真实 http(s) 图、尺寸大、排除 1x1 占位
function pickBestImage(imgs) {
  const valid = imgs.filter((img) => {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (/^data:image\/(gif|png);base64,(R0lGOD|iVBOR)/.test(src)) {
      return !!(img.getAttribute('data-src') && /^https?:/i.test(img.getAttribute('data-src')));
    }
    return true;
  });
  const list = valid.length ? valid : imgs;
  return list.slice().sort((a, b) => {
    const sa = (a.naturalWidth || a.width || 0) + (a.naturalHeight || a.height || 0);
    const sb = (b.naturalWidth || b.width || 0) + (b.naturalHeight || b.height || 0);
    return sb - sa;
  })[0];
}

// UI 垃圾词（精确全等才视为非商品，避免误杀「推荐款连衣裙」这类真实商品名）
const UI_NOISE = /^(新建|发布|全部|在售|下架|已售|商品列表|商品管理|确定|取消|下一页|上一页|搜索|筛选|排序|消息|通知|帮助|帮助中心|客服|客服中心|设置|我的|个人中心|账户中心|返回|首页|数据|数据中心|交易|交易中心|订单|订单中心|营销|营销中心|直播|直播中心|店铺|素材|素材中心|创作|创作中心|登录|退出|刷新|加载|更多|展开|收起|复制|删除|编辑|保存|提交|上传|下载|预览|查看|关注|粉丝|收藏|点赞|评论|分享|热销|推荐|精选|猜你喜欢|没有更多|暂无|下拉加载|联系客服|回到顶部|意见反馈)$/;

// 判断一条识别结果是否该丢弃
function isJunk(t) {
  const name = (t.productName || '').trim();
  if (!name || name.length < 2) return true;                 // 无名/过短
  if (/^[\d\s¥￥.,，。、:：\-+#]+$/.test(name)) return true;   // 纯数字/符号（计数/价格标签）
  if (UI_NOISE.test(name)) return true;                       // UI 文案
  const img = t.image || '';
  const isPlaceholder = /^data:image\/(gif|png);base64,(R0lGOD|iVBOR)/.test(img) && !/^https?:/i.test(img);
  if (isPlaceholder && !t.itemId) return true;                // 占位图且无商品ID
  return false;
}

// 向上找「最近的商品卡片」：含图、且含适量文字（不是整页/空壳/导航区）的最小祖先容器
function nearestCard(img) {
  let el = img.parentElement;
  for (let i = 0; i < 10; i++) {
    if (!el) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const hasImg = !!el.querySelector('img');
    const txtLen = (el.textContent || '').replace(/\s+/g, '').length;
    if (hasImg && txtLen >= 2 && txtLen <= 400) {
      // 排除导航/页眉/页脚/侧栏等明显非商品区
      if (!el.closest('header, footer, nav, aside, [role="navigation"], [class*="sidebar"], [class*="toolbar"]')) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

// 扫描整页：按「卡片」分组，每张卡片只出一条；并过滤 UI 垃圾与占位图
// opts.silent=true 时只返回结果，不写 window.__xhItems / LAST_SCAN_STATS（供自动轮询复用，避免污染全局）
function scanProducts(opts) {
  const silent = !!(opts && opts.silent);
  const found = [];
  const seenKeys = new Set();
  const push = (t) => {
    const key = (t.itemId || t.image || t.productName || '').toString();
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    found.push(t);
  };
  const isIgnored = (t) => IGNORED.has((t.itemId || t.image || t.productName || '').toString());

  // 策略1：合格图片 → 向上找最近卡片，按卡片分组（同一卡片多图合成一条）
  const imgs = [...document.querySelectorAll('img')].filter((img) => {
    if (img.closest('#xhs-ark-helper')) return false;        // 不扫描助手面板自身
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 40 || h < 40) return false;
    const cls = (img.className || '').toString().toLowerCase();
    if (/(avatar|head|icon|logo|banner|bg|background|decor|emoji|arrow|close|delete|edit|more|star|heart|nav|menu|tab|sort|filter|search|thumb|placeholder|skeleton|lazy|badge|tag|advert|ad)/.test(cls)) return false;
    const src = img.getAttribute('src') || '';
    if (/^data:image\/(gif|png);base64,(R0lGOD|iVBOR)/.test(src)) return false; // 1x1 占位图
    return true;
  });
  const cardMap = new Map();
  for (const img of imgs) {
    const card = nearestCard(img);
    if (!card) continue;
    let rec = cardMap.get(card);
    if (!rec) { rec = { images: [] }; cardMap.set(card, rec); }
    rec.images.push(img);
  }
  for (const [card, rec] of cardMap) {
    const best = pickBestImage(rec.images);
    const t = readProductFrom(card, best);
    if (isJunk(t) || isIgnored(t)) continue;
    push(t);
    if (found.length >= 80) break;
  }

  // 策略2：若策略1几乎没找到，退而求其次用「商品详情链接」兜底（链接内含 item 且带图）
  if (found.length < 2) {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => {
      if (a.closest('#xhs-ark-helper')) return false;
      const href = a.getAttribute('href') || '';
      return /item|spu|product|goods/i.test(href) && a.querySelector('img');
    });
    for (const a of links) {
      const t = readProductFrom(a);
      if (isJunk(t) || isIgnored(t)) continue;
      push(t);
      if (found.length >= 80) break;
    }
  }
  if (!silent) LAST_SCAN_STATS = { cards: cardMap.size, kept: found.length, junk: cardMap.size - found.length };
  return found;
}

// 后端推送：直连本地后端，绕开 MV3 service worker（避免 Extension context invalidated）。
// service worker 空闲约 30s 会被 Chrome 回收，经它中转的请求在回收瞬间会报该错。
async function pushViaBackground(products) {
  try {
    const r = await window.XhsCommon.xhsFetch('/api/ext/products', { method: 'POST', body: { products } });
    if (r.ok) return (r.data && typeof r.data.added === 'number') ? r.data : { added: products.length };
    throw new Error((r.data && r.data.msg) || ('HTTP ' + r.status));
  } catch (e) {
    // 极少数直连失败（如后端地址未初始化）时，兜底走 service worker
    try {
      const r2 = await chrome.runtime.sendMessage({ type: 'pushProducts', products });
      if (r2 && typeof r2.ok === 'boolean') return (r2.data && typeof r2.data.added === 'number') ? r2.data : { added: products.length };
    } catch (e2) { /* 忽略，抛原始错误 */ }
    throw e;
  }
}

function buildPanel() {
  if (!document.getElementById('xhs-helper-css')) {
    const link = document.createElement('link');
    link.id = 'xhs-helper-css';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    document.head.appendChild(link);
  }
  const box = document.createElement('div');
  box.id = 'xhs-ark-helper';
  box.setAttribute('data-xhs-helper', '1');
  box.innerHTML = `
    <div class="xh-head">
      <span class="xh-dot" id="xhDot" title="后端连接状态"></span>
      <span class="xh-title">黑猫智记AI</span>
      <div class="xh-drag" title="拖动面板">⋮⋮</div>
      <button class="xh-collapse" id="xhCollapse" title="折叠/展开">▾</button>
    </div>
    <div class="xh-body" id="xhBody">
      <div class="xh-connrow">
        <button class="xh-btn sm" id="xhTest">连接测试</button>
      </div>
      <div class="xh-sec">
        <div class="xh-sechead">
          <span>自动识别 <b id="xhCount" class="xh-count">0</b></span>
          <span class="xh-secact">
            <button class="xh-iconbtn" id="xhRescan" title="重新识别本页商品">🔄<span class="xh-badge" id="xhRescanBadge"></span></button>
            <label class="xh-all"><input type="checkbox" id="xhAll" checked/> 全选</label>
          </span>
        </div>
        <a id="xhClearIgnored" class="xh-clear" style="display:none">清除忽略</a>
        <div class="xh-list" id="xhList"></div>
        <input class="xh-expname" id="xhExpName" placeholder="导出文件名（可空，自动命名）"/>
        <div class="xh-btnrow">
          <button class="xh-btn" id="xhCollect">采集选中</button>
          <button class="xh-btn xh-export" id="xhExport">导出CSV</button>
        </div>
        <button class="xh-btn xh-copyall" id="xhCopyLinks">复制选中商品链接</button>
      </div>
      <details class="xh-manual">
        <summary>手动添加 / 批量粘贴</summary>
        <input id="xmName" placeholder="商品名称 *"/>
        <input id="xmPrice" placeholder="价格（选填）"/>
        <input id="xmItem" placeholder="itemId（选填）"/>
        <input id="xmImg" placeholder="图片URL（选填）"/>
        <button class="xh-btn" id="xmAdd">添加并推送</button>
        <div class="xh-batch">
          <div class="xh-batch-hint">批量粘贴（每行一个，格式：<b>名称|价格|itemId|图片</b>，后三项可空）</div>
          <textarea id="xmBatchBox" rows="5" placeholder="保温杯|99|A001|https://picsum.photos/200
运动鞋|199|A002"></textarea>
          <button class="xh-btn" id="xmBatch">批量推送</button>
        </div>
      </details>
      <div class="xh-status" id="xhStatus">就绪</div>
    </div>`;
  document.body.appendChild(box);
  // 头部可拖动整个选品面板
  if (window.XhsCommon && window.XhsCommon.xhsMakeDraggable) {
    window.XhsCommon.xhsMakeDraggable(box, box.querySelector('.xh-head'));
  }

  const $ = (id) => box.querySelector('#' + id);
  const status = (t) => { $('xhStatus').textContent = t; };
  const dot = (kind) => { $('xhDot').className = 'xh-dot ' + kind; };
  dot('idle');
  // 保活 service worker（防止推送/轮询等操作时 SW 被回收导致 Extension context invalidated）
  try { window.XhsCommon && window.XhsCommon.xhsKeepAlive(); } catch (e) {}

  // 折叠：用 class 切换（CSS 里 .xh-body 带 !important，直接改 inline display 会被覆盖，故改用 class）
  $('xhCollapse').addEventListener('click', () => {
    const b = $('xhBody');
    const collapsed = b.classList.toggle('xh-collapsed');
    $('xhCollapse').textContent = collapsed ? '▴' : '▾';
    $('xhCollapse').title = collapsed ? '展开' : '折叠/展开';
  });

  // 渲染扫描结果
  let scanning = false;
  // 自动轮询状态：记录上次渲染出的商品签名，用于检测「页面新增了商品」
  let lastRenderSignatures = new Set();
  let pollBadgeActive = false;
  let autoPollTimer = null;
  function setRescanBadge(n) { const b = $('xhRescanBadge'); if (b) { b.textContent = n > 99 ? '99+' : String(n); b.classList.add('show'); } }
  function clearRescanBadge() { const b = $('xhRescanBadge'); if (b) b.classList.remove('show'); }
  // 带「识别中」实时反馈的扫描入口：先显示扫描态，再异步执行（让 UI 先绘制）
  const scanAndRender = () => {
    if (scanning) return;
    scanning = true;
    const cEl = $('xhCount');
    cEl.textContent = '…';
    cEl.classList.add('xh-count-scan');
    const cBtn = $('xhCollect');
    if (cBtn) { cBtn.disabled = true; cBtn.classList.add('xh-busy'); }
    status('正在识别本页商品…');
    setTimeout(() => {
      try { renderList(); } finally {
        scanning = false;
        if (cBtn) { cBtn.disabled = false; cBtn.classList.remove('xh-busy'); }
        cEl.classList.remove('xh-count-scan');
      }
    }, 40);
  };

  const renderList = () => {
    const items = scanProducts();
    window.__xhItems = items;
    lastRenderSignatures = new Set(items.map(itemSignature));
    clearRescanBadge();
    pollBadgeActive = false;
    const c = $('xhCount');
    c.textContent = items.length;
    c.classList.remove('xh-count-scan');
    c.classList.add('xh-count-pop');
    setTimeout(() => c.classList.remove('xh-count-pop'), 450);
    const st = (typeof LAST_SCAN_STATS === 'object' && LAST_SCAN_STATS) || { cards: 0, kept: 0, junk: 0 };
    const list = $('xhList');
    if (!items.length) {
      list.innerHTML = '<div class="xh-empty">未自动识别到商品。请用下方「手动添加」。</div>';
      status(st.cards ? `扫描到 ${st.cards} 个候选，均无效（已自动过滤）` : '未识别到商品，可手动添加');
      bindClearIgnored();
      return;
    }
    list.innerHTML = items.map((it, i) => {
      const sig = (it.itemId || it.image || it.productName || '').toString();
      return `
      <label class="xh-item">
        <input type="checkbox" data-i="${i}" checked/>
        ${it.image ? `<img src="${escapeHtml(it.image)}" onerror="this.style.display='none'"/>` : '<span class="xh-noimg">无图</span>'}
        <span class="xh-meta">
          <span class="xh-name">${escapeHtml(it.productName || it.itemId || '未命名')}</span>
          <span class="xh-sub">${it.price ? '¥' + escapeHtml(it.price) : ''} ${it.itemId ? '· ' + escapeHtml(it.itemId) : ''}</span>
        </span>
        <button class="xh-copy" data-i="${i}" title="复制该商品链接">复制</button>
        <button class="xh-ignore" data-sig="${escapeHtml(sig)}" title="忽略此条（不再自动识别）">忽略</button>
      </label>`;
    }).join('');
    // 全选联动
    list.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', syncAll));
    // 忽略单条（持久化，下次扫描自动跳过）
    list.querySelectorAll('.xh-ignore').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sig = b.dataset.sig;
      if (sig) { IGNORED.add(sig); chrome.storage.local.set({ xhIgnore: [...IGNORED] }); }
      renderList();
    }));
    // 单条「复制链接」：点该按钮复制对应商品详情链接（不触发 checkbox 切换）
    list.querySelectorAll('.xh-copy').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const it = items[+b.dataset.i];
      if (it) copyItemLink(it, b);
    }));
    status(`已识别 ${items.length} 条商品` + (st.junk ? `（已过滤 ${st.junk} 个无效项）` : ''));
    bindClearIgnored();
  };
  function bindClearIgnored() {
    const el = $('xhClearIgnored');
    if (!el) return;
    el.style.display = IGNORED.size ? '' : 'none';
    el.textContent = '清除忽略(' + IGNORED.size + ')';
    el.onclick = (e) => { e.preventDefault(); IGNORED.clear(); chrome.storage.local.set({ xhIgnore: [] }); renderList(); };
  }
  function syncAll() {
    const boxes = [...$('xhList').querySelectorAll('input[type=checkbox]')];
    const all = $('xhAll');
    all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  }
  $('xhAll').addEventListener('change', () => {
    $('xhList').querySelectorAll('input[type=checkbox]').forEach((c) => (c.checked = $('xhAll').checked));
  });
  $('xhRescan').addEventListener('click', scanAndRender);

  // 自动轮询：每 5s 扫一次本页，若相比上次渲染「新增了商品」，给 🔄 角标 + 弹提示
  const pollPage = () => {
    if (scanning) return;
    let items;
    try { items = scanProducts({ silent: true }); } catch (e) { return; }
    const fresh = items.map(itemSignature).filter((s) => s && !lastRenderSignatures.has(s));
    if (fresh.length > 0) {
      setRescanBadge(fresh.length);
      if (!pollBadgeActive) { toast(`检测到 ${fresh.length} 条新商品，点 🔄 重新识别`, 'info'); pollBadgeActive = true; }
    } else {
      clearRescanBadge();
      pollBadgeActive = false;
    }
  };

  // 连接测试（直连后端，绕开 service worker）
  async function testConn() {
    dot('wait');
    status('连接测试中…');
    try {
      const r = await window.XhsCommon.xhsFetch('/api/settings', { method: 'GET' });
      if (r.ok) { dot('ok'); status('后端已连接：' + (await window.XhsCommon.getXhsServerUrl())); }
      else { dot('bad'); status('后端无响应：HTTP ' + r.status); }
    } catch (e) {
      dot('bad'); status('通信失败：' + e.message + '（确认后端已启动）');
    }
  }
  $('xhTest').addEventListener('click', testConn);

  // 采集选中
  $('xhCollect').addEventListener('click', async () => {
    const items = window.__xhItems || [];
    const picked = [...$('xhList').querySelectorAll('input[type=checkbox]:checked')]
      .map((c) => items[+c.dataset.i]).filter(Boolean)
      .filter((p) => p.productName || p.itemId || p.price);
    if (!picked.length) { status('请先勾选商品（或用手动添加）。'); return; }
    dot('wait'); status('采集中… ' + picked.length + ' 条');
    try {
      const r = await pushViaBackground(picked.map((p) => ({ ...p, source: 'extension' })));
      const added = (r && r.data && typeof r.data.added === 'number') ? r.data.added : picked.length;
      const updated = (r && r.data && typeof r.data.updated === 'number') ? r.data.updated : 0;
      const total = added + updated;
      dot('ok'); status(`已采集 ${total} 条到后端商品库（新增 ${added}，更新 ${updated}）`);
      toast(`已采集 ${total} 条到后端商品库`, 'ok');
      setTimeout(renderList, 600);
    } catch (e) {
      dot('bad'); status('推送失败：' + e.message);
      toast('采集失败：' + e.message, 'err');
    }
  });

  // 导出CSV：把当页商品 id+标题 写成本地 CSV（后端落盘到 csvExportDir，默认 Desktop/开店商品/csv）
  $('xhExport').addEventListener('click', async () => {
    const items = window.__xhItems || [];
    const rows = items
      .filter((p) => p.itemId || p.productName)
      .map((p) => ({ id: (p.itemId || '').toString(), title: (p.productName || '').toString() }));
    if (!rows.length) { status('没有可导出的商品，请先识别本页商品。'); return; }
    // 文件名：输入框优先；空则按页面标题 + 时间戳自动命名
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    let name = ($('xhExpName').value || '').trim();
    if (!name) {
      const t = (document.title || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30);
      name = (t || '商品导出') + '_' + stamp;
    }
    dot('wait'); status('导出 CSV 中… ' + rows.length + ' 条');
    try {
      const r = await window.XhsCommon.xhsFetch('/api/ext/export-csv', { method: 'POST', body: { rows, name } });
      if (r.ok && r.data && r.data.ok) {
        dot('ok');
        status(`已导出 ${r.data.count} 条 → ${r.data.path || ''}`);
        toast(`已导出 CSV：${r.data.path || ''}`, 'ok');
      } else {
        throw new Error((r.data && (r.data.msg || r.data.error)) || ('HTTP ' + r.status));
      }
    } catch (e) {
      dot('bad'); status('导出失败：' + e.message);
      toast('导出失败：' + e.message, 'err');
    }
  });

  // 复制选中商品链接：把勾选商品（带链接者）的详情链接按行拼成文本复制到剪贴板
  $('xhCopyLinks').addEventListener('click', async () => {
    const items = window.__xhItems || [];
    const picked = [...$('xhList').querySelectorAll('input[type=checkbox]:checked')]
      .map((c) => items[+c.dataset.i]).filter(Boolean)
      .filter((p) => p.link);
    if (!picked.length) { status('请先勾选带链接的商品（或重新识别本页）。'); return; }
    const text = picked.map((p) => p.link).join('\n');
    const ok = await copyText(text);
    if (ok) {
      status(`已复制 ${picked.length} 条商品链接到剪贴板`);
      toast(`已复制 ${picked.length} 条商品链接`, 'ok');
    } else {
      status('复制失败，请手动复制');
      toast('复制失败', 'err');
    }
  });

  // 手动添加
  $('xmAdd').addEventListener('click', async () => {
    const name = $('xmName').value.trim();
    if (!name) { status('请填写商品名称。'); return; }
    const prod = {
      productName: name,
      price: $('xmPrice').value.trim(),
      itemId: $('xmItem').value.trim(),
      image: $('xmImg').value.trim(),
      source: 'extension',
    };
    dot('wait'); status('添加中…');
    try {
      const r = await pushViaBackground([prod]);
      const added = (r && r.data && r.data.added) ?? 1;
      dot('ok');       status(`已推送 ${added} 条到后端商品库`);
      toast(`已添加并推送 ${added} 条`, 'ok');
      $('xmName').value = ''; $('xmPrice').value = ''; $('xmItem').value = ''; $('xmImg').value = '';
      setTimeout(renderList, 600);
    } catch (e) {
      dot('bad'); status('推送失败：' + e.message);
      toast('添加失败：' + e.message, 'err');
    }
  });

  // 批量粘贴推送
  $('xmBatch').addEventListener('click', async () => {
    const text = $('xmBatchBox').value.trim();
    if (!text) { status('请先粘贴商品（每行一个）。'); return; }
    const products = text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const [productName, price, itemId, image] = line.split('|').map((s) => s.trim());
      return {
        productName: productName || ('商品' + (i + 1)),
        price: price || '', itemId: itemId || '', image: image || '',
        source: 'extension',
      };
    });
    if (!products.length) { status('没有可添加的商品'); return; }
    dot('wait'); status('批量推送中… ' + products.length + ' 条');
    try {
      const r = await pushViaBackground(products);
      const added = (r && r.data && r.data.added) ?? products.length;
      dot('ok'); status(`已推送 ${added} 条到后端商品库`);
      toast(`已批量推送 ${added} 条`, 'ok');
      $('xmBatchBox').value = '';
      setTimeout(renderList, 600);
    } catch (e) {
      dot('bad'); status('推送失败：' + e.message);
      toast('批量推送失败：' + e.message, 'err');
    }
  });

  // 载入已忽略列表，再首次渲染
  chrome.storage.local.get({ xhIgnore: [] }, (v) => {
    IGNORED = new Set(Array.isArray(v.xhIgnore) ? v.xhIgnore : []);
    scanAndRender();
    testConn();
    autoPollTimer = setInterval(pollPage, 5000);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 复制到剪贴板：优先 navigator.clipboard（需 https + clipboardWrite 权限），
// 兜底 textarea + execCommand（兼容非聚焦 / 旧环境）。返回是否成功。
async function copyText(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(v);
      return true;
    }
  } catch (e) { /* 落到 execCommand 兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

// 复制单条商品链接，并给按钮一个「✓」瞬时反馈
async function copyItemLink(it, btn) {
  const link = (it && it.link) || '';
  if (!link) { toast('该商品无可用链接（页面未提供详情链接）', 'err'); return; }
  const ok = await copyText(link);
  if (ok) {
    toast('已复制链接：' + ((it.productName || it.itemId || '商品').slice(0, 12)), 'ok');
    if (btn) { const old = btn.textContent; btn.textContent = '✓'; setTimeout(() => { if (btn.parentNode) btn.textContent = old; }, 1200); }
  } else {
    toast('复制失败，请手动复制', 'err');
  }
}

// 轻量 in-page Toast（不依赖浏览器通知权限）：在面板左侧滑入，自动消失
let toastBox = null;
function toast(msg, kind) {
  kind = kind || 'ok';
  try {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.id = 'xh-ark-toasts';
      document.body.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.className = 'xh-toast xh-toast-' + kind;
    t.textContent = msg;
    toastBox.appendChild(t);
    requestAnimationFrame(() => t.classList.add('xh-toast-in'));
    setTimeout(() => {
      t.classList.remove('xh-toast-in');
      setTimeout(() => { if (t.parentNode) t.remove(); }, 320);
    }, 2400);
  } catch (e) { /* 兜底：toast 失败不应影响主流程 */ }
}

if (!document.getElementById('xhs-ark-helper')) {
  if (document.body) buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);
}
