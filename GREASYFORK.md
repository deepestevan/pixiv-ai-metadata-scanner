在 pixiv 上标出哪些图是 AI 生成的。悬停即可看到完整提示词、生成参数与 ComfyUI 工作流，一键导出复现。支持 ComfyUI / Stable Diffusion / NovelAI。

## 能做什么

在 pixiv 页面点击「AI 扫描」按钮，脚本会枚举当前页所有作品缩略图，逐一读取原图内嵌的 AI 生成元数据，并：

- 给含元数据的缩略图加**绿框 + 类型角标**（ComfyUI / SD / NovelAI）
- 显示**全页进度条**（已扫 X/Y · AI 图 N 张）
- **悬停图片**查看该图的 Prompt / Negative / 参数 / 模型
- 面板可**拖动、拉伸、分区折叠**，方便查看长提示词
- 一键**复制或下载**元数据 JSON、ComfyUI workflow JSON（可直接拖回 ComfyUI 复现）

## 支持的元数据

| 工具 | 读取内容 |
|---|---|
| **ComfyUI** | `workflow`（UI 工作流）、`prompt`（API 工作流）、正负提示词、采样参数、模型清单 |
| **Stable Diffusion** (A1111 / Forge) | `parameters`：prompt / negative / seed / sampler / CFG / model |
| **NovelAI** | `Comment`：v4 / v3 提示词（含 Character Prompt）、采样参数 |
| **Civitai 格式** | `generation_data`：提示词、参数、LoRA 与底模清单 |

## 特性

- **快且省流量** — 只读取图片开头的一小段，不下载整张原图
- **不会卡住** — 单个请求有超时保护，个别图片失败不影响整体
- **正负提示词不会搞反** — 按工作流实际连接关系判定
- **不误报** — 严格校验格式，普通图片不会被误标成 AI 图
- **自动限速** — 内置请求节流与限流退避，降低账号风险

## 使用方法

打开 pixiv 的画师主页 / 搜索页 / 收藏页 / 作品详情页，点击页面上的「AI 扫描」按钮即可。扫描为**手动触发**，不会自动运行。

## 未实现

- 隐藏通道元数据（部分 NovelAI / SD Forge 用像素最低位隐写，需完整解码图片）
- 非 PNG 原图（jpg / webp 不含文本块元数据）
- 仅支持 pixiv

## 相关链接

- 源码：https://github.com/deepestevan/pixiv-ai-metadata-scanner
- 问题反馈：https://github.com/deepestevan/pixiv-ai-metadata-scanner/issues
