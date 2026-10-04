/**
 * 【聆竹】音频嗅探下载器 —— 后台 Service Worker
 *
 * 职责：
 *  1. 汇总「内容脚本上报的正在播放的媒体」与「webRequest 嗅探到的音频请求」
 *  2. 通过 chrome.downloads 下载可直接下载的音频文件（不受页面 CORS 限制）
 *  3. 直连下载被服务器拒绝时，回退到「页面内 fetch → blob 下载」（自带 Referer / Cookie）
 *  4. 维护标签页角标、弹出卡片、工具栏面板的数据
 */

'use strict';

const MEDIA_KEY = 'mediaMap';
const SETTINGS_KEY = 'settings';

/** 可直接下载的音频容器类型（拿到这些 Content-Type 就能整文件下载） */
const DIRECT_CT = [
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac',
  'audio/ogg', 'audio/opus', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/flac', 'audio/x-flac', 'audio/ape', 'audio/x-ms-wma', 'audio/mid', 'audio/x-aiff',
  'application/ogg', 'application/octet-stream;audio'
];

/** 明显是「流/分片」的类型，没有完整文件可下载 */
const STREAM_CT = [
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl',
  'application/dash+xml', 'video/vnd.mpeg.dash.mpd', 'application/mpegurl',
  'audio/mp4;segments', 'video/mp2t'
];

const DEFAULT_SETTINGS = {
  autoPopup: true,          // 播放音频时自动弹出简洁卡片
  autoCloseSeconds: 12,     // 卡片自动消失秒数（0 = 不自动消失）
  minPlaySeconds: 0,        // 连续播放多少秒后才提示（0 = 不过滤）
  minDurationSeconds: 0,    // 媒体总时长小于该值不提示（0 = 不过滤）
  position: 'bottom-right',
  onlyTopFrame: true,       // 在页面主框架显示卡片
  showBadge: true,          // 工具栏图标显示已发现数量
  sniffToast: true,         // 纯嗅探（没有媒体元素）时也弹卡片
  saveAs: false,            // 下载前弹「另存为」对话框（可改文件名与文件夹）
  subfolder: '音频下载'      // 浏览器下载目录下的子文件夹
};

/**
 * 设置结构版本。
 * v1.3.0 起把「连续播放多久才提示」「音频总时长下限」的默认值从 2/3 改成 0，
 * 老用户 storage 里存着旧值，需要迁移一次，否则改了默认值他们也看不到变化。
 */
const SETTINGS_VERSION_KEY = 'settingsVersion';
const SETTINGS_VERSION = 2;
const LEGACY_DEFAULTS = { minPlaySeconds: 2, minDurationSeconds: 3 };

/** 同一地址多久内不重复弹卡片 */
const QUIET_MS = 5 * 60 * 1000;

/** tabId -> 最近一次「页面元素播放」被检测到的时间 */
const lastElementDetectAt = new Map();
/** tabId -> 最近一次「纯嗅探」弹卡片的时间 */
const lastSniffToastAt = new Map();

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */

async function loadMediaMap() {
  try {
    const o = await chrome.storage.session.get(MEDIA_KEY);
    return o[MEDIA_KEY] || {};
  } catch (e) {
    return {};
  }
}

async function saveMediaMap(map) {
  try {
    await chrome.storage.session.set({ [MEDIA_KEY]: map });
  } catch (e) { /* 忽略 */ }
}

async function clearTabMedia(tabId) {
  const map = await loadMediaMap();
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k].tabId === tabId) { delete map[k]; changed = true; }
  }
  if (changed) {
    await saveMediaMap(map);
    await updateBadge(tabId);
  }
}

async function getTabMedia(tabId) {
  const map = await loadMediaMap();
  return Object.values(map)
    .filter((m) => m.tabId === tabId)
    .sort((a, b) => b.ts - a.ts);
}

/**
 * 一次性设置迁移。
 * 只有存的值「恰好还是旧默认值」时才改成新默认值 —— 说明用户没手动动过它；
 * 用户自己调过的值（比如 5 秒）保持不动，不擅自覆盖。
 */
async function migrateSettings(stored) {
  let ver = 1;
  try {
    const o = await chrome.storage.local.get(SETTINGS_VERSION_KEY);
    ver = Number(o[SETTINGS_VERSION_KEY]) || 1;
  } catch (e) {
    return stored;
  }
  if (ver >= SETTINGS_VERSION) return stored;

  const next = Object.assign({}, stored);
  for (const k of Object.keys(LEGACY_DEFAULTS)) {
    if (Number(next[k]) === LEGACY_DEFAULTS[k]) next[k] = 0;
  }
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: next,
      [SETTINGS_VERSION_KEY]: SETTINGS_VERSION
    });
  } catch (e) { /* 迁移失败不影响使用，下次再试 */ }
  return next;
}

async function getSettings() {
  try {
    const o = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = await migrateSettings(o[SETTINGS_KEY] || {});
    return Object.assign({}, DEFAULT_SETTINGS, stored);
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

/* ------------------------------------------------------------------ */
/* 媒体记录                                                            */
/* ------------------------------------------------------------------ */

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function mediaKey(tabId, url) {
  return tabId + ':' + hashStr(url);
}

/** 合并写入一条媒体记录，返回 { record, isNew } */
async function upsertMedia(patch) {
  const map = await loadMediaMap();
  const id = patch.id || mediaKey(patch.tabId, patch.url);
  const old = map[id];
  const rec = Object.assign(
    {
      id,
      tabId: patch.tabId,
      frameId: patch.frameId || 0,
      url: patch.url,
      kind: 'file',           // file | blob | stream
      ext: '',
      title: '',
      artist: '',
      pageTitle: '',
      pageUrl: '',
      contentType: '',
      size: 0,
      duration: 0,
      toasted: false,
      toastedAt: 0,
      fellBack: false,
      ts: Date.now()
    },
    old || {},
    patch,
    { id, ts: old ? Math.max(old.ts, patch.ts || 0) : Date.now() }
  );
  // 不因为一次信息更少的更新而丢掉已知信息
  if (old) {
    rec.title = patch.title || old.title;
    rec.artist = patch.artist || old.artist;
    rec.contentType = patch.contentType || old.contentType;
    rec.size = patch.size || old.size;
    rec.duration = patch.duration || old.duration;
    rec.ext = patch.ext || old.ext;
    rec.kind = pickKind(old.kind, patch.kind);
  }
  map[id] = rec;
  await saveMediaMap(map);
  return { record: rec, isNew: !old };
}

/** blob 永远优先（不能直接下载），其次 stream，最后 file */
function pickKind(a, b) {
  const rank = { file: 0, stream: 1, blob: 2 };
  if (!b) return a;
  if (!a) return b;
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

/** 由 Content-Type / URL 推断扩展名 */
function guessExt(contentType, url) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const table = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/x-ms-wma': 'wma',
    'audio/midi': 'mid', 'audio/x-aiff': 'aiff', 'application/ogg': 'ogg'
  };
  if (table[ct]) return table[ct];
  try {
    const p = new URL(url);
    const m = /\.([a-z0-9]{2,5})$/i.exec(p.pathname);
    if (m) return m[1].toLowerCase();
  } catch (e) { /* ignore */ }
  return 'mp3';
}

function isDirectType(contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return false;
  if (STREAM_CT.some((s) => ct === s.split(';')[0])) return false;
  if (ct.startsWith('audio/')) return true;
  if (DIRECT_CT.includes(ct)) return true;
  return false;
}

function isStreamType(contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return false;
  if (STREAM_CT.some((s) => ct === s.split(';')[0])) return true;
  if (ct === 'video/mp4' || ct === 'video/webm' || ct === 'video/mp2t') return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* webRequest 嗅探                                                     */
/* ------------------------------------------------------------------ */

function headerValue(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType = headerValue(details.responseHeaders, 'content-type');
    const size = parseInt(headerValue(details.responseHeaders, 'content-length') || '0', 10) || 0;
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();

    let kind = null;
    if (details.type === 'media') {
      // 明确的媒体请求：分片/MSE 段只标记为 stream
      kind = isStreamType(contentType) ? 'stream' : 'file';
      if (!ct && !isDirectType(contentType)) kind = 'file';
    } else if (ct && (isDirectType(contentType) || isStreamType(contentType))) {
      kind = isStreamType(contentType) ? 'stream' : 'file';
    }
    if (!kind) return;
    if (!/^https?:/i.test(details.url)) return;

    upsertMedia({
      tabId: details.tabId,
      frameId: details.frameId || 0,
      url: details.url,
      kind,
      contentType,
      ext: guessExt(contentType, details.url),
      size
    }).then(({ record }) => {
      updateBadge(details.tabId);
      // 兜底：页面里连媒体元素都没有（纯 Web Audio / XHR 取音频）时，靠嗅探也能弹卡片。
      // 延后 2.5 秒执行，让元素检测（信息更全，有歌名）先有机会上报，避免重复打扰。
      if (details.type === 'media') {
        setTimeout(() => maybeSniffToast(details.tabId, record), 2500);
      }
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

/* ------------------------------------------------------------------ */
/* 纯嗅探兜底：页面里没有媒体元素时也能弹卡片                            */
/* ------------------------------------------------------------------ */

async function maybeSniffToast(tabId, rec) {
  if (!rec || !tabId) return;
  const s = await getSettings();
  if (!s.autoPopup || s.sniffToast === false) return;
  if (rec.kind !== 'file' || !/^https?:/i.test(rec.url)) return;

  // 页面元素检测还在正常工作 → 不插嘴（那条路信息更全，能拿到歌名）
  if (Date.now() - (lastElementDetectAt.get(tabId) || 0) < 8000) return;
  // 同地址短时间内不重复
  if (rec.toasted && Date.now() - (rec.toastedAt || 0) < QUIET_MS) return;
  // 同标签页最多 4 秒弹一次，避免批量预取刷屏
  if (Date.now() - (lastSniffToastAt.get(tabId) || 0) < 4000) return;

  lastSniffToastAt.set(tabId, Date.now());
  const shown = await sendToFrame(tabId, 0, { type: 'toast-show', item: rec });
  if (shown) await upsertMedia({ tabId, url: rec.url, toasted: true, toastedAt: Date.now() });
}

/* ------------------------------------------------------------------ */
/* 与页面通信                                                          */
/* ------------------------------------------------------------------ */

function sendToFrame(tabId, frameId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId }, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp === undefined ? {} : resp);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function updateBadge(tabId) {
  const s = await getSettings();
  if (!s.showBadge) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}
    return;
  }
  const list = await getTabMedia(tabId);
  const n = list.filter((m) => m.kind === 'file').length || list.length;
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6fed' });
  } catch (e) { /* 标签页可能已关闭 */ }
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

const pendingDownloads = new Map(); // downloadId -> record

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!n) n = 'audio';
  return n;
}

function buildFilename(rec) {
  const ext = rec.ext || guessExt(rec.contentType, rec.url);
  let base = '';
  if (rec.artist && rec.title) base = rec.artist + ' - ' + rec.title;
  else if (rec.title) base = rec.title;
  if (!base) {
    try {
      const p = new URL(rec.url);
      base = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
      base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch (e) { base = ''; }
  }
  if (!base) base = rec.pageTitle || 'audio';
  base = sanitizeFilename(base);
  // 标题里已经带正确扩展名就不重复加
  if (new RegExp('\\.' + ext + '$', 'i').test(base)) return base;
  return base + '.' + ext;
}

/** Windows 保留设备名，直接当文件夹/文件名会被系统拒绝 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 把用户填的「默认下载路径」整理成 downloads API 能接受的相对子目录。
 *
 * 硬限制（本机实测，不是猜的）：filename 只允许是浏览器下载目录**之内**的相对路径，
 *   { filename: '音频下载/a.mp3' }      → ok，会创建子目录
 *   { filename: 'D:\\Music\\a.mp3' }     → 报错 Invalid filename
 *   { filename: '../escape/a.mp3' }      → 报错 Invalid filename
 * 所以这里去掉盘符与开头的斜杠，并过滤掉 .. 之类的逃逸片段。
 */
function normalizeSubfolder(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  s = s.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
  const parts = s.split('/')
    .map((p) => p.trim()
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/, ''))                 // Windows 不允许结尾是点或空格
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => (WIN_RESERVED.test(p) ? '_' + p : p));
  return parts.join('/').slice(0, 100);
}

async function nativeDownload(rec) {
  const s = await getSettings();
  const dir = normalizeSubfolder(s.subfolder);
  const base = buildFilename(rec);
  const filename = dir ? dir + '/' + base : base;
  const opts = {
    url: rec.url,
    filename,
    saveAs: !!s.saveAs,          // true → 浏览器弹「另存为」，可改文件名与文件夹
    conflictAction: 'uniquify'   // 重名时自动加 (1)(2)，不覆盖已有文件
  };

  let downloadId;
  try {
    downloadId = await chrome.downloads.download(opts);
  } catch (e) {
    // 子目录写法被判非法时退回只写文件名，别让整次下载因为一个路径设置而失败
    if (dir && /invalid filename/i.test(String((e && e.message) || e))) {
      downloadId = await chrome.downloads.download(Object.assign({}, opts, { filename: base }));
    } else {
      throw e;
    }
  }
  pendingDownloads.set(downloadId, rec);
  return { ok: true, downloadId, filename, saveAs: !!s.saveAs };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const rec = pendingDownloads.get(delta.id);
  if (!rec) return;
  if (delta.state && delta.state.current === 'complete') {
    pendingDownloads.delete(delta.id);
    return;
  }
  if (delta.state && delta.state.current === 'interrupted') {
    pendingDownloads.delete(delta.id);
    const err = (delta.error && delta.error.current) || 'UNKNOWN';
    // 用户在「另存为」对话框里点了取消：不是故障，别弹「下载失败」吓人
    if (/USER_CANCELED/i.test(err)) {
      await notifyToast(rec.tabId, { type: 'notify', text: '已取消下载' });
      return;
    }
    // 服务器拒绝（多半是缺 Referer/Cookie）→ 回退到「页面代下」
    if (!rec.fellBack && /FORBIDDEN|UNAUTHORIZED|SERVER|NETWORK/i.test(err)) {
      rec.fellBack = true;
      await upsertMedia({ tabId: rec.tabId, url: rec.url, fellBack: true });
      const ok = await sendToFrame(rec.tabId, rec.frameId, { type: 'page-fetch-download', item: rec });
      await notifyToast(rec.tabId, {
        type: 'notify',
        text: ok ? '已改用页面内下载…' : '下载失败：' + err
      });
    } else if (rec.fellBack || !/FORBIDDEN|UNAUTHORIZED|SERVER|NETWORK/i.test(err)) {
      await notifyToast(rec.tabId, { type: 'notify', text: '下载失败：' + err });
    }
  }
});

async function notifyToast(tabId, msg) {
  await sendToFrame(tabId, 0, msg);
}

/* ------------------------------------------------------------------ */
/* 消息总入口                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const tabId = sender.tab ? sender.tab.id : msg.tabId;

  switch (msg.type) {
    /* --- 来自内容脚本 --- */
    case 'media-detected': {
      handleMediaDetected(sender, msg.media || {}).then(sendResponse);
      return true;
    }
    case 'toast-download': {
      handleToastDownload(msg, sender).then(sendResponse);
      return true;
    }
    case 'toast-dismiss': {
      sendResponse({ ok: true });
      return;
    }
    case 'get-settings': {
      getSettings().then((s) => sendResponse({ ok: true, settings: s }));
      return true;
    }

    /* --- 来自工具栏面板 --- */
    case 'popup-state': {
      (async () => {
        const list = await getTabMedia(tabId);
        const settings = await getSettings();
        sendResponse({ ok: true, tabId, media: list, settings });
      })();
      return true;
    }
    case 'popup-download': {
      handleToastDownload({ mediaId: msg.mediaId }, { tab: { id: tabId } }).then(sendResponse);
      return true;
    }
    case 'popup-clear': {
      clearTabMedia(tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'popup-open-options': {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return;
    }
    default:
      return;
  }
});

async function handleMediaDetected(sender, media) {
  const tabId = sender.tab ? sender.tab.id : media.tabId;
  if (!tabId || !media.url) return { ok: false };
  const frameId = sender.frameId || 0;
  lastElementDetectAt.set(tabId, Date.now());

  const { record, isNew } = await upsertMedia(Object.assign({}, media, { tabId, frameId }));
  await updateBadge(tabId);

  const s = await getSettings();
  if (!s.autoPopup) return { ok: true, toasted: false };
  // 只对「能直接下载的文件」自动弹卡片；分片流/实时合成的音频只进工具栏列表，不打扰
  if (record.kind !== 'file') return { ok: true, toasted: false, unsupported: true };
  // 同一地址 5 分钟内只提示一次，避免来回刷卡片；超过则允许再次提示
  if (record.toasted && Date.now() - (record.toastedAt || 0) < QUIET_MS) {
    return { ok: true, toasted: false, duplicate: true };
  }

  const payload = { type: 'toast-show', item: record };
  let shown = null;
  if (frameId === 0) {
    shown = await sendToFrame(tabId, 0, payload);
  } else if (s.onlyTopFrame) {
    shown = await sendToFrame(tabId, 0, payload);
    if (!shown) shown = await sendToFrame(tabId, frameId, payload);
  } else {
    shown = await sendToFrame(tabId, frameId, payload);
  }

  if (shown) {
    await upsertMedia({ tabId, url: record.url, toasted: true, toastedAt: Date.now() });
    return { ok: true, toasted: true };
  }
  return { ok: true, toasted: false };
}

async function handleToastDownload(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  const list = await getTabMedia(tabId);
  const rec = list.find((m) => m.id === msg.mediaId) || (msg.url ? list.find((m) => m.url === msg.url) : null);
  if (!rec) return { ok: false, error: '记录已失效，请刷新页面后重试' };

  // blob: 地址属于页面自己，后台下载不了 → 直接交给页面内 fetch 保存
  if (/^blob:/i.test(rec.url)) {
    const r = await sendToFrame(rec.tabId, rec.frameId, { type: 'page-fetch-download', item: rec });
    if (r && r.ok) return { ok: true, mode: 'page' };
    return { ok: false, error: (r && r.error) || '该音频由网页实时合成，无法直接下载' };
  }

  if (!/^https?:/i.test(rec.url)) return { ok: false, error: '该地址无法下载' };

  try {
    const r = await nativeDownload(rec);
    return Object.assign({ ok: true, mode: 'download' }, r);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* 标签页清理 */
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId);
  lastElementDetectAt.delete(tabId);
  lastSniffToastAt.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTabMedia(tabId);
  }
});

/* 首次安装：写入默认设置并打开说明页 */
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(SETTINGS_KEY);
  if (!cur[SETTINGS_KEY]) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [SETTINGS_VERSION_KEY]: SETTINGS_VERSION
    });
  }
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
