#!/usr/bin/env node
'use strict';

/**
 * A stand-in for adb, backed by a folder on this computer.
 *
 * Point QUESTDOCK_ADB at this file and the app cannot tell the difference for
 * browsing, transfers, installs and screenshots. Handy for UI work and for the
 * integration tests, which is the only reason it speaks toybox.
 *
 *   FAKE_DEVICE_ROOT   folder that plays /sdcard   (required)
 *   FAKE_SERIAL        serial shown by `devices`   (default FAKEQUEST3)
 *   FAKE_SLOW_MS       delay per megabyte pushed   (default 0)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');

const ROOT = path.resolve(process.env.FAKE_DEVICE_ROOT || '/tmp/questdock-fake');
const SERIAL = process.env.FAKE_SERIAL || 'FAKEQUEST3';
const SLOW_MS = Number(process.env.FAKE_SLOW_MS || 0);
const DEVICE_ROOT = path.join(ROOT, 'sdcard');

/* ------------------------------------------------------------------ *
 *  Path mapping: /sdcard/... lives under ROOT/sdcard
 * ------------------------------------------------------------------ */

function devicePath(input) {
  const clean = String(input || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  if (clean === '/sdcard') return DEVICE_ROOT;
  if (clean.startsWith('/sdcard/')) return path.join(DEVICE_ROOT, clean.slice('/sdcard/'.length));
  // Anything else is read-only in the fake, but still mapped under ROOT.
  return path.join(ROOT, 'sys', clean.replace(/^\/+/, ''));
}

/* ------------------------------------------------------------------ *
 *  Minimal shell tokenizer, enough for shellQuote output
 * ------------------------------------------------------------------ */

function tokenize(input) {
  const out = [];
  let current = '';
  let has = false;
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || has) {
        out.push(current);
        current = '';
        has = false;
      }
      continue;
    }
    current += ch;
    has = true;
  }
  if (current || has) out.push(current);
  return out;
}

/* ------------------------------------------------------------------ *
 *  ls / du / stat
 * ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

function modeString(stats) {
  const kind = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  const bits = [
    [0o400, 'r'],
    [0o200, 'w'],
    [0o100, 'x'],
    [0o040, 'r'],
    [0o020, 'w'],
    [0o010, 'x'],
    [0o004, 'r'],
    [0o002, 'w'],
    [0o001, 'x'],
  ];
  const text = bits.map(([mask, letter]) => (stats.mode & mask ? letter : '-')).join('');
  return kind + text;
}

async function listDir(target) {
  const dir = devicePath(target);
  const names = await fsp.readdir(dir);
  const lines = ['total 12'];
  for (const name of names) {
    const full = path.join(dir, name);
    let stats;
    try {
      stats = await fsp.lstat(full);
    } catch {
      continue;
    }
    const size = stats.isDirectory() ? 4096 : stats.size;
    lines.push(
      `${modeString(stats)} 1 root sdcard_rw ${size} ${stamp(stats.mtime)} ${name}`
    );
  }
  return lines.join('\n') + '\n';
}

async function duBytes(target) {
  const full = devicePath(target);
  let total = 0;
  async function walk(current) {
    let stats;
    try {
      stats = await fsp.lstat(current);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const names = await fsp.readdir(current).catch(() => []);
      for (const name of names) await walk(path.join(current, name));
    } else {
      total += stats.size;
    }
  }
  await walk(full);
  return total;
}

/* ------------------------------------------------------------------ *
 *  push / pull
 * ------------------------------------------------------------------ */

async function copyTree(source, dest) {
  const stats = await fsp.lstat(source);
  if (stats.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const name of await fsp.readdir(source)) {
      await copyTree(path.join(source, name), path.join(dest, name));
    }
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(fs.createReadStream(source), fs.createWriteStream(dest));
}

async function targetFor(dest, source) {
  // adb treats a trailing slash, or an existing folder, as "put it inside".
  const raw = String(dest);
  const exists = await fsp.stat(devicePath(raw)).then((s) => s.isDirectory()).catch(() => false);
  if (raw.endsWith('/') || exists) {
    return devicePath(path.posix.join(raw.replace(/\/+$/, ''), path.basename(source)));
  }
  return devicePath(raw);
}

async function push(local, remote) {
  const stats = await fsp.stat(local).catch(() => null);
  if (!stats) return { code: 1, stderr: `adb: error: failed to stat local file: '${local}'` };
  const dest = await targetFor(remote, local);
  const bytes = stats.isDirectory() ? await duBytes(local) : stats.size;
  if (SLOW_MS) {
    const chunks = Math.max(1, Math.round(bytes / (1024 * 1024)));
    const per = Math.min(120, SLOW_MS);
    for (let i = 1; i <= chunks; i += 1) {
      process.stderr.write(`[ ${String(Math.floor((i / chunks) * 100)).padStart(3)}%] ${remote}\r`);
      await new Promise((resolve) => setTimeout(resolve, per));
    }
  }
  await copyTree(local, dest);
  process.stdout.write(`1 file pushed. ${bytes} bytes\n`);
  return { code: 0 };
}

async function pull(remote, local) {
  const source = devicePath(remote);
  const stats = await fsp.stat(source).catch(() => null);
  if (!stats) return { code: 1, stderr: `adb: error: remote object '${remote}' does not exist` };

  const localStats = await fsp.stat(local).catch(() => null);
  const dest =
    localStats && localStats.isDirectory()
      ? path.join(local, path.basename(remote.replace(/\/+$/, '')))
      : local;

  const bytes = stats.isDirectory() ? await duBytes(source) : stats.size;
  if (SLOW_MS) {
    const chunks = Math.max(1, Math.round(bytes / (1024 * 1024)));
    const per = Math.min(120, SLOW_MS);
    for (let i = 1; i <= chunks; i += 1) {
      process.stderr.write(`[ ${String(Math.floor((i / chunks) * 100)).padStart(3)}%] ${remote}\r`);
      await new Promise((resolve) => setTimeout(resolve, per));
    }
  }
  await copyTree(source, dest);
  process.stdout.write(`1 file pulled.\n`);
  return { code: 0 };
}

/* ------------------------------------------------------------------ *
 *  Device shell
 * ------------------------------------------------------------------ */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function seededPackages() {
  return ['com.example.beat saber', 'com.example.sideload'];
}

async function readPackages() {
  const file = path.join(ROOT, 'packages.json');
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return seededPackages();
  }
}

async function writePackages(list) {
  await fsp.mkdir(ROOT, { recursive: true });
  await fsp.writeFile(path.join(ROOT, 'packages.json'), JSON.stringify(list, null, 2));
}

async function shell(command) {
  const tokens = tokenize(command);
  // Strip leading VAR=value assignments, as mksh would.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const [head, ...rest] = tokens;
  const args = rest.filter((item) => item !== '--');
  const positional = args.filter((item) => !item.startsWith('-'));
  const last = args.length ? args[args.length - 1] : '';

  switch (head) {
    case 'getprop': {
      return { code: 0, stdout: [
        '[ro.product.model]: [Quest 3]',
        '[ro.product.manufacturer]: [Oculus]',
        '[ro.build.version.release]: [12]',
        '[ro.build.version.sdk]: [32]',
        '[ro.build.display.id]: [SQ3A.220605.009.A1]',
        '',
      ].join('\n') };
    }
    case 'dumpsys':
      return { code: 0, stdout: [
        'Current Battery Service state:',
        '  status: 2',
        '  level: 76',
        '  temperature: 312',
        '',
      ].join('\n') };
    case 'df':
      return { code: 0, stdout: [
        'Filesystem      1K-blocks       Used Available Use% Mounted on',
        '/dev/block/dm-44 109871104   51000832  58870272  47% /storage/emulated',
        '',
      ].join('\n') };
    case 'ls':
      // The real Quest 3 exposes /sdcard as a symlink to /storage/self/primary.
      // `ls /sdcard` prints the link itself; `ls /sdcard/` follows it and lists
      // the folder. Model both, so a missing trailing slash is caught here.
      if (String(last).replace(/\/+$/, '') === '/sdcard' && !String(last).endsWith('/')) {
        return {
          code: 0,
          stdout: 'lrw-r--r-- 1 root root 21 2009-01-01 10:00 /sdcard -> /storage/self/primary\n',
        };
      }
      try {
        return { code: 0, stdout: await listDir(last) };
      } catch {
        return { code: 1, stderr: 'ls: No such file or directory' };
      }
    case 'test': {
      const expr = args[0];
      const target = devicePath(args[1]);
      const exists = await fsp.stat(target).then(() => true).catch(() => false);
      if (expr === '-e' || expr === '-f' || expr === '-d') {
        return { code: exists ? 0 : 1, stdout: '' };
      }
      return { code: 1 };
    }
    case 'mkdir':
      for (const target of positional.length ? positional : [last]) {
        await fsp.mkdir(devicePath(target), { recursive: true });
      }
      return { code: 0 };
    case 'mv':
      if (positional.length < 2) return { code: 1, stderr: 'mv: missing operand' };
      await fsp.mkdir(path.dirname(devicePath(positional[1])), { recursive: true });
      await fsp.rm(devicePath(positional[1]), { recursive: true, force: true });
      await fsp.rename(devicePath(positional[0]), devicePath(positional[1])).catch(async (error) => {
        if (error.code === 'EXDEV') {
          await copyTree(devicePath(positional[0]), devicePath(positional[1]));
          await fsp.rm(devicePath(positional[0]), { recursive: true, force: true });
          return;
        }
        throw error;
      });
      return { code: 0 };
    case 'rm':
      for (const target of positional) {
        await fsp.rm(devicePath(target), { recursive: true, force: true });
      }
      return { code: 0 };
    case 'cp':
      if (positional.length >= 2) {
        await copyTree(devicePath(positional[0]), devicePath(positional[1]));
      }
      return { code: 0 };
    case 'du': {
      const bytes = await duBytes(last);
      return { code: 0, stdout: `${Math.ceil(bytes / 1024)}\t${last}\n` };
    }
    case 'stat': {
      const target = devicePath(last);
      const stats = await fsp.stat(target).catch(() => null);
      if (!stats) return { code: 1, stderr: 'stat: No such file or directory' };
      return { code: 0, stdout: `${stats.size}\n` };
    }
    case 'wc': {
      const target = devicePath(last);
      const stats = await fsp.stat(target).catch(() => null);
      return { code: 0, stdout: `${stats ? stats.size : 0}\n` };
    }
    case 'pm': {
      if (args[0] === 'list') {
        const packages = await readPackages();
        if (args.includes('-f')) {
          return {
            code: 0,
            stdout: packages.map((name) => `package:/data/app/${name}/base.apk=${name}`).join('\n') + '\n',
          };
        }
        return { code: 0, stdout: packages.map((name) => `package:${name}`).join('\n') + '\n' };
      }
      if (args[0] === 'uninstall') {
        const packages = await readPackages();
        const next = packages.filter((name) => name !== args[1]);
        await writePackages(next);
        return {
          code: 0,
          stdout: next.length === packages.length ? 'Failure [not installed]' : 'Success',
        };
      }
      return { code: 0 };
    }
    case 'screenrecord': {
      // Write a stub clip so the stop-recording flow has something to pull.
      const target = devicePath(last);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, Buffer.alloc(2048, 7));
      return { code: 0 };
    }
    case 'kill':
    case 'pkill':
    case 'input':
    case 'wm':
    case 'svc':
      return { code: 0 };
    case 'cat': {
      const text = await fsp.readFile(devicePath(last), 'utf8').catch(() => '');
      return { code: 0, stdout: text };
    }
    default:
      return { code: 0, stdout: '' };
  }
}

/* ------------------------------------------------------------------ *
 *  Entry point
 * ------------------------------------------------------------------ */

async function main(rawArgv) {
  let index = 0;
  if (rawArgv[0] === '-s') index = 2;
  const command = rawArgv[index];
  const rest = rawArgv.slice(index + 1);

  if (command === 'version') {
    process.stdout.write('Android Debug Bridge version 1.0.41\nVersion 37.0.1-fake\n');
    return 0;
  }
  if (command === 'start-server' || command === 'kill-server') return 0;

  if (command === 'devices') {
    const unauthorized = process.env.FAKE_UNAUTHORIZED === '1';
    process.stdout.write(
      `List of devices attached\n${SERIAL}\t${unauthorized ? 'unauthorized' : 'device'} product:hollywood model:Quest_3 device:hollywood transport_id:3\n\n`
    );
    return 0;
  }

  if (command === 'connect') {
    process.stdout.write(`connected to ${rest[0]}\n`);
    return 0;
  }
  if (command === 'disconnect') {
    process.stdout.write(`disconnected ${rest[0]}\n`);
    return 0;
  }
  if (command === 'pair') {
    process.stdout.write(`Successfully paired to ${rest[0]}\n`);
    return 0;
  }
  if (command === 'tcpip') {
    process.stdout.write(`restarting in TCP mode port: ${rest[0] || '5555'}\n`);
    return 0;
  }
  if (command === 'mdns') {
    process.stdout.write(
      `List of discovered mdns services\nadb-${SERIAL}-fake\t_adb-tls-connect._tcp\t192.168.1.42:46289\n`
    );
    return 0;
  }

  // Everything below is `<verb> [args]`.
  const verb = command;
  const tail = rest;

  if (verb === 'shell') {
    const result = await shell(tail.join(' '));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  if (verb === 'exec-out') {
    const command2 = tail.join(' ');
    if (command2.startsWith('screencap')) {
      process.stdout.write(PNG);
      return 0;
    }
    return 0;
  }
  if (verb === 'push') {
    const result = await push(tail[0], tail[1]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  if (verb === 'pull') {
    const result = await pull(tail[0], tail[1]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  if (verb === 'install' || verb === 'install-multiple') {
    const files = tail.filter((item) => item !== '-r');
    const apk = files[files.length - 1] || 'package';
    const name = path.basename(apk, path.extname(apk)).replace(/\s+/g, '.');
    const packages = await readPackages();
    if (!packages.includes(`com.example.${name}`)) packages.push(`com.example.${name}`);
    await writePackages(packages);
    process.stdout.write('Performing Streamed Install\nSuccess\n');
    return 0;
  }
  if (verb === 'uninstall') {
    const packages = await readPackages();
    const next = packages.filter((item) => item !== tail[0]);
    await writePackages(next);
    process.stdout.write(next.length === packages.length ? 'Failure\n' : 'Success\n');
    return 0;
  }

  process.stderr.write(`fake-adb: unsupported command: ${rawArgv.join(' ')}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`fake-adb: ${error.message}\n`);
    process.exitCode = 1;
  });

module.exports = { tokenize };
