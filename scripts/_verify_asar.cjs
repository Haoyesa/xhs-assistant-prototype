// scripts/_verify_asar.cjs — 自包含 asar 校验器（不依赖 @electron/asar）
// 探测头部布局 + 抽取指定文件 + 检查收银台标记，确认重打包后的 app.asar 已含改动。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

const buf = fs.readFileSync(ASAR);
console.log('asar size =', buf.length);

const jsonStart = 16;                 // 实测 JSON 头部起始于 offset 16
const rawHeader = buf.toString('utf8', jsonStart);

// brace-aware：找到顶层 JSON 对象的真正结束位置（忽略字符串内的括号）
function findJsonEnd(str) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    }
  }
  return -1;
}
const end = findJsonEnd(rawHeader);
if (end < 0) { console.error('FAILED to find JSON end'); process.exit(1); }
const header = JSON.parse(rawHeader.slice(0, end));
console.log(`HEADER OK: jsonStart=${jsonStart} jsonBytes=${end}`);

const dataStart = jsonStart + Math.ceil(end / 4) * 4;   // 头部按 4 字节对齐
console.log('dataStart =', dataStart);

// 递归建立 relPath -> {offset,size}
function walk(node, prefix, out) {
  for (const [name, info] of Object.entries(node.files || {})) {
    const rel = prefix ? prefix + '/' + name : name;
    if (info.files) { walk(info, rel, out); continue; }
    if (typeof info.offset !== 'undefined') out[rel] = { offset: Number(info.offset), size: Number(info.size) };
  }
  return out;
}
const files = walk(header, '', {});
console.log('total file entries =', Object.keys(files).length);

function extract(rel) {
  const f = files[rel];
  if (!f) return null;
  return buf.toString('utf8', dataStart + f.offset, dataStart + f.offset + f.size);
}

const TARGETS = ['electron/activation.html', 'electron/activation.js', 'electron/qrcode.js'];
const MARKERS = {
  'electron/activation.html': ['购买并激活', 'qrcode.js', 'co-refresh', 'id="buy"', 'method'],
  'electron/activation.js': ['qrcode', 'getServerUrl', 'startPolling', 'showCheckout', 'doActivate'],
  'electron/qrcode.js': ['createSvgTag', 'addData'],
};

// 0) 快速存在性检查（不依赖偏移公式）
console.log('\n--- presence check ---');
for (const m of ['购买并激活', 'qrcode(0', 'createSvgTag', 'co-refresh', 'startPolling']) {
  console.log(`  ${buf.includes(m) ? '[FOUND]' : '[MISSING]'} "${m}"`);
}

// 1) 标记检查
console.log('\n--- marker check ---');
let ok = true;
for (const t of TARGETS) {
  const content = extract(t);
  if (content === null) { console.log(`  [MISSING IN ASAR] ${t}`); ok = false; continue; }
  const miss = (MARKERS[t] || []).filter(m => !content.includes(m));
  if (miss.length) { console.log(`  [INCOMPLETE] ${t}: missing ${JSON.stringify(miss)}`); ok = false; }
  else console.log(`  [OK] ${t} (${content.length} bytes, all markers present)`);
}

// 2) 偏移公式校验：非混淆文件应与 ROOT 源逐字节一致
console.log('\n--- offset formula validation (byte-exact vs ROOT source) ---');
for (const t of ['electron/activation.html', 'electron/qrcode.js']) {
  const content = extract(t);
  const src = fs.readFileSync(path.join(ROOT, t), 'utf8');
  if (content === src) console.log(`  [EXACT] ${t} matches ROOT source (offset formula correct)`);
  else { console.log(`  [DRIFT] ${t}: asar differs from ROOT source by ${Math.abs(content.length - src.length)} bytes`); ok = false; }
}

console.log(ok ? '\nVERIFY PASS: cashier code present & offsets correct in app.asar' : '\nVERIFY FAIL');
process.exit(ok ? 0 : 1);
