/**
 * 端到端实测（Edge 无头模式）
 *
 * 验证四件事：
 *   1. 扩展能被 Edge 正常加载（Service Worker 注册）
 *   2. 页面播放音频 → 后台捕获到音频记录（内容脚本上报 + webRequest 嗅探）
 *   3. 页面角落真的弹出了「简洁卡片」，标题/按钮正确
 *   4. 点「下载」后，文件最终落到下载目录（直连下载 或 页面内兜底下载）
 *
 * 运行：node test/e2e.js
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
const PORT = 8765;
const CDP_PORT = 9600 + Math.floor(Math.random() * 200);

/* ---------------- 本地测试服务器 ---------------- */

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

const WAV = buildWav(40, 8000);

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>测试曲目 - 音频嗅探下载器自检</title></head>
<body style="font:16px sans-serif;padding:40px">
<h1>E2E 自检页面</h1>
<audio id="a" src="/tone.wav" controls autoplay loop></audio>
<script>
  const a = document.getElementById('a');
  a.play().then(() => console.log('playing')).catch((e) => console.log('blocked: ' + e.message));
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/tone.wav') {
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', WAV.length);
        res.writeHead(200);
        res.end(WAV);
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(HTML);
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
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('超时 ' + method)); } }, 15000);
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
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

/* ---------------- 主流程 ---------------- */

(async () => {
  const results = [];
  const ok = (n, pass, info) => {
    results.push({ n, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + n + (info ? '\n        → ' + info : ''));
  };

  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-e2e-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'http://127.0.0.1:' + PORT + '/test.html'
  ], { stdio: 'ignore' });

  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let pageCdp = null, swCdp = null, browserCdp = null;

  try {
    const version = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (!version) throw new Error('无法连接调试端口 ' + CDP_PORT);
    ok('Edge 启动并开放调试端口', true, version.Browser);

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
    ok('测试页面已打开', !!pageTarget);
    if (!pageTarget || !swTarget) throw new Error('目标缺失，测试中止');

    pageCdp = new CDP(pageTarget.webSocketDebuggerUrl);
    await pageCdp.connect();
    swCdp = new CDP(swTarget.webSocketDebuggerUrl);
    await swCdp.connect();

    // 1. 音频在播
    await sleep(1200);
    const playing = await pageCdp.eval(`(() => { const a=document.getElementById('a'); return a ? {paused:a.paused,t:a.currentTime,dur:a.duration} : null; })()`);
    ok('页面音频正在播放', !!(playing && !playing.paused && playing.t > 0), JSON.stringify(playing));

    // 2. 后台捕获
    await sleep(4500);
    const mediaRaw = await swCdp.eval(`chrome.storage.session.get('mediaMap').then(o => JSON.stringify(Object.values(o.mediaMap||{})))`, true);
    const media = JSON.parse(mediaRaw || '[]');
    const hit = media.find((m) => /tone\.wav/.test(m.url));
    ok('后台捕获到音频记录', !!hit, hit ? `kind=${hit.kind} contentType=${hit.contentType} size=${hit.size} frameId=${hit.frameId} toasted=${hit.toasted}` : mediaRaw);

    // 3. 简洁卡片
    const toast = await pageCdp.eval(`(() => {
      const h = document.querySelector('[data-audio-sniffer]');
      if (!h || !h.shadowRoot) return { toast:false };
      const card = h.shadowRoot.querySelector('.card');
      const r = h.getBoundingClientRect();
      return { toast:true, hidden: card ? card.hidden : null,
               name: (h.shadowRoot.querySelector('.name')||{}).textContent || '',
               sub: (h.shadowRoot.querySelector('.sub')||{}).textContent || '',
               btn: (h.shadowRoot.querySelector('.btn.act')||{}).textContent || '',
               size: Math.round(r.width) + 'x' + Math.round(r.height),
               pos: 'left=' + Math.round(r.left) + ' top=' + Math.round(r.top) };
    })()`);
    ok('弹出简洁卡片且可见', !!(toast && toast.toast && toast.hidden === false), JSON.stringify(toast));
    ok('卡片标题取到了音频名', !!(toast && /测试曲目/.test(toast.name)), toast && toast.name);

    // 4. 点下载 → 最终文件落盘
    if (toast && toast.toast) {
      await pageCdp.eval(`document.querySelector('[data-audio-sniffer]').shadowRoot.querySelector('.btn.act').click(), 1`);
      let files = [];
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        files = walkFiles(dlDir, dlDir).filter((f) => f.size > 1000);
        if (files.length) break;
      }
      const dlRaw = await swCdp.eval(`chrome.downloads.search({}).then(r => JSON.stringify(r.map(x=>({s:x.state,b:x.bytesReceived,e:x.error&&x.error.current,f:x.filename}))))`, true);
      ok('点「下载」后音频最终落盘', files.length > 0, '文件: ' + JSON.stringify(files) + '\n          下载条目: ' + dlRaw);
    }

    // 5. 设置项
    const st = await swCdp.eval(`chrome.storage.local.get('settings').then(o => JSON.stringify(o.settings||{}))`, true);
    const settings = JSON.parse(st || '{}');
    ok('设置项已写入默认值', settings.autoPopup === true && settings.minDurationSeconds === 3 && settings.sniffToast === true, st);
    ok('录制相关设置已彻底移除', settings.recordMime === undefined && settings.recordBitrate === undefined, st);

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
