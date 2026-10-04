/**
 * 【聆竹】音频嗅探下载器 —— 页面主世界钩子（world: MAIN, document_start）
 *
 * 为什么需要它：
 *   很多播放器用 `new Audio()` 创建**从不插入 DOM 的游离音频元素**（米游社 wiki 角色语音就是），
 *   游离元素的 play 事件不会流经 document，内容脚本的事件委托完全看不到它。
 *   所以必须在页面自己的 JS 世界里直接 patch 播放入口。
 *
 * 只做一件事：发现播放 → postMessage 告诉内容脚本（文本消息，跨世界安全）。
 */

'use strict';

(() => {
  if (window.__LZ_AUDIO_HOOK__) return;
  window.__LZ_AUDIO_HOOK__ = true;

  const lastReport = new Map();  // url -> 上次上报时间

  function post(msg) {
    try {
      window.postMessage(Object.assign({ __lzAudioSniffer: true }, msg), '*');
    } catch (e) { /* ignore */ }
  }

  function guessExt(url) {
    try {
      const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url, location.href).pathname);
      return m ? m[1].toLowerCase() : 'mp3';
    } catch (e) {
      return 'mp3';
    }
  }

  /* ---------------- 标题：从「刚被点击的那一行」里取名字 ---------------- */
  /*
   * 很多播放器既不设 mediaSession.metadata、也没有 title 属性，
   * 只能用页面标题当名字 —— 结果同一页所有音频全部重名。
   * 但这类播放器都是「点某一行 → 播放」，所以顺着刚点击的元素往上找这一行，
   * 再取行内第一段像名字的文本，基本就是这一条音频的名字。
   */

  let lastClick = null;
  let lastClickAt = 0;
  try {
    document.addEventListener('click', (e) => {
      lastClick = e.target;
      lastClickAt = Date.now();
    }, true);
  } catch (e) { /* ignore */ }

  /** 行内第一段"像名字"的文本（跳过纯数字/时长一类的片段） */
  function pickLeafText(root) {
    const cands = [];
    const walk = (el, depth) => {
      if (depth > 3) return;
      for (const c of el.children) {
        const t = (c.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) { walk(c, depth + 1); continue; }
        if (c.children.length === 0) cands.push(t);
        else if (t.length <= 30) cands.push(t);
        else walk(c, depth + 1);
      }
    };
    try { walk(root, 0); } catch (e) { return ''; }
    for (const t of cands) {
      if (t.length < 2 || t.length > 60) continue;
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) continue;   // 必须含中文或字母
      if (/^[\d:：.\-\s]+$/.test(t)) continue;           // 排除 "00:12" 这类
      return t;
    }
    return '';
  }

  function guessTitleFromClick() {
    if (!lastClick || Date.now() - lastClickAt > 8000) return '';
    let node = lastClick;
    let row = null;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length <= 90) { row = node; break; }   // 第一个「有文本且不太长」的祖先 = 这一行
    }
    if (!row) return '';
    const leaf = pickLeafText(row);
    if (leaf) return leaf.slice(0, 60);
    const own = (row.textContent || '').replace(/\s+/g, ' ').trim();
    return own.length <= 60 ? own : '';
  }

  function readMeta() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md) return { title: (md.title || '').trim(), artist: (md.artist || '').trim() };
    } catch (e) { /* ignore */ }
    return { title: '', artist: '' };
  }

  /* ---------------- 描述与上报 ---------------- */

  function describe(el) {
    let url = '';
    try { url = el.currentSrc || el.src || ''; } catch (e) { return null; }
    if (!url || !/^(https?|blob):/i.test(url)) return null;

    const ms = readMeta();
    let title = ms.title || (el.getAttribute && el.getAttribute('title')) || '';
    if (!title) title = guessTitleFromClick();
    if (!title) title = (document.title || '').trim();

    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    const isBlob = /^blob:/i.test(url);
    return {
      url,
      kind: isBlob ? 'blob' : 'file',
      title: String(title).slice(0, 200),
      artist: String(ms.artist || '').slice(0, 120),
      pageTitle: String(document.title || '').slice(0, 200),
      pageUrl: location.href,
      duration: Math.round(dur),
      ext: isBlob ? 'bin' : guessExt(url),
      detached: !el.isConnected,
      fromHook: true
    };
  }

  function report(el) {
    if (!el || el.nodeType !== 1) return;
    let info;
    try { info = describe(el); } catch (e) { return; }
    if (!info) return;
    if (el.muted || el.volume === 0) return;

    const now = Date.now();
    if (now - (lastReport.get(info.url) || 0) < 1500) return;
    lastReport.set(info.url, now);

    // 稍等一下再上报：让 duration 就绪、让站点写入 mediaSession 标题（音乐站会填歌名）
    setTimeout(() => {
      try {
        if (el.paused || el.ended) return;
        post({ type: 'played', media: describe(el) || info });
      } catch (e) { /* ignore */ }
    }, 1000);
  }

  /* ---------------- 挂载点 1：play() ---------------- */

  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try { report(this); } catch (e) { /* ignore */ }
      return origPlay.apply(this, args);
    };
  } catch (e) { /* ignore */ }

  /* ---------------- 挂载点 2：new Audio() ---------------- */

  try {
    const OrigAudio = window.Audio;
    if (typeof OrigAudio === 'function') {
      const PatchedAudio = function Audio(src) {
        const el = arguments.length ? new OrigAudio(src) : new OrigAudio();
        watch(el);
        return el;
      };
      PatchedAudio.prototype = OrigAudio.prototype;
      Object.defineProperty(PatchedAudio, 'name', { value: 'Audio' });
      window.Audio = PatchedAudio;
    }
  } catch (e) { /* ignore */ }

  /* ---------------- 挂载点 3：createElement('audio'/'video') ---------------- */
  /* 覆盖「设置 src + autoplay 属性但从不调用 play()」的写法 */

  try {
    const origCE = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, ...rest) {
      const el = origCE.call(this, tag, ...rest);
      try {
        const t = String(tag).toLowerCase();
        if (t === 'audio' || t === 'video') watch(el);
      } catch (e) { /* ignore */ }
      return el;
    };
  } catch (e) { /* ignore */ }

  function watch(el) {
    try {
      if (!el || el.__lzWatched) return;
      el.__lzWatched = true;
      const h = () => report(el);
      el.addEventListener('playing', h, true);
      el.addEventListener('play', h, true);
    } catch (e) { /* ignore */ }
  }
})();
