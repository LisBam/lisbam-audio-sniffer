/**
 * 真实站点终测：米游社 wiki 角色语音页（用户反馈抓不到的那个页面）
 *
 * 该页面的语音播放器用 new Audio() 创建游离元素，从不插入 DOM。
 * 本测试用真实网络打开该页面 → 点击角色语音的播放按钮 → 检查扩展是否弹出卡片。
 *
 * 运行：node test/e2e-mihoyo.js
 */

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const PAGE = 'https://bbs.mihoyo.com/sr/wiki/content/2302/detail?bbs_presentation_style=no_header';
const CDP_PORT = 9870 + Math.floor(Math.random() * 100);

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
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error('超时 ' + method)); } }, timeout || 40000);
    });
  }
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise }, 40000);
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

const CARD_PROBE = `(() => {
  const h = document.querySelector('[data-audio-sniffer]');
  if (!h || !h.shadowRoot) return { toast: false };
  const card = h.shadowRoot.querySelector('.card');
  return {
    toast: true,
    hidden: card ? card.hidden : null,
    names: Array.from(h.shadowRoot.querySelectorAll('.name')).map(e => e.textContent),
    subs: Array.from(h.shadowRoot.querySelectorAll('.sub')).map(e => e.textContent),
    btns: Array.from(h.shadowRoot.querySelectorAll('.btn.act')).map(e => e.textContent),
    note: (h.shadowRoot.querySelector('.note') || {}).textContent || ''
  };
})()`;

(async () => {
  const results = [];
  const ok = (n, pass, info) => {
    results.push({ n, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + n + (info ? '\n        → ' + info : ''));
  };

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-mihoyo-'));
  const dlDir = path.join(profile, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  // 用 profile 的 Preferences 指定下载目录。
  // 不要用 CDP 的 Browser.setDownloadBehavior：实测它会劫持文件命名，
  // 扩展传的 filename 会被忽略、子目录也不建，导致中文文件名与「音频下载」子目录测不出来。
  const defDir = path.join(profile, 'profile', 'Default');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
    download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dlDir },
    profile: { default_content_setting_values: { automatic_downloads: 1 } }
  }), 'utf8');

  const child = spawn(EDGE, [
    '--user-data-dir=' + path.join(profile, 'profile'),
    '--load-extension=' + EXT,
    '--autoplay-policy=no-user-gesture-required',
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT,
    'about:blank'
  ], { stdio: 'ignore' });

  const killTree = () => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} };

  let pageCdp = null, swCdp = null, browserCdp = null;

  try {
    const version = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
    if (!version) throw new Error('无法连接调试端口');

    browserCdp = new CDP(version.webSocketDebuggerUrl);
    await browserCdp.connect();

    let pageTarget = null, swTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await fetchJson('http://127.0.0.1:' + CDP_PORT + '/json/list', 1);
      if (list) {
        pageTarget = list.find((t) => t.type === 'page');
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

    console.log('打开米游社 wiki 页面（真实网络，内容较大，请稍等）…');
    await pageCdp.send('Page.navigate', { url: PAGE });
    await sleep(18000);

    const info = await pageCdp.eval(`JSON.stringify({
      title: document.title, url: location.href,
      voiceBtns: document.querySelectorAll('.obc-tmpl-character__voice-btn').length,
      audioTags: document.querySelectorAll('audio,video').length,
      hookLoaded: !!window.__LZ_AUDIO_HOOK__
    })`);
    const st = JSON.parse(info);
    ok('页面已加载', /wiki/.test(st.url) && st.voiceBtns > 0, info);
    ok('主世界钩子已注入到该页面', st.hookLoaded === true, 'hookLoaded=' + st.hookLoaded);
    ok('页面确实没有 audio/video 标签（游离元素）', st.audioTags === 0, 'audioTags=' + st.audioTags);

    console.log('\n点击第 1 个角色语音播放按钮…');
    const clicked = await pageCdp.eval(`(() => {
      const els = document.querySelectorAll('.obc-tmpl-character__voice-btn');
      if (!els.length) return 'none';
      els[0].click();
      return 'clicked';
    })()`);
    ok('成功点击语音播放按钮', clicked === 'clicked', clicked);

    await sleep(6000);

    const playState = await pageCdp.eval(`(() => {
      const raw = document.querySelector('[data-audio-sniffer]');
      return JSON.stringify({
        anyPlaying: Array.from(document.querySelectorAll('audio,video')).filter(e=>!e.paused).length,
        hookFound: window.__LZ_AUDIO_HOOK__ ? 'yes' : 'no'
      });
    })()`);
    console.log('页面状态: ' + playState);

    const mediaRaw = await swCdp.eval(`chrome.storage.session.get('mediaMap').then(o => JSON.stringify(Object.values(o.mediaMap||{})))`, true);
    const media = JSON.parse(mediaRaw || '[]');
    const hit = media.find((m) => /act-upload\.mihoyo\.com/.test(m.url) && /\.(wav|mp3|m4a|ogg)/i.test(m.url));
    ok('后台捕获到米游社语音音频', !!hit,
      hit ? `url=${hit.url}\n           kind=${hit.kind} content-type=${hit.contentType} size=${hit.size} detached=${hit.detached} fromHook=${hit.fromHook} toasted=${hit.toasted} title="${hit.title}"`
          : '媒体记录: ' + JSON.stringify(media.map(m => m.url).slice(0, 6)));

    const card = await pageCdp.eval(CARD_PROBE);
    ok('页面角落弹出了简洁卡片', !!(card && card.toast && card.hidden === false), JSON.stringify(card));

    if (card && card.toast) {
      ok('卡片标题是页面/语音名（不是原始 URL）', !!(card.names && card.names.length && !/^https?:/.test(card.names[0])), JSON.stringify(card.names));
      ok('卡片按钮是「下载」', !!(card.btns && card.btns.some((b) => /下载/.test(b))), JSON.stringify(card.btns));

      console.log('\n点「下载」，检查文件是否落盘（真实 CDN）…');
      await pageCdp.eval(`(() => {
        const h = document.querySelector('[data-audio-sniffer]');
        const b = Array.from(h.shadowRoot.querySelectorAll('.btn.act')).find(x => /下载/.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()`);

      let files = [];
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        const walk = (dir) => {
          const out = [];
          if (!fs.existsSync(dir)) return out;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) out.push(...walk(full));
            else out.push({ rel: path.relative(dlDir, full), size: fs.statSync(full).size });
          }
          return out;
        };
        files = walk(dlDir);
        if (files.some((f) => f.size > 1000)) break;
      }
      const dlRaw = await swCdp.eval(`chrome.downloads.search({}).then(r => JSON.stringify(r.map(x=>({s:x.state,b:x.bytesReceived,e:x.error&&x.error.current,f:x.filename}))))`, true);
      ok('语音文件真实下载落盘', files.some((f) => f.size > 1000),
        '文件: ' + JSON.stringify(files) + '\n          下载条目: ' + dlRaw);
      // 真实站点上验证「中文文件名 + 默认子目录」确实生效（CDP 无法伪造这两点）
      ok('落到「音频下载」子目录且文件名是语音名',
        files.some((f) => /音频下载[\\/]/.test(f.rel) && /初次见面/.test(f.rel) && f.size > 1000),
        '文件: ' + JSON.stringify(files));
    }

  } catch (e) {
    console.log('异常: ' + (e && e.message));
    results.push({ n: '运行异常', pass: false });
  } finally {
    try { if (pageCdp) pageCdp.close(); } catch (e) {}
    try { if (swCdp) swCdp.close(); } catch (e) {}
    try { if (browserCdp) browserCdp.close(); } catch (e) {}
    killTree();
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n===== 结果：' + (results.length - failed) + '/' + results.length + ' 通过 =====');
  process.exit(failed ? 1 : 0);
})();
