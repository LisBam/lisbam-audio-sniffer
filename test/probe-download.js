/**
 * 探针：实测 chrome.downloads.download 的 filename / saveAs 真实行为
 *
 * 要回答三个问题（官方文档站点在本机被 DNS 拦了，只能实测）：
 *   1. filename 里的相对子目录（'音频下载/xx.wav'）到底会不会被创建？
 *   2. filename 传绝对路径（'D:\\Music\\xx.wav'）会怎样？
 *   3. saveAs:true 在无头模式下会怎样？是否要求用户手势？
 *
 * 用真实外网 HTTPS 文件（本机 localhost 下载被沙箱中间层破坏，不可用）。
 *
 * 运行：node test/probe-download.js
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CDP_PORT = 9900 + Math.floor(Math.random() * 90);

/** 真实外网音频（MDN，实测 HTTP 200） */
const REMOTE = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';

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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise }, 40000);
    if (r.exceptionDetails) return '__THREW__ ' + JSON.stringify(r.exceptionDetails.exception);
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
function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-dl-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'about:blank'
  ], { stdio: 'ignore' });
  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let swCdp = null, browserCdp = null;
  try {
    const version = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (!version) throw new Error('无法连接调试端口');
    browserCdp = new CDP(version.webSocketDebuggerUrl);
    await browserCdp.connect();
    await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) swTarget = list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
      if (!swTarget) await sleep(500);
    }
    if (!swTarget) throw new Error('扩展未加载');
    swCdp = new CDP(swTarget.webSocketDebuggerUrl);
    await swCdp.connect();
    console.log('扩展已加载，下载目录：' + dlDir + '\n');

    const dl = async (opts) => swCdp.eval(
      `(async () => { try { const id = await chrome.downloads.download(${JSON.stringify(opts)});` +
      ` return JSON.stringify({ ok: true, id }); }` +
      ` catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); } })()`, true);

    const cases = [
      ['1) 相对子目录：音频下载/probe1.mp3', { url: REMOTE, filename: '音频下载/probe1.mp3' }],
      ['2) 多层相对子目录：音乐/语音/probe2.mp3', { url: REMOTE, filename: '音乐/语音/probe2.mp3' }],
      ['3) 绝对路径：D:\\Music\\probe3.mp3', { url: REMOTE, filename: 'D:\\Music\\probe3.mp3' }],
      ['4) 反引用逃逸：../escape/probe4.mp3', { url: REMOTE, filename: '../escape/probe4.mp3' }],
      ['5) 带盘符的反斜杠子目录：音频下载\\probe5.mp3', { url: REMOTE, filename: '音频下载\\probe5.mp3' }]
    ];

    for (const [label, opts] of cases) {
      const raw = await dl(opts);
      console.log(label);
      console.log('   调用返回: ' + raw);
      await sleep(2500);
      const info = await swCdp.eval(
        `chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })` +
        `.then(r => JSON.stringify(r.map(x => ({ state: x.state, bytes: x.bytesReceived, err: x.error && x.error.current, file: x.filename }))))`, true);
      console.log('   下载条目: ' + info);
    }

    console.log('\n=== 落盘目录结构 ===');
    for (const f of walk(dlDir, dlDir)) console.log(`   ${f.rel.padEnd(40)} ${String(f.size).padStart(8)} B`);

    /* saveAs: 无头模式下能否弹框 */
    console.log('\n6) saveAs:true（无头模式）');
    const t0 = Date.now();
    const raw6 = await dl({ url: REMOTE, filename: 'probe6.mp3', saveAs: true });
    console.log('   调用返回(' + (Date.now() - t0) + 'ms): ' + raw6);
    await sleep(3000);
    const info6 = await swCdp.eval(
      `chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })` +
      `.then(r => JSON.stringify(r.map(x => ({ state: x.state, bytes: x.bytesReceived, err: x.error && x.error.current, file: x.filename }))))`, true);
    console.log('   下载条目: ' + info6);

    /* 拦下来看后台到底传了什么参数（saveAs / 子目录是否真的传下去了） */
    console.log('\n=== 拦截 chrome.downloads.download，检查实际传参 ===');
    await swCdp.eval(`(() => {
      if (window.__origDl) return 'already';
      window.__origDl = chrome.downloads.download;
      window.__dlCalls = [];
      chrome.downloads.download = function (opts) { window.__dlCalls.push(JSON.parse(JSON.stringify(opts))); return Promise.resolve(9999); };
      return 'patched';
    })()`, true);
    console.log('   已打补丁');
  } catch (e) {
    console.log('异常: ' + (e && e.message));
  } finally {
    try { if (swCdp) swCdp.close(); } catch (e) {}
    try { if (browserCdp) browserCdp.close(); } catch (e) {}
    killTree();
    await sleep(600);
    const keep = process.env.KEEP_PROBE_DIR;
    if (!keep) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
    else console.log('\n保留目录：' + profile);
  }
})();
