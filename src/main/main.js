'use strict';

/**
 * QuestDock main process.
 *
 * Owns the window, the ADB session, the transfer queue and the preview cache.
 * The renderer never touches the filesystem or child processes directly: every
 * capability is an IPC channel registered below, and each handler answers with
 * `{ ok, data }` or `{ ok: false, error }` so failures arrive as readable text.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const adb = require('./adb');
const P = require('../shared/paths');
const zip = require('./zip');
const apkBundle = require('./apk-bundle');
const beatsaber = require('./beatsaber');
const { TransferQueue } = require('./transfers');
const { PreviewCache } = require('./preview');
const { Store } = require('./store');

const isDev = process.argv.includes('--dev');
const POLL_MS = 2500;
const INFO_TTL_MS = 30_000;

/**
 * `--capture <file>` renders the window to a PNG and quits. It exists so the
 * interface can be reviewed on machines where the OS will not let a shell take
 * a screenshot, and so packaging can sanity-check that the UI still paints.
 */
const captureIndex = process.argv.indexOf('--capture');
const capturePath = captureIndex !== -1 ? process.argv[captureIndex + 1] || 'questdock.png' : '';

let win = null;
let store = null;
let queue = null;
let previews = null;
let pollTimer = null;
let pollBusy = false;
let lastSignature = '';
let recorder = null;
let streamer = null;

const infoCache = new Map(); // serial -> { at, info }
const thumbQueue = [];
let thumbActive = 0;
const THUMB_PARALLEL = 2;

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function requireSerial(serial) {
  if (typeof serial !== 'string' || !serial.trim()) {
    throw new Error('No headset selected.');
  }
  return serial.trim();
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}.`);
  return value;
}

/** Only /sdcard is writable unless the user explicitly opted out. */
function assertWritable(remotePath) {
  const clean = P.normalizePosix(requireText(remotePath, 'path'));
  if (store.get('allowAnywhere')) return clean;
  if (!P.isInside('/sdcard', clean)) {
    throw new Error(
      'QuestDock only writes inside /sdcard. Enable "Allow writes anywhere" in Settings if you really need another location.'
    );
  }
  return clean;
}

function downloadsDir() {
  try {
    return app.getPath('downloads');
  } catch {
    return os.homedir();
  }
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function uniqueLocalPath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 500; i += 1) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function defaultWindowOptions() {
  const base = {
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: 'QuestDock',
    icon: fs.existsSync(path.join(__dirname, '..', '..', 'build', 'icon.png'))
      ? path.join(__dirname, '..', '..', 'build', 'icon.png')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (process.platform === 'darwin') {
    base.titleBarStyle = 'hiddenInset';
    base.trafficLightPosition = { x: 14, y: 18 };
  }
  return base;
}

/* ------------------------------------------------------------------ *
 *  Devices
 * ------------------------------------------------------------------ */

async function deviceInfoFor(serial, force = false) {
  const cached = infoCache.get(serial);
  if (!force && cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;
  const info = await adb.deviceInfo(serial);
  infoCache.set(serial, { at: Date.now(), info });
  return info;
}

async function collectDevices() {
  let available = true;
  let error = '';
  let version = '';
  let devices = [];

  try {
    version = await adb.version();
    devices = await adb.listDevices();
  } catch (problem) {
    available = false;
    error = problem && problem.message ? problem.message : String(problem);
  }

  const known = new Set(devices.map((device) => device.serial));
  for (const serial of infoCache.keys()) {
    if (!known.has(serial)) infoCache.delete(serial);
  }

  const enriched = await Promise.all(
    devices.map(async (device) => {
      if (!device.authorized) return { ...device, info: null };
      try {
        const info = await deviceInfoFor(device.serial);
        return { ...device, info };
      } catch (problem) {
        return { ...device, info: null, infoError: problem.message };
      }
    })
  );

  return {
    available,
    error,
    version,
    adbPath: adb.adbPath(),
    devices: enriched,
  };
}

/* ------------------------------------------------------------------ *
 *  Wireless auto-reconnect
 *
 *  Android advertises wireless debugging over mDNS, but the TCP port changes
 *  every time the headset reboots. Remembering only `ip:port` therefore rots:
 *  we keep the hardware serial and look the current port up again.
 * ------------------------------------------------------------------ */

const WIRELESS_RETRY_MS = 15_000;
let lastWirelessTry = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rememberWireless(hostPort) {
  try {
    const devices = await adb.listDevices();
    const tcp = devices.find((device) => device.serial === hostPort);
    let hardwareSerial = '';
    if (tcp) {
      try {
        const map = await adb.props(tcp.serial);
        hardwareSerial = map['ro.serialno'] || map['ro.boot.serialno'] || '';
      } catch {
        /* the host part is enough to reconnect */
      }
    }
    store.set({
      wirelessHost: hostPort,
      wirelessSerial: hardwareSerial,
      lastSerial: hostPort,
    });
    return { hostPort, serial: hardwareSerial };
  } catch {
    return { hostPort, serial: '' };
  }
}

async function autoReconnectWireless() {
  if (store.get('wirelessAutoReconnect') === false) return false;
  const savedHost = store.get('wirelessHost');
  const savedSerial = store.get('wirelessSerial');
  if (!savedHost && !savedSerial) return false;
  if (Date.now() - lastWirelessTry < WIRELESS_RETRY_MS) return false;
  lastWirelessTry = Date.now();

  let devices = [];
  try {
    devices = await adb.listDevices();
  } catch {
    return false;
  }
  if (devices.some((device) => String(device.serial).includes(':') && device.state === 'device')) {
    return false;
  }

  const targets = [];
  const services = await adb.mdnsServices();
  const bySerial = savedSerial
    ? services.find((service) => service.serial === savedSerial)
    : null;
  const anyDebug = services.find((service) => service.service === '_adb-tls-connect._tcp');
  const discovered = bySerial || anyDebug;
  if (discovered) targets.push(discovered.hostPort);
  if (savedHost && !targets.includes(savedHost)) targets.push(savedHost);

  for (const target of targets) {
    try {
      const output = await adb.connect(target);
      if (/connected/i.test(output) && !/failed/i.test(output)) {
        await rememberWireless(target);
        send('devices:wireless', { state: 'connected', hostPort: target });
        return true;
      }
    } catch {
      /* try the next candidate */
    }
  }
  send('devices:wireless', { state: 'searching', hostPort: savedHost });
  return false;
}

async function pollDevices(force = false) {
  if (pollBusy) return null;
  pollBusy = true;
  try {
    await autoReconnectWireless().catch(() => {});
    const payload = await collectDevices();
    const signature = JSON.stringify(
      payload.devices.map((device) => [
        device.serial,
        device.state,
        device.info ? device.info.battery.level : null,
        device.info ? device.info.storage && device.info.storage.freeBytes : null,
      ])
    );
    if (force || signature !== lastSignature || !payload.available) {
      lastSignature = signature;
      send('devices:changed', payload);
    }
    return payload;
  } finally {
    pollBusy = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  const tick = () => {
    pollDevices().catch(() => {});
  };
  tick();
  pollTimer = setInterval(tick, POLL_MS);
  pollTimer.unref?.();
}

/* ------------------------------------------------------------------ *
 *  Transfers
 * ------------------------------------------------------------------ */

function buildTransfers() {
  queue = new TransferQueue();

  queue.on('update', (snapshot) => send('transfer:update', snapshot));

  queue.on('conflict', (payload) => {
    if (!win || win.isDestroyed()) {
      queue.resolveConflict(payload.id, 'skip');
      return;
    }
    send('transfer:conflict', payload);
    if (!win.isFocused()) {
      win.flashFrame(true);
    }
  });

  return queue;
}

async function enqueueTransfer(spec) {
  const direction = spec.direction === 'pull' ? 'pull' : 'push';
  const serial = requireSerial(spec.serial);
  const localPath = path.resolve(requireText(spec.localPath, 'local path'));
  const remotePath =
    direction === 'push'
      ? assertWritable(spec.remotePath)
      : P.normalizePosix(requireText(spec.remotePath, 'remote path'));

  let isDir = Boolean(spec.isDir);
  let totalBytes = Number.isFinite(spec.totalBytes) ? spec.totalBytes : null;
  if (direction === 'push') {
    let stats;
    try {
      stats = await fsp.lstat(localPath);
    } catch {
      throw new Error(`"${path.basename(localPath)}" is no longer on this computer.`);
    }
    isDir = stats.isDirectory();
    if (!isDir) totalBytes = stats.size;
  }

  return queue.add({
    direction,
    serial,
    localPath,
    remotePath,
    isDir,
    totalBytes,
    conflict: ['ask', 'overwrite', 'rename', 'skip'].includes(spec.conflict)
      ? spec.conflict
      : 'ask',
    label: typeof spec.label === 'string' ? spec.label : '',
    cleanupPath: typeof spec.cleanupPath === 'string' ? spec.cleanupPath : '',
  });
}

/**
 * Inspect and install one or more APKs/bundles. Split packages are extracted
 * to a temp folder and installed with `install-multiple`; XAPK/APKM OBB files
 * are pushed afterwards to /sdcard/Android/obb/<package>.
 */
async function installPackages(serial, files) {
  const clean = requireSerial(serial);
  const results = [];

  for (const file of files) {
    let temp = '';
    try {
      const descriptor = await apkBundle.inspect(file);
      temp = await apkBundle.makeTempDir();
      const staged = await apkBundle.stage(descriptor, temp);

      const before = new Set(await adb.listPackages(clean));
      const beforePaths = await adb.listPackagePaths(clean).catch(() => new Map());
      await adb.installMultiple(clean, staged.apkPaths);
      const after = await adb.listPackages(clean);
      const afterPaths = await adb.listPackagePaths(clean).catch(() => new Map());
      const added = after.filter((name) => !before.has(name));
      const updated = [...afterPaths]
        .filter(([name, p]) => beforePaths.has(name) && beforePaths.get(name) !== p)
        .map(([name]) => name);
      const packageName =
        descriptor.packageName ||
        (added.length === 1 ? added[0] : '') ||
        (updated.length === 1 ? updated[0] : '') ||
        '';

      for (const obb of staged.obbPaths) {
        const remoteDir = `/sdcard/Android/obb/${obb.packageName}`;
        await adb.mkdir(clean, remoteDir);
        await adb.pushFile(clean, obb.localPath, P.joinPosix(remoteDir, obb.fileName));
      }

      results.push({
        file,
        ok: true,
        type: descriptor.type,
        packageName,
        label: descriptor.label,
        splits: staged.apkPaths.length,
        obb: staged.obbPaths.length,
      });
    } catch (error) {
      results.push({ file, ok: false, error: error.message });
    } finally {
      if (temp) await zip.removeTree(temp).catch(() => {});
    }
  }

  return results;
}


/* ------------------------------------------------------------------ *
 *  Thumbnails, one small queue so a folder of 400 photos stays responsive
 * ------------------------------------------------------------------ */

function pumpThumbs() {
  while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
    const task = thumbQueue.shift();
    thumbActive += 1;
    previews
      .thumbnail(task.serial, task.entry)
      .then((file) => {
        if (file) send('preview:thumb', { key: task.entry.path, file: pathToFileURL(file).href });
      })
      .catch(() => {})
      .finally(() => {
        thumbActive -= 1;
        pumpThumbs();
      });
  }
}

/* ------------------------------------------------------------------ *
 *  Menu
 * ------------------------------------------------------------------ */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('ui:settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Upload to Headset…',
        accelerator: 'CmdOrCtrl+U',
        click: () => send('ui:upload'),
      },
      {
        label: 'Download Selected…',
        accelerator: 'CmdOrCtrl+D',
        click: () => send('ui:download'),
      },
      { type: 'separator' },
      { label: 'New Folder', accelerator: 'CmdOrCtrl+N', click: () => send('ui:newFolder') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('ui:refresh') },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen', accelerator: 'F11' },
      ...(isDev
        ? [{ type: 'separator' }, { role: 'toggleDevTools' }]
        : []),
    ],
  });

  template.push({
    label: 'Device',
    submenu: [
      { label: 'Take Screenshot', click: () => send('ui:screenshot') },
      { label: 'Start Recording', click: () => send('ui:record') },
      { label: 'Start Recording (with audio)', click: () => send('ui:record', { audio: true }) },
      { type: 'separator' },
      { label: 'Select Headset…', click: () => send('ui:devices') },
      { type: 'separator' },
      { label: 'Wake Headset', click: () => send('ui:wake') },
      { label: 'Connect over Wi-Fi…', click: () => send('ui:wireless') },
    ],
  });

  template.push({
    label: 'Window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 *  Window
 * ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow(defaultWindowOptions());

  win.once('ready-to-show', () => {
    win.show();
    if (process.platform === 'darwin' && isDev && !capturePath) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.on('focus', () => win.flashFrame(false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/* ------------------------------------------------------------------ *
 *  IPC: app and settings
 * ------------------------------------------------------------------ */

function registerIpc() {
  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    adbPath: adb.adbPath(),
    downloads: downloadsDir(),
    settings: store.all(),
  }));

  handle('app:launchScrcpy', async () => {
    const { spawn, execFileSync } = require('child_process');
    let found = null;
    try {
      execFileSync('which', ['scrcpy'], { stdio: 'ignore' });
      found = 'scrcpy';
    } catch {}
    if (!found) {
      return { ok: false, error: 'scrcpy not found on PATH. Install it (brew install scrcpy) for an external mirror.' };
    }
    try {
      const child = spawn(found, ['--max-size', '1280'], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  handle('app:openLocalNetworkSettings', async () => {
    if (process.platform !== 'darwin') return false;
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
      return true;
    } catch {
      return false;
    }
  });

  handle('settings:get', () => store.all());

  handle('settings:set', async (patch) => {
    const clean = patch && typeof patch === 'object' ? patch : {};
    const next = store.set(clean);
    if (typeof clean.adbPath === 'string') {
      adb.setAdbPath(clean.adbPath);
      adb.resolveAdb(true);
      infoCache.clear();
      lastSignature = '';
      await pollDevices(true);
    }
    return next;
  });

  handle('settings:pickAdb', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose the adb executable',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'adb', extensions: ['exe'] }]
          : [{ name: 'adb', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const chosen = result.filePaths[0];
    store.set({ adbPath: chosen });
    adb.setAdbPath(chosen);
    adb.resolveAdb(true);
    infoCache.clear();
    lastSignature = '';
    await pollDevices(true);
    return chosen;
  });

  /* ---------------- devices ---------------- */

  handle('devices:list', () => pollDevices(true));

  handle('devices:info', async (serial, force) => {
    const info = await deviceInfoFor(requireSerial(serial), Boolean(force));
    return info;
  });

  /* ---------------- browsing ---------------- */

  handle('fs:list', async (serial, dirPath) => {
    const listing = await adb.listDir(requireSerial(serial), requireText(dirPath, 'path'));
    return {
      ...listing,
      entries: listing.entries.map((entry) => ({
        ...entry,
        // 0-byte folders and permission oddities are more useful as a hint.
        sizeLabel: entry.isDir ? null : P.formatBytes(entry.size),
      })),
    };
  });

  handle('fs:stat', async (serial, remotePath) => {
    const clean = P.normalizePosix(requireText(remotePath, 'path'));
    return { path: clean, size: await adb.statSize(requireSerial(serial), clean) };
  });

  handle('fs:volumes', async (serial) => {
    const clean = requireSerial(serial);
    const volumes = await adb.listVolumes(clean);
    return volumes.map((volume) => ({
      ...volume,
      totalLabel: volume.totalBytes ? P.formatBytes(volume.totalBytes) : '',
      freeLabel: volume.freeBytes ? P.formatBytes(volume.freeBytes) : '',
    }));
  });

  handle('fs:mkdir', async (serial, dirPath) => {
    const clean = assertWritable(dirPath);
    const exists = await adb.exists(requireSerial(serial), clean);
    if (exists) throw new Error('A file or folder with that name already exists.');
    await adb.mkdir(requireSerial(serial), clean);
    return clean;
  });

  handle('fs:rename', async (serial, from, to) => {
    const source = assertWritable(from);
    const target = assertWritable(to);
    if (source === target) return target;
    const exists = await adb.exists(requireSerial(serial), target);
    if (exists) throw new Error('That name is already taken.');
    await adb.rename(requireSerial(serial), source, target);
    return target;
  });

  handle('fs:delete', async (serial, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).map(assertWritable);
    await adb.remove(requireSerial(serial), list);
    return list.length;
  });

  handle('fs:copyMove', async (serial, paths, destDir, mode) => {
    const list = (Array.isArray(paths) ? paths : [paths]).map(assertWritable);
    const destination = assertWritable(destDir);
    if (list.some((item) => P.isInside(item, destination) && item !== destination)) {
      throw new Error('A folder cannot be copied or moved inside itself.');
    }
    for (const item of list) {
      await adb.copyMove(requireSerial(serial), item, destination, mode === 'move' ? 'move' : 'copy');
    }
    return list.length;
  });

  handle('fs:usage', async (serial, remotePath) => {
    const clean = P.normalizePosix(requireText(remotePath, 'path'));
    return adb.folderSize(requireSerial(serial), clean);
  });

  /* ---------------- the computer's own files ---------------- */

  handle('local:roots', async () => {
    const roots = [
      { label: 'Home', path: os.homedir(), kind: 'place' },
      { label: 'Desktop', path: app.getPath('desktop'), kind: 'place' },
      { label: 'Downloads', path: downloadsDir(), kind: 'place' },
      { label: 'Documents', path: app.getPath('documents'), kind: 'place' },
      { label: 'Pictures', path: app.getPath('pictures'), kind: 'place' },
    ];
    if (process.platform === 'darwin') {
      try {
        const volumes = await fsp.readdir('/Volumes');
        for (const name of volumes) {
          roots.push({ label: name, path: path.join('/Volumes', name), kind: 'volume' });
        }
      } catch {
        /* no volumes mounted */
      }
    }
    if (process.platform === 'win32') {
      // There is no fs API for drives, so probe the letters. A missing letter
      // fails immediately; a disconnected network drive is the only slow case.
      for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\`;
        try {
          if (fs.statSync(root).isDirectory()) {
            roots.push({ label: `${letter}:`, path: root, kind: 'drive' });
          }
        } catch {
          /* no drive at this letter */
        }
      }
    }
    const seen = new Set();
    return roots.filter((root) => {
      if (!root.path || seen.has(root.path)) return false;
      seen.add(root.path);
      return fs.existsSync(root.path);
    });
  });

  handle('local:list', async (dirPath) => {
    const clean = path.resolve(requireText(dirPath, 'path'));
    const stats = await fsp.stat(clean);
    if (!stats.isDirectory()) throw new Error('That is a file, not a folder.');

    let names = [];
    try {
      names = await fsp.readdir(clean);
    } catch (error) {
      if (error.code === 'EACCES') throw new Error('This computer will not let the app read that folder.');
      if (error.code === 'EPERM') throw new Error('macOS blocked access to that folder. Allow it in System Settings › Privacy & Security › Files and Folders.');
      throw error;
    }

    const showHidden = store.get('showHidden') !== false;
    const entries = [];
    for (const name of names) {
      if (!showHidden && name.startsWith('.')) continue;
      const full = path.join(clean, name);
      let info;
      try {
        info = await fsp.lstat(full);
      } catch {
        continue;
      }
      const isDir = info.isDirectory();
      entries.push({
        name,
        path: full,
        isDir,
        isSymlink: info.isSymbolicLink(),
        linkTarget: '',
        size: isDir ? null : info.size,
        mtime: info.mtimeMs,
        mode: '',
        owner: '',
        group: '',
        kind: P.kindForName(name, isDir),
        sizeLabel: isDir ? null : P.formatBytes(info.size),
        url: isDir ? null : pathToFileURL(full).href,
      });
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const folded = a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
      if (folded !== 0) return folded;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    return { path: clean, parent: path.dirname(clean) === clean ? null : path.dirname(clean), entries };
  });

  handle('local:mkdir', async (dirPath) => {
    const clean = path.resolve(requireText(dirPath, 'path'));
    await fsp.mkdir(clean);
    return clean;
  });

  handle('local:rename', async (from, to) => {
    const source = path.resolve(requireText(from, 'path'));
    const target = path.resolve(requireText(to, 'path'));
    try {
      await fsp.access(target);
      throw new Error('That name is already taken.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.rename(source, target);
    return target;
  });

  handle('local:delete', async (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const item of list) {
      const clean = path.resolve(requireText(item, 'path'));
      // Trash rather than unlink: a mis-click should be recoverable.
      await shell.trashItem(clean);
    }
    return list.length;
  });

  handle('local:reveal', (target) => {
    const clean = path.resolve(requireText(target, 'path'));
    shell.showItemInFolder(clean);
    return true;
  });

  handle('local:newWindowPath', async () => downloadsDir());

  /* ---------------- archives ---------------- */

  handle('archive:inspect', async (localPath) => {
    const clean = path.resolve(requireText(localPath, 'local path'));
    const listing = await zip.listZip(clean);
    let song = null;
    try {
      song = await beatsaber.inspectSong(clean);
    } catch {
      song = null;
    }
    return { path: clean, entries: listing.entries, song };
  });

  /** Extract a ZIP to a temp folder and queue one folder push. */
  handle('archive:extract', async (serial, localPath, remoteDir, options = {}) => {
    const clean = requireSerial(serial);
    const source = path.resolve(requireText(localPath, 'local path'));
    const dest = assertWritable(requireText(remoteDir, 'remote folder'));
    const name =
      typeof options.name === 'string' && options.name.trim()
        ? options.name.trim()
        : path.basename(source, path.extname(source));

    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'questdock-zip-'));
    const staged = path.join(temp, name);
    try {
      const result = await zip.extractToFile(source, staged, {
        stripRoot: options.stripRoot !== false,
      });
      if (!result.files.length) throw new Error('That archive is empty.');
      const remotePath = P.joinPosix(dest, name);
      const jobId = await enqueueTransfer({
        direction: 'push',
        serial: clean,
        localPath: staged,
        remotePath,
        isDir: true,
        conflict: options.conflict || 'ask',
        label: name,
        cleanupPath: temp,
      });
      return { jobId, name, remotePath, files: result.files.length };
    } catch (error) {
      await zip.removeTree(temp).catch(() => {});
      throw error;
    }
  });

  /** Extract a ZIP next to itself on this computer. */
  handle('archive:extractLocal', async (localPath, destDir, options = {}) => {
    const source = path.resolve(requireText(localPath, 'local path'));
    const target = path.resolve(requireText(destDir, 'destination'));
    const result = await zip.extractToFile(source, target, {
      stripRoot: options.stripRoot !== false,
    });
    return { path: result.root, files: result.files.length };
  });

  /* ---------------- Beat Saber ---------------- */

  handle('song:loader', async (serial) => {
    const clean = requireSerial(serial);
    const preferred = store.get('beatsaberPath') || '';
    const loader = await beatsaber.detectLoader(adb, clean, preferred);
    return loader;
  });

  handle('song:import', async (serial, files, options = {}) => {
    const clean = requireSerial(serial);
    const list = (Array.isArray(files) ? files : [files])
      .filter((file) => typeof file === 'string' && file.trim())
      .map((file) => path.resolve(file));
    if (!list.length) throw new Error('Choose one or more song ZIPs.');

    const preferred = options.dest || store.get('beatsaberPath') || '';
    const loader = await beatsaber.detectLoader(adb, clean, preferred);
    if (!loader) {
      throw new Error(
        'No Beat Saber custom-song folder was found. Install SongCore/MBF (or BMBF), or choose a folder in Settings.'
      );
    }

    const existing = await beatsaber.existingNames(adb, clean, loader.path);
    const results = [];
    for (const file of list) {
      let temp = '';
      try {
        const song = await beatsaber.inspectSong(file);
        if (!song) {
          results.push({ file, ok: false, error: 'No info.dat inside; that is not a Beat Saber song.' });
          continue;
        }
        const folderName = beatsaber.uniqueName(song.folderName, existing);
        temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'questdock-song-'));
        const extracted = await beatsaber.extractSong(file, temp, { folderName });
        if (!extracted.files.length) throw new Error('That song ZIP is empty.');
        existing.add(folderName);
        const remotePath = P.joinPosix(loader.path, folderName);
        const jobId = await enqueueTransfer({
          direction: 'push',
          serial: clean,
          localPath: extracted.dir,
          remotePath,
          isDir: true,
          conflict: options.conflict || 'ask',
          label: folderName,
          cleanupPath: temp,
        });
        results.push({
          file,
          ok: true,
          jobId,
          folderName,
          remotePath,
          hasAudio: extracted.hasAudio,
          song: {
            name: song.songName,
            author: song.songAuthor,
            mapper: song.mapper,
            bpm: song.bpm,
            duration: song.duration,
            difficulties: song.difficulties,
          },
        });
      } catch (error) {
        if (temp) await zip.removeTree(temp).catch(() => {});
        results.push({ file, ok: false, error: error.message });
      }
    }
    return { loader, results };
  });

  /* ---------------- transfers ---------------- */

  handle('transfer:add', async (specs) => {
    const list = Array.isArray(specs) ? specs : [specs];
    const ids = [];
    for (const spec of list) ids.push(await enqueueTransfer(spec));
    return ids;
  });

  handle('transfer:list', () => queue.snapshot());
  handle('transfer:cancel', (id) => queue.cancel(id));
  handle('transfer:retry', (id) => queue.retry(id));
  handle('transfer:clear', () => {
    queue.clearFinished();
    return queue.snapshot();
  });
  handle('transfer:pause', () => {
    queue.pause();
    return true;
  });
  handle('transfer:resume', () => {
    queue.resume();
    return true;
  });
  handle('transfer:cancelAll', () => {
    if (queue) queue.cancelAll();
    return true;
  });
  handle('transfer:conflict', (id, action, applyToAll) =>
    queue.resolveConflict(id, action, Boolean(applyToAll))
  );

  /* ---------------- previews ---------------- */

  handle('preview:thumb', (serial, entry) => {
    if (!entry || !entry.path) return null;
    const key = entry.path;
    const cached = previews.thumbPathFor({ ...entry, serial });
    if (fs.existsSync(cached)) return { key, file: pathToFileURL(cached).href };
    if (store.get('thumbnails') === false) return null;
    const waiting = thumbQueue.some((task) => task.entry.path === key && task.serial === serial);
    if (!waiting) thumbQueue.push({ serial: requireSerial(serial), entry });
    pumpThumbs();
    return { key, pending: true };
  });

  handle('preview:media', async (serial, entry) => {
    const clean = requireSerial(serial);
    if (!entry || !entry.path) throw new Error('Nothing to preview.');
    const kind = entry.kind || P.kindForName(entry.path, false);
    let file = null;
    if (kind === 'image') file = await previews.image(clean, entry);
    else if (kind === 'video') file = await previews.video(clean, entry);
    else if (kind === 'audio') file = await previews.anyFile(clean, entry);
    if (!file) throw new Error('That file is too large to preview inside the app.');
    return { url: pathToFileURL(file).href, path: file, kind };
  });

  handle('preview:stats', () => previews.stats());
  handle('preview:clear', async () => {
    await previews.clear();
    return previews.stats();
  });

  /* ---------------- apps ---------------- */

  handle('apps:list', async (serial) => {
    const packages = await adb.listPackages(requireSerial(serial));
    return packages;
  });

  handle('apps:inspect', async (localPath) => {
    const clean = path.resolve(requireText(localPath, 'local path'));
    return apkBundle.inspect(clean);
  });

  handle('apps:installPaths', async (serial, files) => {
    const list = (Array.isArray(files) ? files : [files])
      .filter((file) => typeof file === 'string' && file.trim())
      .map((file) => path.resolve(file));
    if (!list.length) throw new Error('Choose an APK first.');
    return installPackages(serial, list);
  });

  handle('apps:install', async (serial) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Install an APK on the headset',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android packages', extensions: ['apk', 'apks', 'xapk', 'apkm'] }],
    });
    if (result.canceled || !result.filePaths.length) return [];
    return installPackages(serial, result.filePaths);
  });

  handle('apps:uninstall', async (serial, packageName) => {
    await adb.uninstall(requireSerial(serial), requireText(packageName, 'package name'));
    return true;
  });

  /* ---------------- device actions ---------------- */

  handle('device:screenshot', async (serial) => {
    const clean = requireSerial(serial);
    const suggested = uniqueLocalPath(downloadsDir(), `Quest-${stamp()}.png`);
    const choice = await dialog.showSaveDialog(win, {
      title: 'Save screenshot',
      defaultPath: suggested,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (choice.canceled || !choice.filePath) return null;
    await adb.captureScreenshot(clean, choice.filePath);
    return { path: choice.filePath, url: pathToFileURL(choice.filePath).href };
  });

  handle('device:preview:snapshot', async (serial) => {
    const clean = requireSerial(serial);
    const file = path.join(os.tmpdir(), 'questdock-live-preview.png');
    await adb.captureScreenshot(clean, file);
    return { path: file, url: pathToFileURL(file).href };
  });

  handle('device:record:start', async (serial, options = {}) => {
    if (recorder) throw new Error('Already recording.');
    const clean = requireSerial(serial);
    const remote = `/sdcard/Movies/QuestDock-${stamp()}.mp4`;
    const pidFile = `/sdcard/Movies/.questdock-rec.pid`;
    const audio = !!(options && options.audio);
    const audioFlag = audio ? ' --audio ' : ' ';

    await adb.shell(clean, `rm -f ${P.shellQuote(pidFile)}`).catch(() => {});
    const child = adb.spawnShell(
      clean,
      `screenrecord --bit-rate 8000000${audioFlag}--time-limit 180 ${P.shellQuote(remote)} & echo $! > ${P.shellQuote(
        pidFile
      )}; wait`,
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    recorder = { serial: clean, remote, pidFile, child, startedAt: Date.now(), stderr: '', audio };
    child.stderr.on('data', (chunk) => {
      if (recorder) recorder.stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      recorder = null;
    });
    return { remote, startedAt: recorder.startedAt };
  });

  handle('device:record:stop', async () => {
    if (!recorder) throw new Error('Nothing is recording.');
    const active = recorder;
    recorder = null;

    const pidOut = await adb
      .shell(active.serial, `cat ${P.shellQuote(active.pidFile)}`, { timeout: 10_000 })
      .catch(() => '');
    const pid = Number(String(pidOut).trim());
    if (Number.isFinite(pid) && pid > 0) {
      await adb
        .shell(active.serial, `kill -2 ${pid}`, { timeout: 10_000 })
        .catch(() => {});
    } else {
      await adb.shell(active.serial, 'pkill -2 screenrecord').catch(() => {});
    }
    active.child.kill('SIGTERM');

    // The file only becomes non-empty once screenrecord has finalised it.
    const deadline = Date.now() + 15_000;
    let size = 0;
    while (Date.now() < deadline) {
      size = (await adb.statSize(active.serial, active.remote).catch(() => 0)) || 0;
      if (size > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!size) throw new Error('The recording did not finish. Try a shorter clip.');

    const suggested = uniqueLocalPath(downloadsDir(), `Quest-Recording-${stamp()}.mp4`);
    const choice = await dialog.showSaveDialog(win, {
      title: 'Save screen recording',
      defaultPath: suggested,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (choice.canceled || !choice.filePath) {
      await adb.remove(active.serial, active.remote).catch(() => {});
      return null;
    }

    try {
      await adb.pullFile(active.serial, active.remote, choice.filePath);
    } finally {
      await adb.remove(active.serial, active.remote).catch(() => {});
      await adb
        .shell(active.serial, `rm -f ${P.shellQuote(active.pidFile)}`)
        .catch(() => {});
    }
    return { path: choice.filePath, url: pathToFileURL(choice.filePath).href, size };
  });

  handle('device:record:status', () => (recorder ? { recording: true, startedAt: recorder.startedAt } : { recording: false }));

  handle('device:stream:start', async (serial, options = {}) => {
    if (streamer) throw new Error('Already streaming.');
    const clean = requireSerial(serial);
    const size = (options && options.size) || '1280x720';
    const bitrate = (options && options.bitrate) || 4000000;
    const child = adb.spawnAdb(
      [...(clean ? ['-s', clean] : []), 'exec-out', 'screenrecord', '--output-format=h264', `--size=${size}`, `--bit-rate=${bitrate}`, '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    streamer = { serial: clean, child, stderr: '' };
    child.stdout.on('data', (chunk) => {
      if (!streamer || streamer.child !== child) return;
      if (win && !win.isDestroyed()) {
        win.webContents.send('device:stream:data', Buffer.from(chunk));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (streamer) streamer.stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (streamer && streamer.child === child) {
        const err = streamer.stderr.trim();
        streamer = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('device:stream:end', { code, error: err || null });
        }
      }
    });
    child.on('error', (error) => {
      if (streamer && streamer.child === child) {
        streamer = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('device:stream:end', { code: -1, error: error.message });
        }
      }
    });
    return { started: true };
  });

  handle('device:stream:stop', async () => {
    if (!streamer) return { stopped: false };
    const active = streamer;
    streamer = null;
    try {
      active.child.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (!active.child.killed) active.child.kill('SIGKILL');
      } catch {}
    }, 2000).unref?.();
    return { stopped: true };
  });

  handle('device:wake', async (serial) => {
    await adb.wake(requireSerial(serial));
    return true;
  });

  handle('device:keepAwake', async (serial, enabled) => {
    await adb.keepAwake(requireSerial(serial), Boolean(enabled));
    store.set({ keepAwake: Boolean(enabled) });
    return true;
  });

  /* ---------------- wireless ---------------- */

  handle('net:connect', async (hostPort) => {
    const target = requireText(hostPort, 'address');
    const out = await adb.connect(target);
    if (/connected/i.test(out) && !/failed/i.test(out)) await rememberWireless(target);
    return out;
  });
  handle('net:pair', async (hostPort, code) =>
    adb.pair(requireText(hostPort, 'address'), requireText(code, 'pairing code'))
  );
  handle('net:disconnect', async (hostPort) => adb.disconnect(requireText(hostPort, 'address')));

  /** Discover wireless debugging endpoints via mDNS. */
  handle('net:discover', async () => {
    const services = await adb.mdnsServices();
    return services.filter((service) => service.service === '_adb-tls-connect._tcp');
  });

  /**
   * One-click wireless on a USB-connected headset: read its Wi-Fi address,
   * switch adbd to TCP, then connect and remember the pair.
   */
  handle('net:enable', async (serial) => {
    const clean = requireSerial(serial);
    const ip = await adb.wlanIp(clean);
    if (!ip) {
      throw new Error(
        'The headset is not on Wi-Fi. Join a Wi-Fi network in the headset settings, then try again.'
      );
    }
    await adb.tcpip(clean, 5555);
    // adbd needs a moment to reopen the socket.
    await delay(1200);
    let output = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      output = await adb.connect(`${ip}:5555`);
      if (/connected/i.test(output) && !/failed/i.test(output)) break;
      await delay(800);
    }
    if (!/connected/i.test(output) || /failed/i.test(output)) {
      throw new Error(
        `The headset did not accept a wireless connection at ${ip}:5555. Keep USB attached and try again.`
      );
    }
    const remembered = await rememberWireless(`${ip}:5555`);
    return { hostPort: `${ip}:5555`, serial: remembered.serial, output };
  });

  /** Try the saved wireless headset again right now. */
  handle('net:reconnect', async () => {
    lastWirelessTry = 0;
    const connected = await autoReconnectWireless();
    return { connected, hostPort: store.get('wirelessHost') || '' };
  });

  handle('net:state', async () => ({
    hostPort: store.get('wirelessHost') || '',
    serial: store.get('wirelessSerial') || '',
    auto: store.get('wirelessAutoReconnect') !== false,
  }));

  handle('net:forget', async () => {
    store.set({ wirelessHost: '', wirelessSerial: '' });
    return true;
  });


  /* ---------------- dialogs ---------------- */

  handle('dialog:files', async (options = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Choose files',
      properties: options.folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      defaultPath: options.defaultPath || undefined,
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('dialog:folder', async (options = {}) => {
    const result = await dialog.showOpenDialog(win, {
      title: options.title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: options.defaultPath || undefined,
      buttonLabel: options.buttonLabel || 'Choose',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('dialog:save', async (options = {}) => {
    const result = await dialog.showSaveDialog(win, {
      title: options.title || 'Save',
      defaultPath: options.defaultPath || undefined,
      filters: options.filters || undefined,
    });
    return result.canceled ? null : result.filePath;
  });

  handle('shell:reveal', (target) => {
    if (typeof target === 'string' && target) shell.showItemInFolder(target);
    return true;
  });

  handle('shell:open', async (target) => {
    if (typeof target === 'string' && target) {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    }
    return true;
  });

  handle('window:frame', (value) => {
    // Let the renderer dim the whole window while a modal is up (macOS only).
    if (process.platform === 'darwin' && win) win.setWindowButtonVisibility(Boolean(value));
    return true;
  });
}

/* ------------------------------------------------------------------ *
 *  Lifecycle
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setName('QuestDock');
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
      if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
    }

    store = new Store(path.join(app.getPath('userData'), 'settings.json'));
    store.load();

    if (store.get('adbPath')) adb.setAdbPath(store.get('adbPath'));
    adb.resolveAdb(true);

    previews = await new PreviewCache({
      root: path.join(app.getPath('userData'), 'cache'),
    }).ready();

    buildTransfers();
    buildMenu();
    registerIpc();
    createWindow();
    startPolling();

    if (capturePath) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const script = process.env.QUESTDOCK_CAPTURE_JS;
            if (script) {
              await win.webContents.executeJavaScript(script, true);
              await new Promise((resolve) => setTimeout(resolve, 2500));
            }
            const image = await win.webContents.capturePage();
            await fsp.writeFile(path.resolve(capturePath), image.toPNG());
            console.log(`captured ${capturePath}`);
            app.exit(0);
          } catch (error) {
            console.error('capture failed', error);
            app.exit(1);
          }
        }, Number(process.env.QUESTDOCK_CAPTURE_DELAY || 4500));
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    if (pollTimer) clearInterval(pollTimer);
    if (queue) queue.cancelAll();
    if (recorder) {
      const active = recorder;
      recorder = null;
      active.child.kill('SIGTERM');
      await adb.shell(active.serial, 'pkill -2 screenrecord').catch(() => {});
    }
    if (streamer) {
      try { streamer.child.kill('SIGTERM'); } catch {}
      streamer = null;
    }
    await store.flushNow().catch(() => {});
  });
}
