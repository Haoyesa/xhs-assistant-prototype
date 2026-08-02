// electron/gating.mjs — 订阅套餐门禁核心（独立混淆模块）
// 把 autoSubmit / 频率档位 的强制约束集中在此，单独混淆后难以被直接阅读或篡改。
// server.js 通过 effectiveAutoSubmit / planIntervalSeconds / resolvedPlan 调用本模块，
// 自身不保留门禁决策明文，提升逆向门槛。
import { currentPlan } from './license.mjs';
import { FREQ_DELAY, resolvePlan } from './plans.mjs';

// 解析当前生效套餐；任何异常都回退免费试用（强制人工复核、标准频率）。
export function resolvedPlan(dataDir) {
  try {
    return currentPlan(dataDir);
  } catch {
    // 回退到完整结构的 free 套餐对象（含 accounts/maxNotes/label），避免缺字段导致配额判断失效
    return resolvePlan('free');
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

// 是否允许自动提交：订阅制下对所有套餐（含免费 / 自用）开放自动发布，
// 仅由用户在「设置」里的「自动提交」开关决定（默认开启）。
// 账号数量门禁此前已放开（见 maxAccounts）；频率档位仍由 planIntervalSeconds 按套餐区分，不受此影响。
// 注：自动发布遇到验证挑战仍会转人工复核（content script 的 detectChallenge → manual_hold），合规红线不变。
export function effectiveAutoSubmit(settings, dataDir) {
  return !!(settings && settings.autoSubmit);
}

// 账号数量门禁：订阅制不再限制账号数量（任何套餐均不限）。
// 既满足当前「多账号管理不限数量」的需求，也符合未来对外付费采用订阅制、不按账号数计费的定位。
// 自动提交 / 发布频率等门禁仍由 resolvedPlan / effectiveAutoSubmit / planIntervalSeconds 控制，此处仅放开账号数。
export function maxAccounts(dataDir) {
  return Infinity;
}
