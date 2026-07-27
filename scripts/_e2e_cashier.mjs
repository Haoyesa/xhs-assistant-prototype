// 临时 E2E：验证收银台依赖的 license-server 契约
// 流程：checkout(wechat,无真实凭证→人工兜底) → admin/issue 模拟支付完成发卡 →
//        GET /api/order/:id 轮询拿到 token → 客户端 verifyToken 校验（机器码绑定）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMachineCode } from '../electron/machine-id.mjs';
import { verifyToken } from '../electron/license.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'license-server', 'index.mjs');
const PORT = 8799;
const ADMIN = 'testadmin';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failed++; }
}
function post(url, body) {
  return fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
}

const srv = spawn('node', [SERVER], {
  env: { ...process.env, LICENSE_PORT: String(PORT), LICENSE_ADMIN_KEY: ADMIN },
  stdio: 'ignore',
});

async function main() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch {}
    await sleep(200);
  }
  const mc = getMachineCode();
  console.log('machineCode =', mc);

  // 1) 收银台下单（微信，开发环境无真实凭证 → 人工兜底，payUrl=null）
  const co = await post('/api/checkout', { plan: 'pro', billing: 'monthly', machineCode: mc, method: 'wechat', notifyUrl: null });
  console.log('checkout   =', JSON.stringify(co).slice(0, 180));
  assert(co.ok, 'checkout 返回 ok');
  assert(typeof co.outTradeNo === 'string', 'checkout 返回 outTradeNo');
  assert(co.payUrl === null, '无凭证环境 → payUrl=null（人工兜底，渲染提示而非二维码）');
  assert(co.status === 'pending', '订单初始状态 pending');

  // 2) 模拟支付完成：管理端按同一机器码发卡（真实渠道则由 webhook 触发 markPaid → 自动 fulfill）
  const issued = await post('/api/admin/issue', { adminKey: ADMIN, plan: 'pro', billing: 'monthly', machineCode: mc, outTradeNo: co.outTradeNo });
  assert(issued.ok && typeof issued.token === 'string', 'admin/issue 完成发卡 → 返回 token');

  // 3) 收银台轮询：GET /api/order/:id（fulfilled 时带回 token）
  const ord = await (await fetch(BASE + '/api/order/' + encodeURIComponent(co.outTradeNo))).json();
  assert(ord.ok && ord.order.status === 'fulfilled', 'GET 订单 → fulfilled');
  assert(ord.order.token === issued.token, 'GET 订单返回绑定 token');

  // 4) 客户端侧校验（与 window.api.activate → license.mjs verifyToken 同逻辑）
  const v = verifyToken(ord.order.token);
  assert(v.ok, '客户端 verifyToken 通过');
  assert(v.payload.plan === 'pro', 'token.plan === pro');
  assert(v.payload.machineCode === mc, 'token 绑定本机机器码');

  // 5) 收银台「刷新状态」分支：支付宝年付结构校验
  const co2 = await post('/api/checkout', { plan: 'basic', billing: 'yearly', machineCode: mc, method: 'alipay', notifyUrl: null });
  assert(co2.ok && co2.amount === 90, '支付宝年付·基础版 → 金额 90（价格表一致）');

  srv.kill();
  console.log(failed === 0 ? '\nALL PASS ✅' : `\n${failed} FAILED ❌`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); srv.kill(); process.exit(2); });
