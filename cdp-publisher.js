// cdp-publisher.js
// 通过 CDP 连接用户已登录的 Chrome，驱动笔记发布页完成：
// 上传图片 → 关联商品(按 itemId/名称选品) → 填标题/正文/话题 → 提交 → 验证。
// 检测到验证挑战即停下、交人工处理，不破解。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadToLocal } from './image-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 上传目录：打包后 app.asar 只读，必须用 app 注入的 XHS_DATA_DIR（落盘到用户目录）。
// 与 server.js 的 UPLOADS 指向同一目录，保证 server 预下载的本地图可直接复用。
const UPLOADS_DIR = (() => {
  const base = process.env.XHS_DATA_DIR || path.join(__dirname, 'data');
  return path.join(base, 'uploads');
})();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'cdp-config.json'), 'utf-8'));
  } catch {
    return { publish: {}, browserURL: 'http://127.0.0.1:9222', pacing: {} };
  }
}

async function getPuppeteer() {
  const mod = await import('puppeteer-core');
  return mod.default;
}

function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class ChallengeDetectedError extends Error {
  constructor() { super('检测到验证挑战，已暂停，请人工处理。'); this.name = 'ChallengeDetectedError'; }
}
class StepFailedError extends Error {
  constructor(step, message) { super(message); this.name = 'StepFailedError'; this.step = step; }
}

export class CdpPublisher {
  constructor(settings = {}) {
    this.settings = settings;
    this.config = loadConfig();
  }

  async testConnection() {
    const puppeteer = await getPuppeteer();
    const browserURL = this.settings.cdpBrowserUrl || this.config.browserURL;
    try {
      const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
      const v = await browser.version();
      await browser.disconnect();
      return { ok: true, detail: `已连接 Chrome：${v}` };
    } catch (e) {
      return { ok: false, detail: `连接失败：${e.message}` };
    }
  }

  async _connect() {
    const puppeteer = await getPuppeteer();
    const browserURL = this.settings.cdpBrowserUrl || this.config.browserURL;
    const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    return browser;
  }

  async _getComposePage(browser) {
    const targets = await browser.targets();
    for (const t of targets) {
      const url = t.url() || '';
      if (url.includes('xiaohongshu.com') && /post|publish|creator|发布/.test(url)) {
        const p = await t.page();
        if (p) return p;
      }
    }
    const page = await browser.newPage();
    await page.goto(this.config.publish.composeUrl || 'https://creator.xiaohongshu.com/creator/post', { waitUntil: 'networkidle2', timeout: 30000 });
    return page;
  }

  async _installStealth(page) {
    if (this.config.stealth?.webdriver) {
      // 对新页面预注入（页面刷新后生效）
      await page.evaluateOnNewDocument(() => {
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      });
      // 对当前已加载页面立即执行（已有标签页场景）
      try {
        await page.evaluate(() => {
          try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
        });
      } catch {}
    }
  }

  async _detectChallenge(page) {
    const sel = this.config.publish.challengeIndicator;
    if (!sel) return false;
    // 要求元素可见且文案含验证关键词，避免宽泛 class 误判（普通 slider/verify 字样组件）
    return page.evaluate((s) => {
      const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null);
      for (const el of els) {
        const t = (el.innerText || '').slice(0, 300);
        if (/验证|滑动|拼图|安全|人机|请完成|拖动|滑块/i.test(t)) return true;
      }
      return false;
    }, sel);
  }

  async _typeLikeHuman(page, selector, text) {
    const el = await page.$(selector);
    if (!el) throw new StepFailedError('fill_form', `未找到输入框：${selector}`);
    await el.click({ clickCount: 3 }).catch(() => {});
    const p = this.config.pacing || {};
    for (const ch of String(text)) {
      await page.keyboard.type(ch, { delay: rand(p.typeDelayMin || 30, p.typeDelayMax || 90) });
    }
    await sleep(rand(p.stepPauseMin || 400, p.stepPauseMax || 1200));
  }

  async _uploadImages(page, imageUrls) {
    if (!imageUrls || !imageUrls.length) return;
    const sel = this.config.publish.imageUploadSelector || "input[type='file']";
    const input = await page.$(sel);
    if (!input) throw new StepFailedError('upload_images', `未找到图片上传控件：${sel}`);
    // 远程图先下载到本地（CDP 上传控件只接受本地文件）。
    // 注意：server.runPump 已把商品远程图预下载到 UPLOADS_DIR 并传入本地路径，
    // 这里 downloadToLocal 会识别本地路径直接复用，不再重复下载（v0.2.3 修复）。
    const local = await downloadToLocal(imageUrls, UPLOADS_DIR);
    if (!local.length) throw new StepFailedError('upload_images', '图片下载失败（网络/防盗链/本地文件缺失），无法上传到发布页。');
    await input.uploadFile(...local);
    await sleep(rand(1500, 3000));
  }

  async _associateProduct(page, product) {
    const cfg = this.config.publish;
    if (!product || (!product.itemId && !product.productName)) return; // 无商品则跳过挂接
    const btn = await page.$(cfg.addProductButtonSelector);
    if (!btn) throw new StepFailedError('select_product', `未找到『关联商品』按钮：${cfg.addProductButtonSelector}`);
    await btn.click();
    await sleep(rand(600, 1200));
    const search = await page.$(cfg.productSearchSelector);
    if (!search) throw new StepFailedError('select_product', `未找到商品搜索框：${cfg.productSearchSelector}`);
    const term = product.itemId || product.productName;
    await search.type(term, { delay: 50 });
    await sleep(rand(800, 1500));
    const result = await page.$(cfg.productResultSelector);
    if (!result) throw new StepFailedError('select_product', `未搜到商品卡片：${cfg.productResultSelector}`);
    await result.click();
    await sleep(rand(600, 1200));
  }

  async _fillTopics(page, topics) {
    const cfg = this.config.publish;
    const input = await page.$(cfg.topicInputSelector);
    if (input && topics && topics.length) {
      for (const t of topics.slice(0, 10)) {
        const clean = String(t).replace(/^#/, '').trim();
        if (!clean) continue;
        await input.type(clean, { delay: 40 });
        await page.keyboard.press('Enter');
        await sleep(rand(300, 600));
      }
    } else if (topics && topics.length) {
      // 无话题输入框则并入正文
      return topics.map((t) => `#${String(t).replace(/^#/, '')}`).join(' ');
    }
    return '';
  }

  // 主流程
  async publishNote(task, { autoSubmit = false, onStep = () => {} } = {}) {
    const cfg = this.config.publish;
    const pacing = this.config.pacing || {};
    const browser = await this._connect();
    try {
      const page = await this._getComposePage(browser);
      await this._installStealth(page);
      await onStep('open_publish_page', '已打开发布页');
      if (await this._detectChallenge(page)) throw new ChallengeDetectedError();

      await this._uploadImages(page, task.images || []);
      await onStep('upload_images', `已上传 ${task.images?.length || 0} 张图片`);
      if (await this._detectChallenge(page)) throw new ChallengeDetectedError();

      await this._associateProduct(page, task.product || null);
      await onStep('select_product', `已关联商品：${task.product?.productName || task.product?.itemId || '（无）'}`);
      if (await this._detectChallenge(page)) throw new ChallengeDetectedError();

      // 标题
      if (task.title) {
        await this._typeLikeHuman(page, cfg.titleSelector, task.title);
        await onStep('fill_title', '已填标题');
      }
      // 正文（话题若无独立输入框则追加）
      let body = task.body || '';
      const appendedTopics = await this._fillTopics(page, task.topics);
      if (appendedTopics) body += '\n\n' + appendedTopics;
      if (body) {
        await this._typeLikeHuman(page, cfg.contentSelector, body);
        await onStep('fill_content', '已填正文');
      }
      if (await this._detectChallenge(page)) throw new ChallengeDetectedError();

      await onStep('waiting_submit', autoSubmit ? '准备提交' : '已就绪，等待人工确认提交');

      if (!autoSubmit) {
        return { ok: true, status: 'waiting_submit', step: 'waiting_submit', detail: '表单已填好，未开启自动提交，请人工点击发布。' };
      }

      const submit = await page.$(cfg.submitSelector);
      if (!submit) throw new StepFailedError('submitting', `未找到发布按钮：${cfg.submitSelector}`);
      await submit.click();
      await sleep(rand(2000, 4000));
      if (await this._detectChallenge(page)) throw new ChallengeDetectedError();

      const ok = await page.$(cfg.successIndicator);
      await onStep('verify_result', ok ? '发布成功' : '已提交，等待结果确认');
      return {
        ok: true,
        status: ok ? 'success' : 'submitted',
        step: 'verify_result',
        detail: ok ? '发布成功' : '已点击发布，未检测到明确成功标识。',
      };
    } finally {
      try { await browser.disconnect(); } catch {}
    }
  }
}

export { ChallengeDetectedError, StepFailedError };
