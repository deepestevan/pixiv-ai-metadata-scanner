/**
 * 构建：esbuild 打包 src/main.js 为单个 IIFE，前置油猴元数据头，输出 .user.js
 * 运行：npm run build
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const VERSION = '1.0.1';
const HEADER = `// ==UserScript==
// @name               pixiv AI 元数据扫描器
// @namespace          https://github.com/deepestevan/pixiv-ai-metadata-scanner
// @version            ${VERSION}
// @description        在 pixiv 上标出哪些图是 AI 生成的，点开即可看到完整提示词、生成参数与 ComfyUI 工作流，一键导出复现。支持 ComfyUI / Stable Diffusion / NovelAI。
// @author             deepestevan
// @license            MIT
// @match              https://www.pixiv.net/*
// @grant              GM_xmlhttpRequest
// @connect            i.pximg.net
// @connect            i-cf.pximg.net
// @connect            i-f.pximg.net
// @connect            www.pixiv.net
// @noframes
// ==/UserScript==

`;

const result = await build({
  entryPoints: [resolve(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  write: false,
  legalComments: 'none',
});

const code = result.outputFiles[0].text;
const outPath = resolve(root, 'pixiv-ai-metadata-scanner.user.js');
writeFileSync(outPath, HEADER + code, 'utf8');
console.log(`✓ 构建完成: ${outPath} (${(HEADER.length + code.length) / 1024 | 0} KB)`);
