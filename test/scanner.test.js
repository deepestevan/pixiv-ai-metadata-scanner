/**
 * 扫描引擎测试（mock fetchHeader，验证并发/限流/429 退避/缓存/重试）。
 * 运行：node test/scanner.test.js
 */
import { Scanner } from '../src/scanner.js';

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mock analyze：url 里含 "ai" 视为 AI 图
function analyze(url) {
  return { isAI: url.includes('ai'), kind: url.includes('comfy') ? 'comfyui' : 'sd', prompt: 'x' };
}

// 1. 基础扫描 + 缓存
{
  const fetches = [];
  const sc = new Scanner({
    fetchHeader: async (url) => { fetches.push(url); return new Uint8Array([1]); },
    analyze: (url) => analyze(url),
    concurrency: 4, intervalMs: 100, intervalCap: 4,
  });
  sc.add([{ url: 'a.png' }, { url: 'ai.png' }, { url: 'ai.png' }]); // 重复应去重
  await sc.start();
  assert(fetches.length === 2, '基础: 去重后只抓 2 个', fetches);
  assert(sc.cache.get('a.png').status === 'no-metadata', '基础: 无元数据');
  assert(sc.cache.get('ai.png').status === 'ai' && sc.cache.get('ai.png').kind === 'sd', '基础: AI 识别');
}

// 2. 并发上限：最多同时 concurrency 个在飞
{
  let inflight = 0, maxInflight = 0, started = 0;
  const sc = new Scanner({
    fetchHeader: async () => { inflight++; maxInflight = Math.max(maxInflight, inflight); await sleep(30); inflight--; started++; return new Uint8Array([1]); },
    analyze,
    concurrency: 2, intervalMs: 50, intervalCap: 100,
  });
  sc.add(Array.from({ length: 8 }, (_, i) => ({ url: `img${i}.png` })));
  await sc.start();
  assert(maxInflight <= 2, `并发: 峰值 ${maxInflight} <= 2`);
  assert(started === 8, '并发: 全部完成');
}

// 3. 速率限制：intervalCap 窗口内不超过 cap
{
  const times = [];
  const sc = new Scanner({
    fetchHeader: async () => { times.push(Date.now()); return new Uint8Array([1]); },
    analyze,
    concurrency: 100, intervalMs: 50, intervalCap: 3,
  });
  sc.add(Array.from({ length: 6 }, (_, i) => ({ url: `r${i}.png` })));
  await sc.start();
  // 前 3 个应在 50ms 窗口内，第 4 个应晚于 50ms
  const ok = times[3] - times[0] >= 45;
  assert(ok, '限流: 第 4 个延迟到下一窗口', times[0], times[3]);
}

// 4. 429 触发退避：之后请求暂停，且该条进 error
{
  let calls = 0, lastTwo;
  const sc = new Scanner({
    fetchHeader: async () => { calls++; lastTwo = [lastTwo?.[1], Date.now()]; if (calls === 1) { const e = new Error('429'); e.status = 429; throw e; } return new Uint8Array([1]); },
    analyze,
    concurrency: 1, intervalMs: 50, intervalCap: 100, backoffMs: 200,
  });
  sc.add([{ url: 'x.png' }, { url: 'y.png' }]);
  const t0 = Date.now();
  await sc.start();
  const elapsed = Date.now() - t0;
  assert(sc.cache.get('x.png').status === 'error' && sc.cache.get('x.png').error === 'rate-limited', '429: 该条进 error');
  assert(elapsed >= 200, `429: 触发退避（耗时 ${elapsed}ms >= 200ms）`);
}

// 5. 重试：前两次失败第三次成功
{
  let tries = 0;
  const sc = new Scanner({
    fetchHeader: async () => { tries++; if (tries < 3) throw new Error('network'); return new Uint8Array([1]); },
    analyze, retry: 3,
    concurrency: 1, intervalMs: 10, intervalCap: 100,
  });
  sc.add([{ url: 'retry.png' }]);
  await sc.start();
  assert(tries === 3, `重试: 共试 3 次成功`, tries);
  assert(sc.cache.get('retry.png').status === 'no-metadata', '重试: 成功状态');
}

// 6. 进度回调
{
  let progresses = 0;
  const sc = new Scanner({
    fetchHeader: async () => { await sleep(10); return new Uint8Array([1]); },
    analyze,
    concurrency: 2, intervalMs: 10, intervalCap: 100,
    onProgress: () => { progresses++; },
  });
  sc.add([{ url: 'ai.png' }, { url: 'b.png' }, { url: 'c.png' }]);
  await sc.start();
  assert(progresses >= 3, `进度: 回调 ${progresses} 次 >= 3`);
}

// 7. forceAdd：可重扫已缓存/已排队的 url（API 兜底场景）
{
  const fetches = [];
  const sc = new Scanner({
    fetchHeader: async (url) => { fetches.push(url); return new Uint8Array([1]); },
    analyze,
    concurrency: 4, intervalMs: 10, intervalCap: 100,
  });
  sc.add([{ url: 'z.png' }]);
  await sc.start();
  assert(fetches.length === 1, 'forceAdd: 初次扫描 1 次', fetches);
  assert(sc.cache.has('z.png'), 'forceAdd: 已缓存');
  // 普通 add 会因缓存去重
  sc.add([{ url: 'z.png' }]);
  // forceAdd 忽略缓存，重新入队
  sc.forceAdd([{ url: 'z.png' }]);
  await sc.start();
  assert(fetches.length === 2, 'forceAdd: forceAdd 后重扫一次', fetches);
}

// 8. 硬超时：fetchHeader 永不 settle 也能跑完（不卡死）
{
  const t0 = Date.now();
  const sc = new Scanner({
    fetchHeader: () => new Promise(() => {}), // 永不 resolve/reject
    analyze, concurrency: 1, intervalMs: 10, intervalCap: 100, itemTimeout: 80,
  });
  sc.add([{ url: 'hang.png' }, { url: 'hang2.png' }]);
  await sc.start();
  const elapsed = Date.now() - t0;
  assert(sc.cache.get('hang.png').status === 'error' && sc.cache.get('hang.png').error === 'timeout', '超时: 标记为 timeout');
  assert(sc.cache.get('hang2.png').status === 'error', '超时: 第二项也完成');
  assert(elapsed < 3000, `超时: ${elapsed}ms 内完成（不卡死）`);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
