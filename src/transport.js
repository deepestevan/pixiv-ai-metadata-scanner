/**
 * 传输层（油猴环境）
 * 用 GM_xmlhttpRequest 抓 i.pximg.net 原图头部：
 * - 设置 referer 防盗链
 * - 带 Range 只取 PNG 头部（前 N 字节）
 * 返回 Uint8Array；失败/无内容返回 null。
 */

const DEFAULT_HEADER_BYTES = 256 * 1024;
const REFERER = 'https://www.pixiv.net/';

/**
 * 创建 fetchHeader（GM_xmlhttpRequest 版）。
 * @param {Object} [opts]
 * @param {number} [opts.headerBytes]
 * @param {Function} [opts.gmxhr] 默认取全局 GM_xmlhttpRequest
 * @returns {(url:string, signal:AbortSignal)=>Promise<Uint8Array|null>}
 */
export function createGmFetchHeader(opts = {}) {
  const headerBytes = opts.headerBytes ?? DEFAULT_HEADER_BYTES;
  const gmxhr = opts.gmxhr || globalThis.GM_xmlhttpRequest;

  return function fetchHeader(url, signal) {
    return new Promise((resolve, reject) => {
      const req = gmxhr({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: {
          Referer: REFERER,
          Range: `bytes=0-${headerBytes - 1}`,
        },
        onload(res) {
          if (res.status === 200 || res.status === 206) {
            if (res.response && res.response.byteLength > 0) {
              resolve(new Uint8Array(res.response));
            } else {
              resolve(null);
            }
          } else if (res.status === 404 || res.status === 403) {
            // 无原图或不可访问 → 视为无元数据
            resolve(null);
          } else if (res.status === 429) {
            const e = new Error('rate limited');
            e.status = 429;
            reject(e);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror(err) {
          reject(new Error(String(err?.error || 'network error')));
        },
        ontimeout() {
          reject(new Error('timeout'));
        },
      });
      if (signal) {
        signal.addEventListener('abort', () => {
          try { req.abort(); } catch (e) { /* noop */ }
        });
      }
    });
  };
}
