/**
 * PNG 文本块解析器
 * 从 PNG 字节中提取所有文本块（tEXt / iTXt / zTXt）的内容。
 * AI 工具把元数据写在这些块里：
 *   - Stable Diffusion (A1111/Forge)  → tEXt 块的 keyword="parameters"
 *   - NovelAI                        → tEXt 块的 keyword="Comment"
 *   - ComfyUI                        → iTXt/tEXt 块的 keyword="prompt" 和 "workflow"（JSON）
 *
 * 本模块纯本地、无 DOM 依赖，可在浏览器与 Node 中复用。
 * 解压（zlib）通过注入的 decompress 函数完成，便于不同环境切换。
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * 从 ArrayBuffer/Uint8Array 解析 PNG 文本块。
 * @param {ArrayBuffer|Uint8Array} input PNG 字节
 * @param {{inflate:(Uint8Array)=>Promise<Uint8Array>}} [opts] 注入解压函数；缺省用 DecompressionStream
 * @returns {Promise<{ok:boolean, items:Array<{type:string,keyword:string,text:string}>}>}
 */
export async function parsePngTextChunks(input, opts = {}) {
  const inflate = opts.inflate || defaultInflate;
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const items = [];

  // PNG 签名校验
  if (u8.length < 8 || PNG_SIGNATURE.some((v, i) => u8[i] !== v)) {
    return { ok: false, items, error: 'invalid-png-signature' };
  }

  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  let off = 8;
  let sawIEND = false;

  while (off + 8 <= u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    // CRC 占 4 字节
    const next = dataEnd + 4;

    if (dataEnd > u8.length) break; // 越界，提前结束（头部已够用）

    const data = u8.subarray(dataStart, dataEnd);

    if (type === 'tEXt') {
      // keyword\0 text（latin-1）
      const sep = indexOfZero(data, 0);
      if (sep >= 0) {
        items.push({
          type,
          keyword: latin1.decode(data.subarray(0, sep)),
          text: latin1.decode(data.subarray(sep + 1)),
        });
      }
    } else if (type === 'iTXt') {
      // keyword\0 compFlag(1) compMethod(1) lang\0 translated\0 text
      const k0 = indexOfZero(data, 0);
      if (k0 < 0) { off = next; continue; }
      const keyword = latin1.decode(data.subarray(0, k0));
      let p = k0 + 1;
      const compFlag = data[p++];
      p++; // compMethod（忽略，zlib 是标准）
      const l0 = indexOfZero(data, p);
      if (l0 < 0) { off = next; continue; }
      p = l0 + 1;
      const t0 = indexOfZero(data, p);
      if (t0 < 0) { off = next; continue; }
      const translatedKeyword = utf8.decode(data.subarray(p, t0));
      p = t0 + 1;
      const textBytes = data.subarray(p);
      let text;
      if (compFlag === 1) {
        const raw = await inflate(textBytes).catch(() => null);
        text = raw ? utf8.decode(raw) : '';
      } else {
        text = utf8.decode(textBytes);
      }
      items.push({ type, keyword, text, translatedKeyword });
    } else if (type === 'zTXt') {
      // keyword\0 compMethod(1) compressed
      const sep = indexOfZero(data, 0);
      if (sep < 0) { off = next; continue; }
      const keyword = latin1.decode(data.subarray(0, sep));
      const compressed = data.subarray(sep + 2);
      const raw = await inflate(compressed).catch(() => null);
      const text = raw ? latin1.decode(raw) : '';
      items.push({ type, keyword, text });
    }

    off = next;
    if (type === 'IEND') { sawIEND = true; break; }
    // 若已超过合理头部范围（遇到了 IDAT 像素数据），文本块一般都在之前，可提前停
    if (type === 'IDAT') break;
  }

  return { ok: true, items, sawIEND };
}

function indexOfZero(data, from) {
  for (let i = from; i < data.length; i++) {
    if (data[i] === 0) return i;
  }
  return -1;
}

/**
 * 默认解压：浏览器 DecompressionStream（zlib/deflate），失败回退 deflate-raw。
 */
async function defaultInflate(u8) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DecompressionStream not available');
  }
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const blob = new Blob([u8]);
      const stream = new Response(blob.stream().pipeThrough(new DecompressionStream(fmt)));
      const ab = await stream.arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      /* 尝试下一种 */
    }
  }
  throw new Error('inflate failed');
}
