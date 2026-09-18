/**
 * PNG 解析器 + 元数据分类器 单元测试（纯 Node，无依赖）。
 * 运行：node test/png.test.js
 * 构造真实的 PNG 字节（含 tEXt/iTXt/zTXt 块），验证提取与分类。
 */
import zlib from 'zlib';
import { parsePngTextChunks } from '../src/png.js';
import { analyzeMetadata } from '../src/metadata.js';

// ---- CRC32（PNG 用标准 CRC-32）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function makeIHDR(width = 1, height = 1) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // bit depth
  d[9] = 6; // color type RGBA
  d[10] = 0; // compression
  d[11] = 0; // filter
  d[12] = 0; // interlace
  return d;
}

function makeIDAT(width, height) {
  // 每行：filter byte(0) + RGBA 像素
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  const raw = Buffer.concat(Array(height).fill(row));
  return zlib.deflateSync(raw);
}

function makePng(chunks) {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', makeIHDR()),
    ...chunks,
    chunk('IDAT', makeIDAT(1, 1)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function tEXt(keyword, text) {
  return chunk('tEXt', Buffer.concat([Buffer.from(keyword), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}
function iTXt(keyword, text, compressed = false) {
  const head = Buffer.concat([
    Buffer.from(keyword), Buffer.from([0]),
    Buffer.from([compressed ? 1 : 0, 0]), // compFlag, compMethod
    Buffer.from([0]), // language
    Buffer.from([0]), // translated keyword
  ]);
  const body = compressed ? zlib.deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return chunk('iTXt', Buffer.concat([head, body]));
}
function zTXt(keyword, text) {
  const head = Buffer.concat([Buffer.from(keyword), Buffer.from([0]), Buffer.from([0])]); // compMethod=0
  return chunk('zTXt', Buffer.concat([head, zlib.deflateSync(Buffer.from(text, 'latin1'))]));
}

// Node 无 DecompressionStream，注入 zlib
const inflate = async (u8) => {
  try {
    return new Uint8Array(zlib.inflateSync(Buffer.from(u8)));
  } catch (e) {
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(u8)));
  }
};

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

(async () => {
  // 1. SD: tEXt parameters
  {
    const png = makePng([tEXt('parameters', 'a cat on the moon\nNegative prompt: blurry, ugly\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 512x512, Model: sd15')]);
    const { items } = await parsePngTextChunks(png, { inflate });
    assert(items.length === 1, 'SD: 解析出 1 个文本块', items);
    assert(items[0].keyword === 'parameters', 'SD: keyword=parameters');
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'sd', 'SD: 识别为 sd');
    assert(r.prompt.includes('a cat on the moon'), 'SD: prompt 正确', r.prompt);
    assert(r.negative === 'blurry, ugly', 'SD: negative 正确', r.negative);
    assert(r.params.steps === '20' && r.params.seed === '42' && r.params.model === 'sd15', 'SD: 参数解析正确', r.params);
  }

  // 2. ComfyUI: iTXt workflow + prompt（prompt 用压缩块）
  {
    const promptJson = JSON.stringify({
      '3': { class_type: 'KSampler', inputs: { steps: 30, cfg: 7.5, seed: 99, sampler_name: 'euler', scheduler: 'normal', positive: ['6'], negative: ['7'] } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality' } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base.safetensors' } },
    });
    const workflowJson = JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }] });
    const png = makePng([iTXt('workflow', workflowJson, true), iTXt('prompt', promptJson, true)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    assert(items.length === 2, 'ComfyUI: 解析出 2 个文本块（含压缩）', items);
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'comfyui', 'ComfyUI: 识别为 comfyui');
    assert(r.workflow && r.workflow.includes('"nodes"'), 'ComfyUI: workflow JSON 提取', r.workflow);
    assert(r.prompt === 'a red fox', 'ComfyUI: prompt 提取', r.prompt);
    assert(r.negative === 'low quality', 'ComfyUI: negative 提取', r.negative);
    assert(r.params.steps === 30 && r.params.model === 'sd_xl_base.safetensors', 'ComfyUI: 参数提取', r.params);
  }

  // 3. NovelAI: tEXt Comment（JSON）
  {
    const comment = JSON.stringify({ v4_prompt: { caption: { base_caption: '1girl, blue hair' } }, v4_negative_prompt: { caption: { base_caption: 'bad anatomy' } }, sampler: 'k_euler', steps: 28, scale: 6 });
    const png = makePng([tEXt('Comment', comment)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'novelai', 'NovelAI: 识别为 novelai');
    assert(r.prompt === '1girl, blue hair', 'NovelAI: prompt 提取', r.prompt);
    assert(r.negative === 'bad anatomy', 'NovelAI: negative 提取', r.negative);
    assert(r.params.sampler === 'k_euler', 'NovelAI: 参数提取', r.params);
  }

  // 4. 无元数据
  {
    const png = makePng([]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(!r.isAI, '无元数据: isAI=false');
  }

  // 5. 非 PNG
  {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { ok } = await parsePngTextChunks(bad, { inflate });
    assert(ok === false, '非 PNG: 签名校验失败');
  }

  // 6. zTXt 压缩块
  {
    const png = makePng([zTXt('parameters', 'zlib compressed prompt here')]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'sd' && r.prompt.includes('zlib compressed'), 'zTXt: 解压并分类');
  }

  // 7. ComfyUI 容错：prompt 含 NaN（非严格 JSON）+ generation_data 补充
  {
    const promptJson = '{"10002": {"class_type": "ECHOCheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}}, "10055": {"class_type": "BNK_CLIPTextEncodeAdvanced", "inputs": {"text": "a cat"}}, "10056": {"class_type": "BNK_CLIPTextEncodeAdvanced", "inputs": {"text": "blurry"}}, "11002": {"class_type": "KSampler_A1111", "inputs": {"steps": 20, "cfg": 7, "seed": 42, "sampler_name": "dpmpp_2m", "scheduler": "karras"}}, "10066": {"class_type": "LoadImage", "inputs": {"image": "x"}, "is_changed": NaN}}';
    const genData = JSON.stringify({ prompt: "a cat", negativePrompt: "blurry", width: 768, height: 1152, steps: 30, cfgScale: 7, seed: "-1", samplerName: "DPM++ 2M Karras", models: [{ type: "LORA", modelFileName: "lora1", weight: 0.7 }, { type: "BASE_MODEL", modelFileName: "checkpoint" }] });
    const png = makePng([tEXt('prompt', promptJson), tEXt('generation_data', genData)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'comfyui', 'ComfyUI(容错): 识别为 comfyui（含 NaN 也能解析）');
    assert(r.prompt === 'a cat', 'ComfyUI(容错): prompt 提取（来自 generation_data）', r.prompt);
    assert(r.negative === 'blurry', 'ComfyUI(容错): negative 提取');
    assert(r.params.steps === 20 && r.params.sampler === 'dpmpp_2m', 'ComfyUI(容错): 从 prompt 节点提取参数', r.params);
    assert(r.models && r.models.length === 2 && r.models[0].name === 'lora1', 'ComfyUI(容错): 模型清单', r.models);
    assert(r.promptJson && r.promptJson.includes('"10002"'), 'ComfyUI(容错): promptJson 原始保留');
  }

  // 9. 误报防护：ezgif 等工具写的非 NovelAI Comment 不算 AI
  {
    const png = makePng([tEXt('Comment', 'PNG edited with https://ezgif.com/censor'), tEXt('Software', 'ezgif.com')]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(!r.isAI && r.kind === null, '误报防护: ezgif Comment 不算 AI');
  }

  // 10. NovelAI v3 直接字段（prompt/uc）仍能识别
  {
    const comment = JSON.stringify({ prompt: '1girl, sword', uc: 'lowres, blurry', sampler: 'k_euler', steps: 28, scale: 6, seed: 5 });
    const png = makePng([tEXt('Comment', comment)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'novelai' && r.prompt === '1girl, sword' && r.negative === 'lowres, blurry', 'NovelAI v3: prompt/uc 提取');
  }

  // 11. NovelAI v4：char_captions 拼入 Prompt（角色提示词也是正面提示词）
  {
    const comment = JSON.stringify({
      v4_prompt: {
        caption: {
          base_caption: '1boy, bennett',
          char_captions: [{ char_caption: 'boy, lying on sofa' }, { char_caption: 'white socks' }],
        },
      },
      v4_negative_prompt: { caption: { base_caption: 'lowres' } },
      sampler: 'k_euler', steps: 28, scale: 6, seed: 5,
    });
    const png = makePng([tEXt('Comment', comment)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'novelai', 'NAI v4: 识别');
    assert(r.prompt.includes('1boy, bennett') && r.prompt.includes('Character Prompt:') && r.prompt.includes('lying on sofa') && r.prompt.includes('white socks'), 'NAI v4: char_captions 拼入 prompt', r.prompt);
    assert(r.negative === 'lowres', 'NAI v4: negative');
  }

  // 12. ComfyUI 正负判定：负面编码器排在前面时，按 sampler 连接正确区分
  {
    // 节点 65 是负面（先出现）、67 是正面（后出现），KSampler 明确连接
    const promptJson = JSON.stringify({
      '46': { class_type: 'SaveImage', inputs: {} },
      '65': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, low quality' } },
      '67': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, best quality, 1girl' } },
      '66': { class_type: 'KSampler', inputs: { steps: 10, cfg: 1, seed: 42, sampler_name: 'dpmpp_2m_sde', scheduler: 'simple', positive: ['67', 0], negative: ['65', 0] } },
    });
    const png = makePng([tEXt('prompt', promptJson)]);
    const { items } = await parsePngTextChunks(png, { inflate });
    const r = analyzeMetadata(items);
    assert(r.isAI && r.kind === 'comfyui', '正负判定: 识别 comfyui');
    assert(r.prompt.includes('masterpiece') && r.prompt.includes('1girl'), '正负判定: 正面=第67节点', r.prompt);
    assert(r.negative.includes('worst quality'), '正负判定: 负面=第65节点', r.negative);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
