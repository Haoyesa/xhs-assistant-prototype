// electron/gating.mjs — 订阅套餐门禁核心（独立混淆模块）
// 把 autoSubmit / 频率档位 的强制约束集中在此，单独混淆后难以被直接阅读或篡改。
// server.js 通过 effectiveAutoSubmit / planIntervalSeconds / resolvedPlan 调用本模块，
// 自身不保留门禁决策明文，提升逆向门槛。
import { currentPlan } from './license.mjs';
import { FREQ_DELAY } from './plans.mjs';

// 解析当前生效套餐；任何异常都回退免费试用（强制人工复核、标准频率）。
export function resolvedPlan(dataDir) {
  try {
    return currentPlan(dataDir);
  } catch {
    return { key: 'free', autoSubmit: false, freqTier: 'standard' };
  }
}

// 频率档位 → 发布间隔（秒），供插件端 getIntervalMs 使用。
export function planIntervalSeconds(dataDir) {
  const tier = resolvedPlan(dataDir).freqTier || 'standard';
  const d = FREQ_DELAY[tier] || FREQ_DELAY.standard;
  return {
    publishIntervalSeconds: d.min,
    publishIntervalRandomDelaySeconds: Math.max(0, d.max - d.min),
  };
}

// 是否允许自动提交：仅专业版以上（autoSubmit=true）且用户在设置里开启自动提交才放行；
// 免费 / 基础版强制 false（人工复核）。这是「发布自动化」的核心开关，也是最该藏住的决策。
export function effectiveAutoSubmit(settings, dataDir) {
  const plan = resolvedPlan(dataDir);
  if (!plan.autoSubmit) return false;
  return !!(settings && settings.autoSubmit);
}

// 当前套餐允许绑定的最大账号数。Infinity 表示不限（团队版）。
// 这是「账号数门禁」的核心阈值，与 autoSubmit 一样藏在本混淆模块内，避免被直接改明文绕过。
export function maxAccounts(dataDir) {
  const plan = resolvedPlan(dataDir);
  const n = plan && plan.accounts;
  if (n === Infinity) return Infinity;
  if (typeof n === 'number' && isFinite(n) && n > 0) return n;
  return 1; // 兜底：未识别套餐按单账号处理
}
