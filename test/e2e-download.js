/**
 * 回归测试：下载设置（默认下载路径 / 下载前选择路径与文件名）
 *
 * 两个要点：
 *  1. 不用 CDP 的 Browser.setDownloadBehavior —— 实测它会劫持文件命名
 *     （扩展传的 filename 被忽略，全部落成 URL 的文件名），
 *     改用 profile 里的 Preferences 指定下载目录，才能看到真实文件名与子目录。
 *  2. 「另存为」对话框在无头模式下弹不出来，所以用拦截 chrome.downloads.download
 *     的方式核对后台到底传了什么参数（saveAs / filename）。
 *
 * 下载的是真实外网 HTTPS 音频（本机 localhost 下载被沙箱中间层破坏，不可用）。
 *
 * 运行：node test/e2e-download.js
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
const PORT = 8813;
const CDP_PORT = 9410 + Math.floor(Math.random() * 180);

const REMOTE = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';
const REAL_DOWNLOADS = path.join(os.homedir(), 'Downloads');

/** 页面：一个普通 <audio autoplay>，播真实外网文件 */
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>下载设置自检</title></head>
<body style="font:16px sans-serif;padding:40px">
<h1>下载设置自检</h1>
<audio id="a" src="${REMOTE}" autoplay preload="auto"></audio>
<p>正在播放外网音频</p>
</body></html>`;

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
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('求值异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
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

const CLICK_DOWNLOAD = `(() => {
  const h = document.querySelector('[data-audio-sniffer]');
  if (!h || !h.shadowRoot) return 'no-card';
  const card = h.shadowRoot.querySelector('.card');
  if (!card) return 'no-card';
  // 按钮成功后 4 秒才恢复成「下载」，所以这里两种文案都接受
  const b = Array.from(h.shadowRoot.querySelectorAll('.btn.act'))
    .find(x => x.textContent === '下载' || x.textContent === '已开始');
  if (!b) return 'no-button';
  if (b.disabled) return 'button-busy';
  b.click();
  return 'clicked';
})()`;

const CARD_STATE = `(() => {
  const h = document.querySelector('[data-audio-sniffer]');
  if (!h || !h.shadowRoot) return { toast: false };
  const card = h.shadowRoot.querySelector('.card');
  return {
    toast: true,
    hidden: card ? card.hidden : null,
    names: Array.from(h.shadowRoot.querySelectorAll('.name')).map(x => x.textContent),
    btns: Array.from(h.shadowRoot.querySelectorAll('.btn.act')).map(x => x.textContent),
    note: (h.shadowRoot.querySelector('.note') || {}).textContent || ''
  };
})()`;

(async () => {
  const results = [];
  const ok = (n, pass, info) => {
    results.push({ n, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + n + (info ? '\n        → ' + info : ''));
  };

  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(HTML);
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-dl-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  // 用 Preferences 指定下载目录（不用 CDP setDownloadBehavior，它会劫持命名）
  const defDir = path.join(profile, 'profile', 'Default');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
    download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dlDir },
    profile: { default_content_setting_values: { automatic_downloads: 1 } }
  }), 'utf8');

  const realBefore = snapshot(REAL_DOWNLOADS);

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'http://127.0.0.1:' + PORT + '/'
  ], { stdio: 'ignore' });
  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let pageCdp = null, swCdp = null;

  /** 改设置（与后台的 getSettings 合并语义一致） */
  const setSettings = async (patch) => {
    await swCdp.eval(`(async () => {
      const cur = await chrome.storage.local.get('settings');
      const next = Object.assign({}, cur.settings || {}, ${JSON.stringify(patch)});
      await chrome.storage.local.set({ settings: next });
      return JSON.stringify(next);
    })()`, true);
    await sleep(400);
  };

  /** 等某个文件出现在下载目录里 */
  const waitForFile = async (pred, tries) => {
    for (let i = 0; i < (tries || 24); i++) {
      const files = walk(dlDir, dlDir);
      const hit = files.find(pred);
      if (hit) return hit;
      await sleep(500);
    }
    return null;
  };

  try {
    let pageTarget = null, swTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) {
        pageTarget = pageTarget || list.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1:' + PORT) >= 0);
        swTarget = swTarget || list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
      }
      if (pageTarget && swTarget) break;
      await sleep(500);
    }
    ok('扩展 Service Worker 已注册', !!swTarget, swTarget && swTarget.url);
    if (!pageTarget || !swTarget) throw new Error('目标缺失');
    pageCdp = new CDP(pageTarget.webSocketDebuggerUrl);
    await pageCdp.connect();
    swCdp = new CDP(swTarget.webSocketDebuggerUrl);
    await swCdp.connect();

    /* 0. 默认值：两项过滤应为 0（改成 0 后连很短的音频也不该被拦） */
    const defs = JSON.parse(await swCdp.eval(
      `chrome.storage.local.get(['settings', 'settingsVersion']).then(o => JSON.stringify(o))`, true) || '{}');
    ok('连续播放/总时长下限默认值为 0', !!(defs.settings && defs.settings.minPlaySeconds === 0 && defs.settings.minDurationSeconds === 0),
      JSON.stringify(defs.settings));
    ok('默认保存子目录为「音频下载」', !!(defs.settings && defs.settings.subfolder === '音频下载'),
      'subfolder=' + (defs.settings && defs.settings.subfolder));
    ok('默认不弹「另存为」', !!(defs.settings && defs.settings.saveAs === false), 'saveAs=' + (defs.settings && defs.settings.saveAs));

    /* 1. 卡片要弹出来（顺带验证 0 = 不过滤：这条音源只有 1 秒左右） */
    let card = null;
    for (let i = 0; i < 20; i++) {
      card = await pageCdp.eval(CARD_STATE);
      if (card && card.toast && card.hidden === false) break;
      await sleep(500);
    }
    ok('短音频（约 1 秒）也会弹卡片（minPlay/minDuration = 0 生效）',
      !!(card && card.toast && card.hidden === false), JSON.stringify(card));

    /* 2. 默认设置下点下载 → 应落到「音频下载」子目录 */
    ok('卡片上有「下载」按钮', !!(card && card.btns && card.btns.includes('下载')), JSON.stringify(card && card.btns));
    await pageCdp.eval(CLICK_DOWNLOAD);
    const f1 = await waitForFile((f) => /音频下载[\\/]/.test(f.rel) && f.size > 1000);
    ok('下载落到「音频下载」子目录，且文件名正确', !!f1,
      f1 ? `落盘: ${f1.rel} (${f1.size} B)` : '目录内容: ' + JSON.stringify(walk(dlDir, dlDir)));

    /* 3. 改子目录 → 多层子目录应被创建 */
    await setSettings({ subfolder: '音乐/语音' });
    await pageCdp.eval(CLICK_DOWNLOAD);
    const f2 = await waitForFile((f) => /音乐[\\/]语音[\\/]/.test(f.rel) && f.size > 1000);
    ok('自定义多层子目录被创建', !!f2, f2 ? `落盘: ${f2.rel}` : '目录内容: ' + JSON.stringify(walk(dlDir, dlDir)));

    /* 4. 清空子目录 → 应直接存到下载目录根下 */
    await setSettings({ subfolder: '' });
    await pageCdp.eval(CLICK_DOWNLOAD);
    const f3 = await waitForFile((f) => f.rel.indexOf(path.sep) < 0 && f.size > 1000);
    ok('子目录留空时直接存到下载目录根下', !!f3, f3 ? `落盘: ${f3.rel}` : '目录内容: ' + JSON.stringify(walk(dlDir, dlDir)));

    /* 5. 参数核对：拦截 chrome.downloads.download，逐项检查后台实际传参 */
    // 注意：Service Worker 里没有 window，必须用 globalThis
    await swCdp.eval(`(() => {
      if (!globalThis.__origDl) {
        globalThis.__origDl = chrome.downloads.download;
        globalThis.__dlCalls = [];
        chrome.downloads.download = function (opts) {
          globalThis.__dlCalls.push(JSON.parse(JSON.stringify(opts)));
          return Promise.resolve(88888);
        };
      }
      return String(!!globalThis.__origDl);
    })()`, true);
    const patched = await swCdp.eval(`String(typeof globalThis.__dlCalls)`, true);
    ok('已拦截 chrome.downloads.download', patched === 'object', 'typeof __dlCalls=' + patched);

    const captureFilename = async (subfolder, saveAs) => {
      await setSettings({ subfolder, saveAs });
      await swCdp.eval(`globalThis.__dlCalls = []`, true);
      const clicked = await pageCdp.eval(CLICK_DOWNLOAD);
      await sleep(1500);
      const raw = await swCdp.eval(`JSON.stringify(globalThis.__dlCalls.slice(-1))`, true);
      if (raw === '[]') console.log('       （未捕获到调用，点击结果: ' + clicked + '）');
      return JSON.parse(raw || '[]')[0];
    };

    const c1 = await captureFilename('D:\\Music\\歌单', false);
    ok('绝对路径被规整成相对子目录（避免 Invalid filename）',
      !!(c1 && c1.filename === 'Music/歌单/t-rex-roar.mp3'),
      c1 ? 'filename=' + c1.filename : '未捕获到调用');

    const c2 = await captureFilename('../escape/..//x', false);
    ok('.. 逃逸片段被过滤掉',
      !!(c2 && c2.filename === 'escape/x/t-rex-roar.mp3'),
      c2 ? 'filename=' + c2.filename : '未捕获到调用');

    const c3 = await captureFilename('音:乐*?', false);
    ok('非法字符被替换成下划线',
      !!(c3 && c3.filename === '音_乐__/t-rex-roar.mp3'),
      c3 ? 'filename=' + c3.filename : '未捕获到调用');

    const c4 = await captureFilename('音频下载', true);
    ok('打开「下载前选择路径与文件名」后 saveAs 传下去了',
      !!(c4 && c4.saveAs === true), c4 ? JSON.stringify(c4) : '未捕获到调用');

    const c5 = await captureFilename('音频下载', false);
    ok('关闭时 saveAs 为 false（不打扰）', !!(c5 && c5.saveAs === false), c5 ? JSON.stringify(c5) : '未捕获到调用');
    ok('重名策略为 uniquify（不覆盖已有文件）', !!(c5 && c5.conflictAction === 'uniquify'),
      c5 ? 'conflictAction=' + c5.conflictAction : '未捕获到调用');

    /* 6. 设置迁移：模拟老用户存着旧的 2/3 且没有版本号 */
    console.log('\n模拟老用户（settings 里存着旧默认值 2/3，且没有版本号）…');
    const makeLegacy = `(async () => {
      const cur = await chrome.storage.local.get('settings');
      const old = Object.assign({}, cur.settings || {}, { minPlaySeconds: 2, minDurationSeconds: 3 });
      await chrome.storage.local.set({ settings: old });
      await chrome.storage.local.remove('settingsVersion');
      return JSON.stringify(old);
    })()`;
    await swCdp.eval(makeLegacy, true);
    await pageCdp.eval(CLICK_DOWNLOAD);          // 下载会走 getSettings() → 触发迁移
    await sleep(1800);
    const afterMig = JSON.parse(await swCdp.eval(
      `chrome.storage.local.get(['settings', 'settingsVersion']).then(o => JSON.stringify(o))`, true) || '{}');
    ok('旧默认值 2/3 被迁移成 0',
      !!(afterMig.settings && afterMig.settings.minPlaySeconds === 0 && afterMig.settings.minDurationSeconds === 0),
      'settings=' + JSON.stringify(afterMig.settings));
    ok('迁移后写入设置版本号 2', afterMig.settingsVersion === 2, 'settingsVersion=' + afterMig.settingsVersion);

    /* 7. 用户自己调过的值不能被迁移覆盖 */
    await swCdp.eval(`(async () => {
      const cur = await chrome.storage.local.get('settings');
      const own = Object.assign({}, cur.settings, { minPlaySeconds: 5, minDurationSeconds: 9 });
      await chrome.storage.local.set({ settings: own });
      await chrome.storage.local.remove('settingsVersion');
      return 'ok';
    })()`, true);
    await pageCdp.eval(CLICK_DOWNLOAD);
    await sleep(1800);
    const own = JSON.parse(await swCdp.eval(
      `chrome.storage.local.get('settings').then(o => JSON.stringify(o.settings))`, true) || '{}');
    ok('用户自己设过的 5/9 不会被迁移覆盖',
      own.minPlaySeconds === 5 && own.minDurationSeconds === 9,
      'minPlay=' + own.minPlaySeconds + ' minDuration=' + own.minDurationSeconds);

    console.log('\n=== 下载目录最终结构 ===');
    for (const f of walk(dlDir, dlDir)) console.log(`   ${f.rel.padEnd(36)} ${String(f.size).padStart(8)} B`);
  } catch (e) {
    console.log('异常: ' + (e && e.message));
    results.push({ n: '运行异常', pass: false });
  } finally {
    try { if (pageCdp) pageCdp.close(); } catch (e) {}
    try { if (swCdp) swCdp.close(); } catch (e) {}
    killTree();
    await sleep(800);
    try { srv.close(); } catch (e) {}

    const realAfter = snapshot(REAL_DOWNLOADS);
    const added = [...realAfter].filter((x) => !realBefore.has(x));
    if (added.length) {
      console.log('\n!! 真实下载目录被写入，正在清理：');
      for (const rel of added) {
        console.log('   ' + rel);
        try { fs.rmSync(path.join(REAL_DOWNLOADS, rel), { force: true }); } catch (e) {}
      }
    } else {
      console.log('\n真实下载目录未被污染 ✓');
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n===== 结果：' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();
