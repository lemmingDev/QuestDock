'use strict';

/**
 * Everything that talks to adb lives here: binary discovery, the device list,
 * property/battery/storage reads, directory listings and file operations.
 *
 * Every command is an argv array; the only place a string reaches a shell is
 * `shell()`, where each path is quoted with PathUtil.shellQuote() first.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const P = require('../shared/paths');

const EXEC_TIMEOUT = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

let configuredAdbPath = '';

function setAdbPath(value) {
  configuredAdbPath = typeof value === 'string' ? value.trim() : '';
}

function platformFolder() {
  if (process.platform === 'win32') return 'win32-x64';
  // Google's macOS adb is a universal binary, so one folder serves both arches.
  if (process.platform === 'darwin') return 'darwin';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function adbName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function candidatePaths() {
  const list = [];
  if (configuredAdbPath) list.push(configuredAdbPath);
  if (process.env.ADB_PATH) list.push(process.env.ADB_PATH);
  if (process.env.QUESTDOCK_ADB) list.push(process.env.QUESTDOCK_ADB);

  const resources = process.resourcesPath || '';
  if (resources) list.push(path.join(resources, 'vendor', platformFolder(), adbName()));

  list.push(path.join(__dirname, '..', '..', 'vendor', platformFolder(), adbName()));
  list.push(adbName());
  return list;
}

let resolved = null;

/** First working adb: explicit setting, env var, bundled copy, then PATH. */
function resolveAdb(force = false) {
  if (resolved && !force) return resolved;
  let found = null;
  for (const candidate of candidatePaths()) {
    if (!candidate) continue;
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    } else {
      // Bare name on PATH: accept it; the first invocation will confirm.
      found = candidate;
      break;
    }
  }
  resolved = found || adbName();
  return resolved;
}

function adbPath() {
  return resolveAdb();
}

function describeError(error) {
  const stderr = String((error && error.stderr) || '').trim();
  const stdout = String((error && error.stdout) || '').trim();
  const text = stderr || stdout || (error && error.message) || 'adb failed';

  if (/no devices\/emulators found|device '.*' not found/i.test(text)) {
    return 'That headset is not connected any more.';
  }
  if (/adb server version .* doesn't match|server version/i.test(text)) {
    return 'Another ADB server on this computer is using a different version. Quit other tools that use ADB (Android Studio, scrcpy, a terminal adb), or run `adb kill-server`, then retry.';
  }
  if (/device offline/i.test(text)) {
    return 'The headset is offline. Replug the USB cable and try again.';
  }
  if (/unauthorized/i.test(text)) {
    return 'The headset has not allowed this computer yet. Put it on and accept the USB debugging prompt.';
  }
  if (/more than one device/i.test(text)) {
    return 'More than one headset is connected. Choose one first.';
  }
  if (/no route to host|network is unreachable|failed to connect to/i.test(text)) {
    return 'Cannot reach the headset at that address. Check that both devices are on the same Wi-Fi network and that the router is not isolating clients. On macOS, allow QuestDock in System Settings › Privacy & Security › Local Network.';
  }
  if (/connection refused/i.test(text)) {
    return 'The headset is reachable, but ADB is not listening on that port. Turn wireless debugging off and on again (the port changes after a reboot), then reconnect.';
  }
  if (/permission denied/i.test(text)) {
    return 'The headset refused access to that location.';
  }
  if (/no such file or directory/i.test(text)) {
    return 'That file or folder no longer exists.';
  }
  if (/not a directory/i.test(text)) {
    return 'That is a file, not a folder.';
  }
  if (/ENOENT/.test(text) && /adb/i.test(text)) {
    return 'adb was not found. Reinstall the app or set the ADB path in Settings.';
  }
  if (/failed to install.*(INSTALL_FAILED)/i.test(text)) return text;
  return text.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400);
}

/** Run adb and resolve with stdout. Rejects with a readable message. */
function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath(),
      args,
      {
        windowsHide: true,
        timeout: options.timeout || EXEC_TIMEOUT,
        maxBuffer: options.maxBuffer || MAX_BUFFER,
        encoding: 'utf8',
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(describeError({ ...error, stderr, stdout }));
          wrapped.stderr = stderr;
          wrapped.stdout = stdout;
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

/** Start adb and return its client/server version line, or throw. */
async function version() {
  return (await run(['version'])).split('\n')[0].trim();
}

async function startServer() {
  await run(['start-server'], { timeout: 20_000 });
  return true;
}

/* ------------------------------------------------------------------ *
 *  Devices
 * ------------------------------------------------------------------ */

function parseDevices(stdout) {
  const devices = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^List of devices/i.test(line) || line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    const serial = parts.shift();
    const state = parts.shift() || 'unknown';
    if (!serial) continue;

    const extra = {};
    for (const token of parts) {
      const colon = token.indexOf(':');
      if (colon === -1) continue;
      extra[token.slice(0, colon)] = token.slice(colon + 1);
    }

    devices.push({
      serial,
      state,
      model: extra.model ? P.prettyModel(extra.model) : '',
      product: extra.product || '',
      device: extra.device || '',
      transportId: extra.transport_id || '',
      wireless: serial.includes(':'),
      authorized: state === 'device',
    });
  }
  return devices;
}

async function listDevices() {
  const stdout = await run(['devices', '-l']);
  return parseDevices(stdout);
}

function serialArgs(serial) {
  return serial ? ['-s', serial] : [];
}

/** Run a command through the device shell; `command` must be pre-quoted. */
function shell(serial, command, options = {}) {
  return run([...serialArgs(serial), 'shell', command], options);
}

function spawnShell(serial, command, options = {}) {
  return spawn(adbPath(), [...serialArgs(serial), 'shell', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/* ------------------------------------------------------------------ *
 *  Device facts
 * ------------------------------------------------------------------ */

async function props(serial) {
  const stdout = await shell(serial, 'getprop', { timeout: 20_000 });
  const map = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (match) map[match[1]] = match[2];
  }
  return map;
}

function parseBattery(stdout) {
  const result = { level: null, charging: null, status: '', temperature: null };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z ]+):\s*(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === 'level') result.level = Number(value);
    else if (key === 'status') {
      result.status = value;
      result.charging = value === '2' || value === '5';
    } else if (key === 'temperature') {
      const n = Number(value);
      result.temperature = Number.isFinite(n) ? n / 10 : null;
    }
  }
  return result;
}

/**
 * Parse `df -k`. Android reports /sdcard mounted at /storage/emulated, and
 * some builds ignore the path argument and dump every mount, so pick the row
 * that owns the shared storage and fall back to the last usable row.
 */
function parseDf(stdout, mount = '/sdcard') {
  const rows = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const blocks = Number(parts[1]);
    const used = Number(parts[2]);
    const free = Number(parts[3]);
    if (!Number.isFinite(blocks) || blocks <= 0) continue;
    // A wrapped device name leaves the numbers in the wrong columns.
    if (/%$/.test(parts[parts.length - 2] || '') === false) continue;
    rows.push({
      blocks,
      used,
      free,
      target: parts[parts.length - 1],
    });
  }
  if (!rows.length) return null;

  const chosen =
    rows.find((row) => row.target === mount) ||
    rows.find((row) => /^\/storage\/emulated/.test(row.target)) ||
    rows.find((row) => /^\/data\b/.test(row.target)) ||
    rows[rows.length - 1];

  const { blocks, used, free } = chosen;
  return {
    totalBytes: blocks * 1024,
    usedBytes: Number.isFinite(used) ? used * 1024 : Math.max(0, (blocks - free) * 1024),
    freeBytes: Number.isFinite(free) ? free * 1024 : Math.max(0, (blocks - used) * 1024),
    mount: chosen.target,
  };
}

async function deviceInfo(serial) {
  const [propMap, batteryOut, dfOut] = await Promise.all([
    props(serial).catch(() => ({})),
    shell(serial, 'dumpsys battery', { timeout: 15_000 }).catch(() => ''),
    shell(serial, 'df -k /sdcard', { timeout: 15_000 }).catch(() => ''),
  ]);

  const battery = parseBattery(batteryOut);
  const storage = parseDf(dfOut, '/sdcard');
  const model = P.prettyModel(
    propMap['ro.product.model'] || propMap['ro.product.vendor.model'] || ''
  );

  return {
    serial,
    model: model || 'Quest',
    manufacturer: propMap['ro.product.manufacturer'] || 'Meta',
    android: propMap['ro.build.version.release'] || '',
    sdk: propMap['ro.build.version.sdk'] || '',
    build: propMap['ro.build.display.id'] || '',
    battery,
    storage,
    storageRoot: '/sdcard',
  };
}

/* ------------------------------------------------------------------ *
 *  Directory listings
 * ------------------------------------------------------------------ */

function parseStamp(dateText, timeText) {
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeText || '');
  if (!time) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  const seconds = Number(time[3] || 0);

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText || '');
  if (iso) {
    return new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      hours,
      minutes,
      seconds
    ).getTime();
  }

  const classic = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(dateText || '');
  if (classic && MONTHS[classic[1]] != null) {
    const now = new Date();
    let year = now.getFullYear();
    const stamp = new Date(year, MONTHS[classic[1]], Number(classic[2]), hours, minutes, seconds);
    if (stamp.getTime() - now.getTime() > 24 * 3600 * 1000) {
      year -= 1;
      stamp.setFullYear(year);
    }
    return stamp.getTime();
  }

  return null;
}

/**
 * Parse `ls -lA` output from Android's toybox. Two date shapes exist in the
 * wild: `2024-06-11 14:32` and `Jun 11 14:32`.
 */
function parseListing(stdout, dirPath) {
  const entries = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || /^total\s+\d+/i.test(line)) continue;

    const head = /^([-dlbcps])([rwxsStT-]{9})[+@.]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(
      line
    );
    if (!head) continue;

    const [, type, , links, owner, group, sizeText, rest] = head;
    let stamp = null;
    let name = '';

    const iso = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/.exec(rest);
    if (iso) {
      stamp = parseStamp(iso[1], iso[2]);
      name = iso[3];
    } else {
      // `Jun 11 14:32 name` (recent) or `Jun 11  2023 name` (older).
      const classic = /^([A-Z][a-z]{2}\s+\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?|\d{4})\s+(.*)$/.exec(
        rest
      );
      if (classic) {
        if (/^\d{4}$/.test(classic[2])) {
          const parsed = new Date(
            Number(classic[2]),
            MONTHS[classic[1].slice(0, 3)] ?? 0,
            Number(classic[1].slice(4).trim())
          );
          stamp = Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
        } else {
          stamp = parseStamp(classic[1], classic[2]);
        }
        name = classic[3];
      } else {
        const loose = /^(\S+)\s+(\S+)\s+(.*)$/.exec(rest);
        if (!loose) continue;
        stamp = parseStamp(loose[1], loose[2]);
        name = loose[3];
      }
    }

    name = name.trimEnd();
    if (!name || name === '.' || name === '..') continue;

    let linkTarget = '';
    if (type === 'l' && name.includes(' -> ')) {
      const cut = name.indexOf(' -> ');
      linkTarget = name.slice(cut + 4);
      name = name.slice(0, cut);
    }

    const isDir = type === 'd';
    const size = isDir ? null : Number(sizeText);
    entries.push({
      name,
      path: P.joinPosix(dirPath, name),
      isDir,
      isSymlink: type === 'l',
      linkTarget,
      size: Number.isFinite(size) ? size : null,
      mtime: stamp,
      mode: head[1] + head[2],
      owner,
      group,
      kind: P.kindForName(name, isDir, type === 'l'),
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    // Explicit locale keeps ordering identical on every host.
    const folded = a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
    if (folded !== 0) return folded;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return entries;
}

async function listDir(serial, dirPath) {
  const clean = P.normalizePosix(dirPath);
  // Quest 3 exposes /sdcard as a symlink to /storage/self/primary. Without a
  // trailing slash `ls` lists the link itself instead of the folder, so the
  // pane shows a single broken-looking entry. The slash follows the link.
  const target = clean === '/' ? '/' : `${clean}/`;
  const quoted = P.shellQuote(target);
  let stdout;
  try {
    stdout = await shell(serial, `LANG=C ls -lA -- ${quoted}`, { timeout: 30_000 });
  } catch (error) {
    // Some old toybox builds do not understand `--`.
    stdout = await shell(serial, `LANG=C ls -lA ${quoted}`, { timeout: 30_000 });
  }
  return {
    path: clean,
    parent: P.parentPosix(clean),
    entries: parseListing(stdout, clean),
  };
}

async function statSize(serial, remotePath) {
  const quoted = P.shellQuote(remotePath);
  try {
    const out = await shell(serial, `stat -c %s -- ${quoted}`, { timeout: 15_000 });
    const value = Number(out.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    try {
      const out = await shell(serial, `wc -c < ${quoted}`, { timeout: 15_000 });
      const value = Number(out.trim().split(/\s+/)[0]);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
}

/** Total bytes under a remote folder, via `du -sk`. Null when unavailable. */
async function folderSize(serial, remotePath) {
  const clean = String(remotePath).replace(/\/+$/, '');
  const withSlash = clean === '' ? '/' : `${clean}/`;
  try {
    return await duBytes(serial, withSlash);
  } catch {
    // A file (or a path `du` will not follow with a slash) still has a size.
    try {
      return await duBytes(serial, clean || '/');
    } catch {
      return null;
    }
  }
}

async function duBytes(serial, target) {
  const out = await shell(serial, `du -sk -- ${P.shellQuote(target)}`, { timeout: 60_000 });
  const kb = Number(out.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

async function exists(serial, remotePath) {
  try {
    await shell(serial, `test -e ${P.shellQuote(remotePath)}`, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 *  File operations
 * ------------------------------------------------------------------ */

async function mkdir(serial, remotePath) {
  await shell(serial, `mkdir -p -- ${P.shellQuote(remotePath)}`, { timeout: 20_000 });
}

async function rename(serial, from, to) {
  await shell(serial, `mv -- ${P.shellQuote(from)} ${P.shellQuote(to)}`, { timeout: 30_000 });
}

async function remove(serial, remotePaths) {
  const list = Array.isArray(remotePaths) ? remotePaths : [remotePaths];
  if (!list.length) return;
  const quoted = list.map((item) => P.shellQuote(item)).join(' ');
  await shell(serial, `rm -rf -- ${quoted}`, { timeout: 120_000 });
}

async function copyMove(serial, from, to, mode = 'copy', options = {}) {
  const command = mode === 'move' ? 'mv' : 'cp -a';
  await shell(serial, `${command} -- ${P.shellQuote(from)} ${P.shellQuote(to)}`, {
    timeout: options.timeout || 10 * 60_000,
  });
}

/* ------------------------------------------------------------------ *
 *  Apps
 * ------------------------------------------------------------------ */

async function listPackages(serial) {
  const out = await shell(serial, 'pm list packages -3', { timeout: 30_000 });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length))
    .filter(Boolean)
    .sort();
}

async function listPackagePaths(serial) {
  const out = await shell(serial, 'pm list packages -f -3', { timeout: 30_000 });
  const map = new Map();
  for (const line of String(out).split(/\r?\n/)) {
    const match = /^package:(.+?)=(.+)$/.exec(line.trim());
    if (!match) continue;
    map.set(match[2].trim(), match[1].trim());
  }
  return map;
}

async function uninstall(serial, packageName) {
  const out = await shell(serial, `pm uninstall ${P.shellQuote(packageName)}`, {
    timeout: 120_000,
  });
  if (!/success/i.test(out)) throw new Error(out.trim() || 'Uninstall failed.');
  return true;
}

/** Shared runner for `adb install` and `adb install-multiple`. */
function runInstall(serial, command, files, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      adbPath(),
      [...serialArgs(serial), command, '-r', ...files],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (options.onProgress) options.onProgress(stdout);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (options.onProgress) options.onProgress(stderr);
    });
    child.on('error', (error) => settle(reject, new Error(describeError(error))));
    child.on('close', (code) => {
      if (code === 0 && /Success/i.test(stdout)) {
        settle(resolve, { packageName: options.packageName || '', output: stdout.trim() });
        return;
      }
      settle(reject, new Error(describeError({ stderr: stderr || stdout })));
    });

    if (options.onChild) options.onChild(child);
  });
}

/** Install an APK with `adb install -r`; resolves when the device reports success. */
function installApk(serial, localPath, options = {}) {
  return runInstall(serial, 'install', [localPath], options);
}

/**
 * Install a split package (base + config splits) with `install-multiple`.
 * `localPaths` must all point at APKs on this computer.
 */
function installMultiple(serial, localPaths, options = {}) {
  const files = (Array.isArray(localPaths) ? localPaths : [localPaths]).filter(Boolean);
  if (!files.length) return Promise.reject(new Error('No APKs to install.'));
  return runInstall(serial, 'install-multiple', files, options);
}

/* ------------------------------------------------------------------ *
 *  Screenshots and screen recording
 * ------------------------------------------------------------------ */

function captureScreenshot(serial, localPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      adbPath(),
      [...serialArgs(serial), 'exec-out', 'screencap', '-p'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const out = fs.createWriteStream(localPath);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.pipe(out);
    child.on('error', (error) => {
      out.destroy();
      reject(new Error(describeError(error)));
    });
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolve(localPath);
        else reject(new Error(describeError({ stderr })));
      });
    });
  });
}

function startScreenRecording(serial, remotePath) {
  return spawnShell(
    serial,
    `screenrecord --bit-rate 8000000 --time-limit 180 ${P.shellQuote(remotePath)}`,
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
}

/* ------------------------------------------------------------------ *
 *  Storage volumes
 * ------------------------------------------------------------------ */

function parseVolumeNames(stdout) {
  const names = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    // type links owner group size date time name...
    const match = /^d\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || name === '.' || name === '..') continue;
    if (name === 'self' || name === 'emulated') continue;
    names.push(name);
  }
  return names;
}

async function dfBytes(serial, target) {
  let stdout;
  try {
    stdout = await shell(serial, `LANG=C df -k -- ${P.shellQuote(target)}`, { timeout: 20_000 });
  } catch {
    stdout = await shell(serial, `LANG=C df -k ${P.shellQuote(target)}`, { timeout: 20_000 });
  }
  const lines = stdout.trim().split(/\r?\n/);
  const row = lines[lines.length - 1] || '';
  const cells = row.trim().split(/\s+/);
  if (cells.length < 4) return null;
  // Filesystem 1K-blocks Used Available Use% Mounted-on
  const total = Number(cells[1]);
  const free = Number(cells[3]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { totalBytes: total * 1024, freeBytes: free * 1024, usedBytes: (total - free) * 1024 };
}

/**
 * Internal storage plus any USB-C drive mounted under /storage.
 * SD cards in a reader and external SSDs both show up as `XXXX-XXXX`.
 */
async function listVolumes(serial) {
  const internal = await dfBytes(serial, '/sdcard').catch(() => null);
  const volumes = [
    {
      id: 'internal',
      label: 'Internal storage',
      path: '/sdcard',
      removable: false,
      ...(internal || {}),
    },
  ];

  let stdout = '';
  try {
    stdout = await shell(serial, 'LANG=C ls -l /storage', { timeout: 20_000 });
  } catch {
    return volumes;
  }
  for (const name of parseVolumeNames(stdout)) {
    const path = `/storage/${name}`;
    const space = await dfBytes(serial, path).catch(() => null);
    volumes.push({
      id: name,
      label: `USB storage ${name}`,
      path,
      removable: true,
      ...(space || {}),
    });
  }
  return volumes;
}

/* ------------------------------------------------------------------ *
 *  Wireless helpers
 * ------------------------------------------------------------------ */

/** Parse `adb mdns services` into discoverable ADB endpoints. */
function parseMdns(stdout) {
  const services = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 3) continue;
    const [name, service, hostPort] = cells;
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(hostPort);
    if (!match) continue;
    services.push({
      name,
      service,
      host: match[1],
      port: Number(match[2]),
      hostPort: `${match[1]}:${match[2]}`,
      serial: name.replace(/^adb-/, '').replace(/-[^-]+$/, ''),
    });
  }
  return services;
}

async function mdnsServices() {
  try {
    const out = await run(['mdns', 'services'], { timeout: 10_000 });
    return parseMdns(out);
  } catch {
    return [];
  }
}

/** The headset's Wi-Fi address, or '' when Wi-Fi is off. */
async function wlanIp(serial) {
  const probe = async (command) => {
    try {
      return await shell(serial, command, { timeout: 15_000 });
    } catch {
      return '';
    }
  };
  const modern = await probe('ip -f inet addr show wlan0');
  let match = /inet\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(modern);
  if (match) return match[1];

  const route = await probe('ip route');
  match = /\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(route);
  if (match) return match[1];

  const legacy = await probe('ifconfig wlan0');
  match = /inet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})/.exec(legacy);
  return match ? match[1] : '';
}

/** Switch a USB-connected headset into TCP mode (`adb tcpip`). */
async function tcpip(serial, port = 5555) {
  const out = await run([...serialArgs(serial), 'tcpip', String(port)], { timeout: 30_000 });
  return out.trim();
}

/** Ask the local ADB server to retry an offline/unauthorized transport. */
async function reconnect(serial, mode = 'device') {
  const args = serial ? [...serialArgs(serial), 'reconnect', mode] : ['reconnect'];
  try {
    return (await run(args, { timeout: 20_000 })).trim();
  } catch {
    return '';
  }
}
/* ------------------------------------------------------------------ *
 *  Connection helpers
 * ------------------------------------------------------------------ */

async function pair(hostPort, code) {
  const out = await run(['pair', hostPort, code], { timeout: 60_000 });
  return out.trim();
}

async function connect(hostPort) {
  const out = await run(['connect', hostPort], { timeout: 30_000 });
  return out.trim();
}

async function disconnect(hostPort) {
  const out = await run(['disconnect', hostPort], { timeout: 20_000 });
  return out.trim();
}

async function wake(serial) {
  await shell(serial, 'input keyevent KEYCODE_WAKEUP', { timeout: 15_000 }).catch(() => {});
  await shell(serial, 'wm dismiss-keyguard', { timeout: 15_000 }).catch(() => {});
}

async function keepAwake(serial, enabled) {
  await shell(serial, `svc power stayon ${enabled ? 'true' : 'false'}`, {
    timeout: 15_000,
  });
}

/** Run adb and hand back the child process; used by the transfer queue. */
function spawnAdb(args, options = {}) {
  return spawn(adbPath(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/** One-off `adb pull` that resolves when the file is on disk. */
function pullFile(serial, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(), [...serialArgs(serial), 'pull', remotePath, localPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new Error(describeError(error))));
    child.on('close', (code) => {
      if (code === 0) resolve(localPath);
      else reject(new Error(describeError({ stderr: stderr || stdout })));
    });
  });
}

/** One-off `adb push` that resolves when the headset has the file. */
function pushFile(serial, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(), [...serialArgs(serial), 'push', localPath, remotePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new Error(describeError(error))));
    child.on('close', (code) => {
      if (code === 0) resolve(remotePath);
      else reject(new Error(describeError({ stderr: stderr || stdout })));
    });
  });
}

module.exports = {
  adbPath,
  resolveAdb,
  setAdbPath,
  version,
  startServer,
  run,
  listDevices,
  parseDevices,
  deviceInfo,
  parseBattery,
  parseDf,
  shell,
  spawnShell,
  props,
  listDir,
  parseListing,
  parseStamp,
  statSize,
  folderSize,
  exists,
  mkdir,
  rename,
  remove,
  copyMove,
  listVolumes,
  parseVolumeNames,
  dfBytes,
  listPackages,
  listPackagePaths,
  uninstall,
  installApk,
  installMultiple,
  captureScreenshot,
  startScreenRecording,
  pair,
  connect,
  disconnect,
  mdnsServices,
  parseMdns,
  wlanIp,
  tcpip,
  reconnect,
  wake,
  keepAwake,
  spawnAdb,
  pullFile,
  pushFile,
  describeError,
};
