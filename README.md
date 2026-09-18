# pixiv AI 元数据扫描器（油猴脚本）

在 pixiv 上标出哪些图是 AI 生成的。悬停即可看到完整提示词、生成参数与 ComfyUI 工作流，一键导出复现。支持 ComfyUI / Stable Diffusion / NovelAI。

> 使用前请阅读文末[免责声明](#免责声明)。

## 功能

- **手动扫描**：点击「AI 扫描」按钮枚举当前页（画师主页 / 搜索页 / 收藏页 / 作品详情页）所有作品缩略图并扫描
- **AI 元数据提取**：
  - **ComfyUI** → `prompt` / `workflow`（工作流 JSON，可直接拖回 ComfyUI 复现）
  - **Stable Diffusion (A1111/Forge)** → `parameters`（prompt / negative / seed / sampler / CFG / model）
  - **NovelAI** → `Comment`
- **快速**：用 HTTP `Range` 只取 PNG 头部（~256KB）解析文本块，不下载整张原图
- **限流**：并发 4、4 req/s、429 自适应退避 30s、失败重试、单项硬超时
- **UI**：
  - 有元数据的缩略图 → **绿框 + 类型角标**（ComfyUI / SD / NovelAI）
  - 每张图扫描状态标记
  - **全页面批量进度条**（已扫 X/Y · AI 图 N 张 · 百分比）
  - 悬停缩略图 → 查看 prompt / 参数 / workflow
  - 一键 **复制 / 下载 ComfyUI workflow JSON**
- **API 兜底**：构造的原图 URL 不可用时自动用 pixiv API 拿权威 URL 重扫，避免漏判

## 安装

1. 安装油猴管理器（Tampermonkey / Violentmonkey）
2. 打开 `pixiv-ai-metadata-scanner.user.js`，导入为新脚本（或从 Greasyfork / GitHub 直接安装）
3. 打开任意 pixiv 页面（画师主页 / 搜索 / 收藏 / 作品详情），**点击右上角「AI 扫描」按钮**开始扫描（不自动扫描）

## 开发

```bash
npm install        # 安装 esbuild
npm test           # 运行单测（PNG 解析 / pixiv URL / 扫描引擎）
npm run build      # 打包为油猴单文件
```

## 目录

```
src/
├── png.js         PNG 文本块解析器（tEXt/iTXt/zTXt，含 zlib 解压）
├── metadata.js    AI 元数据识别与提取（ComfyUI/SD/NovelAI）
├── pixiv.js       pixiv 适配：链接法枚举作品、缩略图→原图 URL、API 兜底
├── scanner.js     批量扫描引擎（并发/限流/429 退避/缓存/重试/进度）
├── transport.js   GM_xmlhttpRequest + Range + referer 抓 PNG 头部
├── ui.js          UI：绿框/类型角标/扫描状态/全页进度条/可拉伸面板/workflow 导出
└── main.js        入口，串起各模块
test/              单元测试
scripts/build.js   构建脚本（esbuild + 油猴头）
```

## 未实现的功能

- **隐藏通道元数据**：部分 NovelAI（stealth_pngcomp）与 SD Forge 会把元数据藏在像素最低位（隐写），需要完整解码整张图才能读取。当前版本只读 PNG 文本块，读不出这类图。
- **非 PNG 原图**：只解析 PNG。jpg / webp 原图本身也不含文本块元数据，因此不处理。
- **其他站点**：目前仅支持 pixiv。

## 致谢

本脚本为独立实现，未使用下列项目的代码，但在设计思路与元数据格式识别上受其启发：

- [pixiv-metadata-viewer](https://github.com/da2el-ai/pixiv-metadata-viewer)（da2el-ai）— 启发来源：从 PNG 内嵌元数据识别 AI 绘图、`parameters` / `Comment` 字段解析、NovelAI v4 `char_captions` 处理
- [Pixiv Downloader](https://github.com/drunkg00se/Pixiv-Downloader)（drunkg00se）— 启发来源：以 `<a href>` + 结构白名单枚举作品（"双闸门"识别）

## 免责声明

- 本脚本通过程序化访问 pixiv 获取图片内嵌元数据，其服务条款禁止使用爬虫等程序收集信息，频繁或大规模使用可能导致账号被限制或封禁，建议使用小号。
- 本脚本仅供个人学习研究，请勿用于商业用途或大规模数据收集。
- 使用本脚本产生的任何后果由使用者自行承担。
