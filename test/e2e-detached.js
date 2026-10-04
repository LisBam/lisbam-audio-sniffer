/**
 * 回归测试：游离音频元素（new Audio()，从不插入 DOM）
 *
 * 复现用户反馈的场景（米游社 wiki 角色语音）：
 *   播放器用 new Audio() 创建元素、永不 append 到文档 →
 *   document 上的事件委托完全看不到它，querySelector 也找不到它。
 *
 * 两阶段：
 *   A. 游离元素播 http 音频 → 必须能检测到、弹出卡片、按钮是「下载」
 *   B. 游离元素播 blob: 音频 → 按钮是「录制」，且录制能委托给主世界钩子完成并落盘
 *      （blob 里的 wav 由页面 JS 现场合成，不依赖任何网络）
 *
 * 运行：node test/e2e-detached.js
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const PORT = 8791;
const CDP_PORT = 9680 + Math.floor(Math.random() * 200);

/* ---------------- 测试服务器 ---------------- */

function buildWav(seconds, rate) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 0.05)) * Math.min(1, (n - i) / (rate * 0.05));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * env * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const WAV = buildWav(4, 8000);

/** A：游离元素播放服务器上的音频 */
const HTML_A = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>测试曲目 - 游离元素自检</title></head>
<body style="font:16px sans-serif;padding:40px">
<h1>游离 new Audio() 自检</h1>
<p>页面上没有任何 &lt;audio&gt; 标签</p>
<script>
  // 关键：创建后绝不插入 DOM
  const el = new Audio('/voice.wav');
  window.__detachedEl = el;
  el.play().then(() => console.log('detached playing')).catch(e => console.log('blocked: ' + e.message));
</script>
</body></html>`;

/** B：游离元素播放页面自己合成的 blob 音频（12 秒） */
const HTML_B = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>测试曲目 - 游离 blob 下载自检</title></head>
<body style="font:16px sans-serif;padding:40px">
<h1>游离元素 blob 录制自检</h1>
<p>页面上没有任何 &lt;audio&gt; 标签</p>
<script>
  function makeWav(seconds, rate) {
    const n = seconds * rate;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (rate * 0.05)) * Math.min(1, (n - i) / (rate * 0.05));
      dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 0.3 * env * 32767), true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  const url = URL.createObjectURL(makeWav(12, 8000));
  window.__blobUrl = url;
  const el = new Audio(url);   // 同样不插入 DOM
  window.__detachedEl = el;
  el.loop = false;
  el.play().then(() => console.log('detached blob playing')).catch(e => console.log('blocked: ' + e.message));
  el.addEventListener('ended', () => console.log('ended'));
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/voice.wav') {
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', WAV.length);
        res.writeHead(200);
        res.end(WAV);
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(url === '/blob.html' ? HTML_B : HTML_A);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------------- CDP ---------------- */

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.waiting = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
      this.ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.waiting.has(msg.id)) {
          const w = this.waiting.get(msg.id); this.waiting.delete(msg.id);
          msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
        }
      });
    });
  }
  send(method, params, timeout) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('超时 ' + method)); } }, timeout || 15000);
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise }, 30000);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(500);
  }
  return null;
}
function walkFiles(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, base));
    else out.push({ rel: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out;
}

const CARD_PROBE = `(() => {
  const h = document.querySelector('[data-audio-sniffer]');
  if (!h || !h.shadowRoot) return { toast: false };
  const card = h.shadowRoot.querySelector('.card');
  const bar = h.shadowRoot.querySelector('.recbar');
  return {
    toast: true,
    hidden: card ? card.hidden : null,
    names: Array.from(h.shadowRoot.querySelectorAll('.name')).map(e => e.textContent),
    subs: Array.from(h.shadowRoot.querySelectorAll('.sub')).map(e => e.textContent),
    btns: Array.from(h.shadowRoot.querySelectorAll('.btn.act')).map(e => e.textContent),
    recbar: bar ? !bar.hidden : null,
    rectext: (h.shadowRoot.querySelector('.rectext') || {}).textContent || '',
    note: (h.shadowRoot.querySelector('.note') || {}).textContent || ''
  };
})()`;

const NOT_AUDIO_TAG = `({ total: document.querySelectorAll('audio,video').length })`;

/* ---------------- 主流程 ---------------- */

(async () => {
  const results = [];
  const ok = (n, pass, info) => {
    results.push({ n, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + n + (info ? '\n        → ' + info : ''));
  };

  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-detached-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'http://127.0.0.1:' + PORT + '/detached.html'
  ], { stdio: 'ignore' });

  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let pageCdp = null, swCdp = null, browserCdp = null;

  try {
    const version = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (!version) throw new Error('无法连接调试端口');
    browserCdp = new CDP(version.webSocketDebuggerUrl);
    await browserCdp.connect();
    await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    let pageTarget = null, swTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) {
        pageTarget = list.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1:' + PORT) >= 0);
        swTarget = swTarget || list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
      }
      if (pageTarget && swTarget) break;
      await sleep(500);
    }
    ok('扩展 Service Worker 已注册', !!swTarget, swTarget && swTarget.url);
    if (!pageTarget || !swTarget) throw new Error('目标缺失，测试中止');

    pageCdp = new CDP(pageTarget.webSocketDebuggerUrl);
    await pageCdp.connect();
    swCdp = new CDP(swTarget.webSocketDebuggerUrl);
    await swCdp.connect();

    const readMedia = async () => {
      const raw = await swCdp.eval(`chrome.storage.session.get('mediaMap').then(o => JSON.stringify(Object.values(o.mediaMap||{})))`, true);
      try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
    };

    /* ================= A. 游离元素 + http 音频 ================= */

    await sleep(1500);
    const noTag = await pageCdp.eval(NOT_AUDIO_TAG);
    ok('测试页面确实没有任何 audio/video 标签（游离元素）', noTag.total === 0, JSON.stringify(noTag));

    const stateA = await pageCdp.eval(`(() => { const e = window.__detachedEl; return e ? { paused: e.paused, t: e.currentTime, dur: e.duration, src: e.currentSrc.slice(0,80) } : null; })()`);
    ok('游离元素确实在播放', !!(stateA && !stateA.paused && stateA.t > 0), JSON.stringify(stateA));

    await sleep(4000);
    const mediaA = (await readMedia()).find((m) => /voice\.wav/.test(m.url));
    ok('主世界钩子捕获到游离元素的播放', !!mediaA,
      mediaA ? `kind=${mediaA.kind} detached=${mediaA.detached} fromHook=${mediaA.fromHook} duration=${mediaA.duration} toasted=${mediaA.toasted}` : '未捕获');

    const cardA = await pageCdp.eval(CARD_PROBE);
    ok('弹出简洁卡片（游离元素）', !!(cardA && cardA.toast && cardA.hidden === false), JSON.stringify(cardA));
    ok('卡片按钮是「下载」（http 文件）', !!(cardA && cardA.btns && cardA.btns.some((b) => /下载/.test(b))), JSON.stringify(cardA.btns));

    /* ================= B. 游离元素 + blob 音频 → 面板内下载 ================= */
    /* blob 不是可直接下载的文件地址，按设计「不自动弹卡片」，但可以从工具栏面板下载 */

    await pageCdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/blob.html' });
    await sleep(1500);
    const noTagB = await pageCdp.eval(NOT_AUDIO_TAG);
    ok('第二阶段页面同样没有 audio/video 标签', noTagB.total === 0, JSON.stringify(noTagB));

    const stateB = await pageCdp.eval(`(() => { const e = window.__detachedEl; return e ? { paused: e.paused, t: e.currentTime, dur: e.duration, src: e.currentSrc.slice(0,40) } : null; })()`);
    ok('游离元素正在播放 blob 音频', !!(stateB && !stateB.paused && stateB.t > 0), JSON.stringify(stateB));

    await sleep(4000);
    const mediaB = (await readMedia()).find((m) => m.kind === 'blob');
    ok('后台把 blob 音频记为 kind=blob', !!mediaB,
      mediaB ? `kind=${mediaB.kind} detached=${mediaB.detached} duration=${mediaB.duration} toasted=${mediaB.toasted}` : '未捕获');

    const cardB = await pageCdp.eval(CARD_PROBE);
    ok('blob 音频不自动弹卡片（只保留下载后不打扰）', !(cardB && cardB.toast && cardB.hidden === false), JSON.stringify(cardB));

    // 面板点「下载」时，后台会把 blob 交给页面内 fetch → blob → 另存。
    // 这里直接从后台向该标签页的内容脚本下发同一个指令，验证这条通道真的能落地文件。
    if (mediaB) {
      console.log('\n触发面板下载通道（页面内 fetch → 另存）…');
      const tabId = await swCdp.eval(`chrome.tabs.query({}).then(t => { const p = t.find(x => (x.url||'').indexOf('127.0.0.1:${PORT}') >= 0); return p ? p.id : null; })`, true);
      const respRaw = await swCdp.eval(
        `chrome.tabs.sendMessage(${JSON.stringify(tabId)}, { type:'page-fetch-download', item: ${JSON.stringify(mediaB)} })` +
        `.then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok:false, error: String(e && e.message || e) }))`, true);
      console.log('        内容脚本返回: ' + respRaw);

      let files = [];
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        files = walkFiles(dlDir, dlDir);
        if (files.some((f) => f.size > 1000)) break;
      }
      const dlRaw = await swCdp.eval(`chrome.downloads.search({}).then(r => JSON.stringify(r.map(x=>({s:x.state,b:x.bytesReceived,e:x.error&&x.error.current,f:x.filename}))))`, true);
      ok('blob 音频能通过面板通道下载并落盘', files.some((f) => f.size > 1000),
        '文件: ' + JSON.stringify(files) + '\n          下载条目: ' + dlRaw);
    }

  } catch (e) {
    console.log('异常: ' + (e && e.message));
    results.push({ n: '运行异常', pass: false });
  } finally {
    try { if (pageCdp) pageCdp.close(); } catch (e) {}
    try { if (swCdp) swCdp.close(); } catch (e) {}
    try { if (browserCdp) browserCdp.close(); } catch (e) {}
    killTree();
    try { srv.close(); } catch (e) {}
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n===== 结果：' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();
