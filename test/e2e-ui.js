/**
 * 扩展页面冒烟测试：确认工具栏面板与设置页删改后仍能正常渲染、无 JS 报错。
 * 运行：node test/e2e-ui.js
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CDP_PORT = 9750 + Math.floor(Math.random() * 150);

class CDP {
  constructor(u) { this.u = u; this.id = 0; this.w = new Map(); this.errors = []; }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', (e) => {
        let m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          this.errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          this.errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
        }
        if (m.id && this.w.has(m.id)) { const x = this.w.get(m.id); this.w.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); }
      });
    });
  }
  send(method, params, t) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.w.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.w.has(id)) { this.w.delete(id); rej(new Error('timeout ' + method)); } }, t || 20000);
    });
  }
  async eval(e, aw) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!aw });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
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

(async () => {
  const results = [];
  const ok = (n, pass, info) => { results.push({ n, pass }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + (info ? '\n        → ' + info : '')); };

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-ui-'));
  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'about:blank'
  ], { stdio: 'ignore' });
  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let browser = null;
  const pages = [];
  try {
    const version = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (!version) throw new Error('无法连接调试端口');
    browser = new CDP(version.webSocketDebuggerUrl);
    await browser.connect();

    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) swTarget = list.find((t) => t.type === 'service_worker' && /background\.js$/.test(t.url));
      if (!swTarget) await sleep(500);
    }
    ok('扩展 Service Worker 已注册', !!swTarget, swTarget && swTarget.url);
    if (!swTarget) throw new Error('扩展未加载');
    const extId = swTarget.url.split('/')[2];

    for (const page of ['options.html', 'popup.html']) {
      const url = `chrome-extension://${extId}/src/${page}`;
      const t = await browser.send('Target.createTarget', { url });
      await sleep(2500);
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      const target = list.find((x) => x.id === t.targetId) || list.find((x) => x.url.indexOf(page) >= 0);
      const c = new CDP(target.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await sleep(2200);   // 让页面脚本跑完（设置页会读 storage）
      pages.push(c);

      if (page === 'options.html') {
        const info = await c.eval(`JSON.stringify({
          title: document.title,
          h1: (document.querySelector('h1')||{}).textContent || '',
          fields: document.querySelectorAll('.field').length,
          autoPopup: (document.getElementById('autoPopup')||{}).checked,
          minDur: (document.getElementById('minDurationSeconds')||{}).value,
          minPlay: (document.getElementById('minPlaySeconds')||{}).value,
          sniff: (document.getElementById('sniffToast')||{}).checked,
          saveAs: (document.getElementById('saveAs')||{}).checked,
          subfolder: (document.getElementById('subfolder')||{}).value,
          hasRecordUI: !!document.getElementById('recordMime') || !!document.getElementById('recordBitrate'),
          mentionsRecord: /录制|录音/.test(document.body.innerText) && !/不做录音/.test(document.body.innerText)
        })`);
        const s = JSON.parse(info);
        ok('设置页正常渲染', s.fields > 0 && /聆竹/.test(s.h1), info);
        ok('设置页读到了新的默认值',
          s.autoPopup === true && s.minDur === '0' && s.minPlay === '0' &&
          s.sniff === true && s.saveAs === false && s.subfolder === '音频下载', info);
        ok('设置页已无录音相关项', s.hasRecordUI === false && s.mentionsRecord === false, info);
        ok('设置页无 JS 报错', c.errors.length === 0, JSON.stringify(c.errors));
      } else {
        const info = await c.eval(`JSON.stringify({
          titleText: (document.querySelector('header .t')||{}).textContent || '',
          listHtml: (document.getElementById('list')||{}).innerText || '',
          footerBtn: (document.getElementById('btnOptions2')||{}).textContent || '',
          hasCaptureBtn: !!document.getElementById('btnCapture'),
          mentionsRecord: /录制/.test(document.body.innerText)
        })`);
        const s = JSON.parse(info);
        ok('面板正常渲染且标题正确', /聆竹/.test(s.titleText) && s.listHtml.length > 0, info);
        ok('面板已无「录制」按钮', s.hasCaptureBtn === false && s.mentionsRecord === false, info);
        ok('面板底部按钮存在', /设置/.test(s.footerBtn), info);
        ok('面板无 JS 报错', c.errors.length === 0, JSON.stringify(c.errors));
      }
    }
  } catch (e) {
    console.log('异常: ' + (e && e.message));
    results.push({ n: '运行异常', pass: false });
  } finally {
    pages.forEach((c) => c.close());
    try { if (browser) browser.close(); } catch (e) {}
    killTree();
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n===== 结果：' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();
