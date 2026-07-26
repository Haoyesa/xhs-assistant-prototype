# 黑猫智记AI

从零自研、无破解的「小红书千帆选品 → 按商品生成种草笔记 → 批量发布」工具，仅服务你自己的单个商家账号，不做群控 / 矩阵 / 验证码破解 / 指纹伪造。

> 软件曾用名：小红书发布助手 / 千帆带货笔记助手。当前版本 **v0.2.59**。

## 功能

- 🛒 **选品**：从千帆商品页一键抓取（CDP 驱动已登录 Chrome），也支持手动录入 / 导入商品。
- ✍️ **笔记生成**：按商品用 AI 生成精简标题 + 种草正文 + 热门话题（DeepSeek / 豆包 / 自定义，无 Key 时本地兜底）。
- 🚀 **批量发布**：队列化批量发布，节奏可调（发布间隔 + 随机延迟），支持发布前倒计时；检测到验证挑战即转人工。
- 🔌 **真实发布（CDP）**：通过 `puppeteer-core` 连接已登录 Chrome，真实点击发布按钮（穿透 Web Component 的 closed shadow DOM），而非模拟接口。
- 📜 **历史 / 设置**：发布留痕；发布设置对齐原软件（生成开关、提示词、emoji、自动提交、间隔、随机延迟等）。

## 技术栈

- **桌面壳**：Electron 31（ESM，`electron/main.mjs` 为入口）。
- **后端**：`server.js`（Node 原生 HTTP，端口 **5199**），同进程托管桌面 UI 与 REST API。
- **前端 UI**：`public/`（原生 HTML/CSS/JS，无框架）。
- **浏览器插件**：`extension/`（Manifest V3），负责选品抓取、内容脚本注入、调度。
- **真实浏览器驱动**：`puppeteer-core` + Chrome DevTools Protocol（CDP）。
- **打包**：`electron-builder`（`npm run dist` → `dist/`）。

## 目录结构

```
xhs-assistant-prototype/
├── server.js                 # 后端服务（端口 5199），托管 UI 与 API
├── public/                   # 桌面端前端 UI（index.html / app.js / styles.css / logo.svg）
├── extension/                # 浏览器插件（MV3）：background / content-* / popup / panel.css
├── electron/
│   └── main.mjs              # Electron 主进程入口
├── cdp-publisher.js          # CDP 真实发布逻辑
├── qianfan-scraper.js        # 千帆商品抓取
├── image-util.js             # 图片工具
├── cdp-config.json           # 选择器 / CDP 配置（随官网改版按需校正）
├── gen_releases.js           # 生成 releases 发布归档页
├── assets/                   # 图标等资源
├── data/                     # 运行时数据（git 忽略）
├── dist/                     # 打包产物（git 忽略，运行版在这里）
├── node_modules/             # 依赖（git 忽略）
└── package.json
```

> `dist/win-unpacked/` 是免安装运行目录，其 `resources/app.asar.unpacked/` 为**运行时可改目录**（改完即生效，无需重打包 asar）。但 git 的**源码真源是顶层**（`server.js` / `public/` / `extension/` 等）——在 `dist` 里改完文件后，记得回写到顶层同名文件再提交。

## 环境要求

- Node.js ≥ 18（Electron 31 自带 Chromium，无需另行安装 Node 跑 UI；后端用系统 Node 启动）。
- 已安装 Chrome / Chromium（用于 CDP 真实发布与千帆抓取）。
- 一个已登录小红书千帆商家后台的 Chrome 用户数据目录。

## 安装与运行

```bash
cd xhs-assistant-prototype
npm install                 # 安装 puppeteer-core / electron / electron-builder

# 方式一：纯本地服务（无桌面壳）
npm start                  # 启动后端，打开 http://localhost:5199

# 方式二：Electron 桌面壳（开发模式）
npm run electron           # 用 electron 加载工程，热改源码

# 方式三：使用已打包的免安装版
# 直接进入 dist/win-unpacked/ 双击「黑猫智记AI.exe」
```

## 构建桌面安装包

```bash
npm run dist               # electron-builder 输出到 dist/（含 setup.exe 与 win-unpacked 免安装版）
```

> 打包后如需改 `server.js` / `public/` / `extension/`，直接编辑 `dist/win-unpacked/resources/app.asar.unpacked/` 对应文件即可生效（已解包）。要重打 asar 用 `dist/win-unpacked/rebuild_asar.cjs`。

## 浏览器插件加载

1. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录。
3. 修改后回到该页面点「重新加载」。

## 真实发布（CDP）配置

1. 设置页填 Chrome 路径（或保持默认 `chrome`），点「启动 Chrome」；或在已登录千帆 / 创作者的 Chrome 上手工加启动参数 `--remote-debugging-port=9222`。
2. 浏览器登录你的千帆商家后台，打开商品列表页。
3. 选品页点「从千帆抓取商品」导入商品。
4. 笔记生成 → 批量发布，发布方式切到「CDP 真实浏览器」。

> 选择器（千帆卡片、发布页输入框、关联商品等）随官网改版变动，请在 `cdp-config.json` 中按实际 DOM 校正。无 Chrome 时抓取 / 发布会优雅报错，不影响其它功能。

## 常见问题

- **打开软件一直「连接中…」**：后端没起来。常见原因是端口 **5199** 被别的进程占用（旧版 exe、残留 `node server.js`）。用 `Get-NetTCPConnection -LocalPort 5199` 看占用 PID，`taskkill /F /PID <pid>` 结束；本版已支持同类后端占用时自动复用、非同类弹窗提示。
- **`app.asar.unpacked` 缺依赖**：`server.js` 依赖同目录的 `qianfan-scraper.js` / `cdp-publisher.js` / `image-util.js`，若缺失会 `ERR_MODULE_NOT_FOUND` 导致后端崩溃。

## 合规提醒

自动化发布可能违反小红书用户协议，存在限流 / 封号风险。请仅用于自有店铺、小范围试用、模拟真人节奏，勿用于任何违规批量营销。

## 许可证

自用工具，未开源许可证；如需分发请自行评估合规风险。
