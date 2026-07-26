# 千帆带货笔记批量发布助手 · 架构说明

> 参见同目录 `软件拆解与可行性分析.md`（对原商业软件的逆向分析）。
> 本原型是**从零自研、无破解**的同类工具，仅服务你自己的单个商家账号。

## 软件真实形态（与原软件对齐）

拆解 `小红书发布助手_v5.1.3.exe` 后确认，它的核心是 **千帆选品 → 按商品生成种草笔记 → 批量发布**：

- 任务生命周期含明确步骤：`select_product`（选品）→ `upload_images` → `fill_title` / `fill_content` → `fill_topics` → `submit_publish` → `verify_result`。
- 去重键为 `shopId:itemId:accountId`（店铺 × 商品 × 账号）。
- 文案生成使用三套提示词：精简标题 / 种草正文 / 热门话题（见 `server.js` 的 `DEFAULT_*_PROMPT`，已对齐原软件）。
- 批量节奏：`publishIntervalSeconds`（默认 500s）+ 随机延迟、`autoSubmit` 自动提交开关、`singleProductRepeatLimit` 防重复、失败转 `manual_hold` 人工处理。

## 本原型结构

```
xhs-assistant-prototype/
├── server.js            # 本地服务内核：商品库 / 笔记生成 / 批量队列 / 千帆抓取 / CDP 发布编排
├── qianfan-scraper.js   # 通过 CDP 连接已登录 Chrome，抓取千帆商品页卡片
├── cdp-publisher.js     # 通过 CDP 驱动发布页：上传图→关联商品→填表→提交→验证
├── cdp-config.json      # 所有选择器与节奏参数（随官网改版自行调整）
├── public/              # 原生前端单页（选品 / 笔记生成 / 批量发布 / 历史 / 设置）
├── electron/main.mjs    # 桌面外壳（进程内启动服务 + 窗口）
├── data/                # 本地 JSON 存储（products / tasks / history / settings）
└── dist/                # 打包好的 Windows 安装包
```

## 三段式流程

1. **选品（Products）**
   - 「从千帆抓取」：`POST /api/qianfan/fetch` → `qianfan-scraper.js` 连接 CDP、定位千帆商品页、按 `cdp-config.json` 的选择器抽取 `itemId / 名称 / 价格 / 图`，写入商品库（自动去重）。
   - 也支持手动添加 / 批量导入（商品列表管理，便于无千帆登录时演示）。
2. **笔记生成（Notes）**
   - 勾选商品 → 「生成笔记并入队」：`POST /api/batch/enqueue` 对每个商品调用 `aiGenerateNote()`。
   - AI 适配器走 DeepSeek / 豆包 / 自定义 OpenAI 兼容接口（设置里填 Key）；无 Key 时本地兜底，离线可用。
   - 生成内容：精简标题、种草正文（2–3 段、80–150 字）、热门话题，全部可配置提示词。
3. **批量发布（Batch）**
   - 「开始批量发布」：`POST /api/batch/pump` 顺序消费队列，按 `dry-run`（模拟）或 `cdp`（真实浏览器）执行。
   - CDP 模式：`cdp-publisher.js` 打开创作者发布页 → 上传图 → 关联商品（按 itemId/名称搜索选品）→ 填标题/正文/话题 → 提交 → 验证。
   - 节奏控制：CDP 模式用 `publishIntervalSeconds + 随机延迟`；检测到验证挑战即停下交人工（不破解）。

## 数据模型（data/*.json）

- `products.json`：`{ id, itemId, productName, price, image, images[], description, source, createdAt }`
- `tasks.json`（批量队列）：`{ id, productId, itemId, title, body, topics[], images[], product{}, status, step, statusDetail, createdAt, updatedAt }`
- `history.json`：`{ id, taskId, itemId, title, status, detail, at }`
- `settings.json`：AI 配置 + 发布设置（对齐原软件）

## 合规边界

- 仅服务**你自己的单个商家账号**；不群控、不矩阵、不破解验证码、不做指纹伪造。
- 自动化发布本身可能违反小红书用户协议，存在限流/封号风险；请小范围试用、模拟真人节奏。
- 选择器随官网改版变动，需在 `cdp-config.json` 自行校正。
