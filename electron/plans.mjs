// 套餐配置表（保守价，月付）。旗舰/团队为价格体系预留，MVP 先实装 free/basic/pro + 年付。
// 频率档(freqTier)后续映射为发布间隔；autoSubmit 决定默认是否自动点发布。
export const PLANS = {
  free: {
    key: 'free',
    label: '免费试用',
    price: 0,
    accounts: 1,
    freqTier: 'standard',
    autoSubmit: false,
    maxNotes: 5, // 试用最多 5 篇
    trialDays: 7,
  },
  basic: {
    key: 'basic',
    label: '基础版',
    price: 9,
    accounts: 1,
    freqTier: 'standard',
    autoSubmit: false, // 强制人工复核
  },
  pro: {
    key: 'pro',
    label: '专业版',
    price: 19,
    accounts: 3,
    freqTier: 'priority',
    autoSubmit: true, // 默认自动
  },
  flag: {
    key: 'flag',
    label: '旗舰版',
    price: 49,
    accounts: 10,
    freqTier: 'fast',
    autoSubmit: true,
  },
  team: {
    key: 'team',
    label: '团队版',
    price: 99,
    accounts: Infinity,
    freqTier: 'fast',
    autoSubmit: true,
  },
};

// 频率档 → 两篇之间的延时区间（秒）。数值偏保守，降低风控压力。
export const FREQ_DELAY = {
  standard: { min: 600, max: 900 }, // 10–15 分钟
  priority: { min: 300, max: 500 }, // 5–8 分钟
  fast: { min: 120, max: 240 }, // 2–4 分钟
};

export function resolvePlan(planKey) {
  return PLANS[planKey] || PLANS.free;
}

// 按频率档返回随机延时（毫秒），供后端发布调度使用。
export function freqDelayMs(tier) {
  const d = FREQ_DELAY[tier] || FREQ_DELAY.standard;
  return Math.floor(d.min * 1000 + Math.random() * (d.max - d.min) * 1000);
}

// 年付价 = 月付 × 10（相当于送 2 个月）。
export function yearlyPrice(monthlyPrice) {
  return monthlyPrice * 10;
}
