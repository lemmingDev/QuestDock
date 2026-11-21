'use strict';

/**
 * QuestDock renderer.
 *
 * Two independent folder views (this computer, the headset) with a transfer
 * dock underneath. All filesystem and ADB work happens in the main process;
 * this file only builds DOM, keeps selection state and calls `window.quest`.
 */

const q = window.quest;
const P = window.PathUtil;

const $ = (selector) => document.querySelector(selector);

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */

function blankPane(root) {
  return {
    cwd: root,
    parent: null,
    entries: [],
    loading: false,
    error: '',
    selected: new Set(),
    anchor: null,
    filter: '',
    history: [],
    totalBytes: 0,
  };
}

const state = {
  ready: false,
  settings: {},
  platform: 'darwin',
  adb: { available: true, version: '', error: '', path: '' },
  devices: [],
  serial: '',
  deviceInfo: null,
  local: blankPane(''),
  remote: blankPane('/sdcard'),
  transfers: { jobs: [], paused: false, runningId: null },
  thumbs: new Map(),
  pendingThumbs: new Set(),
  recording: null,
  dockCollapsed: false,
  status: '',
};

const ICONS = {
  folder:
    '<svg viewBox="0 0 20 20"><path d="M2.6 5.4h5.1l1.5 1.9h8.2v8H2.6Z" fill="currentColor"/></svg>',
  image:
    '<svg viewBox="0 0 20 20"><path d="M3 4.5h14v11H3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.4" cy="8" r="1.4" fill="currentColor"/><path d="m4.2 14 4.2-4.1 3 2.8 2.3-2.1 2.1 3.4Z" fill="currentColor"/></svg>',
  video:
    '<svg viewBox="0 0 20 20"><path d="M8 5.6 15 10l-7 4.4Z" fill="currentColor"/></svg>',
  audio:
    '<svg viewBox="0 0 20 20"><path d="M12.8 3.4v8.2a2.6 2.6 0 1 1-1.7-2.4V6.3L8 7v6a2.5 2.5 0 1 1-1.7-2.4Z" fill="currentColor"/></svg>',
  apk: '<svg viewBox="0 0 20 20"><path d="M6.4 2.6 8 5.1M13.6 2.6 12 5.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 5.4a6.4 6.4 0 0 0-6.4 6.4h12.8A6.4 6.4 0 0 0 10 5.4Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.6" cy="9" r=".8" fill="currentColor"/><circle cx="12.4" cy="9" r=".8" fill="currentColor"/></svg>',
  archive:
    '<svg viewBox="0 0 20 20"><path d="M4 4.4h12v11.2H4Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 8.2h12M10 8.2v4.4" stroke="currentColor" stroke-width="1.6"/><path d="M9.2 10.5h1.6v1.4H9.2Z" fill="currentColor"/></svg>',
  text: '<svg viewBox="0 0 20 20"><path d="M5 4.6h10v10.8H5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.2 8h5.6M7.2 10.4h5.6M7.2 12.8h3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  symlink:
    '<svg viewBox="0 0 20 20"><path d="M8.2 11.8 6.4 13.6a2.4 2.4 0 0 1-3.4-3.4l2.4-2.4a2.4 2.4 0 0 1 3.4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11.8 8.2 13.6 6.4a2.4 2.4 0 0 1 3.4 3.4l-2.4 2.4a2.4 2.4 0 0 1-3.4 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7.4 12.6 12.6 7.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/* ------------------------------------------------------------------ *
 *  Tiny helpers
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(kind) {
  const node = el('span', 'tile ' + kind);
  node.innerHTML = ICONS[kind] || ICONS.file;
  return node;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function paneOf(which) {
  return which === 'local' ? state.local : state.remote;
}

function setStatus(text) {
  state.status = text || '';
  renderFoots();
}

let toastId = 0;
function toast(message, kind = 'info', ms = 4200) {
  const stack = $('#toastStack');
  const node = el('div', `toast ${kind}`);
  const mark = el('span', 'mark', kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i');
  node.append(mark, el('span', '', message));
  node.dataset.id = String(++toastId);
  stack.append(node);
  const close = () => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener('click', close);
  setTimeout(close, ms);
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  toast(message, 'error', 6000);
  return message;
}

function daysAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return '';
}

/* ------------------------------------------------------------------ *
 *  Header: device chip, battery, storage
 * ------------------------------------------------------------------ */

function deviceLabel() {
  if (!state.serial) return 'No headset';
  const device = state.devices.find((item) => item.serial === state.serial);
  if (!device) return 'Headset';
  return (device.model || 'Quest').replace(/^Quest_/, 'Quest ');
}

function renderHeader() {
  const slot = $('#deviceSlot');
  slot.textContent = '';

  const chip = el('button', 'device-chip');
  const led = el('span', 'led');
  const name = el('span', 'name');
  const meta = el('span', 'meta');

  if (!state.adb.available) {
    led.classList.add('off');
    name.textContent = 'ADB not available';
    meta.textContent = 'check Settings';
  } else if (!state.serial) {
    led.classList.add('off');
    name.textContent = 'No headset connected';
    meta.textContent = 'USB or Wi-Fi';
  } else {
    const device = state.devices.find((item) => item.serial === state.serial) || {};
    const info = state.deviceInfo || device.info;
    if (device.state === 'unauthorized') {
      led.classList.add('warn');
      name.textContent = deviceLabel();
      meta.textContent = 'Allow USB debugging on the headset';
    } else if (device.state === 'offline') {
      led.classList.add('off');
      name.textContent = deviceLabel();
      meta.textContent = 'offline';
    } else {
      name.textContent = deviceLabel();
      const bits = [];
      if (info && info.battery.level != null) {
        bits.push(`${info.battery.level}%` + (info.battery.charging ? ' ⚡' : ''));
      }
      if (info && info.storage) bits.push(`${P.formatBytes(info.storage.freeBytes)} free`);
      meta.textContent = bits.join('  ·  ');
    }
  }

  chip.append(led, name);
  if (meta.textContent) chip.append(meta);

  if (state.serial) {
    const info = state.deviceInfo || (state.devices.find((d) => d.serial === state.serial) || {}).info;
    if (info && info.storage && info.storage.totalBytes) {
      const bar = el('span', 'storage');
      const fill = el('i');
      fill.style.width = `${Math.min(100, (info.storage.usedBytes / info.storage.totalBytes) * 100)}%`;
      bar.append(fill);
      chip.append(bar);
    }
    chip.append(el('span', 'caret', '▾'));
  }

  chip.addEventListener('click', () => openDevicePopover(chip));
  slot.append(chip);

  const recordBtn = $('#recordBtn');
  recordBtn.classList.toggle('recording', Boolean(state.recording));
  recordBtn.textContent = state.recording ? 'Stop' : 'Record';

  const wifi = document.querySelector('[data-action="wireless"]');
  if (wifi) {
    // Green only when the headset we are browsing is the Wi-Fi transport.
    // With USB plugged in the app prefers USB, so the dot stays grey.
    const onWifi = Boolean(state.serial && String(state.serial).includes(':'));
    wifi.classList.toggle('active', onWifi);
    wifi.title = onWifi ? 'Connected over Wi-Fi' : 'Connect over Wi-Fi';
  }
}

function openDevicePopover(anchor) {
  closePopover();
  const pop = el('div', 'popover');
  pop.id = 'devicePopover';

  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 360))}px`;
  pop.style.top = `${rect.bottom + 8}px`;

  pop.append(el('div', 'pop-head', state.devices.length ? 'Headsets' : 'Headsets'));

  if (!state.devices.length) {
    pop.append(
      el(
        'div',
        'pop-note',
        'Nothing is connected. Plug in a Quest with USB debugging enabled, or connect over Wi-Fi below.'
      )
    );
  }

  for (const device of state.devices) {
    const item = el('button', 'pop-item');
    const led = el('span', `led ${device.state === 'device' ? '' : 'warn'}`);
    const grow = el('div', 'grow');
    grow.append(el('div', 'title', (device.model || 'Quest') + (device.serial === state.serial ? '  ✓' : '')));
    const detail = device.state === 'device' ? device.serial : device.state;
    grow.append(el('div', 'meta', detail));
    item.append(led, grow);
    item.addEventListener('click', () => {
      closePopover();
      selectDevice(device.serial);
    });
    pop.append(item);
  }

  pop.append(el('div', 'pop-sep'));
  const wifiItem = el('button', 'pop-item');
  wifiItem.append(el('div', 'grow'));
  wifiItem.firstChild.append(el('div', 'title', 'Connect over Wi-Fi…'));
  wifiItem.firstChild.append(el('div', 'meta', 'Pair a Quest that is already on this network'));
  wifiItem.addEventListener('click', () => {
    closePopover();
    openWireless();
  });
  pop.append(wifiItem);

  const refreshItem = el('button', 'pop-item');
  refreshItem.append(el('div', 'grow'));
  refreshItem.firstChild.append(el('div', 'title', 'Refresh'));
  refreshItem.firstChild.append(el('div', 'meta', `adb ${state.adb.version || 'unknown'}`));
  refreshItem.addEventListener('click', () => {
    closePopover();
    refreshDevices();
  });
  pop.append(refreshItem);

  document.body.append(pop);
  anchor.classList.add('open');
}

function closePopover() {
  const existing = $('#devicePopover');
  if (existing) existing.remove();
  const chip = $('.device-chip');
  if (chip) chip.classList.remove('open');
}

function selectDevice(serial) {
  if (serial === state.serial) return;
  state.serial = serial;
  const device = state.devices.find((item) => item.serial === serial);
  state.deviceInfo = device ? device.info : null;
  state.remote.selected.clear();
  state.thumbs.clear();

  if (serial) {
    q.app.saveSettings({ lastSerial: serial }).catch(() => {});
    q.devices
      .info(serial, true)
      .then((info) => {
        state.deviceInfo = info;
        renderHeader();
      })
      .catch(() => {});
    const remembered = state.settings.remoteDir || '/sdcard';
    navigate('remote', remembered, { remember: false });
  } else {
    state.remote.entries = [];
    state.remote.error = 'Connect a headset to browse it.';
    renderHeader();
    renderPane('remote');
  }
}

async function refreshDevices() {
  try {
    const payload = await q.devices.list();
    applyDevices(payload);
  } catch (error) {
    state.adb.available = false;
    state.adb.error = error.message;
    renderHeader();
  }
}

function applyDevices(payload) {
  state.adb = {
    available: payload.available !== false,
    version: payload.version || '',
    error: payload.error || '',
    path: payload.adbPath || '',
  };
  state.devices = payload.devices || [];

  const usable = state.devices.filter((device) => device.state === 'device');
  const preferred = state.settings.lastSerial || state.serial;
  const keep = usable.find((device) => device.serial === preferred) || usable[0] || null;

  const before = state.serial;
  if (!keep) {
    if (before) selectDevice('');
  } else if (keep.serial !== before) {
    selectDevice(keep.serial);
  } else {
    state.deviceInfo = keep.info || state.deviceInfo;
  }
  renderHeader();
  if (!before && keep) renderHeader();
}

/* ------------------------------------------------------------------ *
 *  Panes
 * ------------------------------------------------------------------ */

function crumbParts(cwd, which) {
  if (which === 'local') return P.localCrumbs(cwd);
  const parts = [{ label: '/', path: '/' }];
  const clean = P.normalizePosix(cwd);
  for (const segment of clean.split('/').filter(Boolean)) {
    parts.push({ label: segment, path: P.joinPosix(parts[parts.length - 1].path, segment) });
  }
  return parts;
}

function dirnameOf(target, which) {
  return which === 'remote' ? P.parentPosix(target) : P.parentLocal(target);
}

function basenameOf(target, which) {
  return which === 'remote' ? P.baseName(target) : P.baseNameLocal(target);
}

function joinFor(dir, name, which) {
  return which === 'remote' ? P.joinPosix(dir, name) : P.joinLocal(dir, name);
}

function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isSongArchive(entry) {
  return entry && entry.kind === 'archive' && extensionOf(entry.name) === 'zip';
}

function isInstallable(entry) {
  return entry && entry.kind === 'apk';
}

function renderPane(which) {
  const view = paneOf(which);
  const listNode = which === 'local' ? $('#localList') : $('#remoteList');
  const crumbNode = which === 'local' ? $('#localCrumbs') : $('#remoteCrumbs');

  renderHeader();

  /* breadcrumbs */
  crumbNode.textContent = '';
  if (view.cwd) {
    const parts = crumbParts(view.cwd, which);
    parts.forEach((part, index) => {
      if (index) crumbNode.append(el('span', 'crumb-sep', '›'));
      const button = el('button', 'crumb', part.label);
      if (index === parts.length - 1) button.classList.add('current');
      button.addEventListener('click', () => navigate(which, part.path));
      crumbNode.append(button);
    });
  }
  crumbNode.scrollLeft = crumbNode.scrollWidth;

  /* rows */
  const scroll = listNode.scrollTop;
  listNode.textContent = '';

  if (view.loading) {
    for (let i = 0; i < 8; i += 1) listNode.append(el('div', 'skeleton-row'));
    renderFoots();
    renderActions(which);
    return;
  }

  if (view.error) {
    const empty = el('div', 'list-empty');
    empty.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 9v5m0 2.6v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    empty.append(el('strong', '', which === 'remote' ? 'Cannot read this folder' : 'Cannot read this folder'));
    empty.append(el('span', '', view.error));
    const retry = el('button', 'mini-btn', 'Retry');
    retry.style.marginTop = '8px';
    retry.addEventListener('click', () => navigate(which, view.cwd, { remember: false }));
    empty.append(retry);
    listNode.append(empty);
    renderFoots();
    renderActions(which);
    return;
  }

  const entries = visibleEntries(which);
  if (!entries.length) {
    const empty = el('div', 'list-empty');
    if (view.filter) {
      empty.append(el('strong', '', 'Nothing matches that filter'));
      empty.append(el('span', '', 'Clear the search box to see everything again.'));
    } else if (which === 'remote' && !state.serial) {
      empty.append(el('strong', '', 'No headset connected'));
      empty.append(el('span', '', 'Connect a Quest by USB with developer mode on, or join it over Wi-Fi.'));
      const actions = el('div', 'actions');
      const button = el('button', 'mini-btn primary', 'Connect over Wi-Fi');
      button.addEventListener('click', openWireless);
      actions.append(button);
      empty.append(actions);
    } else if (which === 'remote') {
      empty.append(el('strong', '', 'This folder is empty'));
      empty.append(el('span', '', 'Drag files here from your computer, or use Upload.'));
    } else {
      empty.append(el('strong', '', 'This folder is empty'));
    }
    listNode.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.append(buildRow(which, entry));
    listNode.append(fragment);
  }

  listNode.scrollTop = scroll;
  renderFoots();
  renderActions(which);
}

function visibleEntries(which) {
  const view = paneOf(which);
  const needle = view.filter.trim().toLowerCase();
  if (!needle) return view.entries;
  return view.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

function buildRow(which, entry) {
  const view = paneOf(which);
  const row = el('div', 'row');
  row.dataset.path = entry.path;
  row.dataset.name = entry.name;
  if (view.selected.has(entry.path)) row.classList.add('selected');

  const tile = icon(entry.kind);
  const thumb = state.thumbs.get(entry.path);
  if (thumb) {
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    img.draggable = false;
    tile.textContent = '';
    tile.append(img);
  } else if (entry.kind === 'image' && state.pendingThumbs.has(entry.path)) {
    tile.append(el('span', 'thumb-busy'));
  }

  const name = el('div', 'row-name', entry.name);
  if (entry.isSymlink && entry.linkTarget) name.append(el('span', 'hint', `→ ${entry.linkTarget}`));

  const size = el('div', 'row-size', entry.isDir ? '—' : entry.sizeLabel || P.formatBytes(entry.size));
  const date = el('div', 'row-date', P.formatStamp(entry.mtime));

  row.append(tile, name, size, date);

  row.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey) {
      if (view.selected.has(entry.path)) view.selected.delete(entry.path);
      else view.selected.add(entry.path);
      view.anchor = entry.path;
    } else if (event.shiftKey && view.anchor) {
      const list = visibleEntries(which);
      const from = list.findIndex((item) => item.path === view.anchor);
      const to = list.findIndex((item) => item.path === entry.path);
      if (from !== -1 && to !== -1) {
        view.selected.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
          view.selected.add(list[i].path);
        }
      }
    } else if (!view.selected.has(entry.path)) {
      view.selected.clear();
      view.selected.add(entry.path);
      view.anchor = entry.path;
    }
    updateSelectionStyles(which);
    renderActions(which);
    renderFoots();
    requestAnimationFrame(() => maybeLoadThumb(which, entry));
  });

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!view.selected.has(entry.path)) {
      view.selected.clear();
      view.selected.add(entry.path);
      view.anchor = entry.path;
      updateSelectionStyles(which);
      renderActions(which);
    }
    openContextMenu(which, entry, event.clientX, event.clientY);
  });

  row.addEventListener('dblclick', () => openEntry(which, entry));

  return row;
}

function updateSelectionStyles(which) {
  const view = paneOf(which);
  const listNode = which === 'local' ? $('#localList') : $('#remoteList');
  for (const row of listNode.querySelectorAll('.row')) {
    row.classList.toggle('selected', view.selected.has(row.dataset.path));
  }
}

async function maybeLoadThumb(which, entry) {
  if (which !== 'remote' || entry.kind !== 'image') return;
  if (state.thumbs.has(entry.path) || state.pendingThumbs.has(entry.path)) return;
  if (state.settings.thumbnails === false) return;
  state.pendingThumbs.add(entry.path);
  renderThumbState(entry.path);
  try {
    const result = await q.preview.thumb(state.serial, entry);
    if (result && result.file) {
      state.thumbs.set(entry.path, result.file);
      state.pendingThumbs.delete(entry.path);
      paintThumb(entry.path, result.file);
    } else if (!result) {
      state.pendingThumbs.delete(entry.path);
      renderThumbState(entry.path);
    }
  } catch {
    state.pendingThumbs.delete(entry.path);
    renderThumbState(entry.path);
  }
}

function paintThumb(pathKey, url) {
  const list = $('#remoteList');
  const row = [...list.querySelectorAll('.row')].find((item) => item.dataset.path === pathKey);
  if (!row) return;
  const tile = row.querySelector('.tile');
  if (!tile) return;
  tile.textContent = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.draggable = false;
  tile.append(img);
}

function renderThumbState(pathKey) {
  const list = $('#remoteList');
  const row = [...list.querySelectorAll('.row')].find((item) => item.dataset.path === pathKey);
  if (!row) return;
  const tile = row.querySelector('.tile');
  if (!tile || tile.querySelector('img') || tile.querySelector('.thumb-busy')) return;
  tile.append(el('span', 'thumb-busy'));
}

/* ------------------------------------------------------------------ *
 *  Navigation
 * ------------------------------------------------------------------ */

async function navigate(which, target, options = {}) {
  const view = paneOf(which);
  if (which === 'remote' && !state.serial) {
    view.error = 'Connect a headset to browse it.';
    renderPane('remote');
    return;
  }
  if (!target) return;

  if (options.remember !== false && view.cwd && view.cwd !== target) {
    view.history.push(view.cwd);
    if (view.history.length > 50) view.history.shift();
  }

  view.loading = true;
  view.error = '';
  view.filter = which === 'local' ? $('#localSearch').value : $('#remoteSearch').value;
  view.selected.clear();
  view.anchor = null;
  renderPane(which);

  try {
    const listing =
      which === 'local' ? await q.local.list(target) : await q.fs.list(state.serial, target);
    view.cwd = listing.path;
    view.parent = listing.parent;
    view.entries = listing.entries || [];
    view.selected.clear();
    view.anchor = null;
    view.totalBytes = view.entries.reduce((sum, entry) => sum + (entry.isDir ? 0 : entry.size || 0), 0);

    if (which === 'local') {
      q.app.saveSettings({ localDir: view.cwd }).catch(() => {});
    } else {
      q.app.saveSettings({ remoteDir: view.cwd, lastSerial: state.serial }).catch(() => {});
    }
  } catch (error) {
    view.entries = [];
    view.error = error.message;
  } finally {
    view.loading = false;
    const search = which === 'local' ? $('#localSearch') : $('#remoteSearch');
    if (search.value !== view.filter) search.value = view.filter;
    renderPane(which);
    if (which === 'remote') queueVisibleThumbs();
  }
}

function queueVisibleThumbs() {
  for (const entry of state.remote.entries) {
    if (entry.kind === 'image') maybeLoadThumb('remote', entry);
  }
}

async function goBack(which) {
  const view = paneOf(which);
  const previous = view.history.pop();
  if (previous) await navigate(which, previous, { remember: false });
}

async function goUp(which) {
  const view = paneOf(which);
  if (!view.parent) return;
  await navigate(which, view.parent);
}

async function openEntry(which, entry) {
  if (entry.isDir) {
    await navigate(which, entry.path);
    return;
  }
  if (entry.isSymlink) {
    const view = paneOf(which);
    await navigate(which, entry.path, { remember: false });
    if (!view.error) return;
    // Not a directory target: drop the failed-navigation error and preview/open instead.
    view.error = '';
    renderPane(which);
  }
  if (which === 'local') {
    try {
      await q.shell.open(entry.path);
    } catch (error) {
      fail(error);
    }
    return;
  }
  openLightbox(entry);
}

/* ------------------------------------------------------------------ *
 *  Selection actions
 * ------------------------------------------------------------------ */

function selectedEntries(which) {
  const view = paneOf(which);
  return view.entries.filter((entry) => view.selected.has(entry.path));
}

function renderActions(which) {
  const node = which === 'local' ? $('#localActions') : $('#remoteActions');
  node.textContent = '';
  const selected = selectedEntries(which);
  const count = selected.length;

  if (which === 'local') {
    if (!count) {
      const upload = el('button', 'mini-btn primary', 'Upload files…');
      upload.addEventListener('click', uploadFiles);
      const folder = el('button', 'mini-btn', 'Folder…');
      folder.addEventListener('click', uploadFolder);
      node.append(folder, upload);
      return;
    }
    const upload = el('button', 'mini-btn primary', `Upload ${count}`);
    upload.addEventListener('click', () => uploadPaths(selected.map((entry) => entry.path)));
    const reveal = el('button', 'mini-btn', 'Reveal');
    reveal.addEventListener('click', () => q.local.reveal(selected[0].path).catch(fail));
    node.append(reveal, upload);
    return;
  }

  if (!state.serial) return;

  if (!count) {
    const download = el('button', 'mini-btn', 'Download…');
    download.addEventListener('click', () =>
      toast('Select what you want to download, then press Download', 'info')
    );
    node.append(download);
    return;
  }

  const download = el('button', 'mini-btn primary', `Download ${count}`);
  download.addEventListener('click', () => {
    downloadEntries(selected).catch((error) => {
      if (error && error.code === 'cancel') return;
      fail(error);
    });
  });
  node.append(download);
}

/* ------------------------------------------------------------------ *
 *  Footer summaries
 * ------------------------------------------------------------------ */

function renderFoots() {
  const localNode = $('#localFoot');
  const remoteNode = $('#remoteFoot');
  if (!localNode || !remoteNode) return;

  const localCount = state.local.entries.length;
  const localSelected = state.local.selected.size;
  localNode.textContent = '';
  if (localSelected) {
    const bytes = selectedEntries('local').reduce((sum, entry) => sum + (entry.size || 0), 0);
    localNode.append(el('span', '', `${plural(localSelected, 'item')} selected · ${P.formatBytes(bytes)}`));
  } else if (state.local.cwd) {
    localNode.append(el('span', '', `${plural(localCount, 'item')} · ${P.formatBytes(state.local.totalBytes)}`));
  }
  if (state.status) {
    localNode.append(el('span', 'spacer'));
    localNode.append(el('span', '', state.status));
  }

  remoteNode.textContent = '';
  const remoteSelected = state.remote.selected.size;
  if (!state.serial) {
    remoteNode.append(el('span', '', 'No device'));
  } else if (remoteSelected) {
    const bytes = selectedEntries('remote').reduce((sum, entry) => sum + (entry.size || 0), 0);
    remoteNode.append(el('span', '', `${plural(remoteSelected, 'item')} selected · ${P.formatBytes(bytes)}`));
  } else {
    const info = state.deviceInfo;
    remoteNode.append(el('span', '', `${plural(state.remote.entries.length, 'item')}`));
    if (info && info.storage) {
      remoteNode.append(el('span', 'spacer'));
      remoteNode.append(
        el(
          'span',
          '',
          `${P.formatBytes(info.storage.freeBytes)} free of ${P.formatBytes(info.storage.totalBytes)}`
        )
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Context menu
 * ------------------------------------------------------------------ */

function openContextMenu(which, entry, x, y) {
  const menu = $('#contextMenu');
  menu.textContent = '';
  menu.hidden = false;

  const add = (label, shortcut, handler, options = {}) => {
    const button = el('button', options.danger ? 'danger' : '');
    button.append(el('span', '', label));
    if (shortcut) button.append(el('kbd', '', shortcut));
    button.addEventListener('click', () => {
      hideContextMenu();
      handler();
    });
    if (options.disabled) button.disabled = true;
    menu.append(button);
  };
  const sep = () => menu.append(el('div', 'sep'));

  const selected = selectedEntries(which);
  const many = selected.length > 1;

  if ((entry.isDir || entry.isSymlink) && !many) {
    add('Open', '↩', () => openEntry(which, entry));
  } else if (!many) {
    add(which === 'local' ? 'Open with default app' : 'Preview', 'Space', () => openEntry(which, entry));
  }

  sep();

  if (which === 'local') {
    add(many ? `Upload ${selected.length} items` : 'Upload to headset', '⌘U', () =>
      uploadPaths(selected.map((item) => item.path))
    );
    const archives = selected.filter(isSongArchive);
    const packages = selected.filter(isInstallable);
    if (archives.length) {
      sep();
      add(
        archives.length > 1 ? `Extract ${archives.length} archives` : 'Extract to headset…',
        '',
        () => extractArchivesToHeadset(archives)
      );
      add('Import as Beat Saber song…', '', () => importSongs(archives));
      add(
        archives.length > 1 ? `Extract ${archives.length} here` : 'Extract here',
        '',
        () => extractArchivesHere(archives)
      );
    }
    if (packages.length) {
      sep();
      add(
        packages.length > 1 ? `Install ${packages.length} packages` : 'Install on headset…',
        '',
        () => installLocalPackages(packages)
      );
    }
    sep();
    add('Reveal in Finder', '', () => q.local.reveal(entry.path).catch(fail));
    add('Copy path', '', () => copyText(entry.path));
    sep();
    add('Rename…', 'F2', () => renameLocal(entry));
    add('Move to Trash', '⌫', () => deleteLocal(selected), { danger: true });
  } else {
    add(many ? `Download ${selected.length} items` : 'Download…', '⌘D', () =>
      downloadEntries(selected).catch((error) => {
        if (error && error.code === 'cancel') return;
        fail(error);
      })
    );
    add('Copy path on headset', '', () => copyText(entry.path));
    sep();
    add('Copy to folder…', '', () => copyMoveRemote(selected, 'copy'));
    add('Move to folder…', '', () => copyMoveRemote(selected, 'move'));
    sep();
    add('Rename…', 'F2', () => renameRemote(entry));
    add('Delete', '⌫', () => deleteRemote(selected), { danger: true });
  }

  const width = 220;
  const height = menu.offsetHeight || 260;
  menu.style.left = `${Math.min(x, window.innerWidth - width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - height - 10)}px`;
}

function hideContextMenu() {
  $('#contextMenu').hidden = true;
}

/**
 * The Places menu lists the same shortcuts every file dialog shows, plus the
 * mounted volumes and (on Windows) every drive that exists. It is the only way
 * to reach a drive other than the one Downloads happens to live on.
 */
async function openPlacesMenu(anchor) {
  const menu = $('#contextMenu');
  menu.textContent = '';
  menu.hidden = false;

  let roots = [];
  try {
    roots = await q.local.roots();
  } catch {
    roots = [];
  }

  const group = (title, items) => {
    if (!items.length) return;
    menu.append(el('div', 'menu-title', title));
    for (const root of items) {
      const button = el('button');
      button.append(el('span', '', root.label));
      button.append(el('kbd', '', root.path));
      button.title = root.path;
      button.addEventListener('click', () => {
        hideContextMenu();
        navigate('local', root.path).catch(fail);
      });
      menu.append(button);
    }
  };

  group('Places', roots.filter((root) => !root.kind || root.kind === 'place'));
  group('Volumes', roots.filter((root) => root.kind === 'volume'));
  group('Drives', roots.filter((root) => root.kind === 'drive'));

  if (!menu.childElementCount) {
    menu.append(el('button', '', 'No places found'));
  }

  const rect = anchor.getBoundingClientRect();
  const width = 280;
  const height = menu.offsetHeight || 240;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 10)}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - height - 10)}px`;
}

/**
 * Headset volumes: internal storage and any USB-C drive mounted below
 * /storage. Capacities come straight from `df`, so an external SSD is easy to
 * tell apart from the built-in storage.
 */
async function openVolumesMenu(anchor) {
  const menu = $('#contextMenu');
  menu.textContent = '';
  menu.hidden = false;
  menu.append(el('div', 'menu-title', 'Headset storage'));

  if (!state.serial) {
    menu.append(el('button', '', 'Connect a headset first'));
  } else {
    try {
      const volumes = await q.fs.volumes(state.serial);
      for (const volume of volumes) {
        const button = el('button');
        button.append(el('span', '', volume.label));
        button.append(el('kbd', '', volume.freeLabel ? `${volume.freeLabel} free` : ''));
        button.title = volume.path;
        button.addEventListener('click', () => {
          hideContextMenu();
          navigate('remote', volume.path).catch(fail);
        });
        menu.append(button);
      }
      if (volumes.length === 1) {
        const note = el('div', 'pop-note', 'Plug a USB-C drive into the headset to see it here.');
        menu.append(note);
      }
    } catch (error) {
      menu.append(el('button', '', 'Could not read storage'));
      fail(error);
    }
  }

  const rect = anchor.getBoundingClientRect();
  const width = 300;
  const height = menu.offsetHeight || 200;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 10)}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - height - 10)}px`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Path copied', 'success', 1800);
  } catch {
    toast('Could not copy to the clipboard', 'error');
  }
}

/* ------------------------------------------------------------------ *
 *  Local actions
 * ------------------------------------------------------------------ */

function parentOfLocal(target) {
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return cut <= 0 ? target : target.slice(0, cut);
}

async function uploadFiles() {
  const files = await q.dialog.files({ title: 'Choose files to upload' }).catch(fail);
  if (!files || !files.length) return;
  uploadPaths(files);
}

async function uploadFolder() {
  const folder = await q.dialog.folder({ title: 'Choose a folder to upload' }).catch(fail);
  if (!folder) return;
  await pushMany([folder]);
}

async function uploadPaths(paths) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  await pushMany(paths);
}

async function pushMany(localPaths) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  if (!state.remote.cwd) return;
  const specs = localPaths.map((localPath) => ({
    direction: 'push',
    serial: state.serial,
    localPath,
    remotePath: joinFor(state.remote.cwd, basenameOf(localPath, 'local'), 'remote'),
  }));
  try {
    await q.transfers.add(specs);
    expandDock();
    toast(`Queued ${plural(specs.length, 'item')} for upload`, 'success', 2400);
  } catch (error) {
    fail(error);
  }
}

/* ------------------------------------------------------------------ *
 *  Archives, songs and packages
 * ------------------------------------------------------------------ */

async function extractArchivesToHeadset(entries) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  if (!state.remote.cwd) return;

  let summary = '';
  try {
    if (entries.length === 1) {
      const info = await q.archive.inspect(entries[0].path);
      const bytes = info.entries.reduce((total, item) => total + (item.size || 0), 0);
      summary = `${plural(info.entries.length, 'file')} (${P.formatBytes(bytes)})`;
    } else {
      summary = plural(entries.length, 'archive');
    }
  } catch (error) {
    return fail(error);
  }

  const okay = await confirmModal({
    title: entries.length === 1 ? `Extract “${entries[0].name}”?` : 'Extract these archives?',
    message: `${summary} will be unpacked into ${state.remote.cwd} on the headset. Existing names are left alone until you answer the conflict prompt.`,
    confirm: 'Extract',
  });
  if (!okay) return;

  let queued = 0;
  for (const entry of entries) {
    try {
      await q.archive.extract(state.serial, entry.path, state.remote.cwd, { stripRoot: true });
      queued += 1;
    } catch (error) {
      fail(error);
    }
  }
  if (queued) {
    expandDock();
    toast(`Queued ${plural(queued, 'archive')} for extraction`, 'success', 3000);
  }
}

async function extractArchivesHere(entries) {
  if (!state.local.cwd) return;
  const okay = await confirmModal({
    title: entries.length === 1 ? `Extract “${entries[0].name}” here?` : 'Extract these archives here?',
    message: `The contents go into ${state.local.cwd}. Files with the same name are replaced.`,
    confirm: 'Extract here',
  });
  if (!okay) return;

  for (const entry of entries) {
    try {
      const result = await q.archive.extractLocal(entry.path, state.local.cwd, { stripRoot: true });
      toast(`Extracted ${plural(result.files, 'file')}`, 'success', 2600);
    } catch (error) {
      fail(error);
    }
  }
  await navigate('local', state.local.cwd, { remember: false });
}

async function importSongs(entries) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  let loader = null;
  try {
    loader = await q.songs.loader(state.serial);
  } catch {
    loader = null;
  }
  if (!loader) {
    await confirmModal({
      title: 'No custom-song folder found',
      message:
        'QuestDock looked for SongCore/MBF, SongLoader, BMBF and /sdcard/CustomLevels. Install a Beat Saber mod loader first, then import again.',
      confirm: 'OK',
    });
    return;
  }

  let details = '';
  try {
    const info = await q.archive.inspect(entries[0].path);
    const song = info.song;
    if (song) {
      details = `${song.songName || 'Untitled'}${song.mapper ? ` · mapped by ${song.mapper}` : ''}${song.bpm ? ` · ${song.bpm} BPM` : ''}`;
    }
  } catch {
    details = '';
  }

  const okay = await confirmModal({
    title: entries.length === 1 ? 'Import Beat Saber song?' : `Import ${entries.length} songs?`,
    message: `${details ? `${details}\n\n` : ''}Songs go to ${loader.path} on the headset. Existing songs are kept and duplicates get a numbered name.`,
    confirm: 'Import',
  });
  if (!okay) return;

  try {
    const outcome = await q.songs.import(state.serial, entries.map((entry) => entry.path));
    let good = 0;
    for (const result of outcome.results) {
      if (result.ok) {
        good += 1;
        const title = result.song && result.song.name ? result.song.name : result.folderName;
        toast(`Importing ${title}`, 'success', 3000);
      } else {
        toast(`${basenameOf(result.file, 'local')}: ${result.error}`, 'error', 7000);
      }
    }
    if (good) expandDock();
  } catch (error) {
    fail(error);
  }
}

async function installLocalPackages(entries) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  const okay = await confirmModal({
    title: entries.length === 1 ? `Install “${entries[0].name}”?` : `Install ${entries.length} packages?`,
    message:
      'The app is installed over any existing copy; splits and OBB files in .apks/.xapk/.apkm bundles are handled automatically.',
    confirm: 'Install',
  });
  if (!okay) return;

  try {
    const results = await q.apps.installPaths(
      state.serial,
      entries.map((entry) => entry.path)
    );
    for (const result of results) {
      if (result.ok) {
        const name = result.packageName || result.label || basenameOf(result.file, 'local');
        const bits = [];
        if (result.splits > 1) bits.push(`${result.splits} splits`);
        if (result.obb) bits.push(`${result.obb} OBB`);
        toast(`Installed ${name}${bits.length ? ` (${bits.join(', ')})` : ''}`, 'success', 4000);
      } else {
        toast(`${basenameOf(result.file, 'local')}: ${result.error}`, 'error', 8000);
      }
    }
  } catch (error) {
    fail(error);
  }
}


async function renameLocal(entry) {
  const next = await promptModal({
    title: 'Rename',
    label: 'New name',
    value: entry.name,
    confirm: 'Rename',
  });
  if (!next || next === entry.name) return;
  try {
    await q.local.rename(entry.path, joinFor(parentOfLocal(entry.path), next, 'local'));
    await navigate('local', state.local.cwd, { remember: false });
  } catch (error) {
    fail(error);
  }
}

async function deleteLocal(entries) {
  if (!entries.length) return;
  const okay = await confirmModal({
    title: entries.length > 1 ? `Move ${entries.length} items to Trash?` : 'Move to Trash?',
    message:
      entries.length > 1
        ? 'They go to this computer’s Trash and can be put back from there.'
        : `“${entries[0].name}” goes to this computer’s Trash.`,
    confirm: 'Move to Trash',
    danger: true,
  });
  if (!okay) return;
  try {
    await q.local.remove(entries.map((entry) => entry.path));
    await navigate('local', state.local.cwd, { remember: false });
  } catch (error) {
    fail(error);
  }
}

async function newLocalFolder() {
  const name = await promptModal({ title: 'New folder', label: 'Folder name', value: 'Untitled folder' });
  if (!name) return;
  try {
    await q.local.mkdir(joinFor(state.local.cwd, name, 'local'));
    await navigate('local', state.local.cwd, { remember: false });
  } catch (error) {
    fail(error);
  }
}

/* ------------------------------------------------------------------ *
 *  Remote actions
 * ------------------------------------------------------------------ */

async function downloadEntries(entries) {
  if (!entries.length) return;
  if (!state.local.cwd) {
    toast('Choose a folder on this computer first', 'error');
    return;
  }
  const specs = entries.map((entry) => ({
    direction: 'pull',
    serial: state.serial,
    remotePath: entry.path,
    localPath: joinFor(state.local.cwd, entry.name, 'local'),
    isDir: entry.isDir,
  }));
  try {
    await q.transfers.add(specs);
    expandDock();
    toast(`Queued ${plural(specs.length, 'item')} for download`, 'success', 2400);
  } catch (error) {
    fail(error);
  }
}

async function renameRemote(entry) {
  const next = await promptModal({
    title: 'Rename on headset',
    label: 'New name',
    value: entry.name,
    confirm: 'Rename',
  });
  if (!next || next === entry.name) return;
  try {
    await q.fs.rename(state.serial, entry.path, joinFor(P.parentPosix(entry.path), next, 'remote'));
    await navigate('remote', state.remote.cwd, { remember: false });
  } catch (error) {
    fail(error);
  }
}

async function deleteRemote(entries) {
  if (!entries.length) return;
  const names = entries.map((entry) => entry.name);
  const okay = await confirmModal({
    title: entries.length > 1 ? `Delete ${entries.length} items?` : 'Delete on headset?',
    message:
      entries.length > 1
        ? `This deletes ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} from the headset. It cannot be undone.`
        : `“${names[0]}” is deleted from the headset. This cannot be undone.`,
    confirm: 'Delete',
    danger: true,
  });
  if (!okay) return;
  try {
    await q.fs.remove(state.serial, entries.map((entry) => entry.path));
    await navigate('remote', state.remote.cwd, { remember: false });
    toast(`Deleted ${plural(entries.length, 'item')}`, 'success', 2500);
  } catch (error) {
    fail(error);
  }
}

async function newRemoteFolder() {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  const name = await promptModal({ title: 'New folder on headset', label: 'Folder name', value: 'New folder' });
  if (!name) return;
  try {
    await q.fs.mkdir(state.serial, joinFor(state.remote.cwd, name, 'remote'));
    await navigate('remote', state.remote.cwd, { remember: false });
  } catch (error) {
    fail(error);
  }
}

async function copyMoveRemote(entries, mode) {
  if (!entries.length) return;
  const destination = await pickRemoteFolder({
    title: mode === 'copy' ? 'Copy to folder' : 'Move to folder',
    confirm: mode === 'copy' ? 'Copy here' : 'Move here',
  });
  if (!destination) return;
  try {
    await q.fs.copyMove(
      state.serial,
      entries.map((entry) => entry.path),
      destination,
      mode
    );
    await navigate('remote', state.remote.cwd, { remember: false });
    toast(`${mode === 'copy' ? 'Copied' : 'Moved'} ${plural(entries.length, 'item')}`, 'success', 2500);
  } catch (error) {
    fail(error);
  }
}

/* ------------------------------------------------------------------ *
 *  Transfers dock
 * ------------------------------------------------------------------ */

function expandDock() {
  if (state.dockCollapsed) {
    state.dockCollapsed = false;
    $('#dock').classList.remove('collapsed');
    $('#dockToggle').setAttribute('aria-expanded', 'true');
  }
}

function renderDock() {
  const jobs = state.transfers.jobs || [];
  const summary = $('#dockSummary');
  const list = $('#dockList');
  const actions = $('#dockActions');

  const running = jobs.filter((job) => job.state === 'running');
  const queued = jobs.filter((job) => job.state === 'queued');
  const failed = jobs.filter((job) => job.state === 'failed');
  const done = jobs.filter((job) => job.state === 'done');

  summary.textContent = '';
  if (!jobs.length) {
    summary.textContent = 'Nothing queued';
  } else {
    const bits = [];
    if (running.length) bits.push(`${running.length} running`);
    if (queued.length) bits.push(`${queued.length} waiting`);
    if (failed.length) bits.push(`${failed.length} failed`);
    if (done.length) bits.push(`${done.length} done`);
    summary.textContent = bits.join('  ·  ');
  }

  actions.textContent = '';
  if (jobs.length) {
    if (state.transfers.paused) {
      const resume = el('button', 'mini-btn', 'Resume');
      resume.addEventListener('click', () => q.transfers.resume().catch(fail));
      actions.append(resume);
    } else if (running.length || queued.length) {
      const pause = el('button', 'mini-btn', 'Pause');
      pause.addEventListener('click', () => q.transfers.pause().catch(fail));
      actions.append(pause);
    }
    if (running.length || queued.length) {
      const stop = el('button', 'mini-btn danger', 'Stop all');
      stop.addEventListener('click', () => q.transfers.cancelAll().catch(fail));
      actions.append(stop);
    }
    const finished = done.length + failed.length + jobs.filter((job) => job.state === 'cancelled').length;
    if (finished) {
      const clear = el('button', 'mini-btn', 'Clear finished');
      clear.addEventListener('click', () => q.transfers.clear().catch(fail));
      actions.append(clear);
    }
  }

  list.textContent = '';
  for (const job of jobs) list.append(buildJob(job));
}

function buildJob(job) {
  const row = el('div', `job ${job.state}`);

  const arrow = el('div', `job-arrow ${job.direction}`, job.direction === 'push' ? '↑' : '↓');
  arrow.title = job.direction === 'push' ? 'Uploading to headset' : 'Downloading to computer';

  const main = el('div', 'job-main');
  main.append(el('div', 'job-name', job.name));

  const meta = el('div', 'job-meta');
  const pieces = [];
  if (job.state === 'queued') pieces.push('waiting');
  if (job.state === 'running') {
    pieces.push(`${P.formatBytes(job.bytesDone)}${job.totalBytes ? ` of ${P.formatBytes(job.totalBytes)}` : ''}`);
    if (job.speed) pieces.push(`${P.formatBytes(job.speed)}/s`);
    if (job.eta != null && job.eta > 0) pieces.push(`${P.formatDuration(job.eta)} left`);
    if (job.conflict === 'rename') pieces.push('renamed');
  }
  if (job.state === 'done') {
    pieces.push(job.totalBytes ? P.formatBytes(job.totalBytes) : 'finished');
    pieces.push(job.direction === 'push' ? 'on headset' : 'on this computer');
  }
  if (job.state === 'failed') pieces.push(job.error || 'failed');
  if (job.state === 'cancelled') pieces.push('cancelled');
  for (const piece of pieces) {
    const isError = job.state === 'failed' && piece === pieces[pieces.length - 1];
    meta.append(el('span', isError ? 'bad' : '', piece));
  }
  main.append(meta);

  const pct = el('div', 'job-pct');
  if (job.state === 'done') pct.textContent = 'done';
  else if (job.state === 'failed') pct.textContent = 'failed';
  else if (job.state === 'cancelled') pct.textContent = '—';
  else pct.textContent = `${Math.round(job.percent || 0)}%`;

  const tools = el('div', 'job-tools');
  if (job.state === 'running' || job.state === 'queued') {
    const cancel = el('button', 'icon-btn');
    cancel.title = 'Cancel';
    cancel.innerHTML =
      '<svg viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    cancel.addEventListener('click', () => q.transfers.cancel(job.id).catch(fail));
    tools.append(cancel);
  } else if (job.state === 'failed' || job.state === 'cancelled') {
    const retry = el('button', 'icon-btn');
    retry.title = 'Retry';
    retry.innerHTML =
      '<svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 4v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    retry.addEventListener('click', () => q.transfers.retry(job.id).catch(fail));
    tools.append(retry);
  } else if (job.state === 'done') {
    const reveal = el('button', 'icon-btn');
    reveal.title = job.direction === 'pull' ? 'Show in folder' : 'Copy path';
    reveal.innerHTML =
      '<svg viewBox="0 0 20 20"><path d="M9 5.5h6.5V15H4.5V5.5H9Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m4.5 11 3-2.6 2.4 2 2.1-1.7 3 2.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
    reveal.addEventListener('click', () => {
      if (job.direction === 'pull') q.local.reveal(job.localPath).catch(fail);
      else copyText(job.remotePath);
    });
    tools.append(reveal);
  }

  const bar = el('div', 'job-bar');
  bar.style.width = `${Math.max(job.state === 'running' ? 1.5 : 0, Math.min(100, job.percent || (job.state === 'done' ? 100 : 0)))}%`;

  row.append(arrow, main, pct, tools, bar);
  return row;
}

function applyTransferUpdate(snapshot) {
  state.transfers = snapshot;
  renderDock();
  const done = (snapshot.jobs || []).filter((job) => job.state === 'done').length;
  if (done > (state.doneSeen || 0)) {
    state.doneSeen = done;
    // A finished job probably changed the folder we are looking at.
    scheduleRemoteRefresh();
  }
}

let refreshTimer = null;
function scheduleRemoteRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (state.serial) navigate('remote', state.remote.cwd, { remember: false, quiet: true });
  }, 600);
}

/* ------------------------------------------------------------------ *
 *  Conflicts
 * ------------------------------------------------------------------ */

function openConflictModal(payload) {
  const body = el('div');
  const card = el('div', 'conflict-card');
  card.append(el('div', 'tile', '!'));
  const what = el('div', 'what');
  what.append(el('strong', '', payload.name));
  what.append(el('span', '', payload.destination));
  card.append(what);
  body.append(card);

  body.append(
    el(
      'p',
      'hint',
      payload.remaining > 1
        ? `Another ${payload.remaining - 1} item${payload.remaining - 1 === 1 ? '' : 's'} in the queue may hit the same thing.`
        : 'What should happen to the file that is already there?'
    )
  );

  const choices = el('div', 'chips');
  body.append(choices);

  const decide = (action, applyAll) => {
    closeModal();
    q.transfers.resolveConflict(payload.id, action, applyAll).catch(fail);
  };

  for (const [action, label] of [
    ['overwrite', 'Replace'],
    ['rename', 'Keep both'],
    ['skip', 'Skip this one'],
  ]) {
    const button = el('button', 'choice', label);
    button.addEventListener('click', (event) => decide(action, event.altKey));
    choices.append(button);
  }

  const foot = el('div', 'modal-foot');
  const hint = el('span', '', 'Hold ⌥ while choosing to apply to the rest');
  hint.className = 'hint';
  hint.style.marginRight = 'auto';
  foot.append(hint);
  const cancel = el('button', 'mini-btn', 'Stop the queue');
  cancel.addEventListener('click', () => decide('cancel', false));
  foot.append(cancel);

  openModal({
    title: 'That name is already used',
    sub: payload.direction === 'push' ? 'On the headset' : 'On this computer',
    body,
    foot,
    dismissible: false,
  });
}

/* ------------------------------------------------------------------ *
 *  Modals
 * ------------------------------------------------------------------ */

let modalCloser = null;

function openModal({ title, sub, body, foot, wide, dismissible = true }) {
  const root = $('#modalRoot');
  root.hidden = false;
  root.textContent = '';

  const modal = el('div', `modal${wide ? ' wide' : ''}`);
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.append(el('div', 'modal-title', title));
  if (sub) heading.append(el('div', 'modal-sub', sub));
  head.append(heading);

  if (dismissible) {
    const close = el('button', 'icon-btn');
    close.innerHTML =
      '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', closeModal);
    head.append(close);
  }

  const bodyNode = el('div', 'modal-body');
  if (typeof body === 'string') bodyNode.textContent = body;
  else if (body) bodyNode.append(body);

  modal.append(head, bodyNode);
  if (foot) modal.append(foot);

  root.append(modal);
  modalCloser = () => {
    root.hidden = true;
    root.textContent = '';
  };
  root.onclick = (event) => {
    if (event.target === root && dismissible) closeModal();
  };
  return { modal, body: bodyNode, foot };
}

function closeModal() {
  if (modalCloser) modalCloser();
  modalCloser = null;
}

function promptModal({ title, label, value = '', confirm = 'OK', placeholder = '' }) {
  return new Promise((resolve) => {
    const body = el('div');
    const field = el('div', 'field');
    field.append(el('label', '', label));
    const input = el('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    field.append(input);
    body.append(field);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'mini-btn', 'Cancel');
    const okay = el('button', 'mini-btn primary', confirm);
    foot.append(cancel, okay);

    const finish = (result) => {
      closeModal();
      resolve(result);
    };

    cancel.addEventListener('click', () => finish(null));
    okay.addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value.trim() || null);
      }
    });

    openModal({ title, body, foot });
    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }, 30);
  });
}

function confirmModal({ title, message, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const body = el('p', '', message);
    body.style.color = 'var(--text-soft)';
    body.style.margin = '0';
    body.style.lineHeight = '1.6';

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'mini-btn', 'Cancel');
    const okay = el('button', `mini-btn ${danger ? 'danger' : 'primary'}`, confirm);
    if (danger) okay.style.color = '#ffb3ba';
    foot.append(cancel, okay);

    const finish = (result) => {
      closeModal();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(false));
    okay.addEventListener('click', () => finish(true));

    openModal({ title, body, foot });
    setTimeout(() => okay.focus(), 30);
  });
}

/* ------------------------------------------------------------------ *
 *  Lightbox
 * ------------------------------------------------------------------ */

async function openLightbox(entry) {
  const root = $('#modalRoot');
  root.hidden = false;
  root.textContent = '';

  const box = el('div', 'lightbox');
  const bar = el('div', 'bar');
  bar.append(el('span', 'name', entry.name));
  bar.append(el('span', 'meta', `${P.formatBytes(entry.size)} · ${P.formatStamp(entry.mtime)}`));
  const spacer = el('span');
  spacer.style.flex = '1';
  bar.append(spacer);
  const close = el('button', 'icon-btn');
  close.innerHTML =
    '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  close.addEventListener('click', () => {
    root.hidden = true;
    root.textContent = '';
    modalCloser = null;
  });
  bar.append(close);

  const stage = el('div', 'stage');
  const spinner = el('div', 'spinner');
  stage.append(spinner);

  const foot = el('div', 'foot');
  foot.append(el('span', '', entry.path));

  box.append(bar, stage, foot);
  root.append(box);
  modalCloser = () => {
    root.hidden = true;
    root.textContent = '';
  };
  root.onclick = (event) => {
    if (event.target === root) {
      root.hidden = true;
      root.textContent = '';
    }
  };

  const isLocal = entry.url != null;
  try {
    let url = entry.url;
    if (!isLocal) {
      const media = await q.preview.media(state.serial, entry);
      url = media.url;
    }
    stage.textContent = '';

    if (entry.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = entry.name;
      stage.append(img);
    } else if (entry.kind === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      stage.append(video);
    } else if (entry.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      audio.autoplay = true;
      stage.append(audio);
    } else {
      const message = el('div', 'list-empty');
      message.append(el('strong', '', 'No preview for this file type'));
      message.append(el('span', '', 'Download it and open it with the app for that format.'));
      stage.append(message);
    }
  } catch (error) {
    stage.textContent = '';
    const message = el('div', 'list-empty');
    message.append(el('strong', '', 'Could not load the preview'));
    message.append(el('span', '', error.message));
    stage.append(message);
  }
}

/* ------------------------------------------------------------------ *
 *  Settings
 * ------------------------------------------------------------------ */

function switchRow(title, detail, on, onChange) {
  const row = el('div', 'switch-row');
  const text = el('div', 'text');
  text.append(el('strong', '', title));
  text.append(el('span', '', detail));
  const toggle = el('button', `switch${on ? ' on' : ''}`);
  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    onChange(next);
  });
  row.append(text, toggle);
  return row;
}

async function openSettings() {
  const settings = await q.app.settings().catch(() => state.settings);
  state.settings = settings;

  const body = el('div');

  const adbField = el('div', 'field');
  adbField.append(el('label', '', 'ADB executable'));
  const row = el('div', 'field-row');
  const input = el('input');
  input.type = 'text';
  input.value = settings.adbPath || state.adb.path || 'adb (bundled or on PATH)';
  input.readOnly = true;
  const pick = el('button', 'mini-btn', 'Choose…');
  pick.addEventListener('click', async () => {
    try {
      const chosen = await q.app.pickAdb();
      if (chosen) {
        input.value = chosen;
        toast('ADB path updated', 'success');
      }
    } catch (error) {
      fail(error);
    }
  });
  row.append(input, pick);
  adbField.append(row);
  const adbHint = el('div', 'hint');
  const versionText = (state.adb.version || 'adb').replace('Android Debug Bridge version ', 'adb ');
  adbHint.textContent = state.adb.available
    ? `${versionText} · ${state.adb.path || ''}`
    : state.adb.error || 'adb was not found.';
  adbField.append(adbHint);
  body.append(adbField);

  body.append(
    switchRow(
      'Show hidden files',
      'Dot files such as .nomedia are common on a Quest.',
      settings.showHidden !== false,
      (value) => {
        state.settings.showHidden = value;
        q.app.saveSettings({ showHidden: value }).catch(fail);
        if (state.local.cwd) navigate('local', state.local.cwd, { remember: false });
      }
    )
  );

  body.append(
    switchRow(
      'Image thumbnails',
      'Pull and shrink pictures for the file list. Turn off on slow links.',
      settings.thumbnails !== false,
      (value) => {
        state.settings.thumbnails = value;
        q.app.saveSettings({ thumbnails: value }).catch(fail);
      }
    )
  );

  body.append(
    switchRow(
      'Keep the headset awake',
      'Stops the Quest from sleeping while a transfer is running.',
      settings.keepAwake !== false,
      (value) => {
        state.settings.keepAwake = value;
        q.app.saveSettings({ keepAwake: value }).catch(fail);
        if (state.serial) q.device.keepAwake(state.serial, value).catch(() => {});
      }
    )
  );

  body.append(
    switchRow(
      'Allow writes outside /sdcard',
      'Only enable this if you know the Quest will let you. Most system folders are read-only.',
      Boolean(settings.allowAnywhere),
      (value) => {
        state.settings.allowAnywhere = value;
        q.app.saveSettings({ allowAnywhere: value }).catch(fail);
      }
    )
  );

  const songField = el('div', 'field');
  songField.append(el('label', '', 'Beat Saber custom-song folder'));
  const songInput = el('input');
  songInput.type = 'text';
  songInput.value = settings.beatsaberPath || '';
  songInput.placeholder = 'Detect automatically (SongCore, SongLoader or BMBF)';
  songInput.spellcheck = false;
  songInput.addEventListener('change', () => {
    const value = songInput.value.trim();
    state.settings.beatsaberPath = value;
    q.app.saveSettings({ beatsaberPath: value }).catch(fail);
  });
  const songHint = el(
    'div',
    'hint',
    'Leave blank to find the loader on the headset. Song zips are unpacked here.'
  );
  songField.append(songInput, songHint);
  body.append(songField);

  const cacheField = el('div', 'field');
  cacheField.style.marginTop = '14px';
  cacheField.append(el('label', '', 'Preview cache'));
  const cacheLine = el('div', 'field-row');
  const cacheNote = el('div', 'hint', 'Reading…');
  cacheNote.style.flex = '1';
  const clearCache = el('button', 'mini-btn', 'Clear');
  clearCache.addEventListener('click', async () => {
    try {
      const stats = await q.preview.clear();
      cacheNote.textContent = `Using ${P.formatBytes(stats.total)}`;
      state.thumbs.clear();
      toast('Preview cache cleared', 'success');
    } catch (error) {
      fail(error);
    }
  });
  cacheLine.append(cacheNote, clearCache);
  cacheField.append(cacheLine);
  body.append(cacheField);
  q.preview
    .stats()
    .then((stats) => {
      cacheNote.textContent = `Using ${P.formatBytes(stats.total)} · thumbnails ${P.formatBytes(
        stats.thumbs
      )}, media ${P.formatBytes(stats.media)}`;
    })
    .catch(() => {
      cacheNote.textContent = 'Unavailable';
    });

  const foot = el('div', 'modal-foot');
  const version = el('span', '', `QuestDock ${state.version || ''} · Electron ${state.electron || ''}`);
  version.style.color = 'var(--muted)';
  version.style.fontSize = '11px';
  foot.append(version);
  foot.append(el('span', 'spacer'));
  const done = el('button', 'mini-btn primary', 'Done');
  done.addEventListener('click', closeModal);
  foot.append(done);

  openModal({ title: 'Settings', body, foot });
}

/* ------------------------------------------------------------------ *
 *  Wireless
 * ------------------------------------------------------------------ */

async function openWireless() {
  const saved = await q.net.state().catch(() => ({ hostPort: '', auto: true }));
  const body = el('div');
  const explain = el(
    'p',
    'hint',
    'Over USB, use “Enable wireless” below — QuestDock reads the headset’s Wi-Fi address and switches ADB to TCP. On Quest 3 you can instead turn on Settings › System › Developer › Wireless debugging and enter the address it shows.'
  );
  explain.style.marginTop = '0';
  body.append(explain);

  const status = el('div', 'hint', '');
  body.append(status);

  if (state.serial && !String(state.serial).includes(':')) {
    const enableRow = el('div', 'switch-row');
    const text = el('div', 'text');
    text.append(el('strong', '', 'Enable wireless from this USB connection'));
    text.append(el('span', '', 'Works on Quest 2 and Quest 3 while the cable is attached.'));
    const enable = el('button', 'mini-btn primary', 'Enable');
    enable.addEventListener('click', async () => {
      enable.disabled = true;
      status.textContent = 'Reading the headset’s Wi-Fi address…';
      try {
        const result = await q.net.enable(state.serial);
        status.textContent = `Connected at ${result.hostPort}`;
        toast(`Wireless ready at ${result.hostPort}. You can unplug the cable.`, 'success', 6000);
        setTimeout(() => {
          closeModal();
          refreshDevices();
        }, 900);
      } catch (error) {
        status.textContent = error.message;
        enable.disabled = false;
      }
    });
    enableRow.append(text, enable);
    body.append(enableRow);

    const autoRow = el('div', 'switch-row');
    const autoText = el('div', 'text');
    autoText.append(el('strong', '', 'Auto-enable from USB'));
    autoText.append(el('span', '', 'Switch to Wi-Fi automatically when plugged in via USB.'));
    const autoToggle = el('input');
    autoToggle.type = 'checkbox';
    autoToggle.checked = state.settings.autoEnableWireless !== false;
    autoToggle.addEventListener('change', () => {
      q.app.saveSettings({ autoEnableWireless: autoToggle.checked }).catch(fail);
    });
    autoRow.append(autoText, autoToggle);
    body.append(autoRow);

    // Auto-switch to Wi-Fi when a USB headset is connected and no wireless
    // address is saved yet, so the user doesn't have to find the IP/port.
    if (!saved.hostPort && state.settings.autoEnableWireless !== false) {
      setTimeout(() => {
        if (document.body.contains(enable)) enable.click();
      }, 600);
    }
  }

  const discovered = el('div', 'pkg-list');
  discovered.append(el('div', 'pkg', 'Looking for wireless headsets on this network…'));
  body.append(discovered);

  const isMac = state.platform === 'darwin' || /Mac/i.test(navigator.platform);
  if (isMac) {
    const macHint = el('div', 'hint', '');
    macHint.style.marginTop = '10px';
    macHint.append(
      el(
        'span',
        '',
        'macOS note: if wireless never connects, OpenCode/QuestDock needs Local Network permission (System Settings \u203a Privacy & Security \u203a Local Network). '
      )
    );
    const openSettings = el('button', 'mini-btn', 'Open Local Network settings');
    openSettings.style.marginLeft = '8px';
    openSettings.addEventListener('click', async () => {
      try {
        await q.app.openLocalNetworkSettings();
      } catch (error) {
        fail(error);
      }
    });
    macHint.append(openSettings);
    body.append(macHint);
  }

  let discoverTimer = null;
  let autoConnected = false;

  async function runDiscover() {
    try {
      const services = await q.net.discover();
      discovered.textContent = '';
      if (!services.length) {
        discovered.append(
          el('div', 'pkg', 'No wireless debugging advertised yet. On Quest 3: Settings \u203a System \u203a Developer \u203a Wireless debugging (turn on). On Quest 2: Settings \u203a Developer \u203a Wireless ADB (turn on). Then reopen this window.')
        );
        return;
      }
      for (const service of services) {
        const row = el('div', 'pkg');
        row.append(el('span', '', service.hostPort));
        const use = el('button', 'mini-btn', 'Use');
        use.addEventListener('click', () => {
          address.value = service.hostPort;
          address.focus();
          status.textContent = 'Address filled in. Press Connect.';
        });
        row.append(use);
        discovered.append(row);
      }
      if (saved.hostPort && services.some((svc) => svc.hostPort === saved.hostPort)) {
        address.value = saved.hostPort;
      } else if (!address.value && services.length === 1) {
        address.value = services[0].hostPort;
      }
      const match = services.find((svc) => svc.hostPort === (address.value || saved.hostPort));
      if (match && saved.hostPort === match.hostPort && !autoConnected) {
        autoConnected = true;
        setTimeout(() => {
          if (document.body.contains(connect)) connect.click();
        }, 400);
      }
    } catch {
      discovered.textContent = '';
      discovered.append(el('div', 'pkg', 'Could not list wireless headsets. Enter the address manually.'));
    }
  }

  runDiscover();
  discoverTimer = setInterval(runDiscover, 5000);

  const addressField = el('div', 'field');
  addressField.append(el('label', '', 'Address'));
  const address = el('input');
  address.type = 'text';
  address.placeholder = '192.168.1.42:5555';
  address.value = saved.hostPort || '';
  addressField.append(address);
  body.append(addressField);

  const pairField = el('div', 'field');
  pairField.append(el('label', '', 'Pairing code (only if the headset shows one)'));
  const code = el('input');
  code.type = 'text';
  code.placeholder = '123456';
  code.maxLength = 6;
  pairField.append(code);
  body.append(pairField);

  body.append(
    switchRow(
      'Reconnect automatically',
      'Remember this headset and find its new port after a reboot.',
      saved.auto !== false,
      (value) => {
        q.app.saveSettings({ wirelessAutoReconnect: value }).catch(fail);
      }
    )
  );

  const foot = el('div', 'modal-foot');
  if (saved.hostPort) {
    const forget = el('button', 'mini-btn', 'Forget saved Wi-Fi');
    forget.addEventListener('click', async () => {
      await q.net.forget().catch(fail);
      forget.remove();
      status.textContent = 'Saved wireless headset forgotten.';
    });
    foot.append(forget);
  }
  const connect = el('button', 'mini-btn primary', 'Connect');
  foot.append(el('span', 'spacer'), connect);

  connect.addEventListener('click', async () => {
    const target = address.value.trim();
    if (!target) {
      address.focus();
      return;
    }
    connect.disabled = true;
    status.textContent = 'Connecting…';
    try {
      if (code.value.trim()) {
        status.textContent = await q.net.pair(target, code.value.trim());
      }
      const message = await q.net.connect(target);
      status.textContent = message || 'Connected';
      toast('Connected over Wi-Fi', 'success');
      closeModal();
      setTimeout(refreshDevices, 800);
    } catch (error) {
      status.textContent = error.message;
      fail(error);
    } finally {
      connect.disabled = false;
    }
  });

  const prevCloser = modalCloser;
  modalCloser = () => {
    if (discoverTimer) { clearInterval(discoverTimer); discoverTimer = null; }
    if (prevCloser) prevCloser();
  };

  openModal({
    title: 'Connect over Wi-Fi',
    sub: 'Wireless debugging keeps the headset reachable without a cable.',
    body,
    foot,
  });
  setTimeout(() => address.focus(), 40);
}

/* ------------------------------------------------------------------ *
 *  Apps
 * ------------------------------------------------------------------ */

let livePreviewTimer = null;
let livePreviewRunning = false;
let liveStream = null;

async function openLiveStream() {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  if (!('VideoDecoder' in window)) {
    toast('This build of Electron has no WebCodecs support; falling back to snapshot mode.', 'info');
    openLivePreview();
    return;
  }

  const body = el('div');
  const stage = el('div', 'stage');
  stage.style.minHeight = '240px';
  stage.style.display = 'flex';
  stage.style.alignItems = 'center';
  stage.style.justifyContent = 'center';
  const canvas = document.createElement('canvas');
  canvas.style.maxWidth = '100%';
  canvas.style.maxHeight = '60vh';
  canvas.style.objectFit = 'contain';
  stage.append(canvas);
  body.append(stage);

  const status = el('div', 'hint', 'Connecting to headset video stream…');
  status.style.marginTop = '8px';
  body.append(status);

  const eyeRow = el('div', 'switch-row');
  const eyeText = el('div', 'text');
  eyeText.append(el('strong', '', 'View'));
  eyeText.append(el('span', '', 'Which part of the stereo frame to show.'));
  const eyeBtns = el('div', '');
  eyeBtns.style.display = 'flex';
  eyeBtns.style.gap = '4px';
  let eyeMode = 'left';
  const modes = ['left', 'right', 'both'];
  const eyeButtons = {};
  for (const mode of modes) {
    const b = el('button', 'mini-btn', mode.charAt(0).toUpperCase() + mode.slice(1));
    if (mode === eyeMode) b.classList.add('primary');
    b.addEventListener('click', () => {
      eyeMode = mode;
      for (const m of modes) eyeButtons[m].classList.toggle('primary', m === mode);
      fixRow.style.display = (mode === 'both') ? 'none' : '';
      applyEyeTransform();
    });
    eyeButtons[mode] = b;
    eyeBtns.append(b);
  }

  const fixRow = el('div', 'switch-row');
  const fixText = el('div', 'text');
  fixText.append(el('strong', '', 'Fix view'));
  fixText.append(el('span', '', 'Crop to one eye and rotate to straighten (turn off for original).'));
  const fixToggle = el('input');
  fixToggle.type = 'checkbox';
  fixToggle.checked = false;
  fixRow.append(fixText, fixToggle);
  body.append(fixRow);
  fixRow.style.display = (eyeMode === 'both') ? 'none' : '';

  eyeRow.append(eyeText, eyeBtns);
  body.append(eyeRow);

  function applyEyeTransform() {
    // Rotation is applied to pixels in the frame callback, not the canvas element.
  }
  fixToggle.addEventListener('change', applyEyeTransform);
  applyEyeTransform();


  const foot = el('div', 'modal-foot');
  const fsBtn = el('button', 'mini-btn', 'Fullscreen');
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === stage) {
      stage.style.background = '#000';
      stage.style.minHeight = '100vh';
      canvas.style.maxHeight = '100vh';
      canvas.style.maxWidth = '100vw';
      canvas.style.objectFit = 'cover';
    } else {
      stage.style.background = '';
      stage.style.minHeight = '240px';
      canvas.style.maxHeight = '60vh';
      canvas.style.maxWidth = '100%';
      canvas.style.objectFit = 'contain';
    }
  });
  const recBtn = el('button', 'mini-btn', 'Record');
  recBtn.addEventListener('click', () => { closeModal(); stopLiveStream(); toggleRecording(); });
  const recAudioBtn = el('button', 'mini-btn', 'Record (audio)');
  recAudioBtn.addEventListener('click', () => { closeModal(); stopLiveStream(); toggleRecording({ audio: true }); });
  const scrBtn = el('button', 'mini-btn', 'Mirror (scrcpy)');
  scrBtn.title = 'Launch scrcpy in its own window (must be installed)';
  scrBtn.addEventListener('click', () => { launchScrcpy(); });
  foot.append(el('span', 'spacer'), fsBtn, recBtn, recAudioBtn, scrBtn);

  openModal({ title: 'Live stream', sub: 'Real-time H.264 stream from the headset.', body, foot });

  const ctx = canvas.getContext('2d');
  const offscreen = document.createElement('canvas');
  const offCtx = offscreen.getContext('2d');

  let decoder = null;
  let configured = false;
  let codec = null;
  let buffer = new Uint8Array(0);
  let frameBuffer = [];
  let hasSlice = false;
  let frameHasIdr = false;
  let timestamp = 0;
  const FRAME_US = 33333;

  function codecFromSps(sps) {
    const profile = sps[1].toString(16).padStart(2, '0');
    const constraints = sps[2].toString(16).padStart(2, '0');
    const level = sps[3].toString(16).padStart(2, '0');
    return `avc1.${profile}${constraints}${level}`;
  }

  function emitFrame() {
    if (!frameBuffer.length || !configured || !decoder) return;
    let total = 0;
    for (const nal of frameBuffer) total += 4 + nal.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const nal of frameBuffer) {
      data.set([0, 0, 0, 1], off); off += 4;
      data.set(nal, off); off += nal.length;
    }
    const chunk = new EncodedVideoChunk({
      type: frameHasIdr ? 'key' : 'delta',
      timestamp,
      data,
    });
    timestamp += FRAME_US;
    try { decoder.decode(chunk); } catch (e) { /* ignore */ }
  }

  function feedNal(nal) {
    const type = nal[0] & 0x1f;
    if (type === 7 && !configured) {
      codec = codecFromSps(nal);
    }
    if (type === 7 && codec && !configured) {
      try {
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
        configured = true;
        status.textContent = 'Streaming…';
      } catch (e) {
        status.textContent = `Decoder error: ${e.message}`;
      }
    }
    const isSlice = (type === 1 || type === 5);
    if (isSlice && hasSlice) {
      emitFrame();
      frameBuffer = [];
      frameHasIdr = false;
    }
    frameBuffer.push(nal);
    if (type === 5) frameHasIdr = true;
    if (isSlice) hasSlice = true;
  }

  function processBuffer() {
    // find start code positions
    const positions = [];
    for (let i = 0; i < buffer.length - 3; i++) {
      if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
        positions.push({ idx: i, len: 3 });
      } else if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
        positions.push({ idx: i, len: 4 });
      }
    }
    if (positions.length < 2) return;
    for (let k = 0; k < positions.length - 1; k++) {
      const sc = positions[k];
      const next = positions[k + 1];
      const nalStart = sc.idx + sc.len;
      const nal = buffer.slice(nalStart, next.idx);
      if (nal.length) feedNal(nal);
    }
    const last = positions[positions.length - 1];
    buffer = buffer.slice(last.idx);
  }

  try {
    decoder = new VideoDecoder({
      output: (frame) => {
        if (status.textContent !== 'Streaming…') status.textContent = 'Streaming…';
        const fullW = frame.displayWidth;
        const fullH = frame.displayHeight;
        let effectiveMode = eyeMode;
        let sx = 0, sw = fullW;
        if (effectiveMode === 'left') { sx = 0; sw = Math.floor(fullW / 2); }
        else if (effectiveMode === 'right') { sx = Math.floor(fullW / 2); sw = fullW - sx; }
        else { sx = 0; sw = fullW; }
        if (offscreen.width !== sw || offscreen.height !== fullH) {
          offscreen.width = sw;
          offscreen.height = fullH;
        }
        offCtx.drawImage(frame, sx, 0, sw, fullH, 0, 0, sw, fullH);
        frame.close();

        // Rotation to straighten the view (applied to pixels, not the canvas element).
        let angleDeg = 0;
        if (fixToggle.checked) {
          if (eyeMode === 'left') angleDeg = 21;
          else if (eyeMode === 'right') angleDeg = -21;
        }
        if (angleDeg === 0) {
          if (canvas.width !== sw || canvas.height !== fullH) {
            canvas.width = sw;
            canvas.height = fullH;
          }
          ctx.drawImage(offscreen, 0, 0);
        } else {
          const rad = angleDeg * Math.PI / 180;
          const cos = Math.abs(Math.cos(rad));
          const sin = Math.abs(Math.sin(rad));
          const rotW = Math.ceil(sw * cos + fullH * sin);
          const rotH = Math.ceil(sw * sin + fullH * cos);
          if (canvas.width !== rotW || canvas.height !== rotH) {
            canvas.width = rotW;
            canvas.height = rotH;
          }
          ctx.clearRect(0, 0, rotW, rotH);
          ctx.save();
          ctx.translate(rotW / 2, rotH / 2);
          ctx.rotate(rad);
          ctx.drawImage(offscreen, -sw / 2, -fullH / 2);
          ctx.restore();
        }
      },
      error: (e) => { status.textContent = `Decode error: ${e.message}`; },
    });

    try { await q.device.stopStream(); } catch {}
    await new Promise((r) => setTimeout(r, 200));
    await q.device.startStream(state.serial, { size: '1280x720', bitrate: 4000000 });

    let gotData = false;
    const unsubData = q.device.onStreamData((chunk) => {
      if (!gotData) { gotData = true; status.textContent = 'Receiving data…'; }
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const merged = new Uint8Array(buffer.length + bytes.length);
      merged.set(buffer); merged.set(bytes, buffer.length);
      buffer = merged;
      processBuffer();
    });
    const unsubEnd = q.device.onStreamEnd((info) => {
      status.textContent = info && info.error ? `Stream ended: ${info.error}` : 'Stream ended.';
      stopLiveStream();
    });

    liveStream = { decoder, unsubData, unsubEnd, canvas };
    status.textContent = 'Buffering…';
  } catch (error) {
    status.textContent = error.message;
    fail(error);
    stopLiveStream();
  }

  const prevCloser = modalCloser;
  modalCloser = () => {
    stopLiveStream();
    if (prevCloser) prevCloser();
  };
}

async function launchScrcpy() {
  try {
    const result = await q.app.launchScrcpy();
    if (result && result.ok) {
      toast('Launching scrcpy…', 'info', 2000);
    } else {
      toast((result && result.error) || 'scrcpy not available', 'error', 5000);
    }
  } catch (error) {
    toast('scrcpy not available. Install it (brew install scrcpy).', 'error', 5000);
  }
}

function stopLiveStream() {
  if (liveStream) {
    try { if (liveStream.decoder) liveStream.decoder.close(); } catch {}
    if (liveStream.unsubData) liveStream.unsubData();
    if (liveStream.unsubEnd) liveStream.unsubEnd();
    liveStream = null;
  }
  q.device.stopStream().catch(() => {});
}

// Keep snapshot fallback for older Electron builds.
async function openLivePreview() {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  const body = el('div');
  const stage = el('div', 'stage');
  stage.style.minHeight = '240px';
  stage.style.display = 'flex';
  stage.style.alignItems = 'center';
  stage.style.justifyContent = 'center';
  const canvas = document.createElement('canvas');
  canvas.style.maxWidth = '100%';
  canvas.style.maxHeight = '60vh';
  canvas.style.objectFit = 'contain';
  stage.append(canvas);
  body.append(stage);
  const ctx = canvas.getContext('2d');

  const hint = el('div', 'hint', 'Showing the left eye. Live audio is not streamed; use Record (with audio) to capture sound.');
  hint.style.marginTop = '8px';
  body.append(hint);

  const foot = el('div', 'modal-foot');
  const fpsLabel = el('span', '', 'Live');
  fpsLabel.style.color = 'var(--muted)';
  fpsLabel.style.fontSize = '11.5px';
  const fsBtn = el('button', 'mini-btn', 'Fullscreen');
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  const recBtn = el('button', 'mini-btn', 'Record');
  recBtn.addEventListener('click', () => {
    closeModal();
    stopLivePreview();
    toggleRecording();
  });
  const recAudioBtn = el('button', 'mini-btn', 'Record (audio)');
  recAudioBtn.addEventListener('click', () => {
    closeModal();
    stopLivePreview();
    toggleRecording({ audio: true });
  });
  foot.append(fpsLabel, el('span', 'spacer'), fsBtn, recBtn, recAudioBtn);

  openModal({
    title: 'Live preview',
    sub: 'Near-live view of the headset screen.',
    body,
    foot,
  });

  livePreviewRunning = true;
  const tick = async () => {
    if (!livePreviewRunning) return;
    try {
      const snap = await q.device.previewSnapshot(state.serial);
      if (snap && snap.url) {
        const image = new Image();
        image.onload = () => {
          const halfW = Math.floor(image.width / 2);
          if (canvas.width !== halfW || canvas.height !== image.height) {
            canvas.width = halfW;
            canvas.height = image.height;
          }
          ctx.drawImage(image, 0, 0, halfW, image.height, 0, 0, halfW, image.height);
        };
        image.src = `${snap.url}?t=${Date.now()}`;
      }
    } catch (error) {
      // ignore transient failures
    }
  };
  await tick();
  livePreviewTimer = setInterval(tick, 600);
  // Stop polling when modal closes.
  const prevCloser = modalCloser;
  modalCloser = () => {
    stopLivePreview();
    if (prevCloser) prevCloser();
  };
}

function stopLivePreview() {
  livePreviewRunning = false;
  if (livePreviewTimer) {
    clearInterval(livePreviewTimer);
    livePreviewTimer = null;
  }
}

async function openDevices() {
  const body = el('div');
  const list = el('div', 'pkg-list');
  if (!state.devices.length) {
    list.append(el('div', 'pkg', 'No headsets connected. Plug in a Quest over USB or use Connect over Wi-Fi.'));
  }
  for (const device of state.devices) {
    const row = el('div', 'pkg');
    const info = device.info || {};
    row.append(el('strong', '', (device.model || 'Quest').replace(/^Quest_/, 'Quest ')));
    row.append(el('div', 'hint', device.serial));
    const meta = [];
    if (info.battery && info.battery.level != null) meta.push(`${info.battery.level}%${info.battery.charging ? ' ⚡' : ''}`);
    if (info.storage && info.storage.freeBytes != null) meta.push(`${P.formatBytes(info.storage.freeBytes)} free`);
    if (meta.length) row.append(el('div', 'hint', meta.join('  ·  ')));
    if (device.state && device.state !== 'device') row.append(el('div', 'hint', device.state));
    row.append(el('div', 'hint', `Transport: ${String(device.serial).includes(':') ? 'Wi-Fi' : 'USB'}`));
    if (device.serial === state.serial) {
      row.append(el('div', 'hint', 'Currently selected'));
    } else {
      const use = el('button', 'mini-btn', 'Select');
      use.addEventListener('click', () => {
        selectDevice(device.serial);
        closeModal();
        toast(`Selected ${(device.model || 'Quest').replace(/^Quest_/, 'Quest ')}`, 'success', 2000);
      });
      row.append(use);
    }
    list.append(row);
  }
  body.append(list);

  const foot = el('div', 'modal-foot');
  const wifi = el('button', 'mini-btn primary', 'Connect over Wi-Fi…');
  wifi.addEventListener('click', () => {
    closeModal();
    openWireless();
  });
  foot.append(el('span', 'spacer'), wifi);

  openModal({
    title: 'Select headset',
    sub: 'Choose which connected Quest to browse. QuestDock can talk to several at once.',
    body,
    foot,
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

async function openApps() {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  const body = el('div');
  const list = el('div', 'pkg-list');
  list.append(el('div', 'pkg', 'Loading installed apps…'));
  body.append(list);

  const foot = el('div', 'modal-foot');
  const install = el('button', 'mini-btn', 'Install APK…');
  const count = el('span', '', '');
  count.style.color = 'var(--muted)';
  count.style.fontSize = '11.5px';
  foot.append(count, el('span', 'spacer'), install);

  install.addEventListener('click', async () => {
    try {
      const results = await q.apps.install(state.serial);
      const good = results.filter((item) => item.ok).length;
      const bad = results.filter((item) => !item.ok);
      if (good) toast(`Installed ${plural(good, 'package')}`, 'success');
      for (const failure of bad) toast(`${failure.file}: ${failure.error}`, 'error', 7000);
      await load();
    } catch (error) {
      fail(error);
    }
  });

  async function load() {
    try {
      const packages = await q.apps.list(state.serial);
      list.textContent = '';
      count.textContent = `${packages.length} sideloaded`;
      if (!packages.length) {
        list.append(el('div', 'pkg', 'No sideloaded apps on this headset yet.'));
      }
      for (const name of packages) {
        const row = el('div', 'pkg');
        row.append(el('span', '', name));
        const remove = el('button', 'mini-btn danger', 'Uninstall');
        remove.addEventListener('click', async () => {
          const okay = await confirmModal({
            title: 'Uninstall app?',
            message: `${name} is removed from the headset. Save data for the app goes with it.`,
            confirm: 'Uninstall',
            danger: true,
          });
          if (!okay) return;
          try {
            await q.apps.uninstall(state.serial, name);
            toast(`Uninstalled ${name}`, 'success');
            await load();
          } catch (error) {
            fail(error);
          }
        });
        row.append(remove);
        list.append(row);
      }
    } catch (error) {
      list.textContent = '';
      list.append(el('div', 'pkg', error.message));
    }
  }

  openModal({ title: 'Installed apps', sub: 'Sideloaded packages on this headset', body, foot, wide: true });
  load();
}

/* ------------------------------------------------------------------ *
 *  Remote folder picker
 * ------------------------------------------------------------------ */

function pickRemoteFolder({ title, confirm }) {
  return new Promise((resolve) => {
    let cwd = state.remote.cwd || '/sdcard';

    const body = el('div');
    const crumb = el('div', 'path-bar');
    crumb.style.padding = '0 0 10px';
    const list = el('div', 'pkg-list');
    list.style.minHeight = '240px';
    body.append(crumb, list);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'mini-btn', 'Cancel');
    const choose = el('button', 'mini-btn primary', confirm);
    foot.append(cancel, el('span', 'spacer'), choose);

    const finish = (value) => {
      closeModal();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    choose.addEventListener('click', () => finish(cwd));

    async function load(target) {
      list.textContent = '';
      list.append(el('div', 'pkg', 'Opening…'));
      try {
        const listing = await q.fs.list(state.serial, target);
        cwd = listing.path;
        renderCrumbs(listing.path);
        list.textContent = '';

        if (listing.parent) {
          const up = el('div', 'pkg');
          up.append(el('span', '', '⬑  Up one folder'));
          up.style.cursor = 'pointer';
          up.addEventListener('click', () => load(listing.parent));
          list.append(up);
        }

        const folders = listing.entries.filter((entry) => entry.isDir);
        if (!folders.length) list.append(el('div', 'pkg', 'No folders here'));
        for (const folder of folders) {
          const row = el('div', 'pkg');
          row.style.cursor = 'pointer';
          row.append(el('span', '', `📁  ${folder.name}`));
          row.addEventListener('click', () => load(folder.path));
          list.append(row);
        }
      } catch (error) {
        list.textContent = '';
        list.append(el('div', 'pkg', error.message));
      }
    }

    function renderCrumbs(path) {
      crumb.textContent = '';
      const parts = crumbParts(path, 'remote');
      parts.forEach((part, index) => {
        if (index) crumb.append(el('span', 'crumb-sep', '›'));
        const button = el('button', 'crumb', part.label);
        button.addEventListener('click', () => load(part.path));
        crumb.append(button);
      });
    }

    openModal({ title, sub: 'Choose a folder on the headset', body, foot, wide: true });
    load(cwd);
  });
}

/* ------------------------------------------------------------------ *
 *  Drag and drop
 * ------------------------------------------------------------------ */

function wireDropZone() {
  const pane = $('#remotePane');
  const veil = $('#dropVeil');
  let depth = 0;

  const hasFiles = (event) =>
    event.dataTransfer && [...(event.dataTransfer.types || [])].includes('Files');

  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    depth += 1;
    document.body.classList.add('dragging');
    if (state.serial) {
      if (state.dockCollapsed) {
        /* no change */
      }
      veil.classList.add('visible');
    }
  });

  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.serial ? 'copy' : 'none';
  });

  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      document.body.classList.remove('dragging');
      veil.classList.remove('visible');
    }
  });

  pane.addEventListener('drop', async (event) => {
    event.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    veil.classList.remove('visible');

    if (!state.serial) {
      toast('Connect a headset before dropping files', 'error');
      return;
    }
    const files = [...event.dataTransfer.files];
    const paths = files.map((file) => q.pathForFile(file)).filter(Boolean);
    if (!paths.length) {
      toast('Those items cannot be read from this window', 'error');
      return;
    }
    await pushMany(paths);
  });

  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
  });
}

/* ------------------------------------------------------------------ *
 *  Wiring
 * ------------------------------------------------------------------ */

function wireToolbar() {
  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      const [which, action] = button.dataset.nav.split(':');
      if (action === 'back') goBack(which);
      else if (action === 'up') goUp(which);
      else if (action === 'refresh') navigate(which, paneOf(which).cwd, { remember: false });
      else if (action === 'home') navigate('local', state.settings.home || '');
      else if (action === 'places') openPlacesMenu(button).catch(fail);
      else if (action === 'volumes') openVolumesMenu(button).catch(fail);
      else if (action === 'sdcard') navigate('remote', '/sdcard');
      else if (action === 'newFolder') {
        if (which === 'local') newLocalFolder();
        else newRemoteFolder();
      }
    });
  });

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'settings') openSettings();
      else if (action === 'wireless') openWireless();
      else if (action === 'apps') openApps();
      else if (action === 'devices') openDevices();
      else if (action === 'fullscreen') toggleFullscreen();
      else if (action === 'screenshot') takeScreenshot();
      else if (action === 'record') toggleRecording();
      else if (action === 'live') openLiveStream();
    });
  });

  for (const which of ['local', 'remote']) {
    const search = which === 'local' ? $('#localSearch') : $('#remoteSearch');
    search.addEventListener('input', () => {
      paneOf(which).filter = search.value;
      renderPane(which);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        paneOf(which).filter = '';
        renderPane(which);
        search.blur();
      }
    });
  }

  $('#dockToggle').addEventListener('click', () => {
    state.dockCollapsed = !state.dockCollapsed;
    $('#dock').classList.toggle('collapsed', state.dockCollapsed);
    $('#dockToggle').setAttribute('aria-expanded', String(!state.dockCollapsed));
  });

  document.addEventListener('mousedown', (event) => {
    if (!$('#contextMenu').hidden && !$('#contextMenu').contains(event.target)) hideContextMenu();
    const pop = $('#devicePopover');
    if (pop && !pop.contains(event.target) && !event.target.closest('.device-chip')) closePopover();
  });
}

function activePane() {
  const list = document.activeElement;
  if (list && list.id === 'remoteList') return 'remote';
  if (list && list.id === 'localList') return 'local';
  return 'remote';
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (!$('#modalRoot').hidden) {
      if (event.key === 'Escape') closeModal();
      return;
    }
    const tag = (event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    const which = activePane();
    const view = paneOf(which);
    const key = event.key;

    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'a') {
      event.preventDefault();
      for (const entry of visibleEntries(which)) view.selected.add(entry.path);
      updateSelectionStyles(which);
      renderActions(which);
      renderFoots();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'u') {
      event.preventDefault();
      uploadFiles();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'd') {
      event.preventDefault();
      const entries = selectedEntries(which);
      if (which === 'remote' && entries.length) {
        downloadEntries(entries).catch((error) => {
          if (error && error.code === 'cancel') return;
          fail(error);
        });
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'n') {
      event.preventDefault();
      if (which === 'local') newLocalFolder();
      else newRemoteFolder();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'r') {
      event.preventDefault();
      navigate(which, view.cwd, { remember: false });
      return;
    }

    if (key === 'Backspace' || key === 'ArrowUp' && event.altKey) {
      if (tag !== 'input') {
        event.preventDefault();
        goUp(which);
      }
      return;
    }
    if (key === 'Enter') {
      const entries = selectedEntries(which);
      if (entries.length === 1) {
        event.preventDefault();
        openEntry(which, entries[0]);
      }
      return;
    }
    if (key === ' ') {
      const entries = selectedEntries(which);
      if (entries.length === 1 && !entries[0].isDir) {
        event.preventDefault();
        openLightbox(entries[0]);
      }
      return;
    }
    if (key === 'F2') {
      const entries = selectedEntries(which);
      if (entries.length === 1) {
        event.preventDefault();
        if (which === 'local') renameLocal(entries[0]);
        else renameRemote(entries[0]);
      }
      return;
    }
    if (key === 'Delete' || (key === 'Backspace' && event.metaKey)) {
      const entries = selectedEntries(which);
      if (entries.length) {
        event.preventDefault();
        if (which === 'local') deleteLocal(entries);
        else deleteRemote(entries);
      }
      return;
    }
    if (key === 'Escape') {
      view.selected.clear();
      updateSelectionStyles(which);
      renderActions(which);
      renderFoots();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const list = visibleEntries(which);
      if (!list.length) return;
      event.preventDefault();
      const current = view.anchor ? list.findIndex((entry) => entry.path === view.anchor) : -1;
      const next = Math.max(0, Math.min(list.length - 1, current + (key === 'ArrowDown' ? 1 : -1)));
      view.selected.clear();
      view.selected.add(list[next].path);
      view.anchor = list[next].path;
      updateSelectionStyles(which);
      const listNode = which === 'local' ? $('#localList') : $('#remoteList');
      const row = [...listNode.querySelectorAll('.row')].find(
        (item) => item.dataset.path === list[next].path
      );
      if (row) row.scrollIntoView({ block: 'nearest' });
      renderActions(which);
      renderFoots();
    }
  });
}

async function takeScreenshot() {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  try {
    setStatus('Taking a screenshot…');
    const saved = await q.device.screenshot(state.serial);
    setStatus('');
    if (saved) {
      toast('Screenshot saved', 'success', 3000);
    }
  } catch (error) {
    setStatus('');
    fail(error);
  }
}

async function toggleRecording(options = {}) {
  if (!state.serial) {
    toast('Connect a headset first', 'error');
    return;
  }
  try {
    if (state.recording) {
      setStatus('Finishing recording…');
      const saved = await q.device.stopRecording();
      state.recording = null;
      setStatus('');
      renderHeader();
      if (saved) toast('Recording saved', 'success');
    } else {
      await q.device.startRecording(state.serial, options);
      state.recording = { startedAt: Date.now(), audio: Boolean(options && options.audio) };
      renderHeader();
      toast(
        `Recording${options && options.audio ? ' (with audio)' : ''} — press Record again to stop`,
        'info',
        3500
      );
      const timer = setInterval(async () => {
        if (!state.recording) {
          clearInterval(timer);
          return;
        }
        const status = await q.device.recordingStatus().catch(() => ({ recording: false }));
        if (!status.recording) {
          clearInterval(timer);
          state.recording = null;
          renderHeader();
          toast('Recording stopped (3 minute limit)', 'info');
        }
      }, 4000);
    }
  } catch (error) {
    setStatus('');
    fail(error);
  }
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

async function boot() {
  const info = await q.app.info();
  state.platform = info.platform;
  state.version = info.version;
  state.electron = info.electron;
  state.settings = info.settings || {};
  state.adb.path = info.adbPath || '';

  document.body.classList.add(`platform-${info.platform}`);

  wireToolbar();
  wireKeyboard();
  wireDropZone();

  q.devices.onChanged((payload) => applyDevices(payload));
  q.net.onWireless(({ state: phase, hostPort }) => {
    if (phase === 'connected') {
      toast(`Reconnected over Wi-Fi at ${hostPort}`, 'success', 3200);
    }
  });
  q.transfers.onUpdate((snapshot) => applyTransferUpdate(snapshot));
  q.transfers.onConflict((payload) => openConflictModal(payload));
  q.preview.onThumb(({ key, file }) => {
    state.thumbs.set(key, file);
    state.pendingThumbs.delete(key);
    paintThumb(key, file);
  });

  q.ui.on('settings', () => openSettings());
  q.ui.on('upload', () => uploadFiles());
  q.ui.on('download', () => {
    const entries = selectedEntries('remote');
    if (entries.length) {
      downloadEntries(entries).catch((error) => {
        if (error && error.code === 'cancel') return;
        fail(error);
      });
    } else {
      toast('Select something on the headset first', 'info');
    }
  });
  q.ui.on('newFolder', () => newRemoteFolder());
  q.ui.on('refresh', () => {
    if (state.serial) navigate('remote', state.remote.cwd, { remember: false });
    if (state.local.cwd) navigate('local', state.local.cwd, { remember: false });
  });
  q.ui.on('screenshot', takeScreenshot);
  q.ui.on('record', (payload) => toggleRecording(payload || {}));
  q.ui.on('wake', async () => {
    if (!state.serial) return toast('Connect a headset first', 'error');
    try {
      await q.device.wake(state.serial);
      toast('Headset woken', 'success', 2000);
    } catch (error) {
      fail(error);
    }
  });
  q.ui.on('wireless', openWireless);
  q.ui.on('devices', openDevices);

  // Local pane starts at the remembered folder, or Downloads.
  const startDir = state.settings.localDir || info.downloads || '';
  state.settings.home = info.downloads || startDir;
  try {
    await navigate('local', startDir, { remember: false });
  } catch (error) {
    fail(error);
  }

  const snapshot = await q.transfers.list().catch(() => null);
  if (snapshot) applyTransferUpdate(snapshot);

  await refreshDevices();

  if (state.settings.keepAwake !== false && state.serial) {
    q.device.keepAwake(state.serial, true).catch(() => {});
  }

  renderDock();
  state.ready = true;
}

boot().catch((error) => {
  console.error(error);
  toast(`QuestDock failed to start: ${error.message}`, 'error', 12000);
});

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearTimeout(refreshTimer);
});
