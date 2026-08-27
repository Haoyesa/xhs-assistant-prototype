// server.js — 黑猫智记AI 内容创作辅助工具（本地内核）
// 能力：文案优化(标题/正文/话题) / 素材库 / 封面素材参考 / 本地生成；不接入任何平台接口、不自动发布。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrapeQianfanProducts } from './qianfan-scraper.js';
import { downloadOne, downloadToLocal, primeImages } from './image-util.js';
import { ensureFeishuBitable, writeProductsToFeishu, writeNotesToFeishu, saveNoteDetail, getNoteDetail, feishuTableUrl } from './feishu.js';
// 门禁决策（autoSubmit / 频率 / 账号配额）抽到 electron/gating.mjs，单独混淆以提升逆向门槛
import { resolvedPlan, planIntervalSeconds, effectiveAutoSubmit, maxAccounts } from './electron/gating.mjs';
import { SENSITIVE_CATEGORIES } from './sensitive-words.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA = process.env.XHS_DATA_DIR
  ? path.resolve(process.env.XHS_DATA_DIR)
  : path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const PORT = process.env.PORT || 5199;

// 应用版本：端口被占用时用于判断「占用者是否为同类后端」（同类则复用，否则提示）
let APP_VERSION = '0.3.0';
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
  instances: path.join(DATA, 'ext-instances.json'), // 在线插件实例注册表（比特多账号并行）
  agreement: path.join(DATA, 'agreement.json'), // 免责协议同意状态（首次启动弹窗）
};

async function readStore(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); } catch { return fallback; }
}
async function writeStore(file, data) {
  // 原子写：先写临时文件再 rename，避免进程被杀/断电导致 JSON 文件损坏（损坏会使 readStore 静默回退、数据归零）
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

// ---- 安全辅助：路径穿越防护 / SSRF 防护 / 图片类型嗅探 / CORS 收敛 ----

// 把任意用户输入片段拼入 root，确保最终结果严格落在 root 之内（防 ../ 穿越、防写系统文件）。
// 过滤所有路径分隔符与非法字符；若仍越界直接抛错。
// 取图片根目录的规范路径（解析根本身可能的符号链接），用于二次校验落点不被符号链接引到目录外。
function canonicalRoot(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

// 二次校验：确认已落盘的目标（必须存在）经符号链接解析后仍在 root 之内，防符号链接逃逸。
function assertInside(root, target) {
  const base = canonicalRoot(root);
  let real;
  try { real = fs.realpathSync(target); } catch { return; } // 目标不存在等偶发情况，交给上层处理
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error('非法路径：文件经符号链接逃逸出图片根目录');
  }
}

function safeChild(root, ...parts) {
  const safe = parts.map((p) =>
    String(p == null ? '' : p)
      .trim()
      .replace(/[\/\\]+/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/[:*?"<>|]/g, '_')
  );
  const full = path.resolve(root, ...safe);
  const base = canonicalRoot(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('非法路径：试图写入图片根目录之外');
  }
  return full;
}

// 仅允许的图片扩展名（杜绝 .bat/.ps1/.exe 等可执行落地）
const IMG_EXT_WHITELIST = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true; // IPv6 链路/唯一本地
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// 阻止图片代理访问私网/内网（防 SSRF 探测与云元数据泄露）
async function assertPublicUrl(target) {
  let u;
  try { u = new URL(target); } catch { throw new Error('非法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https');
  const host = u.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIp(host)) throw new Error('禁止访问私网地址');
  if (host === 'localhost') throw new Error('禁止访问私网地址');
  try {
    const { address } = await dns.lookup(host);
    if (isPrivateIp(address)) throw new Error('禁止访问私网地址'); // DNS 重绑定防护
  } catch (e) {
    if (e && /禁止访问/.test(e.message)) throw e;
    // 解析失败（离线/域名不存在）放行，由后续 fetch 失败兜底
  }
}

// 按文件头嗅探位图类型（防 SVG/HTML 等被伪装成图片回显执行）
function sniffRaster(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const four = buf.slice(8, 12).toString('ascii');
    if (four === 'WEBP') return 'image/webp';
    if (four === 'avif' || four === 'mif1') return 'image/avif';
  }
  return null;
}

// CORS 收敛：仅允许本机回环、浏览器插件源（chrome/moz-extension）、以及小红书域名；
// 其他来源（如用户访问的恶意网页）一律回退到回环，禁止跨源读取本地密钥/数据。
const reqScope = new AsyncLocalStorage();
function corsHeaders() {
  const req = reqScope.getStore();
  const origin = req && req.headers && req.headers.origin;
  const ALLOW = [
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
    /^https?:\/\/localhost(:\d+)?$/i,
    /^https:\/\/[\w-]+\.xiaohongshu\.com$/i,
    /^https:\/\/xiaohongshu\.com$/i,
  ];
  if (origin && (ALLOW.some((re) => re.test(origin)) || origin === 'null')) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }
  return {
    'Access-Control-Allow-Origin': `http://127.0.0.1:${PORT}`,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// 敏感配置字段：仅在受信来源（回环页面/本机扩展）返回明文；跨域来源（小红书页面/隐私上下文 null）返回掩码。
const SECRET_SETTING_KEYS = ['aiApiKey', 'imgAiApiKey', 'bitApiKey', 'feishuAppSecret'];
const MASK = '******';
function isTrustedSettingOrigin(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return true; // 同源（桌面页面 http://127.0.0.1:PORT 不带/带同源 Origin 均视为受信）
  if (origin === 'null') return false; // 贴图 data URL / 其他隐私上下文 → 脱敏
  return /^(chrome-extension|moz-extension):\/\//i.test(origin)
    || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}
function maskSecretSettings(obj) {
  const out = { ...obj };
  for (const k of SECRET_SETTING_KEYS) out[k] = out[k] ? MASK : '';
  return out;
}

// ---- 本地敏感词 / 合规自检（词库见 sensitive-words.mjs，纯本地、不依赖平台接口）----
// 扁平化并按词长降序，优先匹配长词；命中仅提示不拦截。
const SENSITIVE_WORDS = [];
for (const c of SENSITIVE_CATEGORIES) {
  for (const w of c.words) {
    if (w) SENSITIVE_WORDS.push({ word: w, category: c.name, severity: c.severity });
  }
}
SENSITIVE_WORDS.sort((a, b) => b.word.length - a.word.length);

function checkSensitive(text) {
  const empty = { clean: true, total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, matches: [] };
  if (!text || typeof text !== 'string') return empty;
  const covered = [];
  const matches = [];
  for (const { word, category, severity } of SENSITIVE_WORDS) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      const end = idx + word.length;
      const overlap = covered.some(([s, e]) => idx < e && end > s);
      if (overlap) { idx = text.indexOf(word, end); continue; }
      if (!overlap) {
        matches.push({ word, category, severity, index: idx });
        covered.push([idx, end]);
      }
      idx = text.indexOf(word, end);
    }
  }
  matches.sort((a, b) => a.index - b.index);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const m of matches) bySeverity[m.severity] = (bySeverity[m.severity] || 0) + 1;
  return { clean: matches.length === 0, total: matches.length, bySeverity, matches };
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

const DEFAULT_TOPICS_PROMPT = `你是一个中文内容创作助手。请严格基于我提供的「标题/商品名」的核心主题，生成6个高度相关的话题。
要求：
1. 每个话题一行，或用中文逗号、英文逗号分隔。
2. 每个话题不超过8个字。
3. 话题必须紧扣内容（品类、场景、人群、功效、风格等角度），禁止使用通用套话（如：好物分享、宝藏好物、平价好物、亲测推荐、干货、日常、必入、分享）。
4. 话题之间不重复。
5. 不要带#号或任何符号，只给纯文字。
6. 只输出话题本身，不要编号、不要解释、不要前后缀。`;

const DEFAULT_CONTENT_PROMPT = `你是一个中文文案助手。请根据我提供的标题，生成一段自然、真实的中文短文案。

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
2. 用自然口语表达，句子可以短一点，带一点“随手记录”的感觉，避免说明书口吻。
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

// AI 生图默认提示词模板（支持占位符 {{标题}} / {{商品ID}}，逐行替换后调用图像 API）
const DEFAULT_IMG_PROMPT = `你是小红书的专家，擅长小红书爆款封面设计。请根据下面这条宝贝信息，直接生成一张适合小红书发布的封面图。

宝贝ID：{{商品ID}}
宝贝标题：{{标题}}

要求：
1. 提取标题里的核心卖点关键词，作为封面主标题文字（醒目、易读、不超过 12 字）。
2. 小红书风格：竖版 3:4 比例，干净背景，清新高级配色，有质感。
3. 画面不要出现违规、低俗、虚假夸大内容。
4. 只输出图片，不要任何解释文字。`;

const DEFAULT_SETTINGS = {
  aiProvider: 'deepseek',
  aiApiKey: '',
  aiModel: '',
  aiBaseUrl: '',
  // AI 生图（图像生成 API，单独配置，独立于上面的文本 AI）
  // 默认对接「方舟 gpt-image-2」接口（Apifox 文档 api-418255962），Key 由用户自配
  // provider: ark=OpenAI风格 /images/generations; suchuang=速创 /api/async/image_gpt（异步轮询）
  imgAiProvider: 'ark',
  imgAiBaseUrl: 'https://api.aiyungc.cn/v1',
  imgAiApiKey: '',
  imgAiModel: 'gpt-image-2',
  imgAiSize: 'auto',
  imgAiCount: 1,
  imgAiExtra: '{"quality":"low","format":"jpeg"}',
  imgAiPromptTemplate: DEFAULT_IMG_PROMPT,
  publishMode: 'extension',
  // 比特浏览器本地 API（用于按指纹配置序号 seq 打开/关闭隔离窗口）
  bitApiHost: 'http://127.0.0.1:54345',
  bitApiKey: '',
  qianfanUrl: 'https://ark.xiaohongshu.com/ark/product/list',
  // 千帆爬虫连接已登录 Chrome 的 CDP 远程调试地址（留空则回退 cdp-config.json 的 browserURL，默认 127.0.0.1:9222）
  qianfanChromeUrl: '',
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
  typingSpeed: 'normal', // 拟人输入速度档：normal=常速，cautious=缓行（更慢、停顿更多，更不易被识别）
  publishIntervalSeconds: 500,
  publishIntervalRandomDelaySeconds: 200,
  singleProductRepeatLimit: 0,
  imagesRoot: '',
  csvExportDir: '', // 商品 CSV 导出目录；空则默认 数据目录/csv
  // 飞书多维表格（千帆商品一键写入飞书）：凭证 + 自动建表后回填的表格定位
  feishuAppId: '',
  feishuAppSecret: '',
  feishuAppToken: '',  // 已创建/复用的多维表格 app_token（首次导出自动建表后回填）
  feishuTableId: '',   // 已创建/复用的数据表 table_id
  feishuNoteTableId: '', // 「热点笔记」数据表 table_id（前台笔记写入后回填）
};

// 下一篇发布时间由浏览器插件通过 /api/ext/schedule 上报维护
let extNextPublishAt = 0;  // 插件通过 /api/ext/schedule 上报
function getNextPublishAt() {
  const now = Date.now();
  return extNextPublishAt > now ? extNextPublishAt : 0;
}

// 在线插件实例注册表（BitBrowser 多账号并行模型）：
// 每个比特窗口里的扩展在 options 页绑定一个后台「账号」(accountId) + 比特配置名(bitProfile)，
// 然后每隔约 30s 调 /api/ext/register 上报一次「在线」；服务端把任务按 accountId 路由给对应窗口实例，
// 各窗口互不抢任务，天然并行。内存 Map + 落盘，进程重启可恢复在线状态。
const extInstances = new Map(); // instanceId -> { instanceId, accountId, profileName, extVersion, serverUrl, firstSeen, lastSeen }
const INSTANCE_TTL_MS = 90 * 1000; // 超过 90s 未心跳视为离线（比特窗口关闭/崩溃）
(async function loadInstances() {
  try {
    const arr = await readStore(stores.instances, []);
    if (Array.isArray(arr)) for (const it of arr) extInstances.set(it.instanceId, it);
  } catch {}
})();
function gcInstances() {
  const now = Date.now();
  for (const [k, v] of extInstances) if (now - (v.lastSeen || 0) > INSTANCE_TTL_MS) extInstances.delete(k);
}
async function saveInstances() {
  try { await writeStore(stores.instances, [...extInstances.values()]); } catch {}
}
// 判断一条任务是否属于某请求实例的「账号范畴」：
//   - 实例配置了 accountId → 仅匹配 task.accountId === accountId（严格按账号隔离）
//   - 实例未配置 accountId（兼容旧的单账号部署）→ 仅匹配「未指派账号」的任务（catch-all）
function taskMatchesAccount(task, reqAccountId) {
  if (reqAccountId) return task.accountId === reqAccountId;
  return !task.accountId || task.accountId === '';
}

// 发布间隔：套餐频率档只规定「最短间隔」下限（反爬安全），用户设置若更大则取其大；
// 随机延迟同理取用户设置（无则用套餐档位范围）。避免套餐 min 直接覆盖用户自定义间隔。
function effectiveInterval(stored) {
  const iv = planIntervalSeconds(DATA);
  const base = Number(stored && stored.publishIntervalSeconds) || iv.publishIntervalSeconds;
  const rand = Number(stored && stored.publishIntervalRandomDelaySeconds);
  return {
    publishIntervalSeconds: Math.max(base, iv.publishIntervalSeconds),
    publishIntervalRandomDelaySeconds: Number.isFinite(rand) && rand > 0 ? rand : iv.publishIntervalRandomDelaySeconds,
  };
}

const PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
};

// 出站请求统一超时（默认 30s），防第三方/本地 API 挂死长期占用事件循环。
async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  const resp = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
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

// ---- AI 生图适配器（多供应商：方舟 OpenAI 风格 / 速创异步）----
async function generateImages(settings, prompt, count, size, extra) {
  const provider = (settings.imgAiProvider || 'ark').toLowerCase();
  if (provider === 'suchuang') {
    return generateImagesSuchuang(settings, prompt, count, size, extra);
  }
  return generateImagesArk(settings, prompt, count, size, extra);
}

// 方舟 / OpenAI 兼容：同步 /images/generations，兼容 b64_json 或 url
async function generateImagesArk(settings, prompt, count, size, extra) {
  const baseUrl = 'https://api.aiyungc.cn/v1';
  const apiKey = settings.imgAiApiKey || '';
  const model = settings.imgAiModel || '';
  // 仅当下载 URL 与图像 API 同源时才附带 Authorization，避免把 API Key 泄漏给第三方 CDN/URL
  const sameOriginAsApi = (u) => { try { return new URL(u).origin === new URL(baseUrl).origin; } catch { return false; } };
  const authForUrl = (u) => (sameOriginAsApi(u) && apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
  if (!apiKey || !baseUrl || !model) throw new Error('未配置 AI 生图（缺 Key / BaseURL / Model）');
  const body = {
    model,
    prompt,
    n: Math.max(1, Math.min(8, count || 1)),
    ...(extra || {}),
  };
  // size='auto' 或不传时省略 size 字段，使用图像 API 的默认尺寸（避免部分接口不支持 'auto' 字面量而报错）
  if (size && size !== 'auto') body.size = size;
  const resp = await fetchWithTimeout(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, 60000);
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`图像 API HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }
  const j = await resp.json().catch(() => ({}));
  // 兼容多种返回结构：data[] / images[] / 直接数组 / 顶层 b64_json
  let arr = [];
  if (Array.isArray(j.data)) arr = j.data;
  else if (Array.isArray(j.images)) arr = j.images;
  else if (Array.isArray(j)) arr = j;
  else if (j && (j.b64_json || j.url)) arr = [j];
  if (!arr.length) throw new Error('图像 API 返回为空');
  const bufs = [];
  for (const item of arr) {
    if (item && item.b64_json) {
      bufs.push(Buffer.from(item.b64_json, 'base64'));
    } else if (item && item.url) {
      const r2 = await fetchWithTimeout(item.url, { headers: authForUrl(item.url) }, 30000);
      if (!r2.ok) throw new Error(`下载图像失败 HTTP ${r2.status}`);
      bufs.push(Buffer.from(await r2.arrayBuffer()));
    } else if (typeof item === 'string') {
      const r2 = await fetchWithTimeout(item, { headers: authForUrl(item) }, 30000);
      if (!r2.ok) throw new Error(`下载图像失败 HTTP ${r2.status}`);
      bufs.push(Buffer.from(await r2.arrayBuffer()));
    } else {
      throw new Error('图像 API 返回缺少 b64_json 或 url');
    }
  }
  return bufs;
}

// 速创：POST /api/async/image_gpt 提交异步任务，然后轮询结果
async function generateImagesSuchuang(settings, prompt, count, size, extra) {
  const baseUrl = 'https://api.wuyinkeji.com';
  const apiKey = settings.imgAiApiKey || '';
  if (!apiKey) throw new Error('未配置速创 AI 生图 Key');
  const SC_PATH = '/api/async/image_gpt';
  const submitUrl = `${baseUrl}${SC_PATH}?key=${encodeURIComponent(apiKey)}`;
  // 文档参数：prompt（必填）、size（可选）、urls（可选）。不传 model（文档未定义）。
  const submitBody = {
    prompt,
    ...(size && size !== 'auto' ? { size } : {}),
    ...(extra || {})
  };
  // 文档示例：?key= 鉴权；同时保留 Authorization 兼容
  const submitResp = await fetchWithTimeout(submitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify(submitBody),
  }, 30000);
  if (!submitResp.ok) {
    const t = await submitResp.text().catch(() => '');
    throw new Error(`速创提交任务失败 HTTP ${submitResp.status}: ${t.slice(0, 300)}`);
  }
  const submitJson = await submitResp.json().catch(() => ({}));
  if (!submitJson || submitJson.code !== 200) {
    throw new Error(`速创提交任务失败：${submitJson && submitJson.msg ? submitJson.msg : JSON.stringify(submitJson)}`);
  }
  const taskId = submitJson.data && (submitJson.data.id || submitJson.data.task_id || submitJson.data.taskId);
  if (!taskId) {
    // 若返回即结果（data 为 url / base64 / 数组），直接下载
    const direct = await extractImagesFromSuchuang(submitJson);
    if (direct.length) return direct;
    throw new Error('速创未返回任务ID，无法轮询结果：' + JSON.stringify(submitJson));
  }
  console.log('[ai-image] 速创任务已提交，taskId=' + taskId);
  // 轮询结果：查询接口为 /api/async/detail（doc/47）：GET ?key=&id=taskId
  const DETAIL_PATH = '/api/async/detail';
  const queryUrlTemplate = (extra && extra.queryUrl) || `${baseUrl}${DETAIL_PATH}?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(taskId)}`;
  const resultPath = (extra && extra.resultPath) || 'data.images';
  const maxAttempts = (extra && extra.maxAttempts) || 40;
  const intervalMs = (extra && extra.intervalMs) || 2000;
  const pollSnapshots = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const queryUrl = queryUrlTemplate
      .replace(/\{key\}/g, encodeURIComponent(apiKey))
      .replace(/\{id\}/g, encodeURIComponent(taskId));
    const qResp = await fetchWithTimeout(queryUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey }
    }, 15000).catch((e) => ({ __networkError: true, message: e && e.message }));
    if (qResp && qResp.__networkError) {
      pollSnapshots.push({ attempt, url: queryUrl, status: 'NETWORK_ERROR', body: qResp.message });
      continue;
    }
    const status = qResp ? qResp.status : null;
    const qText = qResp ? await qResp.text().catch(() => '') : '';
    let qJson = {};
    try { qJson = qText ? JSON.parse(qText) : {}; } catch {}
    pollSnapshots.push({ attempt, url: queryUrl, status, body: qText.slice(0, 600) });
    console.log(`[ai-image] 速创轮询#${attempt} status=${status} body=${qText.slice(0, 400)}`);
    if (status !== 200) continue;
    // 接口层：code !== 0/200 视为异常（成功返回 code=0），但仍尝试提取图片兜底
    const dd = qJson.data || {};
    const taskStatus = dd.status !== undefined ? dd.status
      : (qJson.status !== undefined ? qJson.status : null);
    if (taskStatus === 3) {
      const msg = dd.message || qJson.msg || '未知错误';
      const err = new Error(`速创任务 ${taskId} 执行失败：${msg}`);
      err.suchuangDebug = { taskId, submitResponse: submitJson, lastPolls: pollSnapshots.slice(-5), tip: '任务执行失败（status=3），详见返回的 data.message。' };
      throw err;
    }
    if (taskStatus === 0 || taskStatus === 1) continue; // 未就绪，继续等待
    // 成功（status===2）或 status 缺失时尝试提取图片
    let imgs = await extractImagesFromSuchuang(qJson, resultPath);
    if (!imgs.length) imgs = await extractImagesFromSuchuang(qJson, 'data');
    if (!imgs.length) imgs = await collectImageUrlsDeep(qJson);
    if (imgs.length) {
      console.log(`[ai-image] 速创任务 ${taskId} 成功，取到 ${imgs.length} 张图`);
      return imgs;
    }
  }
  // 轮询失败：把调试信息塞进 Error，让前端能看到 taskId 和最近几次响应
  const debug = {
    taskId,
    submitResponse: submitJson,
    lastPolls: pollSnapshots.slice(-5),
    tip: '任务已提交成功并扣点，但轮询未拿到图片。可能原因：1) 查询结果接口路径不同；2) 结果在 data 其他字段；3) 任务需要更长时间。请在「附加请求体」中配置 queryUrl/resultPath，或去速创控制台查看结果。'
  };
  const err = new Error(`速创任务 ${taskId} 轮询 ${maxAttempts} 次仍未拿到图片。任务已提交成功（见控制台扣点记录）。调试信息：${JSON.stringify(debug)}`);
  err.suchuangDebug = debug;
  throw err;
}

// 递归遍历整个响应对象，收集所有图片 URL（http(s) 链接，后缀为常见图片格式）以及 data:image base64。
// 用于兜底提取，应对速创返回字段路径不固定（文档未明确图片 URL 所在字段）。
async function collectImageUrlsDeep(obj, depth = 0, seen = new Set()) {
  const urls = [];
  const scan = (o, d) => {
    if (!o || d > 8 || typeof o === 'function') return;
    if (seen.has(o)) return;
    if (typeof o === 'string') {
      if (/^data:image\/[^;]+;base64,/.test(o)) urls.push(o);
      else if (/^https?:\/\//.test(o) && /\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i.test(o)) urls.push(o);
      return;
    }
    if (Array.isArray(o)) { o.forEach((v) => scan(v, d + 1)); return; }
    if (typeof o === 'object') {
      seen.add(o);
      Object.keys(o).forEach((k) => scan(o[k], d + 1));
    }
  };
  scan(obj, 0);
  const uniq = [...new Set(urls)].slice(0, 10);
  const bufs = [];
  for (const u of uniq) {
    try {
      if (/^data:image\/[^;]+;base64,/.test(u)) bufs.push(Buffer.from(u.split(',')[1], 'base64'));
      else bufs.push(await downloadBuffer(u));
    } catch (e) { /* 单个失败跳过 */ }
  }
  return bufs;
}

// 从速创响应中提取图片 Buffer（支持 url / base64 / data[].url / data[].b64_json / data.images[].url 等）
async function extractImagesFromSuchuang(json, resultPath = 'data.images') {
  const bufs = [];
  const candidates = [];
  // 1. 常见顶层字段
  if (Array.isArray(json.data)) candidates.push(...json.data);
  else if (json.data && typeof json.data === 'object') {
    if (json.data.images) candidates.push(...json.data.images);
    else if (json.data.url || json.data.b64_json || json.data.image_url) candidates.push(json.data);
    else candidates.push(json.data);
  }
  // 2. 按 resultPath 解析（如 data.images）
  try {
    let cur = json;
    for (const k of resultPath.split('.')) { cur = cur && cur[k]; }
    if (cur) {
      if (Array.isArray(cur)) candidates.push(...cur);
      else candidates.push(cur);
    }
  } catch {}
  // 3. 顶层数组 / 字符串
  if (Array.isArray(json)) candidates.push(...json);
  if (typeof json === 'string' && /^https?:\/\//.test(json)) candidates.push(json);

  for (const item of candidates) {
    if (!item) continue;
    try {
      if (typeof item === 'string') {
        if (/^data:image\/[^;]+;base64,/.test(item)) {
          bufs.push(Buffer.from(item.split(',')[1], 'base64'));
        } else if (/^https?:\/\//.test(item)) {
          bufs.push(await downloadBuffer(item));
        }
      } else if (item.b64_json || item.base64) {
        bufs.push(Buffer.from(item.b64_json || item.base64, 'base64'));
      } else if (item.url || item.image_url || item.imageUrl) {
        bufs.push(await downloadBuffer(item.url || item.image_url || item.imageUrl));
      }
    } catch (e) {
      console.error('[ai-image] 提取单张速创图片失败：', e && e.message);
    }
  }
  return bufs;
}

async function downloadBuffer(url) {
  const r = await fetchWithTimeout(url, {}, 30000);
  if (!r.ok) throw new Error(`下载图像失败 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// 按图片魔数判断真实扩展名（避免 .png 写 jpeg 等错配）
function imageExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return 'png';
}

function localFallback(prompt, kind) {
  // 无 Key 时的本地兜底
  const base = (prompt || '').replace(/\s+/g, ' ').trim();
  if (kind === 'title') {
    const t = base.length > 20 ? base.slice(0, 18) + '…' : base;
    return t || '好物分享';
  }
  if (kind === 'topics') {
    return ['好物', '分享', '日常'];
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
    // 单步失败则用兜底补齐，保证流程不中断；但记录异常便于排查（此前被静默吞没）
    console.error('[AI] 生成异常，已用本地兜底补齐：', e && (e.message || e));
    if (!genTitle || genTitle === title) genTitle = localFallback(title, 'title');
    if (!body) body = localFallback(title, 'content');
    if (!topics.length) topics = localFallback(title, 'topics');
  }
  return { title: genTitle, body, topics };
}

// ---- 批量发布编排（发布由浏览器插件驱动，桌面端仅提供队列读取与倒计时）----
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

function mergeTask(tasks, task) {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = task; else tasks.push(task);
  return tasks;
}
// ---- 本地图片文件夹（按 images/<id>/ 读取并发布）----
// 图片根目录：设置里填了用填的（绝对路径），否则默认「软件根目录（exe 同级）下的 images/」
function resolveImagesRoot(settings) {
  const s = (settings && settings.imagesRoot) || '';
  if (s && s.trim()) return path.resolve(s.trim());
  // 绿色免安装版：exe 同级目录下的 images/（即 win-unpacked/images）；node 直接跑时回退到 DATA/images
  if (process.versions && process.versions.electron) {
    const root = path.join(path.dirname(process.execPath), 'images');
    console.log('[黑猫] 图片根目录(默认):', root);
    return root;
  }
  return path.join(DATA, 'images');
}
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const SEED_FILES = ['name.txt', 'caption.txt', 'title.txt'];
// 扫描图片根目录：每个直接子目录 = 一篇笔记，目录名即 id；目录内图片按文件名排序
// 文件夹名格式支持 "<productId>_<suffix>"（如 686673d41ea4cb001553c6da_1），productId 用于匹配选品商品库
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
  res.end(b);
}
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB（批量作图 import-chunk 单请求上传整张图，PNG base64 可能 >2MB）

// 带 HTTP 状态码的业务错误：外层 catch 据此返回对应状态，而非一律 500
class HttpError extends Error {
  constructor(code, message) { super(message); this.statusCode = code; }
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_SIZE) throw new HttpError(413, '请求体超过 10MB 限制');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf-8');
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new HttpError(400, '请求体不是合法 JSON'); }
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

// ---- 商品 CSV 导出（供浏览器插件「导出CSV」按钮调用，后端落盘）----
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
// 与用户现有「大舟舟第1页.csv」模板对齐：宝贝id,标题,内容,话题,发布日期,发布时间
function buildProductsCsv(rows) {
  const header = ['宝贝id', '标题', '内容', '话题', '发布日期', '发布时间'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of (rows || [])) {
    const id = (r && r.id != null) ? r.id : '';
    const title = (r && r.title != null) ? r.title : '';
    lines.push([id, title, '', '', '', ''].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n'); // UTF-8 BOM 让 Excel 正确识别中文
}
function sanitizeFileName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.+$/, '').trim().slice(0, 80);
  return s || '商品导出';
}
function resolveCsvExportDir(settings) {
  const s = (settings && settings.csvExportDir) || '';
  if (s && s.trim()) return path.resolve(s.trim());
  // 与图片根目录同规则：绿色免安装版用 exe 同级目录下的 csv/，node 直接跑时回退到 DATA/csv
  if (process.versions && process.versions.electron) {
    const root = path.join(path.dirname(process.execPath), 'csv');
    console.log('[黑猫] CSV 导出目录(默认):', root);
    return root;
  }
  return path.join(DATA, 'csv');
}

const server = http.createServer((req, res) => reqScope.run(req, async () => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  // 预检 / 跨域（供浏览器插件从 ark/creator 页面 fetch 本地服务）
  if (method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders() });
    return res.end();
  }

  try {
    // 静态资源
    if (method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
      const rel = p === '/' ? '/index.html' : p.replace('/static', '');
      return sendFile(res, path.join(PUBLIC, rel));
    }

    // 批量作图：读取项目内置副本（public/generator.html，iframe 内加载隔离全局变量冲突）
    if (method === 'GET' && p === '/generator') {
      return sendFile(res, path.join(PUBLIC, 'generator.html'));
    }

    // AI 生图：根据提示词 + CSV 批量生成封面图，落盘到 images/<商品ID>_<序号>/
    if (method === 'GET' && p === '/ai-image') {
      return sendFile(res, path.join(PUBLIC, 'ai-image.html'));
    }

    // 批量作图：图片入库 — 把生成的图片保存到项目设置的图片根目录
    if (p === '/api/generator/import-chunk' && method === 'POST') {
      try {
        const body = await readBody(req);
        const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
        const root = resolveImagesRoot(settings);
        if (!root) return sendJSON(res, 400, { ok: false, error: '图片根目录未配置' });

        const { folderName: fnIn, fileName: fIn, index, total, mime, dataUrl } = body || {};
        if (!fnIn || !fIn || !dataUrl) {
          return sendJSON(res, 400, { ok: false, error: '参数不完整' });
        }

        // 文件夹名支持 <商品ID>_<序号> 格式（如 686673d41ea4cb001553c6da_1），文件名取前端传入
        // 安全：safeChild 过滤 ../ 与分隔符并校验落点在 root 内；扩展名强制走白名单，杜绝 .bat/.ps1 落地
        const mimeMap = {
          'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp'
        };
        const ext = mimeMap[(mime || 'image/png').toLowerCase()] || 'png';
        const base = String(fIn).trim().replace(/\.[^.]+$/i, ''); // 去掉用户给的扩展名
        const finalName = `${base}.${ext}`; // 强制用 mime 推导的安全扩展名
        const dir = safeChild(root, fnIn);
        fs.mkdirSync(dir, { recursive: true });
        assertInside(root, dir); // 二次校验：目录未被符号链接引到 root 外
        const file = safeChild(root, fnIn, finalName);
        const buf = Buffer.from(dataUrl, 'base64');
        await fsp.writeFile(file, buf);
        assertInside(root, file); // 二次校验：落盘文件未被符号链接逃逸

        return sendJSON(res, 200, { ok: true, folderName: fnIn, fileName: finalName, saved: typeof index === 'number' ? index + 1 : undefined, total });
      } catch (err) {
        console.error('[generator/import-chunk]', err);
        return sendJSON(res, 500, { ok: false, error: err.message || '保存失败' });
      }
    }

    // AI 生图：单条任务生成。请求体 { folderName, prompt, title?, count? }；图像 API 配置取自 settings。
    // 把生成结果逐张保存到 images/<folderName>/ 下（1.png/2.png...），并写 title.txt 供发布流水线当文案种子。
    if (p === '/api/ai-image/generate' && method === 'POST') {
      try {
        const body = await readBody(req);
        const s = await readStore(stores.settings, {});
        const settings = { ...DEFAULT_SETTINGS, ...s };
        const folderName = String(body.folderName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
        const prompt = (body.prompt || '').toString();
        const title = (body.title || '').toString();
        const count = Math.max(1, Math.min(8, parseInt(body.count, 10) || settings.imgAiCount || 1));
        // 尺寸优先取请求体（前端下拉框实时值），其次回退已保存配置
        const size = (body.size && String(body.size).trim()) || settings.imgAiSize || '1024x1024';
        if (!folderName) return sendJSON(res, 400, { ok: false, error: '缺少 folderName' });
        if (!prompt) return sendJSON(res, 400, { ok: false, error: '缺少 prompt' });
        const root = resolveImagesRoot(settings);
        if (!root) return sendJSON(res, 400, { ok: false, error: '图片根目录未配置' });
        const dir = safeChild(root, folderName);
        fs.mkdirSync(dir, { recursive: true });
        assertInside(root, dir); // 二次校验：目录未被符号链接引到 root 外
        let extra = {};
        if (settings.imgAiExtra && settings.imgAiExtra.trim()) {
          try { extra = JSON.parse(settings.imgAiExtra); }
          catch (e) { return sendJSON(res, 400, { ok: false, error: '附加参数不是合法 JSON：' + e.message }); }
        }
        const bufs = await generateImages(settings, prompt, count, size, extra);
        const files = [];
        for (let i = 0; i < bufs.length; i++) {
          const ext = imageExt(bufs[i]);
          const file = path.join(dir, `${i + 1}.${ext}`);
          await fsp.writeFile(file, bufs[i]);
          assertInside(root, file); // 二次校验：落盘文件未被符号链接逃逸
          files.push(path.relative(root, file));
        }
        if (title) {
          await fsp.writeFile(path.join(dir, 'title.txt'), title, 'utf-8').catch(() => {});
        }
        console.log('[ai-image/generate] 已保存', folderName, files);
        return sendJSON(res, 200, { ok: true, folderName, files });
      } catch (err) {
        console.error('[ai-image/generate]', err);
        const payload = { ok: false, error: err.message || '生成失败' };
        if (err.suchuangDebug) payload.suchuangDebug = err.suchuangDebug;
        return sendJSON(res, 500, payload);
      }
    }

    // 设置
    if (p === '/api/settings' && method === 'GET') {
      const s = await readStore(stores.settings, {});
      const merged = { ...DEFAULT_SETTINGS, ...s };
      const plan = resolvedPlan(DATA);
      // 套餐只规定最短间隔下限；用户设置更大则取用户值（尊重设置），更小才用套餐下限兜底
      const eff = effectiveInterval(merged);
      const out = {
        appVersion: APP_VERSION,
        ...(isTrustedSettingOrigin(req) ? merged : maskSecretSettings(merged)),
        // 把用户自己设置的间隔原值保留下来，供设置页回显
        userPublishIntervalSeconds: merged.publishIntervalSeconds,
        userPublishIntervalRandomDelaySeconds: merged.publishIntervalRandomDelaySeconds,
        publishIntervalSeconds: eff.publishIntervalSeconds,
        publishIntervalRandomDelaySeconds: eff.publishIntervalRandomDelaySeconds,
        plan: { key: plan.key, label: plan.label, autoSubmit: plan.autoSubmit, freqTier: plan.freqTier },
        maxAccounts: maxAccounts(DATA),
      };
      return sendJSON(res, 200, out);
    }
    if (p === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const cur = await readStore(stores.settings, {});
      // 掩码占位（'******'）视为「未修改」：保留原值，防止跨域来源把明文 Key 覆盖成掩码
      const next = { ...body };
      for (const k of SECRET_SETTING_KEYS) {
        if (body && body[k] === MASK) next[k] = cur[k] !== undefined ? cur[k] : DEFAULT_SETTINGS[k];
      }
      await writeStore(stores.settings, { ...DEFAULT_SETTINGS, ...cur, ...next });
      return sendJSON(res, 200, { ok: true });
    }

    // 免责协议同意状态（首次启动弹窗，落盘 DATA/agreement.json，清缓存不可绕过）
    if (p === '/api/agreement') {
      if (method === 'GET') {
        const a = await readStore(stores.agreement, { agreed: false });
        return sendJSON(res, 200, { agreed: !!(a && a.agreed), agreedAt: (a && a.agreedAt) || null });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body || body.agreed !== true) {
          return sendJSON(res, 400, { ok: false, error: 'must-agree' });
        }
        await writeStore(stores.agreement, { agreed: true, agreedAt: new Date().toISOString() });
        return sendJSON(res, 200, { ok: true });
      }
    }

    // 账号注册表（套餐配额门禁）：绑定/解绑发布平台账号，受 plan.accounts 限制
    if (p === '/api/accounts' && method === 'GET') {
      const reg = await readStore(stores.account, { accounts: [] });
      const raw = Array.isArray(reg.accounts) ? reg.accounts : [];
      gcInstances();
      const now = Date.now();
      const onlineIds = new Set(
        [...extInstances.values()]
          .filter((it) => (now - (it.lastSeen || 0)) <= INSTANCE_TTL_MS && it.accountId)
          .map((it) => it.accountId)
      );
      const list = raw.map((a) => ({ ...a, online: onlineIds.has(a.id) }));
      return sendJSON(res, 200, { ok: true, accounts: list, max: maxAccounts(DATA) });
    }
    if (p === '/api/accounts' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const reg = await readStore(stores.account, { accounts: [] });
      const list = Array.isArray(reg.accounts) ? reg.accounts : [];
      const max = maxAccounts(DATA);
      if (max !== Infinity && list.length >= max) {
        return sendJSON(res, 403, {
          ok: false,
          error: 'account-limit',
          max,
          count: list.length,
          message: `当前套餐最多绑定 ${max} 个账号，已达上限。请升级套餐或解绑多余账号后再添加。`,
        });
      }
      const acct = {
        id: uid('acc'),
        name: (body && body.name) || `账号${list.length + 1}`,
        createdAt: Date.now(),
      };
      list.push(acct);
      await writeStore(stores.account, { accounts: list });
      return sendJSON(res, 200, { ok: true, account: acct, accounts: list, max });
    }
    if (p.startsWith('/api/accounts/') && p.endsWith('/delete') && method === 'POST') {
      const id = p.split('/')[3];
      const reg = await readStore(stores.account, { accounts: [] });
      const list = Array.isArray(reg.accounts) ? reg.accounts : [];
      const next = list.filter((x) => x.id !== id);
      await writeStore(stores.account, { accounts: next });
      // 解绑账号时，把指向该账号的待发任务 accountId 置空，避免任务因找不到账号而永久卡死在队列
      const tasks = await readStore(stores.tasks, []);
      if (Array.isArray(tasks) && tasks.some((t) => t.accountId === id)) {
        const patched = tasks.map((t) => (t.accountId === id ? { ...t, accountId: null } : t));
        await writeStore(stores.tasks, patched);
      }
      return sendJSON(res, 200, { ok: true, accounts: next, max: maxAccounts(DATA) });
    }
    // 更新单个账号（比特配置名 bitProfile、备注名等）。多账号并行时，扩展在 options 页绑定账号即PATCH bitProfile。
    if (p.startsWith('/api/accounts/') && p.endsWith('/patch') && method === 'POST') {
      const id = p.split('/')[3];
      const body = await readBody(req).catch(() => ({}));
      const reg = await readStore(stores.account, { accounts: [] });
      const list = Array.isArray(reg.accounts) ? reg.accounts : [];
      const acc = list.find((x) => x.id === id);
      if (!acc) return sendJSON(res, 404, { ok: false, error: 'account not found' });
      if (body.name != null) acc.name = String(body.name);
      if (body.bitProfile != null) acc.bitProfile = String(body.bitProfile); // 比特浏览器配置名/ID
      if (body.note != null) acc.note = String(body.note);
      // 每账号独立发布间隔（秒）；0/空/非法 → 跟随全局设置（不覆盖套餐下限由 ext/next 保证）
      if (body.interval != null) {
        const n = Number(body.interval);
        acc.interval = (Number.isFinite(n) && n > 0) ? n : null;
      }
      await writeStore(stores.account, { accounts: list });
      return sendJSON(res, 200, { ok: true, account: acc, accounts: list, max: maxAccounts(DATA) });
    }

    // 敏感词 / 合规自检：本地词库，不依赖平台接口
    if (p === '/api/sensitive/categories' && method === 'GET') {
      const categories = SENSITIVE_CATEGORIES.map((c) => ({ name: c.name, severity: c.severity, count: c.words.length }));
      const totalWords = SENSITIVE_WORDS.length;
      return sendJSON(res, 200, { ok: true, categories, totalWords });
    }
    if (p === '/api/sensitive/check' && method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}));
        const text = (body && typeof body.text === 'string') ? body.text : '';
        const result = checkSensitive(text);
        return sendJSON(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error('[sensitive/check]', err);
        return sendJSON(res, 500, { ok: false, error: err.message || '检测失败' });
      }
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

    // 从选品抓取
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

    // 队列（发布由浏览器插件驱动，桌面端只读取队列与倒计时，不内置发布能力）
    if (p === '/api/batch/queue' && method === 'GET') {
      let tasks = await readStore(stores.tasks, []);
      const qa = url.searchParams.get('accountId');
      // 多账号并行：按账号过滤队列（未传 accountId 仍返回全量，向后兼容）
      if (qa) tasks = tasks.filter((t) => t.accountId === qa);
      const nextPublishAt = getNextPublishAt();
      return sendJSON(res, 200, { tasks, nextPublishAt });
    }
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
    // 指派任务到某发布账号（比特多账号并行）：把一批 queued/picked/manual_hold/failed 任务绑定 accountId，
    // 服务端 /api/ext/next 据此只把该账号任务下发给对应窗口实例。taskIds 为空且 all=true 时指派全部可指派任务。
    if (p === '/api/batch/assign' && method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.taskIds) ? body.taskIds : [];
      const all = body.all === true;
      if (!ids.length && !all) return sendJSON(res, 400, { ok: false, error: 'taskIds required' });
      const accountId = (body && body.accountId) || ''; // 空字符串 = 取消指派（回到 catch-all）
      const tasks = await readStore(stores.tasks, []);
      const assignable = new Set(['queued', 'picked', 'manual_hold', 'failed']);
      let n = 0;
      for (const t of tasks) {
        if (ids.length && !ids.includes(t.id)) continue;
        if (!ids.length && !all) continue;
        if (!assignable.has(t.status)) continue;
        t.accountId = accountId;
        t.updatedAt = nowISO();
        n++;
      }
      await writeStore(stores.tasks, tasks);
      return sendJSON(res, 200, { ok: true, assigned: n, accountId });
    }

    // ===== 比特浏览器本地 API 代理（按指纹配置打开/关闭隔离窗口）=====
    // 比特浏览器多窗口并行：每个配置一个独立指纹 + 独立代理 IP。本后端只把指令转发给比特本地 API。
    // 比特 Local API 默认 http://127.0.0.1:54345，路径为 /browser/*，不需要 /api 前缀。
    // 打开/关闭窗口都需要传窗口配置 ID（UUID），不是 seq；列表是 POST /browser/list。
    async function bitForward(rel, method2, bodyObj) {
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const host = (settings.bitApiHost || 'http://127.0.0.1:54345').replace(/\/+$/, '');
      const apiKey = settings.bitApiKey || '';
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['api-key'] = apiKey;
      const r = await fetchWithTimeout(host + rel, {
        method: method2,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      }, 15000);
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { r, data };
    }
    function bitOk(data) {
      return data && (data.success === true || data.code === 0 || data.code === '0');
    }
    if (p.startsWith('/api/bitbrowser/') && method === 'POST') {
      const rel = p === '/api/bitbrowser/open' ? '/browser/open'
        : p === '/api/bitbrowser/close' ? '/browser/close' : null;
      if (!rel) return sendJSON(res, 404, { ok: false, detail: 'unknown endpoint' });
      const body = await readBody(req);
      if (!body.id) return sendJSON(res, 400, { ok: false, detail: '缺少 id（比特窗口 ID / 配置 UUID）' });
      try {
        const { r, data } = await bitForward(rel, 'POST', { id: String(body.id) });
        const ok = r.ok && bitOk(data);
        return sendJSON(res, 200, { ok, detail: ok ? '已发送指令' : ((data && (data.msg || data.message)) || ('比特返回 ' + r.status)), data });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: '调用比特浏览器失败：' + e.message + '（确认比特客户端已运行且本地 API 端口正确）' });
      }
    }
    if (p === '/api/bitbrowser/list' && method === 'GET') {
      try {
        const { r, data } = await bitForward('/browser/list', 'POST', { page: 0, pageSize: 200 });
        const list = (data && data.data && Array.isArray(data.data.list)) ? data.data.list
          : (data && Array.isArray(data.list)) ? data.list : [];
        return sendJSON(res, 200, { ok: r.ok && bitOk(data), detail: (data && (data.msg || data.message)) || (r.ok ? 'ok' : ('比特返回 ' + r.status)), list });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, detail: '调用比特浏览器失败：' + e.message, list: [] });
      }
    }

    // 历史
    if (p === '/api/history' && method === 'GET') {
      return sendJSON(res, 200, await readStore(stores.history, []));
    }

    // ===== 浏览器插件接口（扩展作为「浏览器内自动化层」配对本后端）=====
    // 推商品：扩展在选品页采集后写入商品库
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
        // 统一走 normalizeId 归一化（去空白/小写），避免大小写/空白差异造成重复入库。
        let dup = null;
        if (itemId) dup = products.find((m) => m.itemId && normalizeId(m.itemId) === normalizeId(itemId));
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
    // 导出当页商品 id+标题 为本地 CSV（落盘到 csvExportDir，默认 数据目录/csv）
    if (p === '/api/ext/export-csv' && method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];
      if (!rows.length) return sendJSON(res, 400, { ok: false, msg: '没有可导出的商品' });
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const dir = resolveCsvExportDir(settings);
      fs.mkdirSync(dir, { recursive: true }); // 首次导出时目录可能不存在，避免 ENOENT
      let base = sanitizeFileName(body.name);
      let file = path.join(dir, base + '.csv');
      if (fs.existsSync(file)) {
        let i = 2;
        while (fs.existsSync(path.join(dir, `${base}_${i}.csv`))) i++;
        file = path.join(dir, `${base}_${i}.csv`);
      }
      try {
        await fsp.writeFile(file, buildProductsCsv(rows), 'utf-8');
      } catch (e) {
        return sendJSON(res, 500, { ok: false, msg: '写入文件失败：' + e.message });
      }
      return sendJSON(res, 200, { ok: true, path: file, count: rows.length });
    }
    // 飞书多维表格：写入状态（配置是否完整、已建表格定位），供设置页与插件面板展示
    if (p === '/api/feishu/status' && method === 'GET') {
      const s = await readStore(stores.settings, {});
      const settings = { ...DEFAULT_SETTINGS, ...s };
      return sendJSON(res, 200, {
        ok: true,
        configured: !!(settings.feishuAppId && settings.feishuAppSecret),
        appToken: settings.feishuAppToken || '',
        tableId: settings.feishuTableId || '',
        noteTableId: settings.feishuNoteTableId || '',
        url: feishuTableUrl(settings.feishuAppToken),
      });
    }
    // 详情深采回报：详情页 content script 把正文图片/发布时间 POST 到内存缓存（按 noteId 覆盖）
    if (p === '/api/feishu/note-detail' && method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.noteId) return sendJSON(res, 400, { ok: false, error: '缺少 noteId' });
      saveNoteDetail(body);
      return sendJSON(res, 200, { ok: true });
    }
    // 详情深采查询：批量查某个 noteId 的缓存（供插件「采集正文图片」确认结果）
    if (p === '/api/feishu/note-detail' && method === 'GET') {
      const id = (url.searchParams.get('noteId') || '').trim();
      if (!id) return sendJSON(res, 200, { ok: true, detail: null });
      return sendJSON(res, 200, { ok: true, detail: getNoteDetail(id) });
    }
    // 飞书多维表格：把采集的商品/笔记数据写入（自动建表/复用；手动一键触发）
    // body.type: 'note' → 热点笔记表；缺省/其它 → 商品数据表
    if (p === '/api/feishu/export' && method === 'POST') {
      try {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items.slice(0, 5000) : [];
        if (!items.length) return sendJSON(res, 400, { ok: false, error: '没有要写入飞书的数据' });
        const s = await readStore(stores.settings, {});
        const settings = { ...DEFAULT_SETTINGS, ...s };
        if (!settings.feishuAppId || !settings.feishuAppSecret) {
          return sendJSON(res, 400, { ok: false, error: 'feishu-not-configured', msg: '请先在设置页填写飞书 App ID 与 App Secret' });
        }
        const isNote = body.type === 'note' || (body.items[0] && body.items[0].type === 'note');
        const r = isNote ? await writeNotesToFeishu(settings, items) : await writeProductsToFeishu(settings, items);
        // 首次自动建表后回填定位，避免下次重复建表
        if (r.appToken) {
          const patch = {};
          if (!s.feishuAppToken) patch.feishuAppToken = r.appToken;
          if (isNote) { if (!s.feishuNoteTableId && r.tableId) patch.feishuNoteTableId = r.tableId; }
          else if (!s.feishuTableId && r.tableId) patch.feishuTableId = r.tableId;
          if (Object.keys(patch).length) await writeStore(stores.settings, { ...DEFAULT_SETTINGS, ...s, ...patch });
        }
        return sendJSON(res, 200, { ok: true, count: r.count, url: r.url, appToken: r.appToken, tableId: r.tableId });
      } catch (err) {
        console.error('[feishu/export]', err);
        return sendJSON(res, 500, { ok: false, error: err.message || '飞书写入失败' });
      }
    }
    // 拉待发笔记：扩展在创作者页取一条去填充（标记 picked 防重复）
    if (p === '/api/ext/next' && method === 'GET') {
      const reqAccountId = (url.searchParams.get('accountId') || '').trim();
      const tasks = await readStore(stores.tasks, []);
      const now = Date.now();
      // 1) 先做一次"sweep"：把 picked 超时未回报的任务主动标成 failed，避免永远卡 picked
      //    之前只有"下一次 tick 顺便回收"，用户看到状态不动会误以为扩展死了。
      //    视频/大图填充可能较慢，且有心跳续命，这里放宽到 300s。
      const PICK_TIMEOUT_MS = 300 * 1000;
      const stale = [];
      for (const t of tasks) {
        if (t.status !== 'picked') continue;
        if (!taskMatchesAccount(t, reqAccountId)) continue; // 只回收本账号范畴内的 picked，多账号互不干扰
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
      const task = tasks.find((t) => t.status === 'queued' && taskMatchesAccount(t, reqAccountId))
        || tasks.find((t) => t.status === 'picked' && taskMatchesAccount(t, reqAccountId) && now - new Date(t.pickedAt || t.updatedAt || 0).getTime() <= PICK_TIMEOUT_MS);
      if (!task) return sendJSON(res, 200, { ok: true, task: null });
      task.status = 'picked'; task.step = 'fill_form'; task.statusDetail = '扩展已取走，填充中';
      task.pickedAt = new Date(now).toISOString();
      task.updatedAt = task.pickedAt;
      await writeStore(stores.tasks, mergeTask(tasks, task));
      const settings = { ...DEFAULT_SETTINGS, ...(await readStore(stores.settings, {})) };
      const effAuto = effectiveAutoSubmit(settings, DATA);
      // 发布间隔：尊重用户设置，套餐只作最短间隔下限；若本账号单独配置 interval，则以账号间隔为准（仍不低于套餐下限）
      const eff = effectiveInterval(settings);
      let ivSec = eff.publishIntervalSeconds;
      const ivRand = eff.publishIntervalRandomDelaySeconds;
      if (reqAccountId) {
        const accReg = await readStore(stores.account, { accounts: [] });
        const accList = Array.isArray(accReg.accounts) ? accReg.accounts : [];
        const acc = accList.find((x) => x.id === reqAccountId);
        const accIv = acc && acc.interval ? Number(acc.interval) : 0;
        if (accIv > 0) {
          const floor = planIntervalSeconds(DATA).publishIntervalSeconds; // 套餐最短下限
          ivSec = Math.max(accIv, floor);
        }
      }
      return sendJSON(res, 200, {
        ok: true, task,
        serverUrl: `http://127.0.0.1:${PORT}`,
        autoSubmit: effAuto,
        humanTyping: settings.humanTyping,
        typingSpeed: settings.typingSpeed || 'normal',
        qianfanUrl: settings.qianfanUrl,
        // 发布间隔沿用用户设置（套餐只规定最短下限），账号专属间隔可低于全局但不可低于套餐下限
        publishIntervalSeconds: ivSec,
        publishIntervalRandomDelaySeconds: ivRand,
      });
    }
    // 插件上报「下一篇最早发布时刻」：供桌面批量发布页同步显示倒计时
    if (p === '/api/ext/schedule' && method === 'POST') {
      const body = await readBody(req);
      const at = Number(body && body.nextPublishAt) || 0;
      const old = extNextPublishAt;
      extNextPublishAt = at;
      console.log('[ext/schedule] nextPublishAt=' + at + ' delta=' + (at ? (at - Date.now()) + 'ms' : '0') + ' old=' + old);
      return sendJSON(res, 200, { ok: true, nextPublishAt: at });
    }
    // 插件心跳：content script 长时间填充时定期续命，防止服务端把 picked 任务误判为超时失败
    if (p === '/api/ext/heartbeat' && method === 'POST') {
      const id = url.searchParams.get('id');
      const tasks = await readStore(stores.tasks, []);
      const t = id ? tasks.find((x) => x.id === id) : null;
      if (t && t.status === 'picked') {
        t.pickedAt = new Date(Date.now()).toISOString();
        t.updatedAt = t.pickedAt;
        await writeStore(stores.tasks, mergeTask(tasks, t));
      }
      return sendJSON(res, 200, { ok: true, task: t || null });
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
      // 状态白名单：只接受插件能真实回报的终态，防止任意字符串污染任务状态
      const ALLOWED_STATUS = ['published', 'failed', 'manual_hold', 'waiting_submit', 'verify_result'];
      const status = ALLOWED_STATUS.includes(body.status) ? body.status : 'published';
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
    // 插件实例注册 / 心跳（比特多账号并行核心）：每个扩展窗口周期性上报 instanceId + accountId + 比特配置名，
    // 服务端据此维护「在线实例」注册表，并据此把任务按账号路由到对应窗口。
    if (p === '/api/ext/register' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const instanceId = (body && body.instanceId) || (url.searchParams.get('instanceId')) || '';
      if (!instanceId) return sendJSON(res, 400, { ok: false, error: 'missing instanceId' });
      const accountId = (body && body.accountId) || '';
      const profileName = (body && body.profileName) || '';
      const extVersion = (body && body.extVersion) || '';
      const now = Date.now();
      const prev = extInstances.get(instanceId) || {};
      const inst = {
        instanceId,
        accountId,
        profileName,
        extVersion,
        serverUrl: (body && body.serverUrl) || '',
        firstSeen: prev.firstSeen || now,
        lastSeen: now,
      };
      extInstances.set(instanceId, inst);
      await saveInstances();
      // 回吐该账号当前待发任务数，便于实例侧感知自己的队列是否还有活
      const tasks = await readStore(stores.tasks, []);
      const pending = tasks.filter((t) =>
        taskMatchesAccount(t, accountId) && (t.status === 'queued' || t.status === 'picked')
      ).length;
      console.log('[ext/register] instance=' + instanceId + ' account=' + (accountId || '(none)') + ' profile=' + (profileName || '(none)') + ' pending=' + pending);
      return sendJSON(res, 200, { ok: true, instance: inst, pending });
    }
    // 列出当前在线实例（前端「账号/实例」面板展示哪些比特窗口在线、绑定了哪个账号）
    if (p === '/api/ext/instances' && method === 'GET') {
      gcInstances();
      const now = Date.now();
      const list = [...extInstances.values()].map((it) => ({
        ...it,
        online: (now - (it.lastSeen || 0)) <= INSTANCE_TTL_MS,
      }));
      return sendJSON(res, 200, { ok: true, instances: list, ttlMs: INSTANCE_TTL_MS });
    }

    // 图片代理：把远程商品图下载到本地并返回（带 CORS），供浏览器插件在发布平台页面注入图片时绕过防盗链
    if (p === '/api/image' && method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return sendJSON(res, 400, { ok: false, detail: 'missing url' });
      try {
        await assertPublicUrl(target); // SSRF 防护：拒绝私网/内网/云元数据地址
      } catch (e) {
        return sendJSON(res, 400, { ok: false, detail: 'url 不被允许：' + e.message });
      }
      try {
        const file = await downloadOne(target, UPLOADS);
        if (!file) return sendJSON(res, 502, { ok: false, detail: '图片下载失败（网络/防盗链）' });
        const data = await fsp.readFile(file);
        const ct = sniffRaster(data); // 仅允许位图，杜绝 SVG/HTML 伪装成图片回显执行
        if (!ct) return sendJSON(res, 415, { ok: false, detail: '仅支持位图图片' });
        res.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          ...corsHeaders(),
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
      // 相同 itemId 出现多条（如「选品采集的真实商品」与「导入时自动建的垃圾商品」）时，优先保留真实标题那条
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
        // 如果选品商品库匹配到了，用商品名替换文案种子
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
    // 标题/正文/话题由 AI 按商品名（选品商品库匹配 productId）生成；已导入的 id 自动跳过避免重复。
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
      const serverUrl = `http://127.0.0.1:${PORT}`;
      const created = [];
      for (const f of folders) {
        if (ids && !ids.includes(f.id)) continue;
        if (imported.has(f.id)) continue;
        const images = f.images.map((rel) => `${serverUrl}/api/file?rel=${encodeURIComponent(rel)}`);
        // 用文件夹名解析出的 productId 去选品商品库匹配（兼容大小写/空格）
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
        // 如果选品商品库已有此商品，复用；否则创建一条最小记录
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
            ? (nameWarning ? '已匹配选品商品，但商品名疑似未填真实标题（请到选品页修改该商品名）' : '已匹配选品商品并生成笔记')
            : '已导入本地图片文件夹并生成笔记（未匹配到选品商品，标题按文件夹名/name.txt 生成）', createdAt: nowISO(), updatedAt: nowISO(),
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
      // 符号链接防护：realpath 校验落点仍在 root 内（防止 root 下子目录被软链引到 root 外）
      try { assertInside(root, abs); } catch (e) {
        return sendJSON(res, 403, { ok: false, detail: e.message || '非法路径' });
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return sendJSON(res, 404, { ok: false, detail: '文件不存在' });
      const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      try {
        // 流式返回，避免大图 readFileSync 阻塞事件循环
        const stream = fs.createReadStream(abs);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', ...corsHeaders() });
        stream.on('error', (e) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
          res.end(JSON.stringify({ ok: false, detail: e.message }));
        });
        stream.pipe(res);
        return;
      } catch (e) {
        return sendJSON(res, 500, { ok: false, detail: e.message });
      }
    }

    return sendJSON(res, 404, { ok: false, detail: '未知接口' });
  } catch (e) {
    const code = (e instanceof HttpError && e.statusCode) ? e.statusCode : 500;
    return sendJSON(res, code, { ok: false, detail: e.message });
  }
}));

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
      `通常是另一个「黑猫智记AI」实例、旧版本 exe，或命令行 node server.js 正在运行。\n` +
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
  server.listen(port, '127.0.0.1', () => {
    console.log(`黑猫智记AI已启动: http://127.0.0.1:${port}`);
  });
  return server;
}

// 直接 `node server.js` 时自动监听；被 Electron 引入时由 main.mjs 调用 startServer。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer();
}

export { server, readStore, writeStore, stores, DEFAULT_SETTINGS, aiGenerateNote };
