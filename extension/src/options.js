/** 设置页逻辑 */

'use strict';

const KEYS = [
  'autoPopup', 'autoCloseSeconds', 'minPlaySeconds', 'minDurationSeconds',
  'position', 'onlyTopFrame', 'showBadge', 'sniffToast'
];

const DEFAULTS = {
  autoPopup: true,
  autoCloseSeconds: 12,
  minPlaySeconds: 2,
  minDurationSeconds: 3,
  position: 'bottom-right',
  onlyTopFrame: true,
  showBadge: true,
  sniffToast: true
};

const savedEl = document.getElementById('saved');

function fill(s) {
  for (const k of KEYS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = String(s[k]);
  }
}

function collect() {
  const s = {};
  for (const k of KEYS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'number') s[k] = Math.max(0, parseInt(el.value, 10) || 0);
    else s[k] = el.value;
  }
  return s;
}

function flash() {
  savedEl.classList.add('on');
  setTimeout(() => savedEl.classList.remove('on'), 1600);
}

chrome.storage.local.get('settings', (o) => {
  fill(Object.assign({}, DEFAULTS, (o && o.settings) || {}));
});

document.getElementById('save').addEventListener('click', () => {
  const s = collect();
  chrome.storage.local.set({ settings: s }, flash);
});

document.getElementById('reset').addEventListener('click', () => {
  fill(DEFAULTS);
  chrome.storage.local.set({ settings: DEFAULTS }, flash);
});
