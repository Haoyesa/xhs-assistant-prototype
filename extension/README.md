# 浏览器插件（千帆选品 → 创作者发布助手）

配套本地后端 `server.js`（即 `xhs-assistant-prototype` 原型）。插件是「浏览器内自动化层」：
在**你已登录**的浏览器里，于千帆商品页采集商品、于创作者发布台自动填表，后端负责商品库 / AI 文案 / 批量队列 / 历史。

## 与参考软件的关系
参考的 `小红书自动发笔记5.0.3` 也是 MV3 扩展：在 `ark.xiaohongshu.com`（千帆）与 `creator.xiaohongshu.com`（创作者）注入脚本，通过 `127.0.0.1:5801` 与桌面软件通信。本插件沿用同一思路，但**后端换成我们自己从零写的、无破解的原型**，且：
- 仅服务你自己的单个商家账号；
- 发布前**人工复核**，检测到验证挑战**主动停下**转人工；
- 不注入反检测、不模拟点击绕过、不破解验证码、不做指纹伪造。

## 文件
```
extension/
├── manifest.json        # MV3：权限/匹配域名/host_permissions(含本地后端端口)
├── background.js        # 桥接后端 + 消息路由 + 周期 pump + 状态广播
├── content-ark.js     # 千帆页：注入「采集本页商品」按钮，读商品信息推后端
├── content-creator.js  # 创作者页：注入「发布助手」侧栏，拉任务→填表→关联商品→交人工发布
├── popup.html / popup.js  # 弹窗：一键批量发布、暂停/继续/停止、自动提交开关（后端地址固定本地桌面程序，无需配置）
├── panel.css           # 注入页面的悬浮面板样式
└── icons/             # 16/48/128 png
```

## 加载方式（Chrome / Edge）
1. 启动后端：在 `xhs-assistant-prototype/` 下 `npm start`（默认 `http://127.0.0.1:5199`）。
2. 浏览器打开 `chrome://extensions`（或 `edge://extensions`），右上角开「开发者模式」。
3. 点「加载已解压的扩展程序」，选中本 `extension/` 目录。
4. 固定图标到工具栏。

## 使用流程
1. **选品**：打开千帆商品页 → 右下角「🛒 千帆选品助手」→ 点「采集本页商品」→ 推入后端商品库（按 `itemId` 去重）。
2. **生成**：在后端网页(`localhost:5199`)勾选商品 → 「生成笔记并入队」（按商品调 AI 生成标题/正文/话题）。
3. **发布**：打开创作者发布台(`creator.xiaohongshu.com`)→ 右下角「🚀 发布助手」→「开始批量发布」自动逐篇填充标题/正文/话题/配图/关联商品并自动发布（默认开启自动提交）。
   - 后端 `autoSubmit` 开时，填充后会自动点发布（仍建议人工复核）。
   - 检测到验证挑战立即停下并通知，不破解。

## 后端接口（插件↔server.js，均带 CORS `*`，支持 OPTIONS 预检）
- `POST /api/ext/products` — 推商品（body `{products:[{itemId,productName,price,image}]}`）
- `GET  /api/ext/next`     — 拉一条待发笔记（标记 `picked` 防重复），返回 `{task, serverUrl, autoSubmit, qianfanUrl}`
- `POST /api/ext/done`     — 回报结果（`{taskId,status,detail}`，写入历史，`source:"extension"`）

## ⚠️ 须知与调校
- **选择器随官网改版变动**：`content-ark.js` 的 `SEL`（标题/价格/主图/itemId）与 `content-creator.js` 的 `SEL`（标题/正文/话题/关联商品/发布按钮/验证挑战）是按常见结构写的**最佳猜测**，未连真机验证。若某一步填充失败，扩展会在面板状态里写明哪步失败，请按实际 DOM 在这两个文件的 `SEL` 常量里调整。
- **图片注入**：扩展尝试把后端里的图片 URL 转成 File 注入上传控件；若图片跨域/防盗链拉取失败，会跳过图片并提示手动添加。
- **合规**：自动化发布可能违反小红书用户协议，存在限流/封号风险。请仅用于自有店铺、小范围试用、模拟真人节奏、人工复核。
