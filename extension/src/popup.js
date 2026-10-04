/** 工具栏面板逻辑 */

'use strict';

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const btnClear = document.getElementById('btnClear');
const btnOptions = document.getElementById('btnOptions');
const btnOptions2 = document.getElementById('btnOptions2');
const pageinfo = document.getElementById('pageinfo');

let state = { media: [], settings: {} };
let tick = null;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    const f = decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || '');
    return p.hostname + (f ? ' / ' + f : '');
  } catch (e) {
    return String(u).slice(0, 60);
  }
}

function flash(text, isError) {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
  statusEl.style.color = isError ? '#ffb4b6' : '#9fd6a8';
  if (text) setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
}

function render() {
  const items = state.media || [];
  listEl.textContent = '';

  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = '暂未发现音频。<br><b>先在页面上播放音频</b>，再打开这里看看。';
    listEl.appendChild(d);
  } else {
    items.forEach((item) => {
      const unsupported = item.kind === 'stream';
      const row = document.createElement('div');
      row.className = 'row';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.title || shortUrl(item.url);
      name.title = item.title || item.url;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = [
        unsupported ? '分片流，无法直接下载' : (item.kind === 'blob' ? '页面内合成' : '文件'),
        fmtSize(item.size), item.contentType, shortUrl(item.url)
      ].filter(Boolean).join(' · ');
      meta.appendChild(name);
      meta.appendChild(sub);

      const btn = document.createElement('button');
      btn.className = 'act' + (unsupported ? ' ghost' : '');
      btn.textContent = unsupported ? '不可下载' : '下载';
      if (unsupported) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '下载中…';
          const resp = await send({ type: 'popup-download', mediaId: item.id });
          btn.disabled = false;
          btn.textContent = '下载';
          if (resp && resp.ok) {
            flash('已开始下载到「下载/音频下载」');
            refresh();
          } else {
            flash((resp && resp.error) || '操作失败', true);
          }
        });
      }

      row.appendChild(meta);
      if (unsupported) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = item.kind;
        row.appendChild(tag);
      }
      row.appendChild(btn);
      listEl.appendChild(row);
    });
  }
}

async function refresh() {
  const resp = await send({ type: 'popup-state' });
  if (!resp || !resp.ok) return;
  state = resp;
  render();
  try {
    const tab = await chrome.tabs.get(resp.tabId);
    pageinfo.textContent = (tab.title || '当前标签页').slice(0, 46);
  } catch (e) { /* ignore */ }
}

btnClear.addEventListener('click', async () => {
  await send({ type: 'popup-clear' });
  refresh();
});

function openOptions() {
  send({ type: 'popup-open-options' });
  window.close();
}
btnOptions.addEventListener('click', openOptions);
btnOptions2.addEventListener('click', openOptions);

refresh();
tick = setInterval(refresh, 1500);
window.addEventListener('unload', () => { if (tick) clearInterval(tick); });
