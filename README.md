# 黑猫智记AI

从零自研的本地内容创作辅助工具：文案优化、排版设计、敏感词检测、封面素材参考。本地运行，不接入任何平台接口、不自动发布、不批量管账号。

> 黑猫智记AI · 通用内容创作辅助工具。当前版本 **v0.2.59**。

## 功能

- 📦 **素材库**：管理你自己的文本 / 图片素材，支持手动录入与本地图片文件夹导入。
- ✍️ **文案优化**：按素材用 AI 生成精简标题 + 正文 + 热门话题（DeepSeek / 豆包 / 自定义，无 Key 时本地兜底）。
- 🎨 **封面素材参考**：本地批量生成封面与排版素材。
- 🔒 **本地优先**：所有编辑在本地完成，数据不上传；不收集任何平台账号密码。
- 📜 **历史 / 设置**：生成留痕与本地设置（生成开关、提示词、emoji 等）。

## 技术栈

- **桌面壳**：Electron 31（ESM，`electron/main.mjs` 为入口）。
- **后端**：`server.js`（Node 原生 HTTP，端口 **5199**），同进程托管桌面 UI 与 REST API。
- **前端 UI**：`public/`（原生 HTML/CSS/JS，无框架）。
- **浏览器插件**：`extension/`（Manifest V3，可选辅助组件）。
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
├── cdp-publisher.js          # 发布逻辑（过渡期，将下线）
├── qianfan-scraper.js       # 商品抓取（过渡期，将下线）
├── image-util.js             # 图片工具
├── cdp-config.json           # 选择器 / CDP 配置
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
- （可选）已安装 Chrome / Chromium，用于本地生成预览。

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

## 本地生成与预览

1. 设置页填 Chrome 路径（或保持默认 `chrome`），用于本地预览。
2. 打开你需要参考的网页进行本地截图 / 取色。
3. 在素材库中添加你的文本 / 图片素材。
4. 用「批量作图」本地生成封面与排版素材。

> 本地生成不依赖任何平台接口；所有数据留在你本机。

## 常见问题

- **打开软件一直「连接中…」**：后端没起来。常见原因是端口 **5199** 被别的进程占用（旧版 exe、残留 `node server.js`）。用 `Get-NetTCPConnection -LocalPort 5199` 看占用 PID，`taskkill /F /PID <pid>` 结束；本版已支持同类后端占用时自动复用、非同类弹窗提示。
- **`app.asar.unpacked` 缺依赖**：`server.js` 依赖同目录的 `qianfan-scraper.js` / `cdp-publisher.js` / `image-util.js`，若缺失会 `ERR_MODULE_NOT_FOUND` 导致后端崩溃。

## 合规提醒

请遵守各内容平台的运营规则与所在地区法律法规；本工具仅提供创作辅助，不代您发布，禁止用于虚假种草、批量搬运、刷量等违规行为。完整的权责与数据合规说明见 `docs/用户协议.md`。

## 许可证

自用工具，未开源许可证；如需分发请自行评估合规风险。
