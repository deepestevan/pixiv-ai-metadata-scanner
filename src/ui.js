/**
 * UI 层
 * - 浮动控制（触发扫描）+ 全页面批量进度条（Shadow DOM 隔离）
 * - 每张缩略图：扫描状态、AI 元数据绿框 + 类型角标
 * - 悬停查看 prompt / 参数 / workflow，一键导出 ComfyUI workflow JSON
 *
 * 缩略图标记注入 pixiv 页面 DOM，用注入的 <style>（带 !important）避免被页面样式覆盖。
 */

const KIND_LABEL = { comfyui: 'ComfyUI', sd: 'SD', novelai: 'NovelAI' };
const PAGE_STYLE_ID = 'pams-page-style';

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export class ScannerUI {
  constructor() {
    this.overlays = new Map(); // url -> {chip}
    this._items = new Map();   // url -> artwork item
    this._results = new Map(); // url -> result
    this._imgToUrl = new Map(); // img element -> url
    this._scanRunning = false;
  }

  mount() {
    this._injectPageStyle();
    this._host = document.createElement('div');
    this._host.id = 'pams-root';
    this._host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    this._shadow = this._host.attachShadow({ mode: 'open' });
    this._shadow.innerHTML = this._shellHtml();
    document.body.appendChild(this._host);

    this._ctrlBtn = this._shadow.getElementById('pams-ctrl');
    this._listBtn = this._shadow.getElementById('pams-list');
    this._retryBtn = this._shadow.getElementById('pams-retry');
    this._bar = this._shadow.getElementById('pams-bar');
    this._barFill = this._shadow.getElementById('pams-bar-fill');
    this._barText = this._shadow.getElementById('pams-bar-text');
    this._panel = this._shadow.getElementById('pams-panel');
    this._panelHead = this._shadow.getElementById('pams-panel-head');
    this._panelTitle = this._shadow.getElementById('pams-panel-title');
    this._resize = this._shadow.getElementById('pams-resize');
    this._collapseAllBtn = this._shadow.getElementById('pams-collapse-all');

    this._ctrlBtn.addEventListener('click', () => this._onControl());
    this._listBtn.addEventListener('click', () => this.showAIList());
    this._retryBtn.addEventListener('click', () => this._onRetry());
    this._enableDrag();
    this._enableResize();
    this._collapseAllBtn.addEventListener('click', () => this._toggleAllSections());
    this._bindHover();
  }

  /** 拖标题栏移动面板 */
  _enableDrag() {
    this._panelHead.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      e.preventDefault();
      const panel = this._panel;
      const rect = panel.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev) => {
        const left = Math.max(0, Math.min(ev.clientX - offX, window.innerWidth - 60));
        const top = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - 40));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /** 拖右下角调整面板大小 */
  _enableResize() {
    this._resize.addEventListener('mousedown', (e) => {
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
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /** 全部折叠 / 展开 */
  _toggleAllSections() {
    const sections = this._shadow.querySelectorAll('.pams-sec');
    if (!sections.length) return;
    const anyOpen = [...sections].some((s) => s.getAttribute('data-open') === 'true');
    sections.forEach((s) => s.setAttribute('data-open', String(!anyOpen)));
    this._collapseAllBtn.textContent = anyOpen ? '▸' : '▾';
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
      <button id="pams-ctrl" title="批量扫描 AI 元数据">AI 扫描</button>
      <button id="pams-list" title="列出已识别的 AI 图" style="display:none">AI 列表</button>
      <button id="pams-retry" title="重试扫描超时/出错的项" style="display:none">重试失败</button>
      <div id="pams-bar">
        <span id="pams-bar-text">扫描 0/0</span>
        <div id="pams-bar-track"><div id="pams-bar-fill"></div></div>
      </div>
      <div id="pams-panel">
        <div id="pams-panel-head">
          <span id="pams-panel-title">元信息</span>
          <span class="spacer"></span>
          <button id="pams-collapse-all" title="全部折叠/展开">▾</button>
          <button id="pams-close" title="关闭">×</button>
        </div>
        <div id="pams-panel-body"></div>
        <div id="pams-resize" title="拖拽调整大小"></div>
      </div>
    `;
  }

  _injectPageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement('style');
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
    document.addEventListener('mouseover', (e) => {
      let node = e.target && e.target.closest ? e.target.closest('.pams-ai') : null;
      if (!node && e.target && e.target.closest) node = e.target.closest('img');
      if (!node) return;
      let url = null;
      if (node.tagName !== 'IMG' && node.querySelector) {
        const chip = node.querySelector('.pams-chip');
        if (chip) url = chip.getAttribute('data-url');
      }
      if (!url && node.tagName === 'IMG') url = this._imgToUrl.get(node);
      if (!url) return;
      const item = this._items.get(url);
      const res = this._results.get(url);
      if (item && res) this._showPanel(item, res);
    });
    this._shadow.getElementById('pams-close').addEventListener('click', () => { this._panel.style.display = 'none'; });
  }

  // ---- 控制 ----
  setControlHandler(fn) { this._onControl = fn; }
  setRetryHandler(fn) { this._onRetry = fn; }
  setRetryCount(n) {
    if (n > 0) {
      this._retryBtn.style.display = 'block';
      this._retryBtn.textContent = `重试失败 (${n})`;
    } else {
      this._retryBtn.style.display = 'none';
    }
  }
  getItem(url) { return this._items.get(url); }
  setScanState(running) {
    this._scanRunning = running;
    this._ctrlBtn.setAttribute('data-running', String(running));
    this._ctrlBtn.textContent = running ? '扫描中…' : 'AI 扫描';
  }

  // ---- 进度条 ----
  setTotal(n) { this._total = n; }
  updateProgress({ done, total, aiCount }) {
    this._bar.style.display = 'block';
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    this._barFill.style.width = pct + '%';
    this._barText.textContent = `扫描 ${done}/${total} · AI 图 ${aiCount} 张 · ${pct}%`;
  }
  hideBar() { this._bar.style.display = 'none'; }
  showSummary(text) {
    const bar = this._bar;
    bar.style.display = 'block';
    this._barFill.style.width = '100%';
    this._barText.textContent = text;
    setTimeout(() => { bar.style.display = 'none'; }, 5000);
  }
  setAIListCount(n) {
    this._listBtn.style.display = 'block';
    this._listBtn.textContent = `AI 列表 (${n})`;
  }
  showAIList() {
    const ai = [...this._results.entries()].filter(([, r]) => r.status === 'ai');
    const body = this._shadow.getElementById('pams-panel-body');
    this._collapseAllBtn.textContent = '▾';
    this._panelTitle.textContent = 'AI 列表';
    if (!ai.length) {
      body.innerHTML = `<div class="dim">暂无识别出的 AI 图</div>`;
      this._panel.style.display = 'flex';
      return;
    }
    let html = `<h3>识别出 ${ai.length} 项 AI 元数据</h3><div class="pams-ai-list">`;
    for (const [url, res] of ai) {
      const m = res.meta || {};
      const item = this._items.get(url);
      const label = item ? (item.page ? `${item.id} (p${item.page})` : item.id) : url;
      const snippet = (m.prompt || '').slice(0, 80);
      html += `<div class="pams-ai-row" data-url="${url}">
        <span class="pams-kind">${KIND_LABEL[m.kind] || m.kind}</span>
        <b>${label}</b>
        <span class="dim">${escapeHtml(snippet)}</span>
      </div>`;
    }
    html += `</div>`;
    body.innerHTML = html;
    body.querySelectorAll('.pams-ai-row').forEach((row) => {
      row.addEventListener('click', () => {
        const url = row.getAttribute('data-url');
        const item = this._items.get(url);
        const res = this._results.get(url);
        if (item && res) this._showPanel(item, res);
      });
    });
    this._panel.style.display = 'flex';
  }

  /** 生成可折叠分区 HTML；text 已转义。 */
  _section(title, text, open = true) {
    return `<div class="pams-sec" data-open="${open}">
      <div class="pams-sec-head"><span>${title}</span><span class="arrow">${open ? '▾' : '▸'}</span></div>
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
    if (item.a) item.a.classList.add('pams-scanning');
  }
  markResult(item, result) {
    this._results.set(item.url, result);
    if (item.a) item.a.classList.remove('pams-scanning');
    if (result.status === 'ai') {
      if (item.a) item.a.classList.add('pams-ai');
      if (item.img) item.img.classList.add('pams-ai');
    }
    this._ensureChip(item, result);
  }
  _ensureChip(item, result) {
    // 角标挂到作品卡 <a>（若无则用 img 的父级），全卡可见、最稳定
    const container = item.a || (item.img && item.img.parentElement) || null;
    if (!container) return;
    let chip = this.overlays.get(item.url);
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'pams-chip';
      chip.setAttribute('data-url', item.url);
      container.style.position = container.style.position || 'relative';
      container.appendChild(chip);
      this.overlays.set(item.url, chip);
    }
    const state = result.status === 'ai' ? 'ai' : result.status === 'error' ? 'err' : 'none';
    chip.setAttribute('data-state', state);
    if (result.status === 'ai') {
      chip.setAttribute('data-kind', result.kind || '');
      chip.textContent = KIND_LABEL[result.kind] || 'AI';
    } else if (result.status === 'error') {
      chip.textContent = '!';
    } else {
      chip.textContent = '·';
    }
  }

  // ---- 详情面板 ----
  _showPanel(item, result) {
    const body = this._shadow.getElementById('pams-panel-body');
    this._collapseAllBtn.textContent = '▾';
    if (result.status !== 'ai' || !result.meta) {
      this._panelTitle.textContent = '元信息';
      body.innerHTML = `<div class="dim">该图无 AI 元数据${result.status === 'error' ? '（扫描出错）' : ''}</div>`;
      this._panel.style.display = 'flex';
      return;
    }
    const m = result.meta;
    this._panelTitle.textContent = `${KIND_LABEL[m.kind] || m.kind} · ${item.id}`;
    let html = `<h3>${KIND_LABEL[m.kind] || m.kind} · <span class="dim">${item.id}</span></h3><div class="pams-sections">`;
    if (m.prompt) html += this._section('Prompt', m.prompt, true);
    if (m.negative) html += this._section('Negative', m.negative, false);
    if (m.params && Object.keys(m.params).length) html += this._section('参数', JSON.stringify(m.params, null, 2), false);
    if (m.models && m.models.length) {
      html += this._section('模型 / LoRA', m.models.map((x) => `[${x.type}] ${x.name}${x.weight ? ` ×${x.weight}` : ''}`).join('\n'), false);
    }
    if (m.workflow) html += this._section('ComfyUI 工作流', m.workflow, false);
    else if (m.promptJson) html += this._section('ComfyUI 工作流（API prompt）', m.promptJson, false);
    html += '</div>';
    // 导出按钮
    html += `<div style="margin-top:6px">
        <button class="btn" data-act="copy-meta">复制元数据 JSON</button>
        <button class="btn" data-act="dl-meta">下载元数据 JSON</button>`;
    if (m.workflow) {
      html += `<button class="btn" data-act="copy-wf">复制 workflow</button>
        <button class="btn" data-act="dl-wf">下载 workflow</button>`;
    } else if (m.promptJson) {
      html += `<button class="btn" data-act="copy-pj">复制 prompt</button>
        <button class="btn" data-act="dl-pj">下载 prompt</button>`;
    }
    html += '</div>';
    body.innerHTML = html;
    body.querySelectorAll('.pams-sec-head').forEach((h) => {
      h.addEventListener('click', () => {
        const sec = h.parentElement;
        const open = sec.getAttribute('data-open') === 'true';
        sec.setAttribute('data-open', String(!open));
        h.querySelector('.arrow').textContent = open ? '▸' : '▾';
      });
    });
    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
        if (act === 'copy-wf') {
          navigator.clipboard.writeText(m.workflow).then(() => this._toast('workflow 已复制'));
        } else if (act === 'dl-wf') {
          this._downloadJson(item, m.workflow, 'workflow');
        } else if (act === 'copy-pj') {
          navigator.clipboard.writeText(m.promptJson).then(() => this._toast('prompt 已复制'));
        } else if (act === 'dl-pj') {
          this._downloadJson(item, m.promptJson, 'prompt');
        } else if (act === 'copy-meta') {
          navigator.clipboard.writeText(this._buildMetaJson(item, m)).then(() => this._toast('元数据 JSON 已复制'));
        } else if (act === 'dl-meta') {
          this._downloadJson(item, this._buildMetaJson(item, m), 'metadata');
        }
      });
    });
    this._panel.style.display = 'block';
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
      baseModel: m.baseModel,
    }, null, 2);
  }

  /** 下载：优先弹"另存为"选择保存位置；不支持时回退普通下载。文件名用原图基底。 */
  _downloadJson(item, json, prefix) {
    let pretty = json;
    try { pretty = JSON.stringify(JSON.parse(json), null, 2); } catch (e) { /* 原文 */ }
    const name = `${item.fileBase || this._fallbackBase(item)}.json`;
    const type = 'application/json';
    if (window.showSaveFilePicker) {
      window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      }).then((handle) => handle.createWritable().then((w) => w.write(pretty).then(() => w.close())))
        .then(() => this._toast('已保存'))
        .catch((err) => {
          if (err && err.name === 'AbortError') return; // 用户取消
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 14px;border-radius:6px;z-index:2147483646;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }
}
