/**
 * 批量扫描引擎
 * 对一批原图 URL，用注入的 fetchHeader 抓 PNG 头部，解析并分类 AI 元数据。
 * - 并发 + 速率限制（借鉴下载器 PQueue：intervalCap / 间隔）
 * - 429 自适应退避
 * - 结果缓存
 * - 进度回调
 *
 * 传输无关：不直接发 HTTP，靠注入的 fetchHeader(url, signal)。
 */

const DEFAULT_HEADER_BYTES = 256 * 1024; // 取 PNG 头部 256KB（足够覆盖文本块）

/**
 * @typedef {Object} ScanResult
 * @property {string} url
 * @property {string} status  'ai' | 'no-metadata' | 'error' | 'skip'
 * @property {string|null} kind  'comfyui'|'sd'|'novelai'|null
 * @property {Object} meta   analyzeMetadata 结果
 * @property {number} bytes  已取字节数
 */

export class Scanner {
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
    this.intervalMs = opts.intervalMs ?? 1000;
    this.intervalCap = opts.intervalCap ?? 4;
    this.retry = opts.retry ?? 2;
    this.backoffMs = opts.backoffMs ?? 30000;
    this.itemTimeout = opts.itemTimeout ?? 20000;
    this.onProgress = opts.onProgress;
    this.onResult = opts.onResult;

    this.cache = new Map(); // url -> ScanResult
    this._running = false;
    this._paused = false;
    this._aborted = false;
    this._queue = [];
    this._queued = new Set(); // 已排队/在飞/已缓存的 url，用于去重
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

  get queueLength() { return this._queue.length + this._active; }
  get cachedCount() { return this.cache.size; }

  pause() { this._paused = true; }
  resume() { this._paused = false; this._tick(); }
  cancel() {
    this._aborted = true;
    this._queue = [];
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._tick();
    // 等待队列清空
    while (this.queueLength > 0 && !this._aborted) {
      await sleep(100);
    }
    this._running = false;
  }

  async _tick() {
    while (true) {
      if (this._aborted) return;
      if (this._paused) { await sleep(100); continue; }
      // 429 退避窗口
      if (Date.now() < this._backoffUntil) { await sleep(200); continue; }
      // 速率限制窗口
      const now = Date.now();
      if (now - this._intervalResetAt >= this.intervalMs) {
        this._intervalResetAt = now;
        this._intervalCount = 0;
      }
      if (this._intervalCount >= this.intervalCap) { await sleep(50); continue; }
      if (this._active >= this.concurrency) { await sleep(50); continue; }

      const item = this._queue.shift();
      if (!item) {
        if (this._active === 0) return; // 全部完成
        await sleep(50);
        continue;
      }
      this._active++;
      this._intervalCount++;
      this._run(item).finally(() => { this._active--; });
    }
  }

  async _run(item) {
    const url = item.url;
    let result;
    let timeoutTimer;
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      const ctrl = new AbortController();
      try {
        // 硬超时：防止 GM_xmlhttpRequest / API fetch 挂起导致整个扫描卡死
        const bytes = await Promise.race([
          this.fetchHeader(url, ctrl.signal),
          new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => {
              ctrl.abort();
              const err = new Error('timeout');
              err.timeout = true;
              reject(err);
            }, this.itemTimeout);
          }),
        ]);
        clearTimeout(timeoutTimer);
        if (bytes == null) {
          result = { url, status: 'no-metadata', kind: null, meta: {}, bytes: 0 };
          break;
        }
        const meta = await this.analyze(url, bytes);
        result = {
          url,
          status: meta && meta.isAI ? 'ai' : 'no-metadata',
          kind: meta?.kind ?? null,
          meta: meta ?? {},
          bytes,
        };
        break;
      } catch (e) {
        clearTimeout(timeoutTimer);
        if (e?.timeout) {
          // 超时不重试，直接进错误，避免反复挂起
          result = { url, status: 'error', kind: null, meta: {}, bytes: 0, error: 'timeout' };
          break;
        }
        if (e?.name === 'AbortError' || this._aborted) {
          result = { url, status: 'skip', kind: null, meta: {}, bytes: 0 };
          break;
        }
        if (e?.status === 429) {
          // 触发全队列退避
          this._backoffUntil = Date.now() + this.backoffMs;
          // 429 不重试单条，直接进错误
          result = { url, status: 'error', kind: null, meta: {}, bytes: 0, error: 'rate-limited' };
          break;
        }
        if (attempt === this.retry) {
          result = { url, status: 'error', kind: null, meta: {}, bytes: 0, error: String(e?.message || e) };
          break;
        }
        await sleep(300); // 重试前小等
      }
    }

    this.cache.set(url, result);
    if (this.onResult) this.onResult(item, result);
    if (this.onProgress) {
      const done = [...this.cache.values()].filter((r) => r.status !== 'skip' && r.status !== 'error').length;
      this.onProgress({ done, total: this.cache.size + this.queueLength + this._active, aiCount: [...this.cache.values()].filter((r) => r.status === 'ai').length });
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
