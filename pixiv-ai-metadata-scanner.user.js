// ==UserScript==
// @name               pixiv AI 元数据扫描器
// @namespace          https://github.com/deepestevan/pixiv-ai-metadata-scanner
// @version            1.0.0
// @description        手动扫描 pixiv 页面缩略图，Range 只取原图 PNG 头部解析 AI 元数据（ComfyUI workflow/prompt、SD parameters、NovelAI Comment），绿框+类型角标标记，全页面批量进度条，悬停查看详情，ComfyUI workflow 导出。
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

(() => {
  // src/png.js
  var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  async function parsePngTextChunks(input, opts = {}) {
    const inflate = opts.inflate || defaultInflate;
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const items = [];
    if (u8.length < 8 || PNG_SIGNATURE.some((v, i) => u8[i] !== v)) {
      return { ok: false, items, error: "invalid-png-signature" };
    }
    const latin1 = new TextDecoder("latin1");
    const utf8 = new TextDecoder("utf-8");
    let off = 8;
    let sawIEND = false;
    while (off + 8 <= u8.length) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const len = dv.getUint32(off);
      const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      const next = dataEnd + 4;
      if (dataEnd > u8.length) break;
      const data = u8.subarray(dataStart, dataEnd);
      if (type === "tEXt") {
        const sep = indexOfZero(data, 0);
        if (sep >= 0) {
          items.push({
            type,
            keyword: latin1.decode(data.subarray(0, sep)),
            text: latin1.decode(data.subarray(sep + 1))
          });
        }
      } else if (type === "iTXt") {
        const k0 = indexOfZero(data, 0);
        if (k0 < 0) {
          off = next;
          continue;
        }
        const keyword = latin1.decode(data.subarray(0, k0));
        let p = k0 + 1;
        const compFlag = data[p++];
        p++;
        const l0 = indexOfZero(data, p);
        if (l0 < 0) {
          off = next;
          continue;
        }
        p = l0 + 1;
        const t0 = indexOfZero(data, p);
        if (t0 < 0) {
          off = next;
          continue;
        }
        const translatedKeyword = utf8.decode(data.subarray(p, t0));
        p = t0 + 1;
        const textBytes = data.subarray(p);
        let text;
        if (compFlag === 1) {
          const raw = await inflate(textBytes).catch(() => null);
          text = raw ? utf8.decode(raw) : "";
        } else {
          text = utf8.decode(textBytes);
        }
        items.push({ type, keyword, text, translatedKeyword });
      } else if (type === "zTXt") {
        const sep = indexOfZero(data, 0);
        if (sep < 0) {
          off = next;
          continue;
        }
        const keyword = latin1.decode(data.subarray(0, sep));
        const compressed = data.subarray(sep + 2);
        const raw = await inflate(compressed).catch(() => null);
        const text = raw ? latin1.decode(raw) : "";
        items.push({ type, keyword, text });
      }
      off = next;
      if (type === "IEND") {
        sawIEND = true;
        break;
      }
      if (type === "IDAT") break;
    }
    return { ok: true, items, sawIEND };
  }
  function indexOfZero(data, from) {
    for (let i = from; i < data.length; i++) {
      if (data[i] === 0) return i;
    }
    return -1;
  }
  async function defaultInflate(u8) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("DecompressionStream not available");
    }
    for (const fmt of ["deflate", "deflate-raw"]) {
      try {
        const blob = new Blob([u8]);
        const stream = new Response(blob.stream().pipeThrough(new DecompressionStream(fmt)));
        const ab = await stream.arrayBuffer();
        return new Uint8Array(ab);
      } catch (e) {
      }
    }
    throw new Error("inflate failed");
  }

  // src/metadata.js
  function safeJsonParse(str) {
    if (typeof str !== "string" || !str.trim()) return null;
    try {
      return JSON.parse(str);
    } catch (e) {
      const cleaned = str.replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null");
      try {
        return JSON.parse(cleaned);
      } catch (e2) {
        return null;
      }
    }
  }
  function analyzeMetadata(items) {
    const result = {
      isAI: false,
      kind: null,
      // 'comfyui' | 'sd' | 'novelai' | 'unknown'
      prompt: void 0,
      negative: void 0,
      params: void 0,
      workflow: void 0,
      raw: {}
    };
    if (!items || !items.length) return result;
    const byKeyword = {};
    for (const it of items) {
      byKeyword[it.keyword] = it.text;
      if (!(it.keyword in result.raw)) result.raw[it.keyword] = [];
      result.raw[it.keyword].push({ type: it.type, text: it.text });
    }
    if ("workflow" in byKeyword || "prompt" in byKeyword) {
      result.isAI = true;
      result.kind = "comfyui";
      result.workflow = byKeyword["workflow"] || void 0;
      result.promptJson = byKeyword["prompt"] || void 0;
      const promptObj = safeJsonParse(byKeyword["prompt"]);
      if (promptObj) {
        const { prompt, negative, params } = extractFromComfyPrompt(promptObj);
        result.prompt = prompt;
        result.negative = negative;
        result.params = params;
      }
      const gen = safeJsonParse(byKeyword["generation_data"]);
      if (gen) {
        if (!result.prompt && gen.prompt) result.prompt = gen.prompt;
        if (!result.negative && gen.negativePrompt) result.negative = gen.negativePrompt;
        if (!result.params || !Object.keys(result.params).length) {
          result.params = {};
          if (gen.width && gen.height) result.params.size = `${gen.width}x${gen.height}`;
          if (gen.steps !== void 0) result.params.steps = gen.steps;
          if (gen.cfgScale !== void 0) result.params.cfg = gen.cfgScale;
          if (gen.seed !== void 0) result.params.seed = gen.seed;
          if (gen.samplerName) result.params.sampler = gen.samplerName;
          if (gen.clipSkip !== void 0) result.params.clipSkip = gen.clipSkip;
          if (gen.hrUpscaler) result.params.hrUpscaler = gen.hrUpscaler;
        }
        if (Array.isArray(gen.models)) {
          result.models = gen.models.map((m) => ({
            name: m.modelFileName || m.label,
            type: m.type,
            weight: m.weight
          }));
        }
        if (gen.baseModel?.modelFileName) result.baseModel = gen.baseModel.modelFileName;
      }
      return result;
    }
    if ("parameters" in byKeyword) {
      result.isAI = true;
      result.kind = "sd";
      const parsed = parseA1111Parameters(byKeyword["parameters"]);
      result.prompt = parsed.prompt;
      result.negative = parsed.negative;
      result.params = parsed.params;
      return result;
    }
    if ("Comment" in byKeyword) {
      const commentObj = safeJsonParse(stripQuotes(byKeyword["Comment"]));
      if (commentObj && isNovelAiComment(commentObj)) {
        result.isAI = true;
        result.kind = "novelai";
        result.params = commentObj;
        if (commentObj.v4_prompt?.caption?.base_caption) {
          let p = commentObj.v4_prompt.caption.base_caption;
          const chars = commentObj.v4_prompt.caption.char_captions;
          if (Array.isArray(chars) && chars.length) {
            p += "\n\nCharacter Prompt:\n" + chars.map((c) => c.char_caption).join("\n");
          }
          result.prompt = p;
        }
        if (commentObj.v4_negative_prompt?.caption?.base_caption) {
          result.negative = commentObj.v4_negative_prompt.caption.base_caption;
        }
        if (!result.prompt && commentObj.prompt) result.prompt = commentObj.prompt;
        if (!result.negative && commentObj.uc) result.negative = commentObj.uc;
      }
      return result;
    }
    return result;
  }
  function extractFromComfyPrompt(promptObj) {
    const res = { prompt: void 0, negative: void 0, params: {} };
    if (!promptObj || typeof promptObj !== "object") return res;
    const encoders = /* @__PURE__ */ new Map();
    const textFalls = [];
    const samplers = [];
    for (const [id, node] of Object.entries(promptObj)) {
      const cls = node?.class_type || "";
      const inp = node?.inputs || {};
      if (/CLIPTextEncode|TextEncode|EncodeCLIP|CLIPText/i.test(cls) && typeof inp.text === "string") {
        encoders.set(id, inp.text);
        textFalls.push(inp.text);
      }
      if (/Sampler/i.test(cls)) samplers.push(inp);
      if (/Sampler/i.test(cls)) {
        if (inp.steps !== void 0) res.params.steps = inp.steps;
        if (inp.cfg !== void 0) res.params.cfg = inp.cfg;
        if (inp.seed !== void 0) res.params.seed = inp.seed;
        if (inp.sampler_name !== void 0) res.params.sampler = inp.sampler_name;
        if (inp.scheduler !== void 0) res.params.scheduler = inp.scheduler;
        if (inp.denoise !== void 0) res.params.denoise = inp.denoise;
      }
      if (/CheckpointLoader|UNETLoader|DiffusionModel|ModelLoader/i.test(cls)) {
        if (inp.ckpt_name !== void 0) res.params.model = inp.ckpt_name;
        if (inp.unet_name !== void 0) res.params.model = inp.unet_name;
      }
    }
    for (const s of samplers) {
      const posId = connectionNodeId(s.positive);
      const negId = connectionNodeId(s.negative);
      if (encoders.has(posId)) res.prompt = encoders.get(posId);
      if (encoders.has(negId)) res.negative = encoders.get(negId);
      if (res.prompt && res.negative) break;
    }
    if (!res.prompt) res.prompt = textFalls[0];
    if (!res.negative && textFalls.length > 1) res.negative = textFalls[1];
    return res;
  }
  function connectionNodeId(ref) {
    if (Array.isArray(ref)) return String(ref[0]);
    if (typeof ref === "string") return ref;
    if (ref && typeof ref === "object" && ref.id !== void 0) return String(ref.id);
    return "";
  }
  function parseA1111Parameters(text) {
    const res = { prompt: void 0, negative: void 0, params: {} };
    if (!text) return res;
    const negMatch = text.match(/Negative prompt:\s*([\s\S]*?)(?:\n[A-Z][\w ]+:\s|$)/i);
    if (negMatch) res.negative = negMatch[1].trim();
    const paramsLine = (text.match(/^(?:.*?(?:Steps:|Sampler:|CFG|Seed|Model|Size).*?)$/gim) || [])[0];
    if (paramsLine) {
      for (const pair of paramsLine.split(",")) {
        const idx = pair.indexOf(":");
        if (idx === -1) continue;
        const k = pair.slice(0, idx).trim().toLowerCase();
        const v = pair.slice(idx + 1).trim();
        if (k.startsWith("steps")) res.params.steps = v;
        else if (k.startsWith("sampler")) res.params.sampler = v;
        else if (k.startsWith("cfg")) res.params.cfg = v;
        else if (k.startsWith("seed")) res.params.seed = v;
        else if (k.startsWith("model")) res.params.model = v;
        else if (k.includes("size")) res.params.size = v;
      }
    }
    if (res.prompt === void 0) {
      if (/Negative prompt:/i.test(text)) {
        res.prompt = text.slice(0, text.search(/Negative prompt:/i)).trim();
      } else if (paramsLine) {
        res.prompt = text.slice(0, text.indexOf(paramsLine)).trim();
      } else {
        res.prompt = text.trim();
      }
    }
    return res;
  }
  function stripQuotes(s) {
    if (typeof s !== "string") return s;
    const t = s.trim();
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    return t;
  }
  var NAI_KEYS = [
    "prompt",
    "uc",
    "sampler",
    "steps",
    "scale",
    "seed",
    "strength",
    "noise_schedule",
    "v4_prompt",
    "v4_negative_prompt",
    "parameters",
    "dynamic_thresholding",
    "cfg_rescale",
    "sm",
    "legacy"
  ];
  function isNovelAiComment(obj) {
    return !!obj && typeof obj === "object" && !Array.isArray(obj) && NAI_KEYS.some((k) => k in obj);
  }

  // src/pixiv.js
  var ORIGINAL_EXT = ".png";
  function thumbnailToOriginalPngUrl(thumbUrl) {
    if (!thumbUrl) return null;
    const noCdn = thumbUrl.replace(/^https?:\/\/i\.pximg\.net\/c\/[^/]+\//, "https://i.pximg.net/");
    if (!noCdn.includes("img-master/img/")) return null;
    const original = noCdn.replace("img-master/img/", "img-original/img/").replace(/_(master|square)\d+\.\w+$/, ORIGINAL_EXT);
    return original;
  }
  function getIllustId(node, patterns = {}) {
    const artworksRe = patterns.artworksRe || /\/artworks\/(\d+)$/;
    const activityRe = patterns.activityRe || /illust_id=(\d+)/;
    const href = node.getAttribute && node.getAttribute("href") || "";
    const isArtworksLink = artworksRe.exec(href);
    if (isArtworksLink) {
      const hasGtm = node.getAttribute && node.getAttribute("data-gtm-value");
      const hasFigure = node.querySelector && !!node.querySelector(':scope > figure, :scope > img[src*="pximg.net/c/480x960"]');
      const inWhitelist = [
        "gtm-illust-recommend-node-node",
        "gtm-discover-user-recommend-node",
        "work",
        "_history-item",
        "_history-related-item"
      ].some((c) => node.classList && node.classList.contains(c));
      if (hasGtm || hasFigure || inWhitelist) {
        return isArtworksLink[1];
      }
      return "";
    }
    const isActivityThumb = activityRe.exec(href);
    if (isActivityThumb && node.classList && node.classList.contains("work")) {
      return isActivityThumb[1];
    }
    return "";
  }
  function collectArtworks(root = document) {
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    for (const a of root.querySelectorAll("a")) {
      const id = getIllustId(a);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let img = a.querySelector("img");
      if (!img && a.tagName === "IMG") img = a;
      const thumbUrl = img ? img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "" : "";
      items.push({ id, a, img: img || null, thumbUrl });
    }
    return items;
  }
  function getCurrentArtworkId() {
    const m = location.pathname.match(/\/artworks\/(\d+)/);
    return m ? m[1] : null;
  }
  function extractPageFromImage(src) {
    const m = src && src.match(/_p(\d+)_/);
    return m ? Number(m[1]) : 0;
  }
  function originalUrlForPage(origUrl, page) {
    if (!origUrl || page <= 0) return origUrl;
    return origUrl.replace(/_p0(?=\.\w+$)/, `_p${page}`);
  }
  function isArtworkImageFor(src, id) {
    return src.includes(`/${id}-`) || // {id}-{hash}_p{page}
    src.includes(`/${id}_p`) || // {id}_p{page}
    src.includes(`/${id}.`);
  }
  function findMainImage(root = document, id = "") {
    const imgs = [...root.querySelectorAll("img")];
    const srcOf = (img) => img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "";
    if (id) {
      for (const img of imgs) {
        if (isArtworkImageFor(srcOf(img), id)) return img;
      }
    }
    const px = imgs.filter((i) => {
      const s = srcOf(i);
      return /^https?:\/\/i\.pximg\.net\/(img-master|img-original)/.test(s) && !/\.svg(\?|$)/.test(s);
    });
    px.sort((a, b) => (b.naturalWidth || b.width || 0) - (a.naturalWidth || a.width || 0));
    return px[0] || null;
  }
  function findPageImages(root = document, id = "") {
    const map = /* @__PURE__ */ new Map();
    if (!id) return map;
    const re = new RegExp(`/${id}(?:-[a-z0-9]+)?_p(\\d+)_`, "i");
    for (const img of root.querySelectorAll("img")) {
      const s = img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "";
      const m = s.match(re);
      if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), img);
    }
    return map;
  }
  function collectCurrentArtwork() {
    const id = getCurrentArtworkId();
    if (!id) return null;
    const img = findMainImage(document, id);
    const src = img ? img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "" : "";
    const page = img ? extractPageFromImage(src) : 0;
    const a = img ? img.closest("a") || img.parentElement : null;
    if (img) console.log("[pams] \u8BE6\u60C5\u9875\u4E3B\u56FE:", id, "page", page, "src", src.slice(0, 120));
    return { id, img, a, thumbUrl: src, page };
  }
  async function fetchWithTimeout(url, opts = {}, ms = 15e3, fetchImpl = fetch) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetchImpl(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  async function resolveOriginalUrlViaApi(id, fetchImpl = fetch) {
    try {
      const res = await fetchWithTimeout(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, {
        credentials: "include",
        headers: { "x-requested-with": "XMLHttpRequest" }
      }, 15e3, fetchImpl);
      if (!res.ok) return null;
      const json = await res.json();
      return json?.body?.urls?.original || null;
    } catch (e) {
      return null;
    }
  }
  async function getIllustInfo(id, fetchImpl = fetch) {
    try {
      const res = await fetchWithTimeout(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, {
        credentials: "include",
        headers: { "x-requested-with": "XMLHttpRequest" }
      }, 15e3, fetchImpl);
      if (!res.ok) return null;
      const json = await res.json();
      const b = json?.body;
      if (!b) return null;
      return { original: b.urls?.original || null, pageCount: b.pageCount || 1 };
    } catch (e) {
      return null;
    }
  }

  // src/scanner.js
  var DEFAULT_HEADER_BYTES = 256 * 1024;
  var Scanner = class {
    /**
     * @param {Object} opts
     * @param {(url:string, signal:AbortSignal)=>Promise<Uint8Array|null>} opts.fetchHeader 返回 PNG 头部字节；null=无/失败
     * @param {(url:string)=>Promise<{isAI:boolean,kind:string|null,prompt?:string,workflow?:string}|null>} opts.analyze 解析函数
     * @param {number} [opts.concurrency=4]
     * @param {number} [opts.intervalMs=1000] 每 intervalMs 最多发 intervalCap 个
     * @param {number} [opts.intervalCap=4]
     * @param {number} [opts.retry=2] 失败重试次数
     * @param {number} [opts.backoffMs=30000] 429 退避时长
     * @param {(p:{done:number,total:number,aiCount:number})=>void} [opts.onProgress]
     * @param {(item:Object, result:ScanResult)=>void} [opts.onResult]
     */
    constructor(opts) {
      this.fetchHeader = opts.fetchHeader;
      this.analyze = opts.analyze;
      this.concurrency = opts.concurrency ?? 4;
      this.intervalMs = opts.intervalMs ?? 1e3;
      this.intervalCap = opts.intervalCap ?? 4;
      this.retry = opts.retry ?? 2;
      this.backoffMs = opts.backoffMs ?? 3e4;
      this.itemTimeout = opts.itemTimeout ?? 2e4;
      this.onProgress = opts.onProgress;
      this.onResult = opts.onResult;
      this.cache = /* @__PURE__ */ new Map();
      this._running = false;
      this._paused = false;
      this._aborted = false;
      this._queue = [];
      this._queued = /* @__PURE__ */ new Set();
      this._active = 0;
      this._intervalCount = 0;
      this._intervalResetAt = 0;
      this._backoffUntil = 0;
    }
    /**
     * 加入一批待扫描项（去重）。
     * @param {Object[]} items  [{url, ...附加字段}]
     */
    add(items) {
      for (const it of items) {
        if (!it?.url || this.cache.has(it.url) || this._queued.has(it.url)) continue;
        this._queued.add(it.url);
        this._queue.push(it);
      }
    }
    /**
     * 强制加入（用于 API 兜底重扫）：忽略缓存/队列去重。
     */
    forceAdd(items) {
      for (const it of items) {
        if (!it?.url) continue;
        this.cache.delete(it.url);
        this._queued.add(it.url);
        this._queue.push(it);
      }
    }
    get queueLength() {
      return this._queue.length + this._active;
    }
    get cachedCount() {
      return this.cache.size;
    }
    pause() {
      this._paused = true;
    }
    resume() {
      this._paused = false;
      this._tick();
    }
    cancel() {
      this._aborted = true;
      this._queue = [];
    }
    async start() {
      if (this._running) return;
      this._running = true;
      this._tick();
      while (this.queueLength > 0 && !this._aborted) {
        await sleep(100);
      }
      this._running = false;
    }
    async _tick() {
      while (true) {
        if (this._aborted) return;
        if (this._paused) {
          await sleep(100);
          continue;
        }
        if (Date.now() < this._backoffUntil) {
          await sleep(200);
          continue;
        }
        const now = Date.now();
        if (now - this._intervalResetAt >= this.intervalMs) {
          this._intervalResetAt = now;
          this._intervalCount = 0;
        }
        if (this._intervalCount >= this.intervalCap) {
          await sleep(50);
          continue;
        }
        if (this._active >= this.concurrency) {
          await sleep(50);
          continue;
        }
        const item = this._queue.shift();
        if (!item) {
          if (this._active === 0) return;
          await sleep(50);
          continue;
        }
        this._active++;
        this._intervalCount++;
        this._run(item).finally(() => {
          this._active--;
        });
      }
    }
    async _run(item) {
      const url = item.url;
      let result;
      let timeoutTimer;
      for (let attempt = 0; attempt <= this.retry; attempt++) {
        const ctrl = new AbortController();
        try {
          const bytes = await Promise.race([
            this.fetchHeader(url, ctrl.signal),
            new Promise((_, reject) => {
              timeoutTimer = setTimeout(() => {
                ctrl.abort();
                const err = new Error("timeout");
                err.timeout = true;
                reject(err);
              }, this.itemTimeout);
            })
          ]);
          clearTimeout(timeoutTimer);
          if (bytes == null) {
            result = { url, status: "no-metadata", kind: null, meta: {}, bytes: 0 };
            break;
          }
          const meta = await this.analyze(url, bytes);
          result = {
            url,
            status: meta && meta.isAI ? "ai" : "no-metadata",
            kind: meta?.kind ?? null,
            meta: meta ?? {},
            bytes
          };
          break;
        } catch (e) {
          clearTimeout(timeoutTimer);
          if (e?.timeout) {
            result = { url, status: "error", kind: null, meta: {}, bytes: 0, error: "timeout" };
            break;
          }
          if (e?.name === "AbortError" || this._aborted) {
            result = { url, status: "skip", kind: null, meta: {}, bytes: 0 };
            break;
          }
          if (e?.status === 429) {
            this._backoffUntil = Date.now() + this.backoffMs;
            result = { url, status: "error", kind: null, meta: {}, bytes: 0, error: "rate-limited" };
            break;
          }
          if (attempt === this.retry) {
            result = { url, status: "error", kind: null, meta: {}, bytes: 0, error: String(e?.message || e) };
            break;
          }
          await sleep(300);
        }
      }
      this.cache.set(url, result);
      if (this.onResult) this.onResult(item, result);
      if (this.onProgress) {
        const done = [...this.cache.values()].filter((r) => r.status !== "skip" && r.status !== "error").length;
        this.onProgress({ done, total: this.cache.size + this.queueLength + this._active, aiCount: [...this.cache.values()].filter((r) => r.status === "ai").length });
      }
    }
  };
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // src/transport.js
  var DEFAULT_HEADER_BYTES2 = 256 * 1024;
  var REFERER = "https://www.pixiv.net/";
  function createGmFetchHeader(opts = {}) {
    const headerBytes = opts.headerBytes ?? DEFAULT_HEADER_BYTES2;
    const gmxhr = opts.gmxhr || globalThis.GM_xmlhttpRequest;
    return function fetchHeader2(url, signal) {
      return new Promise((resolve, reject) => {
        const req = gmxhr({
          url,
          method: "GET",
          responseType: "arraybuffer",
          timeout: 2e4,
          headers: {
            Referer: REFERER,
            Range: `bytes=0-${headerBytes - 1}`
          },
          onload(res) {
            if (res.status === 200 || res.status === 206) {
              if (res.response && res.response.byteLength > 0) {
                resolve(new Uint8Array(res.response));
              } else {
                resolve(null);
              }
            } else if (res.status === 404 || res.status === 403) {
              resolve(null);
            } else if (res.status === 429) {
              const e = new Error("rate limited");
              e.status = 429;
              reject(e);
            } else {
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror(err) {
            reject(new Error(String(err?.error || "network error")));
          },
          ontimeout() {
            reject(new Error("timeout"));
          }
        });
        if (signal) {
          signal.addEventListener("abort", () => {
            try {
              req.abort();
            } catch (e) {
            }
          });
        }
      });
    };
  }

  // src/ui.js
  var KIND_LABEL = { comfyui: "ComfyUI", sd: "SD", novelai: "NovelAI" };
  var PAGE_STYLE_ID = "pams-page-style";
  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  var ScannerUI = class {
    constructor() {
      this.overlays = /* @__PURE__ */ new Map();
      this._items = /* @__PURE__ */ new Map();
      this._results = /* @__PURE__ */ new Map();
      this._imgToUrl = /* @__PURE__ */ new Map();
      this._scanRunning = false;
    }
    mount() {
      this._injectPageStyle();
      this._host = document.createElement("div");
      this._host.id = "pams-root";
      this._host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
      this._shadow = this._host.attachShadow({ mode: "open" });
      this._shadow.innerHTML = this._shellHtml();
      document.body.appendChild(this._host);
      this._ctrlBtn = this._shadow.getElementById("pams-ctrl");
      this._listBtn = this._shadow.getElementById("pams-list");
      this._retryBtn = this._shadow.getElementById("pams-retry");
      this._bar = this._shadow.getElementById("pams-bar");
      this._barFill = this._shadow.getElementById("pams-bar-fill");
      this._barText = this._shadow.getElementById("pams-bar-text");
      this._panel = this._shadow.getElementById("pams-panel");
      this._panelHead = this._shadow.getElementById("pams-panel-head");
      this._panelTitle = this._shadow.getElementById("pams-panel-title");
      this._resize = this._shadow.getElementById("pams-resize");
      this._collapseAllBtn = this._shadow.getElementById("pams-collapse-all");
      this._ctrlBtn.addEventListener("click", () => this._onControl());
      this._listBtn.addEventListener("click", () => this.showAIList());
      this._retryBtn.addEventListener("click", () => this._onRetry());
      this._enableDrag();
      this._enableResize();
      this._collapseAllBtn.addEventListener("click", () => this._toggleAllSections());
      this._bindHover();
    }
    /** 拖标题栏移动面板 */
    _enableDrag() {
      this._panelHead.addEventListener("mousedown", (e) => {
        if (e.target.closest && e.target.closest("button")) return;
        e.preventDefault();
        const panel = this._panel;
        const rect = panel.getBoundingClientRect();
        const offX = e.clientX - rect.left;
        const offY = e.clientY - rect.top;
        const move = (ev) => {
          const left = Math.max(0, Math.min(ev.clientX - offX, window.innerWidth - 60));
          const top = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - 40));
          panel.style.left = left + "px";
          panel.style.top = top + "px";
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }
    /** 拖右下角调整面板大小 */
    _enableResize() {
      this._resize.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const panel = this._panel;
        const startW = panel.offsetWidth;
        const startH = panel.offsetHeight;
        const startX = e.clientX;
        const startY = e.clientY;
        const move = (ev) => {
          const w = Math.min(Math.max(320, startW + (ev.clientX - startX)), window.innerWidth - 24);
          const h = Math.min(Math.max(220, startH + (ev.clientY - startY)), window.innerHeight - 40);
          panel.style.width = w + "px";
          panel.style.height = h + "px";
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }
    /** 全部折叠 / 展开 */
    _toggleAllSections() {
      const sections = this._shadow.querySelectorAll(".pams-sec");
      if (!sections.length) return;
      const anyOpen = [...sections].some((s) => s.getAttribute("data-open") === "true");
      sections.forEach((s) => s.setAttribute("data-open", String(!anyOpen)));
      this._collapseAllBtn.textContent = anyOpen ? "\u25B8" : "\u25BE";
    }
    _shellHtml() {
      return `
      <style>
        :host { font-family: system-ui, sans-serif; }
        #pams-ctrl { position: fixed; top: 60px; right: 12px; z-index: 2147483646;
          padding: 8px 12px; border: none; border-radius: 8px; cursor: pointer;
          background: #00aef1; color: #fff; font-weight: 700; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
        #pams-ctrl[data-running="true"] { background: #e67e22; }
        #pams-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483645;
          display: none; background: rgba(20,20,20,.85); color: #fff; padding: 6px 12px;
          font-size: 13px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
        #pams-bar-track { height: 6px; background: #333; border-radius: 3px; margin-top: 6px; overflow: hidden; }
        #pams-bar-fill { height: 100%; width: 0; background: #92ff66; transition: width .2s; }
        #pams-panel { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646;
          width: 540px; height: 62vh; min-width: 320px; min-height: 220px;
          display: none; flex-direction: column; overflow: hidden; background: #222; color: #eee;
          border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.5); font-size: 12px; }
        #pams-panel-head { cursor: move; user-select: none; display: flex; align-items: center; gap: 6px;
          padding: 6px 10px; background: #2c2c2c; border-radius: 8px 8px 0 0; font-weight: 700; }
        #pams-panel-head .spacer { flex: 1; }
        #pams-panel-head button { background: none; border: none; color: #aaa; cursor: pointer; font-size: 14px; padding: 0 4px; }
        #pams-panel-head button:hover { color: #fff; }
        #pams-panel-body { flex: 1; overflow: auto; padding: 8px 10px; }
        #pams-resize { position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px;
          cursor: nwse-resize; z-index: 2; opacity: .6; }
        #pams-resize::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 8px; height: 8px;
          border-right: 2px solid #888; border-bottom: 2px solid #888; border-radius: 1px; }
        #pams-panel h3 { margin: 4px 0 8px; color: #92ff66; }
        #pams-panel pre { white-space: pre-wrap; word-break: break-word; background: #111; padding: 6px; border-radius: 4px; margin: 0; }
        #pams-panel .btn { margin: 4px 4px 4px 0; padding: 4px 8px; border: none; border-radius: 4px;
          background: #00aef1; color: #fff; cursor: pointer; }
        .pams-sec { border: 1px solid #383838; border-radius: 4px; margin-bottom: 6px; }
        .pams-sec-head { display: flex; justify-content: space-between; align-items: center; cursor: pointer;
          padding: 4px 8px; background: #2c2c2c; font-weight: 700; }
        .pams-sec-head .arrow { color: #888; }
        .pams-sec[data-open="false"] .pams-sec-body { display: none; }
        .pams-sec-body { padding: 6px; }
        .pams-ai-list { max-height: 40vh; overflow: auto; }
        .pams-ai-row { display: flex; gap: 6px; align-items: baseline; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
        .pams-ai-row:hover { background: #333; }
        .pams-kind { background: #00aef1; color: #fff; border-radius: 4px; padding: 0 4px; font-size: 11px; flex: none; }
        .dim { color: #888; }
      </style>
      <button id="pams-ctrl" title="\u6279\u91CF\u626B\u63CF AI \u5143\u6570\u636E">AI \u626B\u63CF</button>
      <button id="pams-list" title="\u5217\u51FA\u5DF2\u8BC6\u522B\u7684 AI \u56FE" style="display:none">AI \u5217\u8868</button>
      <button id="pams-retry" title="\u91CD\u8BD5\u626B\u63CF\u8D85\u65F6/\u51FA\u9519\u7684\u9879" style="display:none">\u91CD\u8BD5\u5931\u8D25</button>
      <div id="pams-bar">
        <span id="pams-bar-text">\u626B\u63CF 0/0</span>
        <div id="pams-bar-track"><div id="pams-bar-fill"></div></div>
      </div>
      <div id="pams-panel">
        <div id="pams-panel-head">
          <span id="pams-panel-title">\u5143\u4FE1\u606F</span>
          <span class="spacer"></span>
          <button id="pams-collapse-all" title="\u5168\u90E8\u6298\u53E0/\u5C55\u5F00">\u25BE</button>
          <button id="pams-close" title="\u5173\u95ED">\xD7</button>
        </div>
        <div id="pams-panel-body"></div>
        <div id="pams-resize" title="\u62D6\u62FD\u8C03\u6574\u5927\u5C0F"></div>
      </div>
    `;
    }
    _injectPageStyle() {
      if (document.getElementById(PAGE_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = PAGE_STYLE_ID;
      style.textContent = `
      .pams-ai { border: solid 4px #92ff66 !important; }
      .pams-scanning { outline: 2px dashed rgba(0,174,241,.6) !important; outline-offset: 1px; }
      .pams-chip { position: absolute !important; top: 4px !important; right: 4px !important;
        z-index: 99 !important; padding: 1px 5px !important; border-radius: 4px !important;
        font: bold 10px/1.6 system-ui, sans-serif !important; color: #fff !important;
        background: rgba(0,174,241,.85) !important; pointer-events: none !important; }
      .pams-chip[data-kind="comfyui"] { background: rgba(147,197,253,.9) !important; color:#0b1220!important; }
      .pams-chip[data-kind="sd"] { background: rgba(74,222,128,.9) !important; color:#03260f!important; }
      .pams-chip[data-kind="novelai"] { background: rgba(250,204,21,.9) !important; color:#332a00!important; }
      .pams-chip[data-state="ai"] { background: #92ff66; color:#0a2a00; }
      .pams-chip[data-state="none"] { background: rgba(120,120,120,.8); }
      .pams-chip[data-state="err"] { background: #e74c3c; }
    `;
      document.head.appendChild(style);
    }
    _bindHover() {
      document.addEventListener("mouseover", (e) => {
        let node = e.target && e.target.closest ? e.target.closest(".pams-ai") : null;
        if (!node && e.target && e.target.closest) node = e.target.closest("img");
        if (!node) return;
        let url = null;
        if (node.tagName !== "IMG" && node.querySelector) {
          const chip = node.querySelector(".pams-chip");
          if (chip) url = chip.getAttribute("data-url");
        }
        if (!url && node.tagName === "IMG") url = this._imgToUrl.get(node);
        if (!url) return;
        const item = this._items.get(url);
        const res = this._results.get(url);
        if (item && res) this._showPanel(item, res);
      });
      this._shadow.getElementById("pams-close").addEventListener("click", () => {
        this._panel.style.display = "none";
      });
    }
    // ---- 控制 ----
    setControlHandler(fn) {
      this._onControl = fn;
    }
    setRetryHandler(fn) {
      this._onRetry = fn;
    }
    setRetryCount(n) {
      if (n > 0) {
        this._retryBtn.style.display = "block";
        this._retryBtn.textContent = `\u91CD\u8BD5\u5931\u8D25 (${n})`;
      } else {
        this._retryBtn.style.display = "none";
      }
    }
    getItem(url) {
      return this._items.get(url);
    }
    setScanState(running) {
      this._scanRunning = running;
      this._ctrlBtn.setAttribute("data-running", String(running));
      this._ctrlBtn.textContent = running ? "\u626B\u63CF\u4E2D\u2026" : "AI \u626B\u63CF";
    }
    // ---- 进度条 ----
    setTotal(n) {
      this._total = n;
    }
    updateProgress({ done, total, aiCount }) {
      this._bar.style.display = "block";
      const pct = total > 0 ? Math.round(done / total * 100) : 0;
      this._barFill.style.width = pct + "%";
      this._barText.textContent = `\u626B\u63CF ${done}/${total} \xB7 AI \u56FE ${aiCount} \u5F20 \xB7 ${pct}%`;
    }
    hideBar() {
      this._bar.style.display = "none";
    }
    showSummary(text) {
      const bar = this._bar;
      bar.style.display = "block";
      this._barFill.style.width = "100%";
      this._barText.textContent = text;
      setTimeout(() => {
        bar.style.display = "none";
      }, 5e3);
    }
    setAIListCount(n) {
      this._listBtn.style.display = "block";
      this._listBtn.textContent = `AI \u5217\u8868 (${n})`;
    }
    showAIList() {
      const ai = [...this._results.entries()].filter(([, r]) => r.status === "ai");
      const body = this._shadow.getElementById("pams-panel-body");
      this._collapseAllBtn.textContent = "\u25BE";
      this._panelTitle.textContent = "AI \u5217\u8868";
      if (!ai.length) {
        body.innerHTML = `<div class="dim">\u6682\u65E0\u8BC6\u522B\u51FA\u7684 AI \u56FE</div>`;
        this._panel.style.display = "flex";
        return;
      }
      let html = `<h3>\u8BC6\u522B\u51FA ${ai.length} \u9879 AI \u5143\u6570\u636E</h3><div class="pams-ai-list">`;
      for (const [url, res] of ai) {
        const m = res.meta || {};
        const item = this._items.get(url);
        const label = item ? item.page ? `${item.id} (p${item.page})` : item.id : url;
        const snippet = (m.prompt || "").slice(0, 80);
        html += `<div class="pams-ai-row" data-url="${url}">
        <span class="pams-kind">${KIND_LABEL[m.kind] || m.kind}</span>
        <b>${label}</b>
        <span class="dim">${escapeHtml(snippet)}</span>
      </div>`;
      }
      html += `</div>`;
      body.innerHTML = html;
      body.querySelectorAll(".pams-ai-row").forEach((row) => {
        row.addEventListener("click", () => {
          const url = row.getAttribute("data-url");
          const item = this._items.get(url);
          const res = this._results.get(url);
          if (item && res) this._showPanel(item, res);
        });
      });
      this._panel.style.display = "flex";
    }
    /** 生成可折叠分区 HTML；text 已转义。 */
    _section(title, text, open = true) {
      return `<div class="pams-sec" data-open="${open}">
      <div class="pams-sec-head"><span>${title}</span><span class="arrow">${open ? "\u25BE" : "\u25B8"}</span></div>
      <div class="pams-sec-body"><pre>${escapeHtml(text)}</pre></div>
    </div>`;
    }
    // ---- 缩略图标记 ----
    registerItem(item) {
      this._items.set(item.url, item);
      if (item.img) this._imgToUrl.set(item.img, item.url);
    }
    /**
     * 重放已扫描结果到（重渲染后的）图片上。
     * 用于 pixiv 无限滚动/翻页导致的 DOM 重渲染。
     */
    reapply(url) {
      const item = this._items.get(url);
      const res = this._results.get(url);
      if (item && res) this.markResult(item, res);
    }
    markScanning(item) {
      if (item.a) item.a.classList.add("pams-scanning");
    }
    markResult(item, result) {
      this._results.set(item.url, result);
      if (item.a) item.a.classList.remove("pams-scanning");
      if (result.status === "ai") {
        if (item.a) item.a.classList.add("pams-ai");
        if (item.img) item.img.classList.add("pams-ai");
      }
      this._ensureChip(item, result);
    }
    _ensureChip(item, result) {
      const container = item.a || item.img && item.img.parentElement || null;
      if (!container) return;
      let chip = this.overlays.get(item.url);
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "pams-chip";
        chip.setAttribute("data-url", item.url);
        container.style.position = container.style.position || "relative";
        container.appendChild(chip);
        this.overlays.set(item.url, chip);
      }
      const state = result.status === "ai" ? "ai" : result.status === "error" ? "err" : "none";
      chip.setAttribute("data-state", state);
      if (result.status === "ai") {
        chip.setAttribute("data-kind", result.kind || "");
        chip.textContent = KIND_LABEL[result.kind] || "AI";
      } else if (result.status === "error") {
        chip.textContent = "!";
      } else {
        chip.textContent = "\xB7";
      }
    }
    // ---- 详情面板 ----
    _showPanel(item, result) {
      const body = this._shadow.getElementById("pams-panel-body");
      this._collapseAllBtn.textContent = "\u25BE";
      if (result.status !== "ai" || !result.meta) {
        this._panelTitle.textContent = "\u5143\u4FE1\u606F";
        body.innerHTML = `<div class="dim">\u8BE5\u56FE\u65E0 AI \u5143\u6570\u636E${result.status === "error" ? "\uFF08\u626B\u63CF\u51FA\u9519\uFF09" : ""}</div>`;
        this._panel.style.display = "flex";
        return;
      }
      const m = result.meta;
      this._panelTitle.textContent = `${KIND_LABEL[m.kind] || m.kind} \xB7 ${item.id}`;
      let html = `<h3>${KIND_LABEL[m.kind] || m.kind} \xB7 <span class="dim">${item.id}</span></h3><div class="pams-sections">`;
      if (m.prompt) html += this._section("Prompt", m.prompt, true);
      if (m.negative) html += this._section("Negative", m.negative, false);
      if (m.params && Object.keys(m.params).length) html += this._section("\u53C2\u6570", JSON.stringify(m.params, null, 2), false);
      if (m.models && m.models.length) {
        html += this._section("\u6A21\u578B / LoRA", m.models.map((x) => `[${x.type}] ${x.name}${x.weight ? ` \xD7${x.weight}` : ""}`).join("\n"), false);
      }
      if (m.workflow) html += this._section("ComfyUI \u5DE5\u4F5C\u6D41", m.workflow, false);
      else if (m.promptJson) html += this._section("ComfyUI \u5DE5\u4F5C\u6D41\uFF08API prompt\uFF09", m.promptJson, false);
      html += "</div>";
      html += `<div style="margin-top:6px">
        <button class="btn" data-act="copy-meta">\u590D\u5236\u5143\u6570\u636E JSON</button>
        <button class="btn" data-act="dl-meta">\u4E0B\u8F7D\u5143\u6570\u636E JSON</button>`;
      if (m.workflow) {
        html += `<button class="btn" data-act="copy-wf">\u590D\u5236 workflow</button>
        <button class="btn" data-act="dl-wf">\u4E0B\u8F7D workflow</button>`;
      } else if (m.promptJson) {
        html += `<button class="btn" data-act="copy-pj">\u590D\u5236 prompt</button>
        <button class="btn" data-act="dl-pj">\u4E0B\u8F7D prompt</button>`;
      }
      html += "</div>";
      body.innerHTML = html;
      body.querySelectorAll(".pams-sec-head").forEach((h) => {
        h.addEventListener("click", () => {
          const sec = h.parentElement;
          const open = sec.getAttribute("data-open") === "true";
          sec.setAttribute("data-open", String(!open));
          h.querySelector(".arrow").textContent = open ? "\u25B8" : "\u25BE";
        });
      });
      body.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = btn.getAttribute("data-act");
          if (act === "copy-wf") {
            navigator.clipboard.writeText(m.workflow).then(() => this._toast("workflow \u5DF2\u590D\u5236"));
          } else if (act === "dl-wf") {
            this._downloadJson(item, m.workflow, "workflow");
          } else if (act === "copy-pj") {
            navigator.clipboard.writeText(m.promptJson).then(() => this._toast("prompt \u5DF2\u590D\u5236"));
          } else if (act === "dl-pj") {
            this._downloadJson(item, m.promptJson, "prompt");
          } else if (act === "copy-meta") {
            navigator.clipboard.writeText(this._buildMetaJson(item, m)).then(() => this._toast("\u5143\u6570\u636E JSON \u5DF2\u590D\u5236"));
          } else if (act === "dl-meta") {
            this._downloadJson(item, this._buildMetaJson(item, m), "metadata");
          }
        });
      });
      this._panel.style.display = "block";
    }
    /** 生成统一的元数据 JSON（任意 AI 图可用） */
    _buildMetaJson(item, m) {
      return JSON.stringify({
        kind: m.kind,
        pixivId: item.id,
        page: item.page || 0,
        prompt: m.prompt,
        negative: m.negative,
        params: m.params,
        models: m.models,
        baseModel: m.baseModel
      }, null, 2);
    }
    /** 下载：优先弹"另存为"选择保存位置；不支持时回退普通下载。文件名用原图基底。 */
    _downloadJson(item, json, prefix) {
      let pretty = json;
      try {
        pretty = JSON.stringify(JSON.parse(json), null, 2);
      } catch (e) {
      }
      const name = `${item.fileBase || this._fallbackBase(item)}.json`;
      const type = "application/json";
      if (window.showSaveFilePicker) {
        window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
        }).then((handle) => handle.createWritable().then((w) => w.write(pretty).then(() => w.close()))).then(() => this._toast("\u5DF2\u4FDD\u5B58")).catch((err) => {
          if (err && err.name === "AbortError") return;
          this._fallbackDownload(name, pretty, type);
        });
        return;
      }
      this._fallbackDownload(name, pretty, type);
    }
    _fallbackBase(item) {
      return `${item.id}_p${item.page || 0}`;
    }
    _fallbackDownload(name, content, type) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    _toast(msg) {
      const t = document.createElement("div");
      t.textContent = msg;
      t.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 14px;border-radius:6px;z-index:2147483646;";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2e3);
    }
  };

  // src/main.js
  var ui = new ScannerUI();
  var scanner = null;
  var urlToItem = /* @__PURE__ */ new Map();
  var urlCache = /* @__PURE__ */ new Map();
  var gmFetchHeader = createGmFetchHeader();
  async function resolveUrlForId(id, thumbUrl, page = 0) {
    const cacheKey = `${id}:${page}`;
    if (urlCache.has(cacheKey)) return urlCache.get(cacheKey);
    if (page > 0) {
      const base = await resolveUrlForId(id, thumbUrl, 0);
      const derived = originalUrlForPage(base, page);
      urlCache.set(cacheKey, derived);
      return derived;
    }
    let orig = null;
    try {
      orig = await resolveOriginalUrlViaApi(id);
    } catch (e) {
    }
    if (!orig) orig = thumbnailToOriginalPngUrl(thumbUrl);
    urlCache.set(cacheKey, orig);
    if (!orig) console.warn("[pams] \u65E0\u6CD5\u89E3\u6790\u539F\u56FE URL", { id, thumbUrl });
    return orig;
  }
  async function fetchHeader(key, signal) {
    const parts = key.split(":");
    const id = parts[1];
    const page = Number(parts[2] || 0);
    const item = urlToItem.get(key);
    const orig = await resolveUrlForId(id, item ? item.thumbUrl : "", page);
    if (orig && item) {
      const base = orig.split("/").pop().replace(/\.\w+$/, "");
      item.fileBase = base;
    }
    if (!orig) return null;
    return gmFetchHeader(orig, signal);
  }
  async function analyze(url, bytes) {
    const { items } = await parsePngTextChunks(bytes);
    return analyzeMetadata(items);
  }
  function buildScanner() {
    if (scanner) return scanner;
    scanner = new Scanner({
      fetchHeader,
      analyze,
      concurrency: 4,
      intervalMs: 1e3,
      intervalCap: 4,
      retry: 2,
      backoffMs: 3e4,
      itemTimeout: 2e4,
      onProgress: (p) => {
        ui.updateProgress(p);
      },
      onResult: (item, result) => {
        ui.markResult(item, result);
        updateErrorCount();
      }
    });
    return scanner;
  }
  function updateErrorCount() {
    if (!scanner) return;
    let n = 0;
    for (const res of scanner.cache.values()) {
      if (res.status === "error") n++;
    }
    ui.setRetryCount(n);
  }
  function retryFailed() {
    if (scanner && scanner._running) return;
    const failed = [];
    for (const [url, res] of scanner.cache) {
      if (res.status === "error") {
        const item = ui.getItem(url);
        if (item) failed.push(item);
      }
    }
    if (!failed.length) {
      ui.showSummary("\u6CA1\u6709\u9700\u8981\u91CD\u8BD5\u7684\u9879");
      return;
    }
    console.log("[pams] \u91CD\u8BD5\u5931\u8D25\u9879:", failed.length);
    failed.forEach((it) => ui.markScanning(it));
    scanner.forceAdd(failed);
    if (!scanner._running) scanner.start().catch(() => {
    });
  }
  async function collectItems() {
    const related = collectArtworks(document).map((aw) => ({ ...aw, url: `illust:${aw.id}` }));
    const current = collectCurrentArtwork();
    if (!current) return related;
    const info = await getIllustInfo(current.id);
    const pageCount = info?.pageCount || 1;
    const currentPage = current.page;
    const pageImgs = findPageImages(document, current.id);
    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const isDisplayed = p === currentPage;
      const img = isDisplayed ? current.img : pageImgs.get(p) || null;
      const a = img ? img.closest("a") || img.parentElement : null;
      const src = img ? img.getAttribute("src") || img.getAttribute("data-src") || img.currentSrc || "" : "";
      pages.push({
        id: current.id,
        a,
        img,
        thumbUrl: src,
        url: `illust:${current.id}:${p}`,
        page: p
      });
    }
    console.log("[pams] \u8BE6\u60C5\u9875: id=", current.id, "pageCount=", pageCount, "currentPage=", currentPage, "\u9875\u7801\u7F29\u7565\u56FE\u547D\u4E2D=", pageImgs.size, "\u76F8\u5173\u4F5C\u54C1\u6570=", related.length);
    return [...pages, ...related];
  }
  function registerItems(items) {
    items.forEach((it) => {
      urlToItem.set(it.url, it);
      ui.registerItem(it);
      ui.markScanning(it);
    });
  }
  async function runScan() {
    if (scanner && scanner._running) return;
    const items = await collectItems();
    if (!items.length) {
      ui.showSummary("\u672A\u53D1\u73B0\u4F5C\u54C1");
      return;
    }
    console.log("[pams] \u626B\u63CF\u9879\u6570:", items.length, "\u793A\u4F8B:", items.slice(0, 5).map((i) => i.url));
    registerItems(items);
    ui.setScanState(true);
    ui.setTotal(items.length);
    ui.updateProgress({ done: 0, total: items.length, aiCount: 0 });
    const sc = buildScanner();
    sc.add(items);
    await sc.start();
    const aiCount = [...sc.cache.values()].filter((r) => r.status === "ai").length;
    ui.setScanState(false);
    ui.setAIListCount(aiCount);
    updateErrorCount();
    ui.showSummary(`\u626B\u63CF\u5B8C\u6210\uFF1A\u5171 ${items.length} \u5F20\uFF0C\u53D1\u73B0 ${aiCount} \u5F20\u542B AI \u5143\u6570\u636E`);
  }
  function init() {
    ui.mount();
    ui.setControlHandler(runScan);
    ui.setRetryHandler(retryFailed);
    setInterval(async () => {
      if (scanner && scanner._running) return;
      const items = await collectItems();
      for (const it of items) {
        if (!scanner || !scanner.cache.has(it.url)) continue;
        urlToItem.set(it.url, it);
        ui.registerItem(it);
        ui.reapply(it.url);
      }
    }, 3e3);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
