# Greasyfork 发布文案

## 脚本名称
pixiv AI 元数据扫描器

## 简介（Greasyfork description 字段，200 字内）

在 pixiv 上标出哪些图是 AI 生成的。悬停即可看到完整提示词、生成参数与 ComfyUI 工作流，一键导出复现。支持 ComfyUI / Stable Diffusion / NovelAI。

## 详细说明（Greasyfork additional info / 附加信息）

见 [`GREASYFORK.md`](./GREASYFORK.md)。该文件已设为 Greasyfork 附加信息的同步来源：

```
https://raw.githubusercontent.com/deepestevan/pixiv-ai-metadata-scanner/main/GREASYFORK.md
```

修改附加信息只需编辑 `GREASYFORK.md` 并 push，Greasyfork 会自动同步（与脚本代码同步是两条独立通道）。

## 更新日志（Greasyfork 更新说明）

### 1.0.1

- 优化脚本描述文案，让用途更直观

### 1.0.0

首个公开发布版本。

- 点击按钮即可扫描当前页所有作品，自动标出含 AI 生成元数据的图
- 支持读取 ComfyUI 工作流与提示词、Stable Diffusion 参数、NovelAI 提示词
- 悬停图片查看 Prompt / Negative / 参数 / 模型
- 一键复制或下载 ComfyUI 工作流与元数据 JSON
- 只读取原图头部，不下载整张图片

---

## 发布字段填写参考

| 字段 | 值 |
|---|---|
| 名称 | pixiv AI 元数据扫描器 |
| 命名空间 | https://github.com/deepestevan/pixiv-ai-metadata-scanner |
| 版本 | 1.0.0 |
| 许可证 | MIT |
| 适用站点 | https://www.pixiv.net/* |
| 脚本来源 | 上传 `pixiv-ai-metadata-scanner.user.js` |
| 附加信息 | 同步自 `GREASYFORK.md` |
| 首页 / 支持站点 | https://github.com/deepestevan/pixiv-ai-metadata-scanner |

## 发布渠道

| 平台 | 地址 |
|---|---|
| GitHub | https://github.com/deepestevan/pixiv-ai-metadata-scanner |
| Greasyfork | https://greasyfork.org/zh-CN/scripts/596334 |
