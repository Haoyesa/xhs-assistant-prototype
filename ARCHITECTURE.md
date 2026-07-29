# 黑猫智记AI · 架构说明

> 本工具为**从零自研、本地运行**的内容创作辅助工具，仅服务于你自己的内容创作。
> 黑猫智记AI 是一款本地运行的内容创作与发布辅助工具：核心能力为文案优化 / 排版设计 / 敏感词检测 / 封面素材参考，并保留素材抓取与批量发布等自动化能力（仅在你自有账号下使用，遵守各平台运营规则）。

## 软件能力形态

本工具的核心能力是**素材管理 → 文案优化 → 封面素材参考**的本地创作闭环：

- 任务生命周期含明确步骤：`select_product`（选品）→ `upload_images` → `fill_title` / `fill_content` → `fill_topics` → `submit_publish` → `verify_result`（发布步骤将在重新定位后移除）。
- 去重键为 `shopId:itemId:accountId`（店铺 × 商品 × 账号）。
- 文案生成使用三套提示词：精简标题 / 正文 / 热门话题（见 `server.js` 的 `DEFAULT_*_PROMPT`）。
- 批量节奏：`publishIntervalSeconds`（默认 500s）+ 随机延迟、`autoSubmit` 自动提交开关、`singleProductRepeatLimit` 防重复、失败转 `manual_hold` 人工处理。

## 本原型结构

```
xhs-assistant-prototype/
├── server.js            # 本地服务内核：素材库 / 文案生成 / 批量队列 / 商品抓取 / 发布编排
├── qianfan-scraper.js   # 商品页抓取
├── cdp-publisher.js     # 发布逻辑
├── cdp-config.json      # 所有选择器与节奏参数
├── public/              # 原生前端单页（素材库 / 文案优化 / 封面素材参考 / 历史 / 设置）
├── electron/main.mjs    # 桌面外壳（进程内启动服务 + 窗口）
├── data/                # 本地 JSON 存储（products / tasks / history / settings）
└── dist/                # 打包好的 Windows 安装包
```

## 三段式流程

1. **素材（Products）**
   - 「从商品页抓取」：`POST /api/qianfan/fetch` → `qianfan-scraper.js` 连接 CDP、定位商品页、按 `cdp-config.json` 的选择器抽取 `itemId / 名称 / 价格 / 图`，写入素材库（自动去重）。
   - 也支持手动添加 / 批量导入（素材列表管理）。
2. **文案生成（Notes）**
   - 勾选素材 → 「生成笔记并入队」：`POST /api/batch/enqueue` 对每个素材调用 `aiGenerateNote()`。
   - AI 适配器走 DeepSeek / 豆包 / 自定义 OpenAI 兼容接口（设置里填 Key）；无 Key 时本地兜底，离线可用。
   - 生成内容：精简标题、正文（2–3 段、80–150 字）、热门话题，全部可配置提示词。
3. **发布（Batch，插件驱动）**
   - 「开始批量发布」：在创作者页悬浮面板或扩展弹窗点击 → 发 `startPublish` 给 background 调度器（不再走 `POST /api/batch/pump` 的后台按钮，旧 CDP 模式仅作兼容保留）。
   - 调度流程：background `startPublish` → `pullNext()` 按本窗口绑定账号（`?accountId=`）向 `/api/ext/next` 拉任务 → `openNextTab()` 开新创作者标签 → `fillTab` 注入填充 → 用已验证可用的 `chrome.debugger` 真实点击「发布」→ 成功后倒计时归零自动开下一篇。
   - 多账号隔离：每个比特窗口各自绑定不同 `accountId`，调度器只消费本账号队列，互不抢、可并行。
   - 节奏控制：每账号独立 `interval`（默认 30s）间隔；检测到验证挑战即停下交人工（不破解）。

## 数据模型（data/*.json）

- `products.json`：`{ id, itemId, productName, price, image, images[], description, source, createdAt }`
- `tasks.json`（批量队列）：`{ id, productId, itemId, title, body, topics[], images[], product{}, status, step, statusDetail, createdAt, updatedAt }`
- `history.json`：`{ id, taskId, itemId, title, status, detail, at }`
- `settings.json`：AI 配置 + 发布设置

## 合规边界

- 仅服务**你自己的内容创作**；不群控、不矩阵、不破解验证码、不做指纹伪造。
- 自动化发布能力仅在你自有账号下使用；请遵守各平台运营规则，勿用于违规批量营销。
- 选择器随目标页面改版变动，需在 `cdp-config.json` 自行校正。
