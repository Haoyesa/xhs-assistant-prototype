// content-xhs.js — 小红书前台热点采集（探索页 / 搜索结果页 / 商城·商品页）
// 功能：通用启发式识别页面上的「热点笔记」与「热点商品」卡片（页面所见即所得，卡片级数据），
//       悬浮面板一键「写入飞书」（后端自动分笔记表/商品表）、「复制链接」。
// 依赖：extension/common.js 的 window.XhsCommon（xhsFetch / xhsMakeDraggable / xhsKeepAlive）；
//       样式复用 extension/panel.css 的 xh-* 类。
// 注意：小红书前台 DOM 类名会混淆/改版，本文件全部用「通用启发式」（链接模式+图片+文本长度）
//       而非硬编码类名；若某页面识别不理想，按实际页面截图反馈后针对性调优。
(function () {
  if (window.__xhsHelperXhs) return; // 防重复注入（同一页面刷新后旧实例已销毁，标志位只在本次注入周期内有效）
  window.__xhsHelperXhs = true;

  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const abs = (href) => { try { return new URL(href, location.href).href; } catch { return href || ''; } };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  // 页面类型：note=笔记流（探索/首页），product=商城/商品详情，mixed=搜索结果页（两种卡片都扫）
  const PAGE_TYPE = (() => {
    const p = location.pathname;
    if (/\/search/.test(p)) return 'mixed';
    if (/\/mall|\/goods|\/item\//.test(p)) return 'product';
    return 'note';
  })();

  // 笔记详情页：/explore/{id} 或 /search_result/{id}（第二段为纯 id）。搜索列表页是 /search_result?keyword=（无 id 段）
  const DETAIL = (() => {
    const m = location.pathname.match(/^\/(explore|search_result)\/([\w-]+)/);
    return m ? { noteId: m[2] } : null;
  })();

  // 当前搜索关键词（搜索页 URL ?keyword=xxx）
  function pageKeyword() {
    try {
      const k = new URLSearchParams(location.search).get('keyword');
      return k ? decodeURIComponent(k).trim() : '';
    } catch { return ''; }
  }

  // 抽发布时间：卡片相对时间（「5天前」「3小时前」「刚刚」等）→ 绝对时间 YYYY-MM-DD HH:mm
  function pickPublishTime(card) {
    const now = Date.now();
    const fmt = (ms) => {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const txt = clean(card.innerText || '');
    let m = txt.match(/(\d+)\s*分钟前/); if (m) return fmt(now - +m[1] * 60000);
    m = txt.match(/(\d+)\s*小时前/); if (m) return fmt(now - +m[1] * 3600000);
    m = txt.match(/(\d+)\s*天前/); if (m) return fmt(now - +m[1] * 86400000);
    m = txt.match(/(\d+)\s*周前/); if (m) return fmt(now - +m[1] * 7 * 86400000);
    m = txt.match(/(\d+)\s*个月前/); if (m) return fmt(now - +m[1] * 30 * 86400000);
    if (/刚刚/.test(txt)) return fmt(now);
    return '';
  }

  // 数字归一化：「1.2万」→ 12000，「3.4k」→ 3400；无则空串
  function toCount(s) {
    const m = String(s || '').match(/([\d.]+)\s*([万wWkK]?)/);
    if (!m) return '';
    let n = parseFloat(m[1]);
    if (m[2] && /[万wW]/.test(m[2])) n *= 10000;
    else if (m[2] && /k/i.test(m[2])) n *= 1000;
    return n >= 10000 ? (Math.round((n / 10000) * 10) / 10) + '万' : String(Math.round(n));
  }

  // 抽作者昵称：先用「作者:xx」「by xx」关键字；否则遍历 DOM 文本节点找
  // 「2~20 字、不含数字/标点、像昵称」的候选（小红书作者区常在左下）
  function pickAuthor(card) {
    const txt = clean(card.innerText || '');
    let m = txt.match(/(?:作者|by|@)\s*[:：]?\s*([^\s\n]{2,20})/i);
    if (m) return m[1];
    const UI_NOISE = /^(笔记|分享|收藏|点赞|评论|转发|已售|销量|月售|店铺|综合|免费|最新|最热|图文|视频|筛选|搜索|首页|发现|直播|发布)$/;
    const candidates = [];
    const tw = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = tw.nextNode())) {
      const v = clean(n.textContent);
      if (v.length < 2 || v.length > 20) continue;
      if (/^[\d\s¥￥.,，。、:：\-+#%年月日]+$/.test(v)) continue; // 纯数字/UI 词
      if (UI_NOISE.test(v)) continue;
      candidates.push(v);
    }
    // 取第一个像昵称的（短、含中文/英文/数字混合的纯文本）
    return candidates[0] || '';
  }

  // 抽四个互动数（赞/藏/评/转）：
  // 1) 优先 innerText「关键词+数字」模式
  // 2) 失败时遍历 DOM 找「数字文本节点」（含「1.2万」/「224」/「9+」），按出现顺序映射
  function pickInteractions(card) {
    const out = { likes: '', collects: '', comments: '', shares: '' };
    const txt = clean(card.innerText || '');
    if (!txt) return out;
    // 1) 关键词匹配
    const keywordMap = [
      { key: 'likes', kws: ['点赞', '获赞', '赞'] },
      { key: 'collects', kws: ['收藏', '藏'] },
      { key: 'comments', kws: ['评论', '留言'] },
      { key: 'shares', kws: ['转发', '分享'] },
    ];
    for (const { key, kws } of keywordMap) {
      for (const kw of kws) {
        const re = new RegExp(kw + '\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?\\s*[万wWkK]?)');
        const m = txt.match(re);
        if (m) { out[key] = toCount(m[1]); break; }
      }
    }
    // 2) DOM 数字节点：抓所有 leaf 文本节点匹配「短数字」，按出现顺序补齐空槽
    const numNodes = [];
    const tw = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = tw.nextNode())) {
      const v = clean(n.textContent);
      if (/^(\d+(?:\.\d+)?[万wWkK]?|\d+\+)$/.test(v)) numNodes.push(v);
    }
    const slots = ['likes', 'collects', 'comments', 'shares'];
    let idx = 0;
    for (const s of slots) {
      if (!out[s] && numNodes[idx]) { out[s] = toCount(numNodes[idx]); idx++; }
    }
    return out;
  }

  // 抽价格：¥/￥/元 后数字
  function pickPrice(card) {
    const txt = clean(card.innerText || '');
    const m = txt.match(/[¥￥]\s*([\d,]+\.?\d*)/) || txt.match(/([\d,]+\.?\d*)\s*元/);
    return m ? m[1].replace(/,/g, '') : '';
  }

  // 抽销量/已售（商品专用）
  function pickSales(card) {
    const txt = clean(card.innerText || '');
    const m = txt.match(/(?:已售|销量|月售)\s*[:：]?\s*(\d+(?:\.\d+)?\s*[万wWkK]?)/);
    if (m) return toCount(m[1]);
    return '';
  }

  // 向上找「最近的可读卡片容器」：含图 + 文本量适中（排除导航/页眉/整页壳）
  function nearestCard(el, maxDepth = 6) {
    let cur = el && el.parentElement;
    for (let i = 0; cur && i < maxDepth; i++) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      if (cur.closest('header, footer, nav, aside, [role="navigation"]')) { cur = cur.parentElement; continue; }
      const hasImg = !!cur.querySelector('img');
      const txtLen = (cur.innerText || '').replace(/\s+/g, '').length;
      if (hasImg && txtLen >= 4 && txtLen <= 500) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // 头像图特征：CDN 域名 sns-avatar / 路径含 /avatar/ / 头像裁剪参数（w/80 等小尺寸）
  const isAvatar = (src) => /sns-avatar|avatar\/|avatar\.|\/avatar\//i.test(src || '');

  // 取卡片封面图：1) <img>（排除头像/占位）2) 兜底 div 背景图 / data-src（小红书封面常是 div 背景，非 img）
  function bestImg(card) {
    const imgs = $$('img', card).filter((im) => {
      const src = im.getAttribute('src') || im.getAttribute('data-src') || '';
      if (/^data:image\/(gif|png);base64,(R0lGOD|iVBOR)/.test(src)) return false; // 1x1 占位
      if (isAvatar(src)) return false; // 头像图直接排除
      return src.length > 10;
    });
    // 取「尺寸最大」的图（封面 100+，头像 24~48），避免 DOM 顺序里头像在前时抽到小头像
    imgs.sort((a, b) => {
      const sa = (a.naturalWidth || a.offsetWidth || 0) + (a.naturalHeight || a.offsetHeight || 0);
      const sb = (b.naturalWidth || b.offsetWidth || 0) + (b.naturalHeight || b.offsetHeight || 0);
      return sb - sa;
    });
    if (imgs[0]) return imgs[0];
    // 兜底：找背景图 div（background-image 或 data-src），同样排除头像特征
    for (const el of $$('[style*="background-image"], [data-src]', card)) {
      let src = el.getAttribute('data-src') || '';
      const bg = (el.getAttribute('style') || '').match(/url\(['"]?(.*?)['"]?\)/i);
      if (!src && bg) src = bg[1];
      if (src && !isAvatar(src) && src.length > 10) return { getAttribute: (k) => (k === 'src' ? src : null), src };
    }
    return null;
  }

  function linkOf(card) {
    for (const a of $$('a[href]', card)) {
      const href = abs(a.getAttribute('href'));
      if (/(explore|item|goods|search_result)\//.test(href)) return href;
    }
    return '';
  }

  // 过滤无效锚点：用户主页/直播/店铺/官方等非笔记商品链接，或包着「小尺寸图」（头像/icon/二维码）
  function isJunkAnchor(a) {
    const href = a.getAttribute('href') || '';
    // 1) 非笔记/商品相关链接直接排除（user/live/shop/brand/topic/official/board 等）
    if (/\/(user|live|shop|brand|topic|official|board|discover\/null)\//.test(href)) return true;
    // 2) 锚点自身含图片：若最大图 < 60px（头像/icon 几乎都 24~48，封面通常 100+）则视为头像/icon
    const imgs = a.querySelectorAll('img');
    if (imgs.length) {
      let maxDim = 0;
      imgs.forEach((im) => {
        const w = im.naturalWidth || im.offsetWidth || parseFloat(im.getAttribute('width') || 0) || 0;
        const h = im.naturalHeight || im.offsetHeight || parseFloat(im.getAttribute('height') || 0) || 0;
        maxDim = Math.max(maxDim, w, h);
      });
      if (maxDim < 60) return true;
    }
    return false;
  }

  // 抽店铺名：尝试「店铺:xx」格式；否则取卡片末尾非数字短文本作为兜底
  function pickTitleShop(card) {
    const txt = clean(card.innerText || '');
    const m = txt.match(/店铺\s*[:：]?\s*([^\s\n]{2,20})/);
    if (m) return m[1];
    return '';
  }

  // 抽标题：卡片内最长的非按钮/链接纯文本（2~60 字）
  function pickTitle(card) {
    let best = '';
    const walk = (n) => {
      if (n.nodeType === 3) {
        const v = clean(n.textContent);
        if (v.length >= 2 && v.length <= 60 && v.length > best.length) best = v;
      } else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'img' || tag === 'svg') return;
        const role = (n.getAttribute('role') || '').toLowerCase();
        if (role === 'button' || role === 'link') return;
        n.childNodes.forEach(walk);
      }
    };
    walk(card);
    return best;
  }

  // 识别一条记录：type=note 笔记卡片 / product 商品卡片
  function readCard(card, type) {
    const imgEl = bestImg(card);
    const image = (imgEl && (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '')) || '';
    const link = linkOf(card);
    if (type === 'product') {
      return {
        type: 'product',
        itemId: (link.match(/\/(?:item|goods)\/([\w-]+)/) || [])[1] || '',
        productName: pickTitle(card),
        price: pickPrice(card),
        sales: pickSales(card),
        shop: pickTitleShop(card),
        image,
        link,
      };
    }
    const ia = pickInteractions(card);
    return {
      type: 'note',
      noteId: (link.match(/\/(?:explore|search_result)\/([\w-]+)/) || [])[1] || '',
      title: pickTitle(card),
      author: pickAuthor(card),
      likes: ia.likes,
      collects: ia.collects,
      comments: ia.comments,
      shares: ia.shares,
      publishTime: pickPublishTime(card),
      keyword: pageKeyword(),
      image,
      link,
    };
  }

  // 页面级扫描：返回 [{ type:'note'|'product', ... }]
  function scanPage() {
    const out = [];
    const seen = new Set();
    const push = (t) => {
      // 主键去重：同一 noteId/itemId 只保留一条（一张卡片有 explore/search_result 多个详情链接，
      // 旧逻辑用 link+type 去重导致同一笔记重复识别）
      const id = (t.type === 'note' ? t.noteId : t.itemId) || '';
      const key = (id ? id + '|' + t.type : (t.link || t.image || '') + '|' + t.type);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    // 商品详情页 /item/xxx：整页当一张商品卡片
    if (/\/item\//.test(location.pathname)) {
      const body = document.body;
      const t = readCard(body, 'product');
      if (t.productName || t.price) push(t);
    }
    // 通用：按「链接模式」找候选锚点 → 上溯卡片 → 判定类型
    for (const a of $$('a[href]')) {
      const href = a.getAttribute('href') || '';
      let type = null;
      if (/(explore|search_result)\//.test(href) && !/(item|goods)\//.test(href)) type = 'note';
      else if (/(item|goods)\//.test(href) || /\/mall/.test(href)) type = 'product';
      if (!type) continue;
      if (isJunkAnchor(a)) continue; // 头像/icon/用户主页等小图链接直接跳过
      if (PAGE_TYPE === 'note' && type === 'product') continue; // 探索页只认笔记
      const card = nearestCard(a, 8);
      if (!card) continue;
      const t = readCard(card, type);
      // 必须带「详情链接」才是有效卡片：头像/icon/用户主页等容器无 explore/item/goods/search_result 链接
      if (!t.link) continue;
      if (type === 'product' ? (t.productName || t.price) : (t.title || t.image || t.link)) push(t);
      if (out.length >= 120) break;
    }
    return out;
  }

  // ---- 面板 ----
  function buildPanel() {
    if (!document.getElementById('xhs-helper-css')) {
      const link = document.createElement('link');
      link.id = 'xhs-helper-css';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('panel.css');
      document.head.appendChild(link);
    }
    const box = document.createElement('div');
    box.id = 'xhs-xhs-helper';
    box.setAttribute('data-xhs-helper', '1');
    box.innerHTML = `
      <div class="xh-head">
        <span class="xh-dot" id="xhDot" title="后端连接状态"></span>
        <span class="xh-title">黑猫智记AI · 热点采集</span>
        <div class="xh-drag" title="拖动面板">⋮⋮</div>
        <button class="xh-collapse" id="xhCollapse" title="折叠/展开">▾</button>
      </div>
      <div class="xh-body" id="xhBody">
        <div class="xh-sec">
          <div class="xh-sechead">
            <span>本页识别 <b id="xhCount" class="xh-count">0</b> <em id="xhType" style="font-style:normal;color:#9aa3b2;font-size:11px"></em></span>
            <span class="xh-secact">
              <button class="xh-iconbtn" id="xhRescan" title="重新识别本页">🔄</button>
            </span>
          </div>
          <div class="xh-list" id="xhList"></div>
          <div class="xh-btnrow">
            <button class="xh-btn xh-export" id="xhFeishu">写入飞书</button>
            <button class="xh-btn" id="xhDetail">采集详情（图文+互动数）</button>
            <button class="xh-btn" id="xhCopy">复制链接</button>
          </div>
        </div>
        <div class="xh-status" id="xhStatus">就绪</div>
      </div>`;
    document.body.appendChild(box);
    if (window.XhsCommon && window.XhsCommon.xhsMakeDraggable) window.XhsCommon.xhsMakeDraggable(box, box.querySelector('.xh-head'));
    try { window.XhsCommon && window.XhsCommon.xhsKeepAlive(); } catch {}

    const $id = (id) => box.querySelector('#' + id);
    const status = (t) => { $id('xhStatus').textContent = t; };
    const dot = (k) => { $id('xhDot').className = 'xh-dot ' + k; };
    dot('idle');
    $id('xhType').textContent = { note: '· 探索页(笔记)', product: '· 商城/商品页', mixed: '· 搜索页(笔记+商品)' }[PAGE_TYPE] || '';

    $id('xhCollapse').addEventListener('click', () => {
      const b = $id('xhBody');
      const c = b.classList.toggle('xh-collapsed');
      $id('xhCollapse').textContent = c ? '▴' : '▾';
    });

  // 调试通道：把 items 序列化到 <html data-xhs-items="..."> 属性上
  // （isolated world 与 page world 共享同一个 DOM，CSP 免疫，无需注入脚本）。
  // DevTools 控制台读取：JSON.parse(document.documentElement.dataset.xhsItems || '[]')
  function syncItems() {
    try {
      document.documentElement.setAttribute('data-xhs-items', JSON.stringify(items));
    } catch (e) { /* JSON 过大或含循环引用时忽略，仅影响调试 */ }
  }

  let items = [];
  syncItems();
  const render = () => {
      const list = $id('xhList');
      $id('xhCount').textContent = items.length;
      if (!items.length) {
        list.innerHTML = '<div class="xh-empty">未识别到卡片。滚动页面加载更多后点 🔄；<br/>若始终为 0，截商品列表图反馈（前台 DOM 改版需适配）。</div>';
        return;
      }
      list.innerHTML = items.map((it, i) => `
        <label class="xh-item">
          <input type="checkbox" data-i="${i}" checked/>
          ${it.image ? `<img src="${esc(it.image)}" onerror="this.style.display='none'"/>` : '<span class="xh-noimg">无图</span>'}
          <span class="xh-meta">
            <span class="xh-name">${esc(it.title || it.productName || '未命名')}</span>
            <span class="xh-sub">${it.type === 'product' ? '商品 ' + esc(it.price ? '¥' + it.price : '') : '笔记 ' + esc(it.likes ? '赞' + it.likes : '')} ${it.link ? '' : '· 无链接'}</span>
          </span>
        </label>`).join('');
      list.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {}));
    };

    const doScan = () => {
      status('正在识别本页…');
      setTimeout(() => {
        try {
          items = scanPage();
          syncItems(); // 同步到 page world（DevTools 可读）
          render();
          status(`识别到 ${items.length} 条（${items.filter((x) => x.type === 'note').length} 笔记 / ${items.filter((x) => x.type === 'product').length} 商品）`);
        } catch (e) {
          status('识别出错：' + e.message);
        }
      }, 30);
    };
    $id('xhRescan').addEventListener('click', doScan);

    // 写入飞书（后端按 items[0].type 分流：note→热点笔记表，product→商品数据表）
    $id('xhFeishu').addEventListener('click', async () => {
      const picked = [...$id('xhList').querySelectorAll('input[type=checkbox]:checked')]
        .map((c) => items[+c.dataset.i]).filter(Boolean);
      if (!picked.length) { status('请先勾选要写入的卡片（或点 🔄 识别）。'); return; }
      const btn = $id('xhFeishu');
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = '写入中…';
      dot('wait'); status('正在写入飞书… ' + picked.length + ' 条');
      try {
        const r = await window.XhsCommon.xhsFetch('/api/feishu/export', { method: 'POST', body: { type: picked[0].type, items: picked } });
        if (!r.ok) {
          const err = (r.data && (r.data.msg || r.data.error)) || ('HTTP ' + r.status);
          if (/feishu-not-configured/.test(err)) status('未配置飞书：请到桌面端「设置 → 飞书多维表格」填 App ID/Secret');
          else status('写入失败：' + err);
          dot('bad');
        } else {
          const d = r.data || {};
          dot('ok');
          status(`已写入飞书 ${d.count ?? picked.length} 条` + (d.url ? '，表格：' + d.url : ''));
        }
      } catch (e) {
        dot('bad'); status('写入失败：' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    });

    // 复制链接
    $id('xhCopy').addEventListener('click', async () => {
      const picked = [...$id('xhList').querySelectorAll('input[type=checkbox]:checked')]
        .map((c) => items[+c.dataset.i]).filter(Boolean).filter((p) => p.link);
      if (!picked.length) { status('没有可复制的链接（先勾选）。'); return; }
      const ok = await copyText(picked.map((p) => p.link).join('\n'));
      status(ok ? `已复制 ${picked.length} 条链接` : '复制失败，请手动复制');
    });

    // 采集详情（深采）：对勾选笔记逐个后台打开详情页（串行、间隔防风控），
    // 详情页 content script 抓正文图片/发布时间/精确赞藏评转/封面图/正文 并 POST 后端缓存，
    // 「写入飞书」时自动合并覆盖卡片级不准的字段。
    $id('xhDetail').addEventListener('click', async () => {
      const picked = [...$id('xhList').querySelectorAll('input[type=checkbox]:checked')]
        .map((c) => items[+c.dataset.i]).filter(Boolean)
        .filter((p) => p.type === 'note' && p.link && p.noteId);
      if (!picked.length) { status('请先勾选要采集详情的笔记。'); return; }
      if (!chrome.runtime || !chrome.runtime.sendMessage) { status('当前环境不支持后台开标签（请用浏览器加载扩展）。'); return; }
      const btn = $id('xhDetail');
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = '采集中…';
      dot('wait'); status(`采集详情中 0/${picked.length}…`);
      let okCount = 0;
      for (let i = 0; i < picked.length; i++) {
        const p = picked[i];
        try {
          const r = await chrome.runtime.sendMessage({ type: 'openDetail', url: p.link });
          if (r && r.ok) okCount++;
        } catch (e) { /* 单个失败继续 */ }
        status(`采集详情中 ${i + 1}/${picked.length}（成功 ${okCount}）…`);
      }
      btn.disabled = false; btn.textContent = old;
      dot('ok');
      status(`详情采集完成：${okCount}/${picked.length} 篇（每篇约 6~8s）`);
      toast(`详情采集完成 ${okCount}/${picked.length} 篇，写入飞书时带上`, 'ok');
    });

    // 首次自动识别
    doScan();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText ='position:fixed;opacity:0;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  // 简易 toast：3 秒后自动消失，多个叠加（顶部右上）
  function toast(msg, kind) {
    const host = document.getElementById('__xhs_toast_host') || (() => {
      const h = document.createElement('div');
      h.id = '__xhs_toast_host';
      h.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;pointer-events:none';
      document.body.appendChild(h);
      return h;
    })();
    const el = document.createElement('div');
    const bg = kind === 'err' ? 'rgba(232,76,76,.92)' : kind === 'ok' ? 'rgba(46,160,67,.92)' : 'rgba(0,0,0,.78)';
    el.style.cssText = `background:${bg};color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;line-height:1.4;max-width:340px;box-shadow:0 4px 12px rgba(0,0,0,.25);animation:xhsToastIn .25s ease`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 2700);
    setTimeout(() => el.remove(), 3100);
  }

  // ---- 笔记详情页模式：抓正文图片/发布时间/精确赞藏评转/封面图/正文，POST 后端缓存（按 noteId 覆盖）----
  // 卡片级拿不到/拿不准的字段都在这里补救（搜索结果页卡片不显示评论/不显示封面大图 → 必须详情深采）
  if (DETAIL) {
    // 自动滚动触发懒加载（正文图片多为懒加载，不滚动可能拿不到）
    try {
      const scrollPass = () => {
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => window.scrollTo(0, 0), 600);
      };
      setTimeout(scrollPass, 600);
    } catch (e) {}
    // 多轮抓取（2s 首屏 + 5s 懒加载后），合并结果幂等覆盖；background 约 6~8.5s 后关标签
    const grab = () => {
      try {
        const imgs = [];
        const seen = new Set();
        let cover = '';
        let coverW = 0;
        for (const im of document.querySelectorAll('img')) {
          // 懒加载图常在 data-src / data-xhs-img-src
          const src = im.getAttribute('data-xhs-img-src') || im.getAttribute('data-src') || im.getAttribute('src') || '';
          if (!src || src.length < 20 || isAvatar(src)) continue;
          if (seen.has(src)) continue;
          seen.add(src);
          const w = im.naturalWidth || im.offsetWidth || 0;
          const h = im.naturalHeight || im.offsetHeight || 0;
          if (w * h > coverW) { coverW = w * h; cover = src; }
          imgs.push(src);
        }
        const bodyText = document.body.innerText || '';
        // 发布时间（详情页顶部绝对时间优先）
        let publishTime = '';
        const pm = bodyText.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?\s*(\d{1,2})?:?(\d{1,2})?/);
        if (pm) {
          const p = (n) => String(n || 0).padStart(2, '0');
          publishTime = `${pm[1]}-${p(pm[2])}-${p(pm[3])} ${p(pm[4])}:${p(pm[5] || '00')}`;
        } else {
          const rel = bodyText.match(/(\d+)\s*(分钟|小时|天|周|个月)前/);
          if (rel) {
            const n = +rel[1];
            const ms = { '分钟': 60000, '小时': 3600000, '天': 86400000, '周': 7 * 86400000, '个月': 30 * 86400000 }[rel[2]] || 0;
            if (ms) {
              const d = new Date(Date.now() - n * ms);
              const p = (x) => String(x).padStart(2, '0');
              publishTime = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
            }
          }
        }
        // 互动数：先关键词（数字+词 / 词+数字 双向），再「底部位置兜底」——
        // 小红书详情页互动区是「icon+数字」无文字，只能按底部数字序列顺序映射 赞/藏/评/转
        const countMap = { 点赞: 'likes', 赞: 'likes', 收藏: 'collects', 藏: 'collects', 评论: 'comments', 回复: 'comments', 转发: 'shares', 分享: 'shares' };
        const interactions = {};
        for (const [word, key] of Object.entries(countMap)) {
          let m = bodyText.match(new RegExp('(\\d+(?:\\.\\d+)?\\s*[万wWkK]?)\\s*' + word));
          if (!m) m = bodyText.match(new RegExp(word + '\\s*(\\d+(?:\\.\\d+)?\\s*[万wWkK]?)'));
          if (m) interactions[key] = toCount(m[1].trim());
        }
        // 底部位置兜底：取 bodyText 尾部 500 字符内的数字序列（互动区一般在作者/评论区下方）
        if (!(interactions.likes && interactions.collects && interactions.comments)) {
          const tail = bodyText.slice(-500);
          const nums = [...tail.matchAll(/(\d+(?:\.\d+)?[万wWkK]?)/g)].map((m) => toCount(m[1])).filter(Boolean);
          if (!interactions.likes && nums[0]) interactions.likes = nums[0];
          if (!interactions.collects && nums[1]) interactions.collects = nums[1];
          if (!interactions.comments && nums[2]) interactions.comments = nums[2];
          if (!interactions.shares && nums[3]) interactions.shares = nums[3];
        }
        // 正文前 500 字
        const noteEl = document.querySelector('#note-desc, .note-content, [class*="desc"], [class*="content"]') || document.body;
        const body = clean(noteEl.innerText || '').slice(0, 500);
        if (imgs.length || publishTime || cover || body || Object.keys(interactions).length) {
          window.XhsCommon.xhsFetch('/api/feishu/note-detail', {
            method: 'POST',
            body: {
              noteId: DETAIL.noteId,
              bodyImages: imgs.slice(0, 30),
              publishTime,
              title: document.title,
              cover,
              body,
              likes: interactions.likes || '',
              collects: interactions.collects || '',
              comments: interactions.comments || '',
              shares: interactions.shares || '',
            },
          }).catch(() => {});
        }
      } catch (e) { /* 抓取失败不影响页面 */ }
    };
    setTimeout(grab, 2000); // 首屏
    setTimeout(grab, 5000); // 懒加载后再抓一次（幂等覆盖）
    return; // 详情页不注入面板
  }

  // 注入面板（document_idle 已过，直接构建；延迟一小段确保 DOM 就绪）
  setTimeout(buildPanel, 300);
})();
