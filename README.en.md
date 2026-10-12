# pixiv AI Metadata Scanner (Userscript)

**English** · **[中文](README.md)** · **[日本語](README.ja.md)**

Highlights which images on pixiv are AI-generated. Hover to read the full prompt, the generation parameters and the ComfyUI workflow, and export them with one click to reproduce the image. Supports ComfyUI / Stable Diffusion / NovelAI.

> Please read the [disclaimer](#disclaimer) at the end before use.

## Features

- **Manual scan** — click the 「AI 扫描」 (Scan) button to enumerate every artwork thumbnail on the current page (artist profile / search results / bookmarks / artwork detail page) and scan them
- **AI metadata extraction**:
  - **ComfyUI** → `prompt` / `workflow` (workflow JSON, ready to drag straight back into ComfyUI)
  - **Stable Diffusion (A1111/Forge)** → `parameters` (prompt / negative / seed / sampler / CFG / model)
  - **NovelAI** → `Comment`
- **Fast** — uses the HTTP `Range` header to read only the PNG header (~256 KB) to parse its text chunks, instead of downloading the whole original image
- **Rate limited** — concurrency 4, 4 req/s, adaptive 30 s backoff on 429, retries, per-item hard timeout
- **UI**:
  - thumbnails that carry metadata → **green border + type badge** (ComfyUI / SD / NovelAI)
  - per-image scan status
  - **page-wide batch progress bar** (scanned X/Y · N AI images · percentage)
  - hover a thumbnail → read prompt / parameters / workflow
  - one-click **copy / download** of the ComfyUI workflow JSON
- **API fallback** — if the constructed original-image URL is unavailable, the script falls back to the pixiv API to fetch the authoritative URL and rescans, so nothing is silently missed

## Installation

1. Install a userscript manager (Tampermonkey / Violentmonkey)
2. Open `pixiv-ai-metadata-scanner.user.js` and import it as a new script (or install directly from Greasyfork / GitHub)
3. Open any pixiv page (artist profile / search / bookmarks / artwork detail) and **click the 「AI 扫描」 (Scan) button in the top-right corner** to start scanning (nothing is scanned automatically)

## Development

```bash
npm install        # install esbuild
npm test           # run unit tests (PNG parsing / pixiv URLs / scan engine)
npm run build      # bundle into a single userscript file
```

## Layout

```
src/
├── png.js         PNG text chunk parser (tEXt/iTXt/zTXt, including zlib inflate)
├── metadata.js    AI metadata detection and extraction (ComfyUI/SD/NovelAI)
├── pixiv.js       pixiv adapter: link-based artwork enumeration, thumbnail→original URL, API fallback
├── scanner.js     batch scan engine (concurrency / rate limit / 429 backoff / cache / retry / progress)
├── transport.js   GM_xmlhttpRequest + Range + referer to fetch the PNG header
├── ui.js          UI: green border / type badge / scan status / page-wide progress bar / resizable panel / workflow export
└── main.js        entry point, wires the modules together
test/              unit tests
scripts/build.js   build script (esbuild + userscript header)
```

## Not implemented

- **Steganographic metadata** — some NovelAI (stealth_pngcomp) and SD Forge images hide metadata in the least-significant bits of the pixels, which requires decoding the entire image to read. The current version only reads PNG text chunks, so it cannot read those images.
- **Non-PNG originals** — only PNG is parsed. jpg / webp originals do not carry text-chunk metadata either, so they are not handled.
- **Other sites** — pixiv only for now.

## Credits

This script is an independent implementation. It does not use code from the projects below, but its design thinking and metadata-format detection were inspired by them:

- [pixiv-metadata-viewer](https://github.com/da2el-ai/pixiv-metadata-viewer) (da2el-ai) — inspiration: detecting AI images from metadata embedded in PNGs, parsing the `parameters` / `Comment` fields, handling NovelAI v4 `char_captions`
- [Pixiv Downloader](https://github.com/drunkg00se/Pixiv-Downloader) (drunkg00se) — inspiration: enumerating artworks via `<a href>` plus a structural whitelist (the "double gate" check)

## Disclaimer

- This script accesses pixiv programmatically to read metadata embedded in images. pixiv's Terms of Service prohibit collecting information with crawlers and similar automated tools; frequent or large-scale use may get your account restricted or banned — using a secondary account is recommended.
- This script is for personal study and research only. Do not use it for commercial purposes or for large-scale data collection.
- You are solely responsible for any consequences of using this script.
