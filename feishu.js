// feishu.js — 飞书多维表格写入模块
// 能力：tenant_access_token 获取与缓存、首次自动建「多维表格 → 数据表 → 字段」、
//       批量写入商品记录（每批 ≤500 条）。
// 数据流：千帆选品插件采集商品 → POST /api/feishu/export → 本模块写入飞书多维表格。
// 依赖：仅 Node 内置 fetch（Node ≥18），无第三方库；被 server.js import，勿反向依赖 server.js。

// 中国区飞书开放平台基址（非 larksuite 国际版）
const FEISHU_BASE = 'https://open.feishu.cn';

// 出站请求统一超时（20s），防飞书侧挂死拖垮本地服务
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 多维表格「商品数据」字段（type: 1 = 多行文本；用文本兜住价格/销量等任意形态，避免类型错误整批失败）
export const PRODUCT_FIELDS = [
  { field_name: '商品ID', type: 1 },
  { field_name: '商品名称', type: 1 },
  { field_name: '价格', type: 1 },
  { field_name: '销量', type: 1 },
  { field_name: 'SKU', type: 1 },
  { field_name: '店铺/卖家', type: 1 },
  { field_name: '图片链接', type: 1 },
  { field_name: '商品链接', type: 1 },
  { field_name: '采集时间', type: 1 },
];

// 多维表格「热点笔记」字段（前台探索/搜索页采的热门笔记，卡片级数据）
export const NOTE_FIELDS = [
  { field_name: '笔记标题', type: 1 },
  { field_name: '作者', type: 1 },
  { field_name: '点赞', type: 1 },
  { field_name: '收藏', type: 1 },
  { field_name: '评论', type: 1 },
  { field_name: '转发', type: 1 },
  { field_name: '封面图', type: 1 },
  { field_name: '笔记链接', type: 1 },
  { field_name: '采集时间', type: 1 },
];

// tenant_access_token 缓存：expire - 5min 提前刷新
let cachedToken = { value: '', expireAt: 0 };

async function getTenantToken(appId, appSecret) {
  if (cachedToken.value && Date.now() < cachedToken.expireAt) return cachedToken.value;
  const r = await fetchWithTimeout(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 0 || !j.tenant_access_token) {
    throw new Error(`飞书凭证校验失败（${r.status}）：${j.msg || j.code || '未知错误'}。请检查设置页的 App ID / App Secret`);
  }
  cachedToken = { value: j.tenant_access_token, expireAt: Date.now() + (j.expire || 7200) * 1000 - 5 * 60 * 1000 };
  return cachedToken.value;
}

// 飞书 API 通用调用：自动带 tenant token，返回业务 JSON
async function feishuApi(token, method, apiPath, body) {
  const r = await fetchWithTimeout(`${FEISHU_BASE}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    const msg = j.msg || j.code || ('HTTP ' + r.status);
    if (/permission|权限|scope|forbidden|forbidden_error/i.test(msg)) {
      throw new Error(`飞书权限不足：${msg}。请在飞书开放平台给应用开通「多维表格」读写权限（bitable:app 等）并发布新版本`);
    }
    if (r.status === 401) throw new Error(`飞书鉴权失败（401）：${msg}`);
    throw new Error(`飞书接口错误 ${apiPath.split('/').slice(-2).join('/')}：${msg}`);
  }
  return j;
}

// 由 app_token 拼出多维表格网页地址（用于前端展示「打开表格」链接）
// 由 app_token (+ table_id) 拼出多维表格网页地址（用于前端展示「打开表格」链接）
// 带 tableId 时直接落到目标表，避免飞书网页默认跳到「数据表」让用户看到空表
export function feishuTableUrl(appToken, tableId) {
  if (!appToken) return '';
  const base = `https://feishu.cn/base/${appToken}`;
  return tableId ? `${base}?table=${tableId}` : base;
}

// 确保多维表格已就绪：已配置 appToken+tableId 则复用；否则自动创建（多维表格→数据表含全部字段）。
// 返回 { appToken, tableId, url, created }
export async function ensureFeishuBitable(settings) {
  const appId = (settings.feishuAppId || '').trim();
  const appSecret = (settings.feishuAppSecret || '').trim();
  if (!appId || !appSecret) {
    throw new Error('feishu-not-configured: 请先在设置页填写飞书 App ID 与 App Secret');
  }
  // 已建好：直接复用
  if (settings.feishuAppToken && settings.feishuTableId) {
    return {
      appToken: settings.feishuAppToken,
      tableId: settings.feishuTableId,
      url: feishuTableUrl(settings.feishuAppToken),
      created: false,
    };
  }
  const token = await getTenantToken(appId, appSecret);
  // 1) 创建多维表格应用（仅在完全没建过时；已有 appToken 但缺 tableId 时跳过建 app）
  let appToken = (settings.feishuAppToken || '').trim();
  let url = feishuTableUrl(appToken);
  if (!appToken) {
    const app = await feishuApi(token, 'POST', '/open-apis/bitable/v1/apps', { name: '小红书商品数据' });
    // 响应结构：data.app.app_token（创建时会自动带一个默认数据表，我们另建带完整字段的表）
    appToken = app.data && app.data.app && app.data.app.app_token;
    if (!appToken) throw new Error('飞书创建多维表格失败：响应缺少 app_token');
    url = (app.data && app.data.app && app.data.app.url) || feishuTableUrl(appToken);
  }
  // 2) 创建数据表（含全部字段）——字段已在表内则跳过（避免重复建列）
  let tableId = (settings.feishuTableId || '').trim();
  if (!tableId) {
    const tbl = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables`, {
      table: { name: '商品数据', fields: PRODUCT_FIELDS },
    });
    tableId = tbl.data && tbl.data.table_id;
    if (!tableId) throw new Error('飞书创建数据表失败：响应缺少 table_id');
  }
  return { appToken, tableId, url, created: true };
}

// 把采集到的商品批量写入飞书多维表格（自动建表/复用；每批 500 条）
// items: [{ itemId, productName, price, image, link, ... }]
// 返回 { count, appToken, tableId, url }
export async function writeProductsToFeishu(settings, items) {
  const { appToken, tableId, url } = await ensureFeishuBitable(settings);
  const token = await getTenantToken((settings.feishuAppId || '').trim(), (settings.feishuAppSecret || '').trim());
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const records = (items || [])
    .filter((it) => it && (it.itemId || it.productName))
    .map((it) => ({
      fields: {
        商品ID: String(it.itemId || ''),
        商品名称: String(it.productName || ''),
        价格: String(it.price || ''),
        销量: String(it.sales || it.salesCount || ''),
        SKU: String(it.sku || ''),
        '店铺/卖家': String(it.shop || it.shopName || it.seller || ''),
        图片链接: String(it.image || ''),
        商品链接: String(it.link || ''),
        采集时间: ts,
      },
    }));
  if (!records.length) return { count: 0, appToken, tableId, url, error: '没有可写入的商品记录' };

  let written = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const r = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      records: chunk,
    });
    written += (r.data && Array.isArray(r.data.records) ? r.data.records.length : chunk.length);
  }
  return { count: written, appToken, tableId, url: feishuTableUrl(appToken, tableId) };
}
// 返回 { appToken, noteTableId, url }
export async function ensureFeishuNoteTable(settings) {
  const appId = (settings.feishuAppId || '').trim();
  const appSecret = (settings.feishuAppSecret || '').trim();
  if (!appId || !appSecret) {
    throw new Error('feishu-not-configured: 请先在设置页填写飞书 App ID 与 App Secret');
  }
  const token = await getTenantToken(appId, appSecret);
  // 复用已建多维表格 App（商品表用的那个）；没有就先建一个
  let appToken = (settings.feishuAppToken || '').trim();
  let url = feishuTableUrl(appToken);
  if (!appToken) {
    const app = await feishuApi(token, 'POST', '/open-apis/bitable/v1/apps', { name: '小红书数据采集' });
    appToken = app.data && app.data.app && app.data.app.app_token;
    if (!appToken) throw new Error('飞书创建多维表格失败：响应缺少 app_token');
    url = (app.data && app.data.app && app.data.app.url) || feishuTableUrl(appToken);
  }
  let noteTableId = (settings.feishuNoteTableId || '').trim();
  if (!noteTableId) {
    const tbl = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables`, {
      table: { name: '热点笔记', fields: NOTE_FIELDS },
    });
    noteTableId = tbl.data && tbl.data.table_id;
    if (!noteTableId) throw new Error('飞书创建「热点笔记」表失败：响应缺少 table_id');
  }
  return { appToken, noteTableId, url: feishuTableUrl(appToken, noteTableId), created: true };
}

// 把前台采集的热点笔记批量写入飞书「热点笔记」表
// items: [{ title, author, likes, collects, comments, shares, image, link }]
// 返回 { count, appToken, tableId, url }
export async function writeNotesToFeishu(settings, items) {
  const { appToken, noteTableId, url } = await ensureFeishuNoteTable(settings);
  const token = await getTenantToken((settings.feishuAppId || '').trim(), (settings.feishuAppSecret || '').trim());
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const records = (items || [])
    .filter((it) => it && (it.title || it.link))
    .map((it) => ({
      fields: {
        笔记标题: String(it.title || ''),
        作者: String(it.author || ''),
        点赞: String(it.likes || ''),
        收藏: String(it.collects || ''),
        评论: String(it.comments || ''),
        转发: String(it.shares || ''),
        封面图: String(it.image || ''),
        笔记链接: String(it.link || ''),
        采集时间: ts,
      },
    }));
  if (!records.length) return { count: 0, appToken, tableId: noteTableId, url, error: '没有可写入的笔记记录' };

  let written = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const r = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${noteTableId}/records/batch_create`, {
      records: chunk,
    });
    written += (r.data && Array.isArray(r.data.records) ? r.data.records.length : chunk.length);
  }
  return { count: written, appToken, tableId: noteTableId, url: feishuTableUrl(appToken, noteTableId) };
}
