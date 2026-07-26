// server.js — 小红书千帆带货笔记批量发布助手（原型内核）
// 三段式：选品(千帆CDP/手动) → 按商品生成笔记(标题/正文/话题) → 批量发布(带节奏)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrapeQianfanProducts } from './qianfan-scraper.js';
import { CdpPublisher, ChallengeDetectedError, StepFailedError } from './cdp-publisher.js';
import { downloadOne, downloadToLocal, primeImages } from './image-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.XHS_DATA_DIR
  ? path.resolve(process.env.XHS_DATA_DIR)
  : path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const PORT = process.env.PORT || 5199;

// 应用版本：端口被占用时用于判断「占用者是否为同类后端」（同类则复用，否则提示）
let APP_VERSION = '0.2.58';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  if (pkg && pkg.version) APP_VERSION = String(pkg.version);
} catch {}

const stores = {
  settings: path.join(DATA, 'settings.json'),
  products: path.join(DATA, 'products.json'),
  tasks: path.join(DATA, 'tasks.json'),
  history: path.join(DATA, 'history.json'),
  account: path.join(DATA, 'account.json'),
  importedFolders: path.join(DATA, 'importedFolders.json'),
};

async function readStore(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return fallback; }
}
async function writeStore(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ---- 原软件同款提示词（默认发布设置）----
const DEFAULT_TITLE_PROMPT = `精简我提供的商品标题。

规则：
1. 先删违禁词、敏感词、引流词、重复词。
2. 含"夸克网盘""百度网盘""网盘"必须删除。
3. 处理后少于20字，直接返回。
4. 处理后多于20字，继续精简到15-20字。
5. 保留核心商品信息，不要产生歧义，不要补充原标题没有的信息。
6. 禁止出现评论、留言、点赞、收藏、关注、私信、主页、购买链接、加我、点我、进群、下单、购买、网址、微信、公众号、淘宝、京东、百度网盘、夸克网盘、网盘、免费看资源、网盘分享等词及变体。
7. 只输出最终标题，不要解释，不要前缀，不要标点提示语。
下面是要修改的标题：`;

const DEFAULT_TOPICS_PROMPT = `你是一个小红书种草官。请严格基于我提供的「标题/商品名」的核心主题，生成6个高度相关的话题。
要求：
1. 每个话题一行，或用中文逗号、英文逗号分隔。
2. 每个话题不超过8个字。
3. 话题必须紧扣该笔记内容（品类、场景、人群、功效、风格等角度），禁止套用通用种草词（如：好物分享、种草、宝藏好物、平价好物、亲测推荐、干货、日常、必入、分享）。
4. 话题之间不重复。
5. 不要带#号或任何符号，只给纯文字。
6. 只输出话题本身，不要编号、不要解释、不要前后缀。`;

const DEFAULT_CONTENT_PROMPT = `你是一个中文小红书文案助手。请根据我提供的商品标题，生成一段像小红书真实笔记的中文短文案。

输出格式优先级最高，必须严格遵守：
1. 必须输出 2 到 3 个小段。
2. 每段 1 到 2 句。
3. 段与段之间必须空一行。
4. 至少 2 个自然表情符号。
5. 不要输出标题、编号、解释、前后缀。
6. 总字数尽量控制在 90 到 130 字，少于 80 字就补一句再输出。

请严格按这个节奏输出：
第 1 段：直接写场景，1 句，带 1 个自然表情。
空一行
第 2 段：写特点或适用点，1 到 2 句。
空一行
第 3 段：写选购关注点或补充场景，1 到 2 句，可带第 2 个表情。

任务目标：
只基于标题中可推断的信息写内容，语气自然、轻松、像普通人随手分享。不要写成广告，不要写成客服回复，不要写成亲身体验。

标题类型判断：
1. 如果标题是实体商品，优先写"场景 + 特点 + 选购关注点"。
2. 如果标题是虚拟商品、课程、课件、资料、教程、模板、素材包，优先写"适用场景 + 内容特点 + 选择关注点"。
3. 如果标题信息不足，就保守表达，宁少写，也不要脑补。

内容要求：
1. 只能根据标题可推断的信息写内容，不要虚构使用经历、购买经历、评价结论、销量、口碑、效果。
2. 用小红书常见的口语表达，句子可以短一点，带一点"随手记录"的感觉，避免说明书口吻。
3. 允许使用自然表情符号，全文至少 1 个、最多 3 个，优先放在段首或句中，不能连续堆叠，不要使用 [emoji] 或 [✨] 这类占位符表情。
4. 输出控制在 80 到 150 字，必须分成 2 到 4 个小段，每段 1 到 2 句，段与段之间必须换行空一行；不要写成一整坨。
5. 第一段直接进入场景或适用场景，不要先解释，不要先总结。
6. 句子长短要有变化，允许自然停顿和轻微口语化表达，不要整齐划一。
7. 实体商品可以写常见使用场景、搭配场景、容量、材质、风格、适合人群、选购关注点。
8. 虚拟商品可以写备考、复习、整理、学习辅助、内容匹配度、资料结构、适合人群、选择关注点。
9. 禁止出现任何亲身体验表达，包括但不限于：我用了、我买了、亲测、回购、实测、用了一段时间、一直在用。
10. 禁止出现强营销表达，包括但不限于：闭眼入、冲就对了、必入、无脑入、真的绝了、谁懂啊。
11. 虚拟商品额外禁止出现效果承诺，包括但不限于：提分、逆袭、押题、保过、包会、必会。
12. 不要加入任何话题标签。
13. 不要出现评论、点赞、收藏、关注、私信、链接、购买、下单、微信、公众号、淘宝、京东等引导词。
14. 禁止使用 AI 高频套话，包括但不限于：适配不同场景、满足多元需求、提升体验、赋能、一站式。
15. 不要刻意堆砌错别字，也不要为了"像人写的"去故意写错字。

输出规则：
1. 输出必须从正文第一句直接开始。
2. 禁止输出任何前置说明、客套话、解释、确认语、标题、引导语。
3. 禁止出现以下任一词语或近义表达：你好、您好、以下是、下面是、根据您的要求、我已经、已为您生成、为您生成、文案如下、参考文案、已生成、希望对您有帮助。
4. 只输出正文，不要解释，不要标题。
5. 如果生成内容不符合以上规则，请立即重写，直到只剩合格正文。`;

const DEFAULT_SETTINGS = {
  aiProvider: 'deepseek',
  aiApiKey: '',
  aiModel: '',
  aiBaseUrl: '',
  publishMode: 'dry-run',
  cdpBrowserUrl: 'http://127.0.0.1:9222',
  cdpChromePath: '',
  qianfanUrl: 'https://channel.xiaohongshu.com/ark/product/list',
  // 发布设置（对齐原软件）
  generateTitle: true,
  titlePrompt: DEFAULT_TITLE_PROMPT,
  generateContent: true,
  contentPrompt: DEFAULT_CONTENT_PROMPT,
  enableAiTopics: true,
  topicsPrompt: DEFAULT_TOPICS_PROMPT,
  topicsCount: 6,
  randomEmoji: 30,
  autoSubmit: true,
  humanTyping: true,
  publishIntervalSeconds: 500,
  publishIntervalRandomDelaySeconds: 200,
  singleProductRepeatLimit: 0,
  imagesRoot: '',
};

let lastNextPublishAt = 0; // 插件上报的「下一篇最早发布时刻(ms)」，供桌面批量发布页做倒计时展示

const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
};

// ---- AI 适配器 ----
async function callAI(settings, systemPrompt, userPrompt) {
  const providerKey = settings.aiProvider;
  let baseUrl, model;
  if (providerKey === 'custom') {
    baseUrl = settings.aiBaseUrl;
    model = settings.aiModel;
  } else {
    const p = PROVIDERS[providerKey] || PROVIDERS.deepseek;
    baseUrl = p.baseUrl;
    model = settings.aiModel || p.model;
  }
  if (!settings.aiApiKey || !baseUrl) throw new Error('未配置 AI（缺 Key 或 BaseURL）');
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.aiApiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const j = await resp.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

function localFallback(prompt, kind) {
  // 无 Key 时的本地兜底
  const base = (prompt || '').replace(/\s+/g, ' ').trim();
  if (kind === 'title') {
    const t = base.length > 20 ? base.slice(0, 18) + '…' : base;
    return t || '好物分享';
  }
  if (kind === 'topics') {
    return ['好物', '种草', '分享'];
  }
  // content
  const lines = [
    `最近在用的${base || '这件好物'}真的挺顺手的🌿`,
    '',
    '质感在线，日常搭配很省心，朋友看到都问链接。',
    '',
    '容量和细节都够用，通勤、出门、周末都合适✨',
  ];
  return lines.join('\n');
}

async function aiGenerateNote(settings, product) {
  const title = product.productName || product.itemId || '';
  let genTitle = title;
  let body = '';
  let topics = [];
  const hasKey = Boolean(settings.aiApiKey);
  try {
    if (settings.generateTitle) {
      genTitle = hasKey
        ? await callAI(settings, settings.titlePrompt, title)
        : localFallback(title, 'title');
    }
    if (settings.generateContent) {
      body = hasKey
        ? await callAI(settings, settings.contentPrompt, title)
        : localFallback(title, 'content');
    }
    if (settings.enableAiTopics) {
      const raw = hasKey
        ? await callAI(settings, settings.topicsPrompt, title)
        : '';
      topics = raw
        ? raw.replace(/^\s*[\d]+[.、)]\s*/gm, '').split(/[\s,，、#]+/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 8)).slice(0, settings.topicsCount || 6)
        : localFallback(title, 'topics');
    }
  } catch (e) {
    // 单步失败则用兜底补齐，保证流程不中断
    if (!genTitle || genTitle === title) genTitle = localFallback(title, 'title');
    if (!body) body = localFallback(title, 'content');
    if (!topics.length) topics = localFallback(title, 'topics');
  }
  return { title: genTitle, body, topics };
}

// ---- 批量发布编排 ----
const pump = { running: false, paused: false, stop: false };

function nowISO() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
function normalizeId(v) { return String(v ?? '').toLowerCase().replace(/\s+/g, '').replace(/[\u200b\u200c\u200e\u200f]/g, ''); }
// 判断一个商品名是不是「疑似文件夹名 / 纯 id」（如 686673d41ea4cb001553c6da_1 或纯 hex / 纯长数字）
function isFolderish(s) {
  const t = normalizeId(s);
  if (!t) return false;
  if (/^[0-9a-f]{16,}_?\d*$/i.test(t)) return true; // 686673..._1 或纯 hex
  if (/^\d{6,}$/.test(t)) return true; // 纯长数字
  return false;
}
// 多个商品拥有相同 itemId 时，优先保留「标题像真实标题、且非 images-folder 垃圾来源」的那个
function chooseBetter(a, b) {
  if (!a) return b;
  if (!b) return a;
  const score = (p) => (isFolderish(p.productName) ? 0 : 2) + (p.source === 'images-folder' ? 0 : 1);
  return score(b) > score(a) ? b : a;
}

async function runPump(settings) {
  if (pump.running) return;
  pump.running = true; pump.stop = false; pump.paused = false;
  try {
    const tasks = await readStore(stores.tasks, []);
    const queued = tasks.filter((t) => t.status === 'queued');
    const mode = settings.publishMode === 'cdp' ? 'cdp' : 'dry-run';
    const publisher = mode === 'cdp' ? new CdpPublisher(settings) : null;

    for (const task of queued) {
      if (pump.stop) break;
      while (pump.paused) { await new Promise((r) => setTimeout(r, 1000)); if (pump.stop) break; }
      if (pump.stop) break;

      task.status = 'running';
      task.step = 'open_publish_page';
      task.statusDetail = '开始执行';
      task.updatedAt = nowISO();
      await writeStore(stores.tasks, mergeTask(tasks, task));

      try {
        if (mode === 'cdp') {
          // 发布前把远程商品图下载到本地（CDP 上传需要本地文件路径）
          const localImgs = await downloadToLocal(task.images, UPLOADS);
          const res = await publisher.publishNote({ ...task, images: localImgs }, {
            autoSubmit: settings.autoSubmit,
            onStep: async (step, detail) => {
              task.step = step; task.statusDetail = detail; task.updatedAt = nowISO();
              await writeStore(stores.tasks, mergeTask(tasks, task));
            },
          });
          task.status = res.status === 'success' ? 'success' : (res.status || 'submitted');
          task.statusDetail = res.detail;
          task.step = res.step || task.step;
          if (res.status === 'success') { task.noteUrl = ''; }
        } else {
          // dry-run 模拟
          const steps = ['open_publish_page', 'upload_images', 'select_product', 'fill_title', 'fill_content', 'waiting_submit', 'submitting', 'verify_result'];
          for (const s of steps) {
            if (pump.stop) break;
            task.step = s;
            task.statusDetail = `[模拟] ${s}`;
            task.updatedAt = nowISO();
            await writeStore(stores.tasks, mergeTask(tasks, task));
            await new Promise((r) => setTimeout(r, 250));
          }
          task.status = settings.autoSubmit ? 'success' : 'waiting_submit';
          task.statusDetail = settings.autoSubmit ? '[模拟] 发布成功' : '[模拟] 已填好，等待人工提交';
        }
        // 写入历史
        const history = await readStore(stores.history, []);
        history.unshift({
          id: uid('h'), taskId: task.id, itemId: task.itemId, title: task.title,
          status: task.status, detail: task.statusDetail, at: nowISO(),
        });
        await writeStore(stores.history, history.slice(0, 500));
      } catch (e) {
        task.status = 'manual_hold';
        task.statusDetail = e.message || '执行失败';
        task.step = e.step || task.step;
        const history = await readStore(stores.history, []);
        history.unshift({ id: uid('h'), taskId: task.id, itemId: task.itemId, title: task.title, status: 'failed', detail: task.statusDetail, at: nowISO() });
        await writeStore(stores.history, history.slice(0, 500));
      }
      task.updatedAt = nowISO();
      await writeStore(stores.tasks, mergeTask(tasks, task));

      // 节奏控制（CDP 模式用配置间隔；dry-run 用短间隔便于演示）
      if (mode === 'cdp') {
        const base = (settings.publishIntervalSeconds || 500) * 1000;
        const extra = (settings.publishIntervalRandomDelaySeconds || 200) * 1000 * Math.random();
        await sleepInterruptible(base + extra);
      } else {
        await sleepInterruptible(1500 + Math.random() * 1500);
      }
    }
  } finally {
    pump.running = false;
  }
}

function mergeTask(tasks, task) {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = task; else tasks.push(task);
  return tasks;
}
function sleepInterruptible(ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pump.stop || Date.now() - start >= ms) return resolve();
      setTimeout(tick, Math.min(500, ms - (Date.now() - start)));
    };
    tick(); // 立即检查，不等待
  });
}

// ---- 本地图片文件夹（按 images/<id>/ 读取并发布）----
// 图片根目录：设置里填了用填的（绝对路径），否则默认「软件根目录（exe 同级）下的 images/」
function resolveImagesRoot(settings) {
  const s = (settings && settings.imagesRoot) || '';
  if (s && s.trim()) return path.resolve(s.trim());
  // 绿色免安装版：exe 同级目录下的 images/（即 win-unpacked/images）；node 直接跑时回退到 DATA/images
  if (process.versions && process.versions.electron) {
    const root = path.join(path.dirname(process.execPath), 'images');
    console.log('[XHS] 图片根目录(默认):', root);
    return root;
  }
  return path.join(DATA, 'images');
}
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const SEED_FILES = ['name.txt', 'caption.txt', 'title.txt'];
// 扫描图片根目录：每个直接子目录 = 一篇笔记，目录名即 id；目录内图片按文件名排序
// 文件夹名格式支持 "<productId>_<suffix>"（如 686673d41ea4cb001553c6da_1），productId 用于匹配千帆商品库
function scanImageFolders(root) {
  if (!root) return [];
  if (!fs.existsSync(root)) { try { fs.mkdirSync(root, { recursive: true }); } catch {} return []; }
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const fp = path.join(root, name);
    if (!fs.statSync(fp).isDirectory()) continue;
    const files = fs.readdirSync(fp).filter((f) => IMG_EXT.test(f)).sort();
    if (!files.length) continue; // 跳过不含图片的文件夹
    // 从文件夹名解析 productId：格式 "<productId>_<suffix>" 或纯 "<productId>"
    const productId = name.includes('_') ? name.split('_')[0] : name;
    let seed = name; // 默认用文件夹名作为 AI 生成文案的种子
    for (const nf of SEED_FILES) {
      const np = path.join(fp, nf);
      if (fs.existsSync(np)) {
        try { const t = fs.readFileSync(np, 'utf-8').trim().split('\n')[0].trim(); if (t) seed = t; } catch {}
        break;
      }
    }
    out.push({ id: name, name, productId, imageCount: files.length, images: files.map((f) => `${name}/${f}`), seed });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
  res.end(b);
}
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_SIZE) throw new Error('请求体超过 2MB 限制');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf-8');
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
function sendFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  // 预检 / 跨域（供浏览器插件从 ark/creator 页面 fetch 本地服务）
  if (method === 'OPTIONS') {
    res.writeHead(204, { ...CORS_HEADERS });
    return res.end();
  }

  try {
    // 静态资源
    if (method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
      const rel = p === '/' ? '/index.html' : p.replace('/static', '');
      return sendFile(res, path.join(PUBLIC, rel));
    }

    // 设置
    if (p === '/api/settings' && method === 'GET') {
      const s = await readStore(stores.settings, {});
      return sendJSON(res, 200, { appVersion: APP_VERSION, ...DEFAULT_SETTINGS, ...s });
    }
    if (p === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const cur = await readStore(stores.settings, {});
      await writeStore(stores.settings, { ...DEFAULT_SETTINGS, ...cur, ...body });
      return sendJSON(res, 200, { ok: true });
    }

    // 清除发布数据（保留设置与账号）
    if (p === '/api/data/clear' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const want = (body && Array.isArray(body.targets)) ? body.targets
        : ['tasks', 'products', 'history', 'uploads'];
      const KEEP = new Set(['settings', 'account']);
      const result = { cleared: [], kept: [] };
      for (const k of ['tasks', 'products', 'history', 'settings', 'account']) {
        if (!want.includes(k)) continue;
        if (KEEP.has(k)) { result.kept.push(k); continue; }
        await writeStore(stores[k], []);
        result.cleared.push(k);
      }
      if (want.includes('uploads')) {
        let n = 0;
        try {
          for (const f of fs.readdirSync(UPLOADS)) {
            try { fs.unlinkSync(path.join(UPLOADS, f)); n++; } catch {}
          }
        } catch {}
        result.cleared.push('uploads(' + n + ')');
      }
      // 清除发布数据时一并重置「已导入文件夹」记录，便于之后重新导入图片文件夹
      try { await writeStore(stores.importedFolders, []); } catch {}
      result.cleared.push('importedFolders');
      return sendJSON(res, 200, { ok: true, result });
    }

    // AI 测试
    if (p === '/api/ai/test' && method === 'POST') {
      const body = await readBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})), ...body };
      try {
        const r = await callAI(settings, '只回复 ok', 'ok');
        return sendJSON(res, 200, { ok: true, detail: 'AI 连通正常' });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: e.message });
      }
    }

    // 商品库
    if (p === '/api/products' && method === 'GET') {
      return sendJSON(res, 200, await readStore(stores.products, []));
    }
    if (p === '/api/products' && method === 'POST') {
      const body = await readBody(req);
      const products = await readStore(stores.products, []);
      const prod = {
        id: uid('p'), itemId: body.itemId || '', productName: body.productName || '',
        price: body.price || '', image: body.image || '', description: body.description || '',
        images: body.images || [], source: body.source || 'manual', createdAt: nowISO(),
      };
      products.push(prod);
      await writeStore(stores.products, products);
      return sendJSON(res, 200, prod);
    }
    if (p === '/api/products/import' && method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.products) ? body.products : [];
      const products = await readStore(stores.products, []);
      const added = list.map((b) => ({
        id: uid('p'), itemId: b.itemId || '', productName: b.productName || b.title || '',
        price: b.price || '', image: b.image || '', description: b.description || '',
        images: b.images || [], source: 'import', createdAt: nowISO(),
      }));
      products.push(...added);
      await writeStore(stores.products, products);
      return sendJSON(res, 200, { added: added.length, products: added });
    }
    if (p.startsWith('/api/products/') && p.endsWith('/delete') && method === 'POST') {
      const id = p.split('/')[3];
      let products = await readStore(stores.products, []);
      products = products.filter((x) => x.id !== id);
      await writeStore(stores.products, products);
      return sendJSON(res, 200, { ok: true });
    }

    // 从千帆抓取
    if (p === '/api/qianfan/fetch' && method === 'POST') {
      const body = await readBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})), ...body };
      try {
        const fetched = await scrapeQianfanProducts(settings);
        if (body.save !== false) {
          const products = await readStore(stores.products, []);
          let merged = [...products];
          for (const f of fetched) {
            const key = normalizeId(f.itemId);
            // 先按 itemId 找，再按 商品名 找（采集标题稳定，itemId 可能缺失）
            let existing = key ? merged.find((m) => normalizeId(m.itemId) === key) : null;
            if (!existing && f.productName) existing = merged.find((m) => normalizeId(m.productName) === normalizeId(f.productName));
            if (existing) {
              // 更新已有商品，重点是补全缺失的 itemId，让图片文件夹 <id>_1 能按 id 对应上
              if (!existing.itemId && f.itemId) existing.itemId = f.itemId;
              if (f.productName) existing.productName = f.productName;
              if (f.price) existing.price = f.price;
              if (f.image && !(existing.images && existing.images.length)) { existing.image = f.image; existing.images = [f.image]; }
              existing.source = 'qianfan';
              existing.updatedAt = nowISO();
            } else {
              merged.push({ id: uid('p'), ...f, images: f.image ? [f.image] : [], source: 'qianfan', createdAt: nowISO() });
            }
          }
          // 自修复：删除「images-folder 来源、商品名疑似文件夹名、且已有同 id 的真实商品」的垃圾记录
          merged = merged.filter((p) => {
            if (p.source === 'images-folder' && isFolderish(p.productName)) {
              const k = normalizeId(p.itemId);
              if (k && merged.some((m) => m !== p && normalizeId(m.itemId) === k && !(m.source === 'images-folder' && isFolderish(m.productName)))) return false;
            }
            return true;
          });
          await writeStore(stores.products, merged);
        }
        primeImages(fetched.flatMap((f) => (f.image ? [f.image] : [])), UPLOADS);
        return sendJSON(res, 200, { ok: true, count: fetched.length, products: fetched });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: e.message });
      }
    }

    // 为单个商品生成笔记
    if (p.startsWith('/api/products/') && p.endsWith('/generate') && method === 'POST') {
      const id = p.split('/')[3];
      const products = await readStore(stores.products, []);
      const prod = products.find((x) => x.id === id);
      if (!prod) return sendJSON(res, 404, { ok: false, detail: '商品不存在' });
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const note = await aiGenerateNote(settings, prod);
      const tasks = await readStore(stores.tasks, []);
      const existing = tasks.find((t) => t.productId === id && t.status === 'queued');
      const task = existing || { id: uid('t'), productId: id, status: 'queued', step: 'created', createdAt: nowISO() };
      task.itemId = prod.itemId;
      task.title = note.title;
      task.body = note.body;
      task.topics = note.topics;
      task.images = (prod.images && prod.images.length) ? prod.images : (prod.image ? [prod.image] : []);
      task.product = { itemId: prod.itemId, productName: prod.productName, price: prod.price };
      task.statusDetail = '已生成笔记，待入队';
      task.updatedAt = nowISO();
      await writeStore(stores.tasks, mergeTask(tasks, task));
      return sendJSON(res, 200, task);
    }

    // 批量入队
    if (p === '/api/batch/enqueue' && method === 'POST') {
      const body = await readBody(req);
      const products = await readStore(stores.products, []);
      const ids = body.productIds && body.productIds.length ? body.productIds : products.map((x) => x.id);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const tasks = await readStore(stores.tasks, []);
      const created = [];
      for (const pid of ids) {
        const prod = products.find((x) => x.id === pid);
        if (!prod) continue;
        const note = await aiGenerateNote(settings, prod);
        const task = {
          id: uid('t'), productId: pid, itemId: prod.itemId,
          title: note.title, body: note.body, topics: note.topics,
          images: (prod.images && prod.images.length) ? prod.images : (prod.image ? [prod.image] : []),
          product: { itemId: prod.itemId, productName: prod.productName, price: prod.price },
          status: 'queued', step: 'created', statusDetail: '已入队', createdAt: nowISO(), updatedAt: nowISO(),
        };
        tasks.push(task); created.push(task);
      }
      await writeStore(stores.tasks, tasks);
      return sendJSON(res, 200, { created: created.length, tasks: created });
    }

    // 队列 / 控制
    if (p === '/api/batch/queue' && method === 'GET') {
      const tasks = await readStore(stores.tasks, []);
      return sendJSON(res, 200, { tasks, pump: { running: pump.running, paused: pump.paused, stop: pump.stop }, nextPublishAt: lastNextPublishAt });
    }
    if (p === '/api/batch/pump' && method === 'POST') {
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      runPump(settings);
      return sendJSON(res, 200, { ok: true, detail: '已开始执行批量发布' });
    }
    if (p === '/api/batch/pause' && method === 'POST') { pump.paused = true; return sendJSON(res, 200, { ok: true }); }
    if (p === '/api/batch/resume' && method === 'POST') { pump.paused = false; return sendJSON(res, 200, { ok: true }); }
    if (p === '/api/batch/stop' && method === 'POST') { pump.stop = true; pump.paused = false; return sendJSON(res, 200, { ok: true }); }
    // 重试失败/人工挂起的任务：把 manual_hold / failed 重置回 queued 重新排队
    if (p === '/api/batch/retry' && method === 'POST') {
      const body = await readBody(req);
      const onlyIds = Array.isArray(body.taskIds) ? body.taskIds : null;
      const tasks = await readStore(stores.tasks, []);
      const recover = ['manual_hold', 'failed'];
      let n = 0;
      for (const t of tasks) {
        if (onlyIds && !onlyIds.includes(t.id)) continue;
        if (recover.includes(t.status)) {
          t.status = 'queued';
          t.step = 'created';
          t.statusDetail = '已重置，等待重新发布';
          t.updatedAt = nowISO();
          n++;
        }
      }
      await writeStore(stores.tasks, tasks);
      return sendJSON(res, 200, { ok: true, requeued: n });
    }
    if (p.startsWith('/api/batch/') && p.endsWith('/cancel') && method === 'POST') {
      const id = p.split('/')[3];
      const tasks = await readStore(stores.tasks, []);
      const t = tasks.find((x) => x.id === id);
      if (t) { t.status = 'skipped'; t.statusDetail = '已取消'; t.updatedAt = nowISO(); }
      await writeStore(stores.tasks, tasks);
      return sendJSON(res, 200, { ok: true });
    }

    // CDP 连接状态 / 启动
    if (p === '/api/cdp/status' && method === 'POST') {
      const body = await readBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})), ...body };
      try {
        const pub = new CdpPublisher(settings);
        const out = await pub.testConnection();
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: e.message });
      }
    }
    if (p === '/api/cdp/launch' && method === 'POST') {
      const body = await readBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})), ...body };
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'cdp-config.json'), 'utf-8'));
      } catch {
        cfg = { launch: { args: [] } };
      }
      // 自动探测浏览器：设置路径 → 常见 Chrome 安装位 → Edge（本机常只有 Edge）
      const pf = process.env.ProgramFiles || 'C:\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)';
      const candidates = [];
      if (settings.cdpChromePath) candidates.push(settings.cdpChromePath);
      candidates.push(
        path.join(pf, 'Google/Chrome/Application/chrome.exe'),
        path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
        path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
        'chrome', 'msedge',
      );
      let exe = null;
      for (const c of candidates) { try { if (c && fs.existsSync(c)) { exe = c; break; } } catch {} }
      if (!exe) return sendJSON(res, 200, { ok: false, detail: '未找到 Chrome/Edge，请在设置页「Chrome 路径」填写浏览器 exe 完整路径后重试。' });
      // 专用调试 profile（登录态持久化，不抢占日常浏览器）
      const _home = process.env.USERPROFILE || process.env.HOME || '.';
      const profileDir = process.env.XHS_DATA_DIR ? path.join(process.env.XHS_DATA_DIR, 'cdp-profile') : path.join(_home, '.xhs-cdp-profile');
      fs.mkdirSync(profileDir, { recursive: true });
      // 必带参数：调试端口 + 允许 CDP 远程来源(Chrome>=111 默认拦截) + 专用 profile
      const args = [
        '--remote-debugging-port=9222',
        '--remote-allow-origins=*',
        '--user-data-dir=' + profileDir,
        '--no-first-run', '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
      ];
      const { spawn } = await import('node:child_process');
      let child;
      try {
        child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: '启动浏览器失败：' + e.message });
      }
      return sendJSON(res, 200, { ok: true, detail: '已启动 ' + path.basename(exe) + '（调试端口 9222）。首次请在弹出的浏览器里登录小红书，之后会保持登录。' });
    }

    // 历史
    if (p === '/api/history' && method === 'GET') {
      return sendJSON(res, 200, await readStore(stores.history, []));
    }

    // ===== 浏览器插件接口（扩展作为「浏览器内自动化层」配对本后端）=====
    // 推商品：扩展在千帆页采集后写入商品库
    if (p === '/api/ext/products' && method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body.products) ? body.products : (body.itemId ? [body] : []);
      const products = await readStore(stores.products, []);
      const added = [];
      let updated = 0;
      for (const b of list) {
        if (!b.productName && !b.itemId) continue;
        const itemId = String(b.itemId || '').trim();
        // 去重：相同 itemId，或「之前导入/采集的空 id 记录且商品名相同」都视为同一商品，更新而非新增。
        // 这样修复「先导入本地图片（建了空 id 商品）后采集到真实 id」导致的重复与匹配失效。
        let dup = null;
        if (itemId) dup = products.find((m) => m.itemId === itemId);
        if (!dup && !itemId && b.productName) dup = products.find((m) => m.productName && normalizeId(m.productName) === normalizeId(b.productName) && !m.itemId);
        if (dup) {
          if (!dup.itemId && itemId) dup.itemId = itemId;
          if (b.productName) dup.productName = b.productName;
          if (b.price) dup.price = b.price;
          if (b.image) { dup.image = b.image; if (!dup.images || !dup.images.length) dup.images = [b.image]; }
          dup.source = 'extension';
          dup.updatedAt = nowISO();
          updated++;
          continue;
        }
        const prod = {
          id: uid('p'), itemId, productName: b.productName || '',
          price: b.price || '', image: b.image || (b.images && b.images[0]) || '',
          description: b.description || '', images: b.images || (b.image ? [b.image] : []),
          source: 'extension', createdAt: nowISO(),
        };
        products.push(prod); added.push(prod);
      }
      await writeStore(stores.products, products);
      // 后台预热图片缓存，供后续代理/CDP 快速命中（不阻塞响应）
      primeImages(added.flatMap((p) => (p.images && p.images.length ? p.images : (p.image ? [p.image] : []))), UPLOADS);
      return sendJSON(res, 200, { ok: true, added: added.length, updated, products: added });
    }
    // 拉待发笔记：扩展在创作者页取一条去填充（标记 picked 防重复）
    if (p === '/api/ext/next' && method === 'GET') {
      const tasks = await readStore(stores.tasks, []);
      const now = Date.now();
      // 1) 先做一次"sweep"：把 picked 超时未回报的任务主动标成 failed，避免永远卡 picked
      //    之前只有"下一次 tick 顺便回收"，用户看到状态不动会误以为扩展死了。
      const PICK_TIMEOUT_MS = 120 * 1000;
      const stale = [];
      for (const t of tasks) {
        if (t.status !== 'picked') continue;
        const pickedMs = t.pickedAt ? new Date(t.pickedAt).getTime() : new Date(t.updatedAt || 0).getTime();
        if (now - pickedMs > PICK_TIMEOUT_MS) {
          t.status = 'failed';
          t.step = 'verify_result';
          t.statusDetail = `扩展取走后未回报（超过 ${Math.round(PICK_TIMEOUT_MS / 1000)}s），已自动标记失败`;
          t.updatedAt = nowISO();
          stale.push(t);
        }
      }
      if (stale.length) {
        await writeStore(stores.tasks, tasks);
        const history = await readStore(stores.history, []);
        for (const t of stale) {
          history.unshift({
            id: uid('h'), taskId: t.id, itemId: t.itemId, title: t.title,
            status: 'failed', detail: t.statusDetail, at: nowISO(), source: 'extension-timeout',
          });
        }
        await writeStore(stores.history, history.slice(0, 500));
      }
      // 2) 优先取 queued；若没有，找一个未超时的 picked（理论上此时已被 sweep 清理）
      const task = tasks.find((t) => t.status === 'queued')
        || tasks.find((t) => t.status === 'picked' && now - new Date(t.pickedAt || t.updatedAt || 0).getTime() <= PICK_TIMEOUT_MS);
      if (!task) return sendJSON(res, 200, { ok: true, task: null });
      task.status = 'picked'; task.step = 'fill_form'; task.statusDetail = '扩展已取走，填充中';
      task.pickedAt = new Date(now).toISOString();
      task.updatedAt = task.pickedAt;
      await writeStore(stores.tasks, mergeTask(tasks, task));
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      return sendJSON(res, 200, {
        ok: true, task,
        serverUrl: `http://localhost:${PORT}`,
        autoSubmit: settings.autoSubmit,
        humanTyping: settings.humanTyping,
        qianfanUrl: settings.qianfanUrl,
        // 供插件调度器计算「两篇笔记之间的延时」：默认 publishIntervalSeconds(500)+随机 publishIntervalRandomDelaySeconds(200)
        publishIntervalSeconds: settings.publishIntervalSeconds || 500,
        publishIntervalRandomDelaySeconds: settings.publishIntervalRandomDelaySeconds || 200,
      });
    }
    // 插件上报「下一篇最早发布时刻」：供桌面批量发布页同步显示倒计时
    if (p === '/api/ext/schedule' && method === 'POST') {
      const body = await readBody(req);
      const at = Number(body && body.nextPublishAt) || 0;
      lastNextPublishAt = at;
      return sendJSON(res, 200, { ok: true, nextPublishAt: at });
    }
    // 按 id 查单条任务状态：插件调度器用它轮询「当前这篇是否已发布/失败/需人工」，作为开新标签的可靠信号
    if (p === '/api/ext/task' && method === 'GET') {
      const id = url.searchParams.get('id');
      const tasks = await readStore(stores.tasks, []);
      const t = id ? tasks.find((x) => x.id === id) : null;
      return sendJSON(res, 200, { ok: true, task: t || null });
    }
    // 回报结果：扩展发布后写回状态与历史
    if (p === '/api/ext/done' && method === 'POST') {
      const body = await readBody(req);
      const tasks = await readStore(stores.tasks, []);
      const t = tasks.find((x) => x.id === body.taskId);
      if (!t) return sendJSON(res, 404, { ok: false, detail: '任务不存在' });
      const status = body.status || 'published';
      t.status = status; t.step = 'verify_result'; t.statusDetail = body.detail || status; t.updatedAt = nowISO();
      await writeStore(stores.tasks, mergeTask(tasks, t));
      const history = await readStore(stores.history, []);
      history.unshift({
        id: uid('h'), taskId: t.id, itemId: t.itemId, title: t.title,
        status, detail: body.detail || '', at: nowISO(), source: 'extension',
      });
      await writeStore(stores.history, history.slice(0, 500));
      return sendJSON(res, 200, { ok: true });
    }

    // 图片代理：把远程商品图下载到本地并返回（带 CORS），供浏览器插件在小红书页面注入图片时绕过防盗链
    if (p === '/api/image' && method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) return sendJSON(res, 400, { ok: false, detail: 'invalid url' });
      try {
        const file = await downloadOne(target, UPLOADS);
        if (!file) return sendJSON(res, 502, { ok: false, detail: '图片下载失败（网络/防盗链）' });
        const data = await fsp.readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          ...CORS_HEADERS,
        });
        return res.end(data);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, detail: e.message });
      }
    }

    // 本地图片文件夹：扫描 images/<id>/ 结构，列出可导入的笔记组
    if (p === '/api/images-folders' && method === 'GET') {
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const root = resolveImagesRoot(settings);
      const imported = await readStore(stores.importedFolders, []);
      const products = await readStore(stores.products, []);
      // 同时按 itemId / id / productName 建索引，兼容用户文件夹里的 productId 各种可能写法；
      // 相同 itemId 出现多条（如「千帆采集的真实商品」与「导入时自动建的垃圾商品」）时，优先保留真实标题那条
      const prodByItemId = new Map();
      for (const p of products) { const k = normalizeId(p.itemId); if (k) prodByItemId.set(k, chooseBetter(prodByItemId.get(k), p)); }
      const prodById = new Map(products.map((p) => [normalizeId(p.id), p]));
      const prodByName = new Map();
      for (const p of products) { const k = normalizeId(p.productName); if (k) prodByName.set(k, chooseBetter(prodByName.get(k), p)); }
      const folders = scanImageFolders(root).map((f) => {
        const key = normalizeId(f.productId);
        const prod = prodByItemId.get(key) || prodById.get(key) || prodByName.get(key);
        const matchBy = prod
          ? (prodByItemId.has(key) ? 'itemId' : prodById.has(key) ? 'id' : 'productName')
          : null;
        // 如果千帆商品库匹配到了，用商品名替换文案种子
        const seed = prod?.productName || f.seed;
        // 诊断：匹配到了商品，但商品名疑似没填真实标题（等于文件夹名或 productId）
        const nameWarning = prod
          ? (normalizeId(prod.productName) === normalizeId(f.name) || normalizeId(prod.productName) === normalizeId(f.productId))
          : false;
        return {
          ...f,
          seed,
          previewTitle: prod?.productName || f.seed,
          nameWarning,
          imported: imported.includes(f.id),
          productName: prod?.productName || '',
          matchedProduct: prod ? { itemId: prod.itemId, productName: prod.productName, price: prod.price, matchBy } : null,
        };
      });
      return sendJSON(res, 200, { ok: true, root, exists: fs.existsSync(root), folders });
    }
    // 导入选中的图片文件夹为「商品 + 待发布笔记」：图片以本地文件服务 URL 进入 task.images，
    // 标题/正文/话题由 AI 按商品名（千帆商品库匹配 productId）生成；已导入的 id 自动跳过避免重复。
    if (p === '/api/images-folders/import' && method === 'POST') {
      const body = await readBody(req);
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const root = resolveImagesRoot(settings);
      const ids = Array.isArray(body.ids) ? body.ids : null;
      const matchedOnly = !!body.matchedOnly;
      const folders = scanImageFolders(root);
      const imported = new Set(await readStore(stores.importedFolders, []));
      const products = await readStore(stores.products, []);
      const tasks = await readStore(stores.tasks, []);
      // 同时按 itemId / id / productName 建索引，兼容用户文件夹里的 productId 各种可能写法；
      // 相同 itemId 出现多条时优先保留真实标题那条（避免被 images-folder 垃圾记录覆盖）
      const prodByItemId = new Map();
      for (const p of products) { const k = normalizeId(p.itemId); if (k) prodByItemId.set(k, chooseBetter(prodByItemId.get(k), p)); }
      const prodById = new Map(products.map((p) => [normalizeId(p.id), p]));
      const prodByName = new Map();
      for (const p of products) { const k = normalizeId(p.productName); if (k) prodByName.set(k, chooseBetter(prodByName.get(k), p)); }
      const serverUrl = `http://localhost:${PORT}`;
      const created = [];
      for (const f of folders) {
        if (ids && !ids.includes(f.id)) continue;
        if (imported.has(f.id)) continue;
        const images = f.images.map((rel) => `${serverUrl}/api/file?rel=${encodeURIComponent(rel)}`);
        // 用文件夹名解析出的 productId 去千帆商品库匹配（兼容大小写/空格）
        const itemId = f.productId;
        const key = normalizeId(itemId);
        const matchedProd = prodByItemId.get(key) || prodById.get(key) || prodByName.get(key);
        const matchBy = matchedProd
          ? (prodByItemId.has(key) ? 'itemId' : prodById.has(key) ? 'id' : 'productName')
          : null;
        // 仅「有图片且匹配到商品库」的文件夹才导入（任务要求：扫描后只把这类直接导入生成笔记并入队）
        if (matchedOnly && (!f.images || !f.images.length || !matchedProd)) continue;
        // 诊断：匹配到了商品，但商品名疑似没填真实标题（等于文件夹名或 productId）
        const nameWarning = matchedProd
          ? (normalizeId(matchedProd.productName) === normalizeId(f.name) || normalizeId(matchedProd.productName) === normalizeId(f.productId))
          : false;
        // 匹配到则用商品名作为文案种子，否则回退到文件夹名/name.txt
        const productName = matchedProd?.productName || f.seed;
        // 如果千帆商品库已有此商品，复用；否则创建一条最小记录
        const prod = matchedProd || {
          id: uid('p'), itemId, productName, price: '', image: images[0] || '',
          description: '', images, source: 'images-folder', createdAt: nowISO(),
        };
        if (!matchedProd) products.push(prod);
        // 用商品名（而非文件夹名）作为 AI 生成文案的种子
        const note = await aiGenerateNote(settings, { productName, itemId });
        // 兜底：如果 AI 返回的标题仍包含原文件夹名/种子，说明没有真正替换，强制以商品名为准
        let finalTitle = note.title || productName;
        const rawSeed = String(f.seed || f.name || '');
        if (matchedProd && (normalizeId(finalTitle).includes(normalizeId(rawSeed)) || normalizeId(finalTitle).includes(normalizeId(f.name)))) {
          finalTitle = productName;
        }
        // 再按常规标题规则兜底
        if (!finalTitle || finalTitle.length > 40) finalTitle = localFallback(productName, 'title');
        const task = {
          id: uid('t'), productId: prod.id, itemId,
          title: finalTitle, body: note.body, topics: note.topics,
          images,
          product: { itemId, productName, price: matchedProd?.price || '' },
          matchedProduct: matchedProd ? { itemId: matchedProd.itemId, productName: matchedProd.productName, matchBy } : null,
          status: 'queued', step: 'created', statusDetail: matchedProd
            ? (nameWarning ? '已匹配千帆商品，但商品名疑似未填真实标题（请到选品页修改该商品名）' : '已匹配千帆商品并生成笔记')
            : '已导入本地图片文件夹并生成笔记（未匹配到千帆商品，标题按文件夹名/name.txt 生成）', createdAt: nowISO(), updatedAt: nowISO(),
        };
        tasks.push(task);
        created.push(task);
        imported.add(f.id);
      }
      await writeStore(stores.products, products);
      await writeStore(stores.tasks, tasks);
      await writeStore(stores.importedFolders, [...imported]);
      return sendJSON(res, 200, { ok: true, created: created.length, tasks: created });
    }
    // 本地图片文件服务：把 images/<id>/ 下的图片以 http 暴露给插件注入 / CDP 上传（带 CORS，防目录穿越）
    if (p === '/api/file' && method === 'GET') {
      const rel = url.searchParams.get('rel');
      if (!rel) return sendJSON(res, 400, { ok: false, detail: '缺少 rel 参数' });
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const root = resolveImagesRoot(settings);
      const abs = path.resolve(root, rel);
      // 严格限制：必须位于 root 目录下（防止 ../../etc/passwd 穿越）
      const relative = path.relative(root, abs);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return sendJSON(res, 403, { ok: false, detail: '禁止访问目录外文件' });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJSON(res, 404, { ok: false, detail: '文件不存在' });
      const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      try {
        const data = fs.readFileSync(abs);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS });
        return res.end(data);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, detail: e.message });
      }
    }

    return sendJSON(res, 404, { ok: false, detail: '未知接口' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, detail: e.message });
  }
});

// 探测端口上是否已是「同类后端」在运行（用于端口冲突时安全复用，而非崩溃）
async function probeExistingBackend(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && j.appVersion === APP_VERSION); // 版本一致才视为同类后端
  } catch {
    return false;
  }
}

async function showPortErrorAndExit(port) {
  try {
    const { dialog } = await import('electron');
    dialog.showErrorBox(
      '后端启动失败',
      `端口 ${port} 已被其他程序占用，无法启动本地后端。\n` +
      `通常是另一个「黑猫AI自动笔记小助理」实例、旧版本 exe，或命令行 node server.js 正在运行。\n` +
      `请先在任务管理器结束这些进程，再重新打开本软件。`
    );
  } catch {}
  setTimeout(() => process.exit(1), 400);
}

export function startServer(port = PORT) {
  // 端口冲突处理：同类后端占用 → 复用；其他占用 → 明确提示后退出（不再未捕获崩溃）
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      probeExistingBackend(port).then((isOurs) => {
        if (isOurs) {
          console.warn(`[server] 端口 ${port} 已被同类后端占用，复用现有实例，本进程不再监听`);
        } else {
          console.error(`[server] 端口 ${port} 被非本应用占用，启动失败`);
          showPortErrorAndExit(port);
        }
      });
    } else {
      console.error('[server] 启动错误:', err);
    }
  });
  server.listen(port, () => {
    console.log(`黑猫AI自动笔记小助理已启动: http://localhost:${port}`);
  });
  return server;
}

// 直接 `node server.js` 时自动监听；被 Electron 引入时由 main.mjs 调用 startServer。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer();
}

export { server, readStore, writeStore, stores, DEFAULT_SETTINGS, aiGenerateNote };
