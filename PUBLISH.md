# Greasyfork 发布文案

## 脚本名称
pixiv AI 元数据扫描器

## 简介（Greasyfork description 字段，200 字内）

手动扫描 pixiv 页面缩略图，识别哪些图由 AI 生成，并提取完整提示词与 ComfyUI 工作流。只读取原图 PNG 头部约 256KB，不下载整张图片。

## 详细说明（Greasyfork additional info / 附加信息）

**功能**

在 pixiv 页面上点击「AI 扫描」按钮，脚本会枚举当前页所有作品缩略图，逐一读取原图内嵌的 AI 生成元数据，并：

- 给含元数据的缩略图加**绿框 + 类型角标**（ComfyUI / SD / NovelAI）
- 显示**全页进度条**（已扫 X/Y · AI 图 N 张）
- **悬停图片**查看该图的 Prompt / Negative / 参数 / 模型
- 面板可**拖动、拉伸、分区折叠**
- 一键**复制或下载**元数据 JSON、ComfyUI workflow JSON（可直接拖回 ComfyUI 复现）

**支持识别的元数据**

| 工具 | 读取内容 |
|---|---|
| ComfyUI | `workflow`（UI 工作流）、`prompt`（API 工作流）、正负提示词、采样参数、模型 |
| Stable Diffusion (A1111/Forge) | `parameters`：prompt / negative / seed / sampler / CFG / model |
| NovelAI | `Comment`：v4/v3 提示词（含 Character Prompt）、采样参数 |
| Civitai 格式 | `generation_data`：提示词、参数、LoRA 与模型清单 |

**特性**

- **快**：HTTP `Range` 只取 PNG 头部（~256KB）解析文本块，不下载整张原图
- **稳**：原图地址走 pixiv API 权威解析，失败时回退推算；单请求硬超时，不会卡死
- **准**：按 ComfyUI 采样器连接判定正负提示词；严格校验 NovelAI 格式，避免把 ezgif 等工具的注释误判为 AI
- **限流**：并发 4、约 4 req/s、429 自适应退避 30s、失败可单独重试

**使用**

1. 安装油猴管理器（Tampermonkey / Violentmonkey）
2. 安装本脚本
3. 打开 pixiv 页面（画师主页 / 搜索 / 收藏 / 作品详情）
4. 点击右下角/右上角「AI 扫描」按钮

**未实现**

- 隐藏通道元数据（部分 NovelAI / SD Forge 用像素最低位隐写，需完整解码图片）
- 非 PNG 原图（jpg / webp 不含文本块元数据）
- 仅支持 pixiv

## 更新日志（Greasyfork 更新说明）

### 1.0.0

首个公开发布版本。

- 点击按钮即可扫描当前页所有作品，自动标出含 AI 生成元数据的图
- 支持读取 ComfyUI 工作流与提示词、Stable Diffusion 参数、NovelAI 提示词
- 悬停图片查看 Prompt / Negative / 参数 / 模型
- 一键复制或下载 ComfyUI 工作流与元数据 JSON
- 只读取原图头部，不下载整张图片

---

## 首发时建议填写

| 字段 | 建议值 |
|---|---|
| 名称 | pixiv AI 元数据扫描器 |
| 命名空间 | https://github.com/deepestevan/pixiv-ai-metadata-scanner |
| 版本 | 1.0.0 |
| 许可证 | MIT |
| 适用站点 | https://www.pixiv.net/* |
| 脚本来源 | 上传 `pixiv-ai-metadata-scanner.user.js` |
| 附加信息 | 上方「详细说明」全文 |
| 首页 / 支持站点 | https://github.com/deepestevan/pixiv-ai-metadata-scanner |
