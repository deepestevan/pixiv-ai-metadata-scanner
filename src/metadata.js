/**
 * AI 元数据识别与提取
 * 根据解析出的 PNG 文本块判断图片是否由 AI 生成、属于哪个工具，并提取结构化信息。
 */

/**
 * 容错 JSON 解析：ComfyUI 工作流常含裸 NaN/Infinity（非严格 JSON），先替换再解析。
 * 解析失败返回 null。
 */
function safeJsonParse(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    const cleaned = str
      .replace(/\bNaN\b/g, 'null')
      .replace(/\b-?Infinity\b/g, 'null');
    try { return JSON.parse(cleaned); } catch (e2) { return null; }
  }
}

/**
 * 分析文本块列表，返回识别结果。
 * @param {Array<{type:string,keyword:string,text:string}>} items
 * @returns {{isAI:boolean, kind:string|null, prompt?:string, negative?:string, params?:Object, workflow?:string, raw:Object}}
 */
export function analyzeMetadata(items) {
  const result = {
    isAI: false,
    kind: null, // 'comfyui' | 'sd' | 'novelai' | 'unknown'
    prompt: undefined,
    negative: undefined,
    params: undefined,
    workflow: undefined,
    raw: {},
  };

  if (!items || !items.length) return result;

  const byKeyword = {};
  for (const it of items) {
    byKeyword[it.keyword] = it.text;
    if (!(it.keyword in result.raw)) result.raw[it.keyword] = [];
    result.raw[it.keyword].push({ type: it.type, text: it.text });
  }

  // ComfyUI：prompt（API 图）+ workflow（UI 图）两个 JSON
  if ('workflow' in byKeyword || 'prompt' in byKeyword) {
    result.isAI = true;
    result.kind = 'comfyui';
    result.workflow = byKeyword['workflow'] || undefined;
    result.promptJson = byKeyword['prompt'] || undefined;

    // prompt 可能是含 NaN/Infinity 的非严格 JSON（ComfyUI 常见），容错解析
    const promptObj = safeJsonParse(byKeyword['prompt']);
    if (promptObj) {
      const { prompt, negative, params } = extractFromComfyPrompt(promptObj);
      result.prompt = prompt;
      result.negative = negative;
      result.params = params;
    }

    // generation_data（Civitai 格式）补充可读信息：prompt/negative/参数/模型清单
    const gen = safeJsonParse(byKeyword['generation_data']);
    if (gen) {
      if (!result.prompt && gen.prompt) result.prompt = gen.prompt;
      if (!result.negative && gen.negativePrompt) result.negative = gen.negativePrompt;
      if (!result.params || !Object.keys(result.params).length) {
        result.params = {};
        if (gen.width && gen.height) result.params.size = `${gen.width}x${gen.height}`;
        if (gen.steps !== undefined) result.params.steps = gen.steps;
        if (gen.cfgScale !== undefined) result.params.cfg = gen.cfgScale;
        if (gen.seed !== undefined) result.params.seed = gen.seed;
        if (gen.samplerName) result.params.sampler = gen.samplerName;
        if (gen.clipSkip !== undefined) result.params.clipSkip = gen.clipSkip;
        if (gen.hrUpscaler) result.params.hrUpscaler = gen.hrUpscaler;
      }
      if (Array.isArray(gen.models)) {
        result.models = gen.models.map((m) => ({
          name: m.modelFileName || m.label, type: m.type, weight: m.weight,
        }));
      }
      if (gen.baseModel?.modelFileName) result.baseModel = gen.baseModel.modelFileName;
    }
    return result;
  }

  // Stable Diffusion (A1111/Forge)：parameters 纯文本
  if ('parameters' in byKeyword) {
    result.isAI = true;
    result.kind = 'sd';
    const parsed = parseA1111Parameters(byKeyword['parameters']);
    result.prompt = parsed.prompt;
    result.negative = parsed.negative;
    result.params = parsed.params;
    return result;
  }

  // NovelAI：Comment（JSON）。Comment 是通用 PNG 字段，很多编辑工具（ezgif 等）也写，必须严格判定。
  if ('Comment' in byKeyword) {
    const commentObj = safeJsonParse(stripQuotes(byKeyword['Comment']));
    if (commentObj && isNovelAiComment(commentObj)) {
      result.isAI = true;
      result.kind = 'novelai';
      result.params = commentObj;
      if (commentObj.v4_prompt?.caption?.base_caption) {
        let p = commentObj.v4_prompt.caption.base_caption;
        // char_captions 也是正面提示词（角色提示词），拼入 Prompt
        const chars = commentObj.v4_prompt.caption.char_captions;
        if (Array.isArray(chars) && chars.length) {
          p += '\n\nCharacter Prompt:\n' + chars.map((c) => c.char_caption).join('\n');
        }
        result.prompt = p;
      }
      if (commentObj.v4_negative_prompt?.caption?.base_caption) {
        result.negative = commentObj.v4_negative_prompt.caption.base_caption;
      }
      // v3/v2 形式：直接 prompt/uc 字段
      if (!result.prompt && commentObj.prompt) result.prompt = commentObj.prompt;
      if (!result.negative && commentObj.uc) result.negative = commentObj.uc;
    }
    return result;
  }

  return result;
}

/**
 * 从 ComfyUI 的 prompt（API 格式节点图）提取 prompt/负面/关键参数。
 * prompt 结构：{ "nodeId": { class_type, inputs: {...} } }
 *
 * 正负判定：优先按 sampler 节点 inputs.positive / inputs.negative 的连接引用
 * 指向的编码器节点 ID（权威）；找不到连接才退回"第一个为正面、第二个为负面"。
 */
function extractFromComfyPrompt(promptObj) {
  const res = { prompt: undefined, negative: undefined, params: {} };
  if (!promptObj || typeof promptObj !== 'object') return res;

  const encoders = new Map(); // nodeId -> text
  const textFalls = [];       // 兜底：编码器文本出现顺序
  const samplers = [];

  for (const [id, node] of Object.entries(promptObj)) {
    const cls = node?.class_type || '';
    const inp = node?.inputs || {};

    if (/CLIPTextEncode|TextEncode|EncodeCLIP|CLIPText/i.test(cls) && typeof inp.text === 'string') {
      encoders.set(id, inp.text);
      textFalls.push(inp.text);
    }
    if (/Sampler/i.test(cls)) samplers.push(inp);

    // 参数
    if (/Sampler/i.test(cls)) {
      if (inp.steps !== undefined) res.params.steps = inp.steps;
      if (inp.cfg !== undefined) res.params.cfg = inp.cfg;
      if (inp.seed !== undefined) res.params.seed = inp.seed;
      if (inp.sampler_name !== undefined) res.params.sampler = inp.sampler_name;
      if (inp.scheduler !== undefined) res.params.scheduler = inp.scheduler;
      if (inp.denoise !== undefined) res.params.denoise = inp.denoise;
    }
    if (/CheckpointLoader|UNETLoader|DiffusionModel|ModelLoader/i.test(cls)) {
      if (inp.ckpt_name !== undefined) res.params.model = inp.ckpt_name;
      if (inp.unet_name !== undefined) res.params.model = inp.unet_name;
    }
  }

  // 权威判定：按 sampler 的 positive/negative 连接找编码器
  for (const s of samplers) {
    const posId = connectionNodeId(s.positive);
    const negId = connectionNodeId(s.negative);
    if (encoders.has(posId)) res.prompt = encoders.get(posId);
    if (encoders.has(negId)) res.negative = encoders.get(negId);
    if (res.prompt && res.negative) break;
  }

  // 兜底：第一个为正、第二个为负
  if (!res.prompt) res.prompt = textFalls[0];
  if (!res.negative && textFalls.length > 1) res.negative = textFalls[1];
  return res;
}

/** 取连接引用的节点 ID：支持 ["nodeId", 0] / "nodeId" / 节点对象 */
function connectionNodeId(ref) {
  if (Array.isArray(ref)) return String(ref[0]);
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && ref.id !== undefined) return String(ref.id);
  return '';
}

/**
 * 解析 A1111 的 parameters 纯文本。
 * 形如：
 *   prompt text
 *   Negative prompt: negative text
 *   Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 123, Size: 512x512, Model: xxx
 */
function parseA1111Parameters(text) {
  const res = { prompt: undefined, negative: undefined, params: {} };
  if (!text) return res;

  const negMatch = text.match(/Negative prompt:\s*([\s\S]*?)(?:\n[A-Z][\w ]+:\s|$)/i);
  if (negMatch) res.negative = negMatch[1].trim();

  // 参数行（Steps:/Sampler:/CFG/Seed/Size/Model 等）
  const paramsLine = (text.match(/^(?:.*?(?:Steps:|Sampler:|CFG|Seed|Model|Size).*?)$/gim) || [])[0];
  if (paramsLine) {
    for (const pair of paramsLine.split(',')) {
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim().toLowerCase();
      const v = pair.slice(idx + 1).trim();
      if (k.startsWith('steps')) res.params.steps = v;
      else if (k.startsWith('sampler')) res.params.sampler = v;
      else if (k.startsWith('cfg')) res.params.cfg = v;
      else if (k.startsWith('seed')) res.params.seed = v;
      else if (k.startsWith('model')) res.params.model = v;
      else if (k.includes('size')) res.params.size = v;
    }
  }

  if (res.prompt === undefined) {
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
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/**
 * NovelAI 特征字段。只有含这些字段之一的 JSON 才判定为 NovelAI 元数据，
 * 避免把 ezgif 等编辑工具写的通用 Comment 误判成 AI。
 */
const NAI_KEYS = [
  'prompt', 'uc', 'sampler', 'steps', 'scale', 'seed', 'strength',
  'noise_schedule', 'v4_prompt', 'v4_negative_prompt', 'parameters',
  'dynamic_thresholding', 'cfg_rescale', 'sm', 'legacy',
];
function isNovelAiComment(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && NAI_KEYS.some((k) => k in obj);
}
