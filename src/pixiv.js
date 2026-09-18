/**
 * pixiv 站点适配
 * - 从缩略图 src 换算原图 PNG URL（纯函数，可单测）
 * - 链接法枚举页面作品 ID（借鉴 Pixiv Downloader 的"双闸门"设计）
 * - 可选 API 解析原图 URL 作为兜底
 *
 * pixiv 缩略图与原始图 URL 结构（参考实际格式）：
 *   缩略图: https://i.pximg.net/c/540x540_70/img-master/img/2024/08/01/10/20/30/12345678_p0_master1200.jpg
 *            https://i.pximg.net/c/360x360_70/img-master/img/2024/08/01/10/20/30/12345678_p0_square1200.jpg
 *   原始图: https://i.pximg.net/img-original/img/2024/08/01/10/20/30/12345678_p0.png
 *
 * 换算规则：去 /c/xxx/ 前缀 → img-master 改 img-original → 去 _master1200/_square1200 后缀 → 扩展名改 .png
 */

const ORIGINAL_EXT = '.png';

/**
 * 从缩略图 URL 提取作品 ID 与页码。
 * @param {string} src
 * @returns {{id:string, page:number}|null}
 */
export function extractArtworkIdFromThumb(src) {
  if (!src) return null;
  // 匹配 .../img-master/img/.../{id}_p{page}_...
  const m = src.match(/img-master\/img\/.*\/(\d+)_p(\d+)_/);
  if (!m) return null;
  return { id: m[1], page: Number(m[2]) };
}

/**
 * 缩略图 → 原始 PNG URL（构造法）。
 * @param {string} thumbUrl
 * @returns {string|null}
 */
export function thumbnailToOriginalPngUrl(thumbUrl) {
  if (!thumbUrl) return null;
  // 去掉 CDN 尺寸前缀 /c/xxxx_xx/
  const noCdn = thumbUrl.replace(/^https?:\/\/i\.pximg\.net\/c\/[^/]+\//, 'https://i.pximg.net/');
  if (!noCdn.includes('img-master/img/')) return null;
  const original = noCdn
    .replace('img-master/img/', 'img-original/img/')
    .replace(/_(master|square)\d+\.\w+$/, ORIGINAL_EXT);
  return original;
}

/**
 * 链接法枚举：判断一个 <a> 元素是否指向作品页并返回作品 ID。
 * 借鉴下载器"双闸门"：href 必须匹配作品页，且节点结构/类名通过白名单。
 * @param {HTMLElement} node
 * @param {{artworksRe:RegExp, activityRe:RegExp}} [patterns]
 * @returns {string} 作品 ID（无则空串）
 */
export function getIllustId(node, patterns = {}) {
  const artworksRe = patterns.artworksRe || /\/artworks\/(\d+)$/;
  const activityRe = patterns.activityRe || /illust_id=(\d+)/;

  const href = node.getAttribute && node.getAttribute('href') || '';
  const isArtworksLink = artworksRe.exec(href);

  if (isArtworksLink) {
    const hasGtm = node.getAttribute && node.getAttribute('data-gtm-value');
    const hasFigure = node.querySelector && !!node.querySelector(':scope > figure, :scope > img[src*="pximg.net/c/480x960"]');
    const inWhitelist = [
      'gtm-illust-recommend-node-node',
      'gtm-discover-user-recommend-node',
      'work',
      '_history-item',
      '_history-related-item',
    ].some((c) => node.classList && node.classList.contains(c));
    if (hasGtm || hasFigure || inWhitelist) {
      return isArtworksLink[1];
    }
    return '';
  }

  // 活动流
  const isActivityThumb = activityRe.exec(href);
  if (isActivityThumb && node.classList && node.classList.contains('work')) {
    return isActivityThumb[1];
  }

  return '';
}

/**
 * 扫描页面里所有作品，返回富信息项。
 * @param {Document|HTMLElement} root
 * @returns {Array<{id:string, a:HTMLElement, img:HTMLImageElement|null, thumbUrl:string|null}>}
 */
export function collectArtworks(root = document) {
  const seen = new Set();
  const items = [];
  for (const a of root.querySelectorAll('a')) {
    const id = getIllustId(a);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // 任意深度查找缩略图（pixiv 作品卡里 img 可能嵌套在多层 div/figure 内）
    let img = a.querySelector('img');
    if (!img && a.tagName === 'IMG') img = a;
    const thumbUrl = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '') : '';
    items.push({ id, a, img: img || null, thumbUrl });
  }
  return items;
}

// 兼容旧名
export const collectArtworkIds = (root = document) => collectArtworks(root).map((x) => x.id);

/**
 * 当前作品页 ID（/artworks/{id}），非作品页返回 null。
 */
export function getCurrentArtworkId() {
  const m = location.pathname.match(/\/artworks\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 从图片 URL 提取页码（_p0_ / _p2_ 等），无则 0。
 */
export function extractPageFromImage(src) {
  const m = src && src.match(/_p(\d+)_/);
  return m ? Number(m[1]) : 0;
}

/**
 * 把原图 URL 的页码替换为指定页（默认页 0 → _pN）。
 */
export function originalUrlForPage(origUrl, page) {
  if (!origUrl || page <= 0) return origUrl;
  return origUrl.replace(/_p0(?=\.\w+$)/, `_p${page}`);
}

/**
 * 判断图片 src 是否属于某作品。
 * pixiv 现支持两种格式：{id}_p{page} 或 {id}-{hash}_p{page}，以及单图 {id}.{ext}
 */
function isArtworkImageFor(src, id) {
  return (
    src.includes(`/${id}-`) ||   // {id}-{hash}_p{page}
    src.includes(`/${id}_p`) ||  // {id}_p{page}
    src.includes(`/${id}.`)      // {id}.{ext}
  );
}

/**
 * 定位详情页主图元素。
 * 优先：按当前作品 ID 精确匹配图片 URL（兼容 hash）；兜底：最大的 i.pximg.net 图片（排除 logo/svg）。
 * @param {Document|HTMLElement} root
 * @param {string} id 当前作品 ID（可空）
 * @returns {HTMLImageElement|null}
 */
export function findMainImage(root = document, id = '') {
  const imgs = [...root.querySelectorAll('img')];
  const srcOf = (img) => img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '';

  if (id) {
    for (const img of imgs) {
      if (isArtworkImageFor(srcOf(img), id)) return img;
    }
  }

  // 兜底：最大的 i.pximg.net 图片（img-master/img-original，排除 logo/svg）
  const px = imgs.filter((i) => {
    const s = srcOf(i);
    return /^https?:\/\/i\.pximg\.net\/(img-master|img-original)/.test(s) && !/\.svg(\?|$)/.test(s);
  });
  px.sort((a, b) => ((b.naturalWidth || b.width || 0) - (a.naturalWidth || a.width || 0)));
  return px[0] || null;
}

/**
 * 找到当前作品在 DOM 里所有页码缩略图（漫画查看器顶部的页码条）。
 * 返回 Map<page, img>。
 * @param {Document|HTMLElement} root
 * @param {string} id
 */
export function findPageImages(root = document, id = '') {
  const map = new Map();
  if (!id) return map;
  // 兼容 {id}_p{page} 与 {id}-{hash}_p{page}
  const re = new RegExp(`/${id}(?:-[a-z0-9]+)?_p(\\d+)_`, 'i');
  for (const img of root.querySelectorAll('img')) {
    const s = img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '';
    const m = s.match(re);
    if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), img);
  }
  return map;
}

/**
 * 详情页作品项：主图 + 对应页码。
 * @returns {{id:string, img:HTMLImageElement|null, a:HTMLElement|null, thumbUrl:string, page:number}|null}
 */
export function collectCurrentArtwork() {
  const id = getCurrentArtworkId();
  if (!id) return null;
  const img = findMainImage(document, id);
  const src = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '') : '';
  const page = img ? extractPageFromImage(src) : 0;
  const a = img ? (img.closest('a') || img.parentElement) : null;
  if (img) console.log('[pams] 详情页主图:', id, 'page', page, 'src', src.slice(0, 120));
  return { id, img, a, thumbUrl: src, page };
}

/**
 * 通过 pixiv API 解析原图 URL（兜底，比构造可靠，但要 +1 请求）。
 * GET /ajax/illust/{id} → body.urls.original
 * @param {string} id
 * @param {Function} [fetchImpl]
 * @returns {Promise<string|null>}
 */
/**
 * 带超时的 fetch（默认 15s），避免挂起请求堆积。
 */
async function fetchWithTimeout(url, opts = {}, ms = 15000, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveOriginalUrlViaApi(id, fetchImpl = fetch) {
  try {
    const res = await fetchWithTimeout(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, {
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    }, 15000, fetchImpl);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.body?.urls?.original || null;
  } catch (e) {
    return null;
  }
}

/**
 * 获取作品信息：原图 URL + 页数。
 * GET /ajax/illust/{id} → body.{ urls.original, pageCount }
 * @returns {Promise<{original:string|null, pageCount:number}|null>}
 */
export async function getIllustInfo(id, fetchImpl = fetch) {
  try {
    const res = await fetchWithTimeout(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, {
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    }, 15000, fetchImpl);
    if (!res.ok) return null;
    const json = await res.json();
    const b = json?.body;
    if (!b) return null;
    return { original: b.urls?.original || null, pageCount: b.pageCount || 1 };
  } catch (e) {
    return null;
  }
}
