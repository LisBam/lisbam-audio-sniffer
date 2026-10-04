/**
 * 探针 2：不用 CDP 的 Browser.setDownloadBehavior（怀疑它会劫持文件命名），
 * 改为通过 profile 里的 Preferences 指定下载目录，看扩展传的 filename 是否真的生效。
 *
 * 同时监控用户真实的「下载」文件夹，确保测试不会污染它（会清理掉新增文件）。
 *
 * 运行：node test/probe-download2.js
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CDP_PORT = 9950 + Math.floor(Math.random() * 40);

const REMOTE = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';
const REAL_DOWNLOADS = path.join(os.homedir(), 'Downloads');

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
function snapshot(dir) {
  const s = new Set();
  for (const f of walk(dir, dir)) s.add(f.rel);
  return s;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe2-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  // 关键：用 Preferences 指定下载目录（而不是 CDP 的 setDownloadBehavior）
  const defDir = path.join(profile, 'profile', 'Default');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
    download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dlDir },
    profile: { default_content_setting_values: { automatic_downloads: 1 } }
  }), 'utf8');

  const before = snapshot(REAL_DOWNLOADS);

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'about:blank'
  ], { stdio: 'ignore' });
  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let swCdp = null;
  try {
    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) swTarget = list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
      if (!swTarget) await sleep(500);
    }
    if (!swTarget) throw new Error('扩展未加载');
    swCdp = new CDP(swTarget.webSocketDebuggerUrl);
    await swCdp.connect();

    console.log('profile 下载目录 : ' + dlDir);
    console.log('真实下载目录     : ' + REAL_DOWNLOADS + '（已快照，结束后清理）\n');

    const dl = async (opts) => swCdp.eval(
      `(async () => { try { const id = await chrome.downloads.download(${JSON.stringify(opts)});` +
      ` return JSON.stringify({ ok: true, id }); }` +
      ` catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); } })()`, true);

    const cases = [
      ['1) 相对子目录：音频下载/probe1.mp3', { url: REMOTE, filename: '音频下载/probe1.mp3' }],
      ['2) 多层子目录：音乐/语音/probe2.mp3', { url: REMOTE, filename: '音乐/语音/probe2.mp3' }],
      ['3) 纯文件名（含中文）：测试曲目.mp3', { url: REMOTE, filename: '测试曲目.mp3' }],
      ['4) 绝对路径：D:\\Music\\probe4.mp3', { url: REMOTE, filename: 'D:\\Music\\probe4.mp3' }],
      ['5) 反引用逃逸：../escape/probe5.mp3', { url: REMOTE, filename: '../escape/probe5.mp3' }]
    ];

    for (const [label, opts] of cases) {
      console.log(label);
      console.log('   调用返回  : ' + await dl(opts));
      await sleep(3000);
      const info = await swCdp.eval(
        `chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })` +
        `.then(r => JSON.stringify(r.map(x => ({ state: x.state, bytes: x.bytesReceived, err: x.error && x.error.current, file: x.filename }))))`, true);
      console.log('   下载条目  : ' + info);
    }

    console.log('\n=== profile 下载目录的实际结构 ===');
    const got = walk(dlDir, dlDir);
    if (!got.length) console.log('   （空）');
    for (const f of got) console.log(`   ${f.rel.padEnd(38)} ${String(f.size).padStart(8)} B`);

    console.log('\n=== saveAs:true ===');
    const t0 = Date.now();
    console.log('   调用返回  : ' + await dl({ url: REMOTE, filename: '另存为.mp3', saveAs: true }) + '  (' + (Date.now() - t0) + 'ms)');
    await sleep(3000);
    const info6 = await swCdp.eval(
      `chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })` +
      `.then(r => JSON.stringify(r.map(x => ({ state: x.state, bytes: x.bytesReceived, err: x.error && x.error.current, file: x.filename }))))`, true);
    console.log('   下载条目  : ' + info6);
    console.log('\n=== 加了 saveAs 之后目录结构 ===');
    for (const f of walk(dlDir, dlDir)) console.log(`   ${f.rel.padEnd(38)} ${String(f.size).padStart(8)} B`);
  } catch (e) {
    console.log('异常: ' + (e && e.message));
  } finally {
    try { if (swCdp) swCdp.close(); } catch (e) {}
    killTree();
    await sleep(800);

    // 清理：真实下载目录里新增的文件
    const after = snapshot(REAL_DOWNLOADS);
    const added = [...after].filter((x) => !before.has(x));
    if (added.length) {
      console.log('\n!! 有文件落进了真实下载目录，正在清理：');
      for (const rel of added) {
        console.log('   ' + rel);
        try { fs.rmSync(path.join(REAL_DOWNLOADS, rel), { force: true }); } catch (e) {}
      }
    } else {
      console.log('\n真实下载目录未被污染 ✓');
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
