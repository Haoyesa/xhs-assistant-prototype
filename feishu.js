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

// 多维表格「热点笔记」字段（前台探索/搜索页采的热门笔记，卡片级 + 详情深采补充）
export const NOTE_FIELDS = [
  { field_name: '笔记标题', type: 1 },
  { field_name: '作者', type: 1 },
  { field_name: '点赞', type: 1 },
  { field_name: '收藏', type: 1 },
  { field_name: '评论', type: 1 },
  { field_name: '转发', type: 1 },
  { field_name: '发布时间', type: 1 },
  { field_name: '关键词', type: 1 },
  { field_name: '封面图', type: 1 },
  { field_name: '正文图片', type: 1 },
  { field_name: '笔记链接', type: 1 },
  { field_name: '采集时间', type: 1 },
];

// 详情深采缓存：noteId -> { bodyImages:[], publishTime, title }（内存，进程重启清空，够用）
const detailCache = new Map();
export function saveNoteDetail(d) {
  if (!d || !d.noteId) return;
  detailCache.set(String(d.noteId), {
    bodyImages: Array.isArray(d.bodyImages) ? d.bodyImages : [],
    publishTime: d.publishTime || '',
    title: d.title || '',
  });
}
export function getNoteDetail(noteId) {
  return detailCache.get(String(noteId || ''));
}

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

// 列出表已存在的字段（name+type，用于比对缺失字段并识别附件等特殊类型）。失败抛错
async function listFieldNames(token, appToken, tableId) {
  const j = await feishuApi(token, 'GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
  return ((j.data && j.data.items) || []).map((f) => ({ field_name: f.field_name, type: f.type })).filter((f) => f.field_name);
}

// 补齐缺失字段：飞书「字段」没有 batch_create 接口，只有单条 POST /tables/{id}/fields，
// 逐个补建（缺失一般 ≤9 个，9 次请求可接受）。失败抛错并明确提示。
// 返回 { added, existing: [{field_name,type}] }
async function ensureTableFields(token, appToken, tableId, wantFields) {
  const existing = await listFieldNames(token, appToken, tableId);
  const existSet = new Set(existing.map((f) => f.field_name));
  const missing = (wantFields || []).filter((f) => !existSet.has(f.field_name));
  if (!missing.length) return { added: 0, existing };
  const added = [];
  for (const f of missing) {
    try {
      await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        field_name: f.field_name,
        type: f.type,
      });
      added.push(f.field_name);
    } catch (e) {
      // 字段已存在（并发/重复建）视为成功
      if (/FieldNameDuplicated|1254014/i.test(e.message)) { added.push(f.field_name); continue; }
      throw new Error(`自动补齐表格字段失败（${f.field_name}）：${e.message}`);
    }
  }
  console.log('[feishu] 已自动补字段', added.join(', '));
  return { added: added.length, existing: [...existing, ...missing.map((f) => ({ field_name: f.field_name, type: f.type }))] };
}

// 构造写入 records 时按表内实际字段类型转换值，避免类型不匹配报错：
//   type=1 文本 → 字符串；type=2 数字 → 纯数字（"1.2万"→12000，"224"→224）；
//   type=17 附件 / 日期(5) / 单选(3) / 多选(4) / 其他 → 跳过不写（飞书自动留空）
// existing: [{field_name, type}]；fields: 我们要写入的 {key:value}
function coerceFields(fields, existing) {
  const map = new Map((existing || []).map((f) => [f.field_name, f.type]));
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const t = map.get(k);
    if (t === undefined) { out[k] = v; continue; }        // 表里没有 → 我们刚补建的文本字段
    if (t === 1) { out[k] = v; continue; }                 // 文本
    if (t === 2) {                                          // 数字
      const n = parseCountNum(v);
      if (n !== null && Number.isFinite(n)) out[k] = n;    // 转不了就跳过
      continue;
    }
    // 附件(17)/日期(5)/单选(3)/多选(4)/人员(11)/超链接(15) 等：跳过
  }
  return out;
}

// 字符串数量 → 纯数字：「1.2万」→12000，「3k」→3000，「224」→224；解析失败返回 null
function parseCountNum(s) {
  if (s === null || s === undefined || s === '') return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([万wWkK]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/[万wW]/.test(m[2] || '')) n *= 10000;
  else if (/k/i.test(m[2] || '')) n *= 1000;
  return Number.isFinite(n) ? n : null;
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
  // 写入前先确保表的字段齐全（用户用自建表时常缺字段，缺什么自动补什么）
  const { existing } = await ensureTableFields(token, appToken, tableId, PRODUCT_FIELDS);
  // 按表内实际字段类型转换值（数字→数字、附件/日期/单选→跳过），避免 AttachFieldConvFail / NumberFieldConvFail
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500).map((r) => ({ fields: coerceFields(r.fields, existing) }));
    const rr = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      records: chunk,
    });
    written += (rr.data && Array.isArray(rr.data.records) ? rr.data.records.length : chunk.length);
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
    // 强制详情链接：头像/icon/用户主页等无 explore/item/goods 链接的条目一律不写
    .filter((it) => it && (it.link || '').trim() && (it.title || '').trim())
    .map((it) => {
      // 合并详情深采缓存（正文图片/发布时间/标题）
      const det = getNoteDetail(it.noteId || '') || {};
      return {
        fields: {
          笔记标题: String(it.title || det.title || ''),
          作者: String(it.author || ''),
          点赞: String(it.likes || ''),
          收藏: String(it.collects || ''),
          评论: String(it.comments || ''),
          转发: String(it.shares || ''),
          发布时间: String(it.publishTime || det.publishTime || ''),
          关键词: String(it.keyword || ''),
          封面图: String(it.image || ''),
          正文图片: Array.isArray(det.bodyImages) && det.bodyImages.length ? det.bodyImages.join('\n') : '',
          笔记链接: String(it.link || ''),
          采集时间: ts,
        },
      };
    });
  if (!records.length) return { count: 0, appToken, tableId: noteTableId, url, error: '没有可写入的笔记记录' };

  let written = 0;
  // 写入前先确保表的字段齐全（缺什么自动补什么）
  const { existing } = await ensureTableFields(token, appToken, noteTableId, NOTE_FIELDS);
  // 按表内实际字段类型转换值（数字→数字、附件/日期/单选→跳过），避免 AttachFieldConvFail / NumberFieldConvFail
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500).map((r) => ({ fields: coerceFields(r.fields, existing) }));
    const rr = await feishuApi(token, 'POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${noteTableId}/records/batch_create`, {
      records: chunk,
    });
    written += (rr.data && Array.isArray(rr.data.records) ? rr.data.records.length : chunk.length);
  }
  return { count: written, appToken, tableId: noteTableId, url: feishuTableUrl(appToken, noteTableId) };
}
