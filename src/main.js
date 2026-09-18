/**
 * 入口：串起 站点枚举 → URL 解析（API 权威） → 批量扫描 → UI 标记
 *
 * - 列表页（画师主页/搜索/收藏）：枚举所有作品卡，批量扫描
 * - 详情页（/artworks/{id}）：专门定位主图，扫描其原图并高亮
 *
 * URL 解析策略：pixiv API 权威为主，缩略图构造法兜底。
 */
import { parsePngTextChunks } from './png.js';
import { analyzeMetadata } from './metadata.js';
import {
  collectArtworks, collectCurrentArtwork, thumbnailToOriginalPngUrl,
  resolveOriginalUrlViaApi, originalUrlForPage, getIllustInfo, findPageImages,
} from './pixiv.js';
import { Scanner } from './scanner.js';
import { createGmFetchHeader } from './transport.js';
import { ScannerUI } from './ui.js';

const ui = new ScannerUI();
let scanner = null;

const urlToItem = new Map(); // url -> artwork item
const urlCache = new Map(); // "id:page" -> resolved original url | null
const gmFetchHeader = createGmFetchHeader();

/**
 * 解析某作品某页的权威原图 URL（带缓存）。
 * 页码 >0 从第 0 页 URL 派生（_p0 → _pN），避免重复调 API。
 */
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
    /* 走兜底 */
  }
  if (!orig) orig = thumbnailToOriginalPngUrl(thumbUrl); // 构造法兜底
  urlCache.set(cacheKey, orig);
  if (!orig) console.warn('[pams] 无法解析原图 URL', { id, thumbUrl });
  return orig;
}

/**
 * 扫描器用的 fetchHeader：key = "illust:{id}" 或 "illust:{id}:{page}"。
 * 内部先解析权威 URL，再抓 PNG 头部。
 */
async function fetchHeader(key, signal) {
  const parts = key.split(':');
  const id = parts[1];
  const page = Number(parts[2] || 0);
  const item = urlToItem.get(key);
  const orig = await resolveUrlForId(id, item ? item.thumbUrl : '', page);
  if (orig && item) {
    // 记录原图文件名基底（如 147425026_p0），供导出 JSON 用同名文件
    const base = orig.split('/').pop().replace(/\.\w+$/, '');
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
    intervalMs: 1000,
    intervalCap: 4,
    retry: 2,
    backoffMs: 30000,
    itemTimeout: 20000,
    onProgress: (p) => { ui.updateProgress(p); },
    onResult: (item, result) => { ui.markResult(item, result); updateErrorCount(); },
  });
  return scanner;
}

/**
 * 更新"重试失败"按钮计数（超时/出错项）。
 */
function updateErrorCount() {
  if (!scanner) return;
  let n = 0;
  for (const res of scanner.cache.values()) {
    if (res.status === 'error') n++;
  }
  ui.setRetryCount(n);
}

/**
 * 重新扫描超时/出错的项。
 */
function retryFailed() {
  if (scanner && scanner._running) return;
  const failed = [];
  for (const [url, res] of scanner.cache) {
    if (res.status === 'error') {
      const item = ui.getItem(url);
      if (item) failed.push(item);
    }
  }
  if (!failed.length) {
    ui.showSummary('没有需要重试的项');
    return;
  }
  console.log('[pams] 重试失败项:', failed.length);
  failed.forEach((it) => ui.markScanning(it));
  scanner.forceAdd(failed);
  if (!scanner._running) scanner.start().catch(() => {});
}

/**
 * 收集当前页应扫描的作品项（async，因为详情页需要 API 拿页数）。
 * - 列表页：所有作品卡
 * - 详情页：当前作品的所有页 + 相关作品的所有缩略图
 * 每项以 url（illust:{id} 或 illust:{id}:{page}）为唯一键。
 * @returns {Promise<Array<{id,a,img,thumbUrl,url,page}>>}
 */
async function collectItems() {
  // 相关作品 / 作品卡（列表页与详情页都适用）
  const related = collectArtworks(document).map((aw) => ({ ...aw, url: `illust:${aw.id}` }));

  const current = collectCurrentArtwork();
  if (!current) return related;

  // 详情页：当前作品的所有页
  const info = await getIllustInfo(current.id);
  const pageCount = info?.pageCount || 1;
  const currentPage = current.page;
  // 漫画查看器的页码缩略图（每页一个 img），让每一页都能独立高亮
  const pageImgs = findPageImages(document, current.id);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const isDisplayed = p === currentPage;
    const img = isDisplayed ? current.img : (pageImgs.get(p) || null);
    const a = img ? (img.closest('a') || img.parentElement) : null;
    const src = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '') : '';
    pages.push({
      id: current.id,
      a,
      img,
      thumbUrl: src,
      url: `illust:${current.id}:${p}`,
      page: p,
    });
  }
  console.log('[pams] 详情页: id=', current.id, 'pageCount=', pageCount, 'currentPage=', currentPage, '页码缩略图命中=', pageImgs.size, '相关作品数=', related.length);
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
    ui.showSummary('未发现作品');
    return;
  }

  console.log('[pams] 扫描项数:', items.length, '示例:', items.slice(0, 5).map((i) => i.url));
  registerItems(items);

  ui.setScanState(true);
  ui.setTotal(items.length);
  ui.updateProgress({ done: 0, total: items.length, aiCount: 0 });

  const sc = buildScanner();
  sc.add(items);
  await sc.start();

  const aiCount = [...sc.cache.values()].filter((r) => r.status === 'ai').length;
  ui.setScanState(false);
  ui.setAIListCount(aiCount);
  updateErrorCount();
  ui.showSummary(`扫描完成：共 ${items.length} 张，发现 ${aiCount} 张含 AI 元数据`);
}

function init() {
  ui.mount();
  ui.setControlHandler(runScan);
  ui.setRetryHandler(retryFailed);
  // 不自动扫描：由用户点击「AI 扫描」手动触发，避免进页面即全量程序化访问
  // 定时器只重放已扫描项的标记（应对无限滚动与 SPA 重渲染），不发起新扫描
  setInterval(async () => {
    if (scanner && scanner._running) return;
    const items = await collectItems();
    for (const it of items) {
      if (!scanner || !scanner.cache.has(it.url)) continue;
      urlToItem.set(it.url, it);
      ui.registerItem(it); // 更新 img 引用
      ui.reapply(it.url);
    }
  }, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
