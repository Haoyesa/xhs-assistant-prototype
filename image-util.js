// image-util.js — 图片下载与本地缓存工具（服务端使用）
// 解决两个真实问题：
// 1) CDP 发布需要「本地文件路径」上传图片，但商品只有远程图片 URL；
// 2) 浏览器插件在商品页面 fetch 远程图常被防盗链/CORS 拦截。
// 这里统一把远程图下载到 uploads/ 目录并缓存（按 URL 哈希），供 CDP 上传或经 /api/image 代理返回。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 单图大小上限（12MB），防止巨图撑爆磁盘 / 上传控件拒绝
const MAX_BYTES = 12 * 1024 * 1024;
// 同一 URL 并发下载去重：避免页面多张缩略图同时拉同一图导致重复下载
const inflight = new Map();

function defaultDir() {
  // 打包后数据目录由 app 注入 XHS_DATA_DIR，回退到源码 data/
  const base = process.env.XHS_DATA_DIR || path.join(__dirname, 'data');
  return path.join(base, 'uploads');
}
function extOf(url) {
  const clean = String(url).split('?')[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif|bmp|avif)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}
function hashUrl(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20);
}

// 下载单张图到 dir，返回绝对路径（命中缓存直接返回）。失败返回 null。
export async function downloadOne(url, dir) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const base = dir || defaultDir();
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, hashUrl(url) + '.' + extOf(url));
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  // 并发去重：同一 URL 只下载一次
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s 超时
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) return null; // 空图或超大图直接丢弃
      fs.writeFileSync(file, buf);
      return file;
    } catch {
      return null;
    } finally {
      clearTimeout(timer); // 无论成功/失败/超时都清理定时器，避免残留句柄
    }
  })();
  inflight.set(url, job);
  try { return await job; } finally { inflight.delete(url); }
}

// 批量下载，返回成功下载的本地绝对路径数组（最多 9 张）
// 兼容「已经是本地文件」的情况（server 预下载后传给 CDP publisher 即为本地路径），
// 此时直接复用，不再尝试按 URL 下载——这是 v0.2.2 图片管线断裂的根因修复。
export async function downloadToLocal(urls, dir) {
  const out = [];
  for (const u of (urls || []).slice(0, 9)) {
    if (u && !/^https?:\/\//i.test(u)) {
      // 已是本地路径：存在且非空则直接复用
      try {
        const ap = path.resolve(u);
        if (fs.existsSync(ap) && fs.statSync(ap).size > 0) { out.push(ap); continue; }
      } catch {}
    }
    const p = await downloadOne(u, dir);
    if (p) out.push(p);
  }
  return out;
}

// 仅预热缓存（不阻塞主流程）：后台下载商品图，供后续代理/CDP 快速命中
export function primeImages(urls, dir) {
  for (const u of (urls || []).slice(0, 9)) {
    downloadOne(u, dir).catch(() => {});
  }
}
