/**
 * 【聆竹】音频嗅探下载器 —— 内容脚本（注入到所有页面 / 所有框架）
 *
 * 职责：
 *  1. 监听页面里的音视频元素，发现「真正在播放」的音频后上报后台
 *  2. 接收主世界钩子上报的游离元素（new Audio()）播放事件
 *  3. 在页面角落渲染一个简洁卡片（Shadow DOM，不污染页面样式）
 *  4. 作为 chrome.downloads 失败时的「页面代下」兜底（自带 Referer / Cookie）
 */

'use strict';

(() => {
  if (window.__AUDIO_SNIFFER_LOADED__) return;
  window.__AUDIO_SNIFFER_LOADED__ = true;

  const DEFAULT_SETTINGS = {
    autoPopup: true,
    autoCloseSeconds: 12,
    minPlaySeconds: 0,
    minDurationSeconds: 0,
    position: 'bottom-right',
    onlyTopFrame: true,
    showBadge: true,
    sniffToast: true,
    saveAs: false,
    subfolder: '音频下载'
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('settings', (o) => {
          settings = Object.assign({}, DEFAULT_SETTINGS, (o && o.settings) || {});
          resolve(settings);
        });
      } catch (e) {
        resolve(settings);
      }
    });
  }
  loadSettings();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
        applyPosition();
      }
    });
  } catch (e) { /* ignore */ }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ================================================================ */
  /* 一、媒体检测                                                      */
  /* ================================================================ */

  const pendingTimers = new WeakMap();
  const reported = new Set();

  function onMediaEvent(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag !== 'AUDIO' && tag !== 'VIDEO') return;
    scheduleCheck(el);
  }

  document.addEventListener('play', onMediaEvent, true);
  document.addEventListener('playing', onMediaEvent, true);

  function scheduleCheck(el) {
    const old = pendingTimers.get(el);
    if (old) clearTimeout(old);
    const wait = Math.max(0, (settings.minPlaySeconds || 0) * 1000);
    pendingTimers.set(el, setTimeout(() => {
      pendingTimers.delete(el);
      checkAndReport(el);
    }, wait));
  }

  function checkAndReport(el) {
    if (!el.isConnected || el.paused || el.ended) return;
    if (el.muted || el.volume === 0) return;          // 静音播放不用提示
    if (el.currentTime <= 0) return;
    const info = describeMedia(el);
    if (!info) return;
    if (reported.has(info.url)) return;
    reported.add(info.url);
    send({ type: 'media-detected', media: info }).then((resp) => {
      // 被判定为重复（同标签页此前已提示过）也无需再报
      if (!resp || !resp.ok) reported.delete(info.url);
    });
  }

  function readMediaSession() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md) {
        return {
          title: (md.title || '').trim(),
          artist: (md.artist || '').trim(),
          album: (md.album || '').trim()
        };
      }
    } catch (e) { /* ignore */ }
    return { title: '', artist: '', album: '' };
  }

  function describeMedia(el) {
    const url = el.currentSrc || el.src || '';
    if (!url || url === 'about:blank') return null;
    if (!/^(https?|blob):/i.test(url)) return null;
    const isBlob = /^blob:/i.test(url);
    const ms = readMediaSession();
    let title = ms.title || el.getAttribute('title') || el.title || '';
    let artist = ms.artist || '';
    if (!title) title = (document.title || '').trim();
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    // 时长过滤只用在「页面里的音效」上；游离元素（new Audio()）是站点主动播的内容，不过滤
    const detached = !el.isConnected;
    if (!detached && settings.minDurationSeconds > 0 && dur > 0 && dur < settings.minDurationSeconds) return null;
    return {
      url,
      kind: isBlob ? 'blob' : 'file',
      title: title.slice(0, 200),
      artist: artist.slice(0, 120),
      pageTitle: (document.title || '').slice(0, 200),
      pageUrl: location.href,
      duration: Math.round(dur),
      ext: isBlob ? 'webm' : guessExtFromUrl(url),
      detached
    };
  }

  function guessExtFromUrl(url) {
    try {
      const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url).pathname);
      return m ? m[1].toLowerCase() : 'mp3';
    } catch (e) {
      return 'mp3';
    }
  }

  /* ================================================================ */
  /* 二、简洁弹窗（Shadow DOM）                                        */
  /* ================================================================ */

  const MAX_ROWS = 3;
  let hostEl = null;
  let shadow = null;
  let rowsEl = null;
  let noteEl = null;
  let hideTimer = null;
  let noteTimer = null;
  let items = [];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card {
      font: 12px/1.45 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
      width: 316px;
      background: rgba(26, 28, 34, .95);
      color: #eef1f6;
      border: 1px solid rgba(255, 255, 255, .10);
      border-radius: 10px;
      box-shadow: 0 8px 26px rgba(0, 0, 0, .34);
      padding: 5px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      animation: in .18s ease-out;
      pointer-events: auto;
    }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; }
    .row:hover { background: rgba(255, 255, 255, .06); }
    .icon { flex: 0 0 auto; width: 16px; height: 16px; color: #7cb0ff; }
    .meta { flex: 1 1 auto; min-width: 0; }
    .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; font-size: 12px; }
    .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10.5px; color: #9aa3b2; margin-top: 1px; }
    .btn {
      flex: 0 0 auto; appearance: none; border: 0; cursor: pointer;
      background: #2f6fed; color: #fff; font: inherit; font-size: 11.5px; font-weight: 600;
      padding: 4px 10px; border-radius: 999px; line-height: 1.5;
    }
    .btn:hover { background: #4a82f2; }
    .btn:active { background: #2a62d4; }
    .btn.ghost { background: rgba(255, 255, 255, .10); color: #dfe5ee; }
    .btn.ghost:hover { background: rgba(255, 255, 255, .18); }
    .btn.rec { background: #e5484d; }
    .btn.rec:hover { background: #f2585d; }
    .x {
      flex: 0 0 auto; appearance: none; border: 0; background: transparent; cursor: pointer;
      color: #8d96a5; font: inherit; font-size: 13px; line-height: 1; padding: 3px 4px; border-radius: 5px;
    }
    .x:hover { color: #fff; background: rgba(255, 255, 255, .10); }
    .note { font-size: 10.5px; color: #9aa3b2; padding: 1px 8px 3px 30px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sep { height: 1px; background: rgba(255, 255, 255, .08); margin: 3px 6px; }
  `;

  const ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

  function ensureUI() {
    if (hostEl && hostEl.isConnected) return;
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-audio-sniffer', '1');
    hostEl.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + CSS + '</style><div class="card" hidden></div>';
    const card = shadow.querySelector('.card');
    card.innerHTML = '<div class="rows"></div><div class="note" hidden></div>';
    rowsEl = card.querySelector('.rows');
    noteEl = card.querySelector('.note');
    card.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
    card.addEventListener('mouseleave', () => scheduleHide());
    (document.body || document.documentElement).appendChild(hostEl);
    attachDrag(card);
    applyPosition();
  }

  function applyPosition() {
    if (!hostEl || !hostEl.style) return;
    const p = settings.position || 'bottom-right';
    const gap = '14px';
    hostEl.style.top = 'auto';
    hostEl.style.bottom = 'auto';
    hostEl.style.left = 'auto';
    hostEl.style.right = 'auto';
    hostEl.style.transform = 'none';
    if (p.indexOf('top') === 0) hostEl.style.top = gap;
    else hostEl.style.bottom = gap;
    if (p.indexOf('left') > 0 || p === 'top-left' || p === 'bottom-left') hostEl.style.left = gap;
    if (p === 'top-right' || p === 'bottom-right') hostEl.style.right = gap;
  }

  /** 允许用户拖动卡片，拖过之后就固定在拖到的位置 */
  function attachDrag(card) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const head = () => card;
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = hostEl.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      hostEl.style.left = r.left + 'px';
      hostEl.style.top = r.top + 'px';
      hostEl.style.right = 'auto';
      hostEl.style.bottom = 'auto';
      hostEl.style.transform = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      hostEl.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + 'px';
      hostEl.style.top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy)) + 'px';
    }, true);
    window.addEventListener('mouseup', () => { dragging = false; }, true);
    void head;
  }

  function showCard() {
    ensureUI();
    const card = shadow.querySelector('.card');
    card.hidden = false;
    applyPosition();
  }

  function hideCard() {
    if (!shadow) return;
    const card = shadow.querySelector('.card');
    if (card) card.hidden = true;
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    const sec = Number(settings.autoCloseSeconds) || 0;
    if (sec <= 0) return;
    hideTimer = setTimeout(() => { hideCard(); }, sec * 1000);
  }

  function shortUrl(u) {
    try {
      const p = new URL(u);
      const file = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
      return (p.hostname + (file ? ' / ' + file : '')).slice(0, 70);
    } catch (e) {
      return String(u).slice(0, 70);
    }
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function addItem(item) {
    if (!item || !item.url) return;
    if (items.some((x) => x.id === item.id || x.url === item.url)) {
      showCard(); scheduleHide(); return;
    }
    items.unshift(item);
    if (items.length > MAX_ROWS) items = items.slice(0, MAX_ROWS);
    showCard();
    renderRows();
    scheduleHide();
  }

  function renderRows() {
    ensureUI();
    rowsEl.textContent = '';
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'row';
      const undownloadable = item.kind === 'stream';
      const sub = (item.artist ? item.artist + ' · ' : '') +
        (undownloadable ? '分片流，无法直接下载' : (fmtSize(item.size) || shortUrl(item.url)));
      row.innerHTML =
        ICON +
        '<div class="meta"><div class="name"></div><div class="sub"></div></div>' +
        '<button class="btn act"></button>' +
        '<button class="x" title="不再提示">✕</button>';
      row.querySelector('.name').textContent = item.title || shortUrl(item.url);
      row.querySelector('.name').title = item.title || item.url;
      row.querySelector('.sub').textContent = sub;
      const act = row.querySelector('.act');
      act.textContent = undownloadable ? '不可下载' : '下载';
      if (undownloadable) {
        act.disabled = true;
        act.classList.add('ghost');
        act.style.opacity = '.55';
        act.style.cursor = 'default';
      } else {
        act.addEventListener('click', () => onAction(item, act));
      }
      row.querySelector('.x').addEventListener('click', () => {
        items = items.filter((x) => x.id !== item.id);
        if (!items.length) hideCard(); else renderRows();
      });
      rowsEl.appendChild(row);
      if (rowsEl.children.length > 1) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        rowsEl.insertBefore(sep, row);
      }
    });
  }

  async function onAction(item, btn) {
    btn.disabled = true;
    btn.textContent = '下载中';
    const resp = await send({ type: 'toast-download', mediaId: item.id });
    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = '已开始';
      note(resp.saveAs
        ? '已弹出「另存为」对话框，请选择位置和文件名'
        : '已开始下载：' + (resp.filename || item.title || ''));
      scheduleHide();
      // 几秒后恢复成「下载」：想再存一份、或在「另存为」里点了取消，都能直接重来
      setTimeout(() => { if (btn.textContent === '已开始') btn.textContent = '下载'; }, 4000);
    } else {
      btn.textContent = '下载';
      note('下载失败：' + ((resp && resp.error) || '未知原因'));
    }
  }

  function note(text) {
    ensureUI();
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.hidden = false;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { noteEl.hidden = true; }, 6000);
    scheduleHide();
  }

  /* ================================================================ */
  /* 三、下载兜底：直连下载失败时由页面内 fetch → blob → 另存            */
  /* ================================================================ */

  function sanitizeName(n) {
    return String(n || 'audio').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'audio';
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 120000);
  }

  const EXT_BY_MIME = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/x-ms-wma': 'wma'
  };

  /** 后台 chrome.downloads 被服务器拒绝时，由页面代下（自带 Referer / Cookie） */
  async function pageFetchDownload(item) {
    if (!item || !item.url) return { ok: false, error: '无效的音频地址' };
    let blob;
    try {
      const resp = await fetch(item.url, { credentials: 'include' });
      if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
      blob = await resp.blob();
    } catch (e) {
      const isBlob = /^blob:/i.test(item.url);
      return {
        ok: false,
        error: isBlob
          ? '该音频由网页实时合成（分片流），没有可下载的完整文件'
          : ((e && e.message) || String(e))
      };
    }
    if (!blob || !blob.size) return { ok: false, error: '下载到的内容为空' };
    // 用实际 MIME 决定扩展名，比猜 URL 后缀准
    const mime = String(blob.type || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mime] || item.ext || 'mp3';
    const name = sanitizeName(item.title || item.pageTitle || 'audio') + '.' + ext;
    saveBlob(blob, name);
    note('已通过页面下载：' + name + '（' + fmtSize(blob.size) + '）');
    return { ok: true, filename: name };
  }

  /* ================================================================ */
  /* 四、来自页面主世界钩子的消息（游离 new Audio() 元素就靠它才能发现）  */
  /* ================================================================ */

  /** 钩子报来的播放事件：走和 DOM 检测完全相同的上报通道 */
  function onHookPlayed(media) {
    if (!media || !media.url) return;
    if (reported.has(media.url)) return;
    reported.add(media.url);
    send({ type: 'media-detected', media }).then((resp) => {
      if (!resp || !resp.ok) reported.delete(media.url);
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__lzAudioSniffer !== true) return;
    if (d.type === 'played') onHookPlayed(d.media);
  });

  /* ================================================================ */
  /* 五、消息处理                                                      */
  /* ================================================================ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'toast-show':
        addItem(msg.item);
        sendResponse({ ok: true });
        return;
      case 'notify':
        note(msg.text || '');
        sendResponse({ ok: true });
        return;
      case 'page-fetch-download':
        pageFetchDownload(msg.item).then(sendResponse);
        return true;
      default:
        return;
    }
  });
})();
