/**
 * pixiv URL 换算纯函数测试。
 * 运行：node test/pixiv.test.js
 */
import { extractArtworkIdFromThumb, thumbnailToOriginalPngUrl, extractPageFromImage, originalUrlForPage, findPageImages, findMainImage } from '../src/pixiv.js';

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

// 1. master1200 缩略图
{
  const thumb = 'https://i.pximg.net/c/540x540_70/img-master/img/2024/08/01/10/20/30/12345678_p0_master1200.jpg';
  const info = extractArtworkIdFromThumb(thumb);
  assert(info && info.id === '12345678' && info.page === 0, 'master1200: 提取 id/page', info);
  const orig = thumbnailToOriginalPngUrl(thumb);
  assert(orig === 'https://i.pximg.net/img-original/img/2024/08/01/10/20/30/12345678_p0.png', 'master1200: 换算原图', orig);
}

// 2. square 缩略图
{
  const thumb = 'https://i.pximg.net/c/360x360_70/img-master/img/2024/01/02/03/04/05/99999_p1_square1200.jpg';
  const info = extractArtworkIdFromThumb(thumb);
  assert(info && info.id === '99999' && info.page === 1, 'square: 提取 id/page', info);
  const orig = thumbnailToOriginalPngUrl(thumb);
  assert(orig === 'https://i.pximg.net/img-original/img/2024/01/02/03/04/05/99999_p1.png', 'square: 换算原图', orig);
}

// 3. 多页：p2
{
  const thumb = 'https://i.pximg.net/c/540x540_70/img-master/img/2024/08/01/10/20/30/12345678_p2_master1200.jpg';
  const orig = thumbnailToOriginalPngUrl(thumb);
  assert(orig === 'https://i.pximg.net/img-original/img/2024/08/01/10/20/30/12345678_p2.png', '多页 p2: 换算', orig);
}

// 4. 非 pixiv / 非法
{
  assert(thumbnailToOriginalPngUrl('https://example.com/x.jpg') === null, '非法: 返回 null');
  assert(extractArtworkIdFromThumb('') === null, '空: 返回 null');
  assert(extractArtworkIdFromThumb('https://i.pximg.net/c/540x540_70/img-master/img/2024/08/01/10/20/30/abc_p0_master1200.jpg') === null, '非数字 id: null');
}

// 5. 页码提取 + 原图页码替换
{
  assert(extractPageFromImage('https://i.pximg.net/c/540x540_70/img-master/img/2024/08/01/10/20/30/12345678_p2_master1200.jpg') === 2, '页码: p2 → 2');
  assert(extractPageFromImage('https://i.pximg.net/img-original/img/x/123_p0.png') === 0, '页码: p0 → 0');
  const orig = 'https://i.pximg.net/img-original/img/2024/08/01/10/20/30/12345678_p0.png';
  assert(originalUrlForPage(orig, 3) === 'https://i.pximg.net/img-original/img/2024/08/01/10/20/30/12345678_p3.png', '原图页码替换: p0→p3');
  assert(originalUrlForPage(orig, 0) === orig, '原图页码替换: 0 不改');
}

// 6. hash 格式 URL（{id}-{hash}_p{page}）
{
  const url = 'https://i.pximg.net/img-master/img/2026/07/23/22/23/01/147548951-c9f326ad6bd8baebc9b494070fa30a7c_p18_master1200.jpg';
  assert(extractPageFromImage(url) === 18, 'hash格式: 页码 18');
  assert(thumbnailToOriginalPngUrl(url) === 'https://i.pximg.net/img-original/img/2026/07/23/22/23/01/147548951-c9f326ad6bd8baebc9b494070fa30a7c_p18.png', 'hash格式: 换算原图');
}

// 7. findPageImages 兼容 hash 格式
{
  const fakeImg = (src) => ({ getAttribute: (a) => (a === 'src' ? src : null), currentSrc: '' });
  const root = { querySelectorAll: () => [
    fakeImg('https://i.pximg.net/img-master/img/x/147548951-c9f326ad6bd8baebc9b494070fa30a7c_p0_master1200.jpg'),
    fakeImg('https://i.pximg.net/img-master/img/x/147548951-c9f326ad6bd8baebc9b494070fa30a7c_p1_master1200.jpg'),
  ] };
  const map = findPageImages(root, '147548951');
  assert(map.size === 2 && map.get(0) && map.get(1), 'findPageImages: hash格式命中 2 页', map.size);
}

// 8. findMainImage 命中 hash 主图而非 logo
{
  const fakeImg = (src) => ({ getAttribute: (a) => (a === 'src' ? src : null), currentSrc: '', naturalWidth: 0, width: 100 });
  const root = { querySelectorAll: () => [
    fakeImg('https://s.pximg.net/soy/pixiv-web-next//_static/newLogo2025.svg'),
    fakeImg('https://i.pximg.net/img-master/img/x/147548951-c9f326ad6bd8baebc9b494070fa30a7c_p18_master1200.jpg'),
  ] };
  const img = findMainImage(root, '147548951');
  assert(img && img.getAttribute('src').includes('147548951'), 'findMainImage: 命中 hash 主图而非 logo', img && img.getAttribute('src'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
