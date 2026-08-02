// qianfan-scraper.js
// 通过 CDP 连接用户已登录的 Chrome，抓取商品页的商品卡片。
// 选择器全部来自 cdp-config.json 的 qianfan 段，随官网改版需自行调整。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'cdp-config.json'), 'utf-8'));
  } catch {
    return { qianfan: {}, browserURL: 'http://127.0.0.1:9222' };
  }
}

async function getPuppeteer() {
  const mod = await import('puppeteer-core');
  return mod.default;
}

// 找到已有的商品页标签页，没有就新开
async function getQianfanPage(browser, cfg) {
  const targets = await browser.targets();
  for (const t of targets) {
    const url = t.url() || '';
    if (url.includes('xiaohongshu.com') && /qianfan|channel|ark|product|goods|商品/.test(url)) {
      const page = await t.page();
      if (page) return page;
    }
  }
  const page = await browser.newPage();
  const url = cfg.productPageUrl || 'https://channel.xiaohongshu.com/ark/product/list';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return page;
}

export async function scrapeQianfanProducts(settings = {}) {
  const cfg = loadConfig().qianfan || {};
  const browserURL = settings.qianfanChromeUrl || loadConfig().browserURL || 'http://127.0.0.1:9222';
  const puppeteer = await getPuppeteer();
  let browser;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    // connect 加 10s 超时：Chrome 未启动/端口不可达时快速失败，避免接口永久挂起
    browser = await Promise.race([
      puppeteer.connect({ browserURL, defaultViewport: null }),
      new Promise((_, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('连接超时(10s)，请确认浏览器已启动且远程调试端口可访问')));
      }),
    ]);
  } catch (e) {
    throw new Error(`无法连接 Chrome（${browserURL}）：请先在设置里启动/连接已登录的浏览器。原始错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  try {
    const page = await getQianfanPage(browser, cfg);
    const cardSelector = cfg.cardSelector || '.product-item';
    try {
      await page.waitForSelector(cardSelector, { timeout: 15000 });
    } catch {
      throw new Error('在商品页面未找到商品卡片，可能页面未加载或选择器不匹配，请在 cdp-config.json 调整 qianfan.cardSelector。');
    }
    if (cfg.scrollToLoadMore) {
      // 尝试滚动加载更多
      for (let i = 0; i < 5; i++) {
        const before = await page.$$eval(cardSelector, (els) => els.length).catch(() => 0);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise((r) => setTimeout(r, 800));
        const after = await page.$$eval(cardSelector, (els) => els.length).catch(() => 0);
        if (after === before) break;
      }
    }
    const products = await page.evaluate((cfg) => {
      cfg = cfg || {};
      const cardSel = cfg.cardSelector || '.product-item';
      const cards = Array.from(document.querySelectorAll(cardSel)).slice(0, cfg.maxCards || 50);
      const pick = (card, sel) => {
        if (!sel) return '';
        const el = card.querySelector(sel);
        return el ? (el.getAttribute('src') || el.getAttribute('data-src') || el.textContent || '').trim() : '';
      };
      // 稳健提取商品 id：依次尝试 配置选择器 / 卡片内链接的 query 参数或路径段 / data-* 属性 / 标签文本 / 整段 HTML 中的长 hex 或 id 字段
      const extractId = (card) => {
        if (cfg.itemIdSelector) {
          const t = pick(card, cfg.itemIdSelector);
          if (t) return t;
        }
        const a = card.querySelector('a');
        if (a && a.href) {
          try {
            const u = new URL(a.href);
            for (const k of ['id', 'itemId', 'goodsId', 'productId', 'item_id', 'goods_id', 'product_id', 'skuId', 'sku_id']) {
              const v = u.searchParams.get(k);
              if (v) return v.trim();
            }
            const seg = u.pathname.match(/\/(?:product|goods|item|detail|sku)\/([0-9a-zA-Z]{8,})/i);
            if (seg) return seg[1];
          } catch (e) { /* ignore */ }
        }
        for (const el of card.querySelectorAll('[data-item-id],[data-goods-id],[data-product-id],[data-sku-id],[data-id]')) {
          const v = el.getAttribute('data-item-id') || el.getAttribute('data-goods-id') || el.getAttribute('data-product-id') || el.getAttribute('data-sku-id') || el.getAttribute('data-id');
          if (v) return v.trim();
        }
        const label = card.querySelector('[class*="goodsId"],[class*="itemId"],[class*="productId"]');
        if (label && label.textContent) {
          const m = label.textContent.match(/(?:商品ID|宝贝ID|货号|编码|ID)\s*[:：]?\s*([0-9a-zA-Z_-]{6,})/i);
          if (m) return m[1];
        }
        const html = card.outerHTML || '';
        const m = html.match(/(?:id|goodsId|itemId|productId|product_id|item_id|goods_id|skuId|sku_id)["'=:\s]+["']?([0-9a-zA-Z]{10,40})/i)
          || html.match(/\b[0-9a-fA-F]{20,40}\b/);
        return m ? m[1] : '';
      };
      return cards.map((card, index) => {
        let imageAttr = pick(card, cfg.imageSelector);
        const img = card.querySelector(cfg.imageSelector || 'img');
        if (img && !imageAttr) imageAttr = img.getAttribute('src') || img.getAttribute('data-src') || '';
        const itemId = extractId(card);
        return {
          index,
          itemId: (itemId || '').trim(),
          productName: pick(card, cfg.nameSelector),
          price: pick(card, cfg.priceSelector),
          image: (imageAttr || '').trim(),
        };
      }).filter((p) => p.productName || p.itemId);
    }, cfg);
    return products;
  } finally {
    try { await browser.disconnect(); } catch {}
  }
}
