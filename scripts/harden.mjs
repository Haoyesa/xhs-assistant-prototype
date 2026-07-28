// scripts/harden.mjs — 授权/门禁代码加固构建
// 把敏感模块（验签、门禁决策、机器码、套餐、激活 UI、主进程入口）混淆后重打包进 app.asar。
// 源文件保持明文留在 git；本脚本只产出「发布用」的 app.asar，可重复执行。
//
// 用法：node scripts/harden.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import asar from '@electron/asar';

const require = createRequire(import.meta.url);
// 优先用项目本地 node_modules 的 javascript-obfuscator；沙箱环境回退到受管路径。
// 你本机重跑前若没有，执行：npm i -D javascript-obfuscator
const OBF_PATH = 'C:/Users/25147/.workbuddy/binaries/node/workspace/node_modules/javascript-obfuscator';
let obf;
try {
  obf = require('@javascript-obfuscator');
} catch {
  obf = require(OBF_PATH);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'dist', 'win-unpacked', 'resources');
const ASAR = path.join(RES, 'app.asar');
const OUT = path.join(ROOT, '_harden_out');
const SRC = path.join(ROOT, '_harden_src');

const HEAVY = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  transformObjectKeys: false,
  selfDefending: false,
  debugProtection: false,
};

const LIGHT = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  transformObjectKeys: false,
  selfDefending: false,
  debugProtection: false,
};

// 目标文件：rel 路径 -> { config, target }
const TARGETS = [
  { rel: 'electron/license.mjs', cfg: HEAVY, target: 'node' },
  { rel: 'electron/gating.mjs', cfg: HEAVY, target: 'node' },
  { rel: 'electron/machine-id.mjs', cfg: HEAVY, target: 'node' },
  { rel: 'electron/plans.mjs', cfg: HEAVY, target: 'node' },
  { rel: 'electron/activation.js', cfg: HEAVY, target: 'browser' },
  { rel: 'electron/main.mjs', cfg: LIGHT, target: 'node' },
];

function obfuscateFile(rel, cfg, target) {
  const srcPath = path.join(ROOT, rel);
  const src = fs.readFileSync(srcPath, 'utf8');
  const out = obf.obfuscate(src, { ...cfg, target }).getObfuscatedCode();
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  console.log(`obfuscated ${rel.padEnd(26)} ${out.length} bytes`);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

console.log('--- 1) obfuscate sources ---');
for (const t of TARGETS) obfuscateFile(t.rel, t.cfg, t.target);

console.log('--- 2) extract current app.asar ---');
rmrf(SRC);
asar.extractAll(ASAR, SRC);

console.log('--- 2.5) overlay fresh source from ROOT (server.js + electron/*) ---');
// 把最新源码覆盖进 asar 树，确保 server.js / electron 非混淆文件的改动生效。
// 只刷新「已存在于 asar 树」的文件，避免把开发期临时文件打进包里。
function syncFresh(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const f of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const sp = path.join(srcDir, f.name);
    const dp = path.join(dstDir, f.name);
    if (f.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      syncFresh(sp, dp);
    } else if (fs.existsSync(dp)) {
      fs.copyFileSync(sp, dp); // 仅覆盖 asar 树里已有的文件
    }
  }
}
for (const root of ['server.js', 'sensitive-words.mjs', 'qianfan-scraper.js', 'cdp-publisher.js', 'image-util.js', 'electron/qrcode.js']) {
  const sp = path.join(ROOT, root);
  const dp = path.join(SRC, root);
  if (fs.existsSync(sp)) {
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.copyFileSync(sp, dp); // 显式复制（含新增文件），syncFresh 仅覆盖 asar 树中已存在的文件
  }
}
syncFresh(path.join(ROOT, 'electron'), path.join(SRC, 'electron'));
// 前端（桌面 GUI）也打包在 asar 内的 public/，需同步最新版本，否则 UI 改动不会进 EXE
syncFresh(path.join(ROOT, 'public'), path.join(SRC, 'public'));
// 新增的 public 静态资源（如 generator.html）syncFresh 只覆盖已存在文件、不会带进来，此处显式复制
for (const f of ['generator.html']) {
  const sp = path.join(ROOT, 'public', f);
  const dp = path.join(SRC, 'public', f);
  if (fs.existsSync(sp)) fs.copyFileSync(sp, dp);
}

console.log('--- 3) drop obfuscated files into asar tree ---');
for (const t of TARGETS) {
  const from = path.join(OUT, t.rel);
  const to = path.join(SRC, t.rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

console.log('--- 4) repack app.asar ---');
const newAsar = path.join(RES, 'app.asar.new');
rmrf(newAsar);
const packResult = asar.createPackageWithOptions(SRC, newAsar, { unpackDir: 'extension/**/*' });
if (packResult && typeof packResult.then === 'function') await packResult;

// 校验产出尺寸合理
const size = fs.statSync(newAsar).size;
if (size < 1000) throw new Error('repacked asar too small, abort');
console.log(`repacked app.asar: ${size} bytes`);

console.log('--- 5) swap in ---');
const bak = path.join(RES, 'app.asar.bak');
rmrf(bak);
fs.renameSync(ASAR, bak);
fs.renameSync(newAsar, ASAR);

console.log('--- 6) syntax check obfuscated files ---');
for (const t of TARGETS) {
  const p = path.join(OUT, t.rel);
  // ESM .mjs 用 --check；.js(activation) 也用 --check
  require('child_process').execSync(`"${process.execPath}" --check "${p}"`, { stdio: 'inherit' });
}

console.log('--- 7) cleanup temp ---');
rmrf(SRC);
rmrf(bak);
console.log('DONE. app.asar hardened.');
