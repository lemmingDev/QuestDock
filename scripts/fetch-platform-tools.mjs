#!/usr/bin/env node
'use strict';

/**
 * Vendors Google's platform-tools into `vendor/`, so a built app does not need
 * adb installed on the user's machine.
 *
 *   node scripts/fetch-platform-tools.mjs                # every platform
 *   node scripts/fetch-platform-tools.mjs --platform=darwin
 *   node scripts/fetch-platform-tools.mjs --offline      # copy the local adb
 *
 * Downloads come from dl.google.com and are checked against the SHA-1 in
 * Google's repository manifest. If the network is unavailable, the script
 * falls back to the adb on this machine and says so.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const vendorDir = path.join(projectRoot, 'vendor');
const MANIFEST = 'https://dl.google.com/android/repository/repository2-3.xml';
const BASE = 'https://dl.google.com/android/repository/';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const force = args.includes('--force');

/**
 * Node's fetch ignores HTTP(S)_PROXY unless asked, and the flag only works at
 * startup. Re-run once with it enabled when a proxy is configured.
 */
if (
  !offline &&
  !process.env.NODE_USE_ENV_PROXY &&
  (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(result.status == null ? 1 : result.status);
}
const requested = args
  .filter((item) => item.startsWith('--platform='))
  .map((item) => item.split('=')[1]);

const PLATFORMS = {
  darwin: { hostOs: 'macosx', folders: ['darwin'], files: ['adb'] },
  win32: {
    hostOs: 'windows',
    folders: ['win32-x64'],
    files: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'],
  },
  linux: { hostOs: 'linux', folders: ['linux-x64'], files: ['adb'] },
};

const wanted = requested.length ? requested : Object.keys(PLATFORMS);
const unknown = wanted.filter((name) => !PLATFORMS[name]);
if (unknown.length) {
  console.error(`Unknown platform: ${unknown.join(', ')}. Use darwin, win32 or linux.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 *  Zip reading (stored + deflate), so no unzip binary is required
 * ------------------------------------------------------------------ */

function unzip(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (name.endsWith('/')) {
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    files.push({
      name,
      data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw),
      size,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/* ------------------------------------------------------------------ *
 *  Manifest and download
 * ------------------------------------------------------------------ */

async function fetchBuffer(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadManifest() {
  const xml = (await fetchBuffer(MANIFEST)).toString('utf8');
  const block = /<remotePackage path="platform-tools"[\s\S]*?<\/remotePackage>/.exec(xml);
  if (!block) throw new Error('platform-tools is missing from the repository manifest');

  const archives = new Map();
  for (const match of block[0].matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const body = match[1];
    const hostOs = /<host-os>([^<]+)<\/host-os>/.exec(body);
    const url = /<url>([^<]+)<\/url>/.exec(body);
    const checksum = /<checksum[^>]*>([^<]+)<\/checksum>/.exec(body);
    if (hostOs && url) {
      archives.set(hostOs[1].trim(), {
        url: url[1].trim(),
        checksum: checksum ? checksum[1].trim() : '',
      });
    }
  }
  return archives;
}

function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

/* ------------------------------------------------------------------ *
 *  Fallback: vendor whatever adb this machine has
 * ------------------------------------------------------------------ */

function hostAdb() {
  const candidates = ['/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/usr/bin/adb'];
  try {
    const found = execFileSync('which', ['adb'], { encoding: 'utf8' }).trim();
    if (found) candidates.unshift(found);
  } catch {
    /* not on PATH */
  }
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile()) return real;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/** Only the machine we are on can supply a usable fallback binary. */
const HOST_PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';

function hostEntries(platform) {
  if (platform !== HOST_PLATFORM) return null;
  const adbBinary = hostAdb();
  if (!adbBinary) return null;
  const entries = new Map();
  const dir = path.dirname(adbBinary);
  const name = process.platform === 'win32' ? 'adb.exe' : 'adb';
  entries.set(name, fs.readFileSync(adbBinary));
  for (const dll of ['AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    const file = path.join(dir, dll);
    if (fs.existsSync(file)) entries.set(dll, fs.readFileSync(file));
  }
  return { entries, label: adbBinary };
}

/* ------------------------------------------------------------------ *
 *  Write a platform folder
 * ------------------------------------------------------------------ */

function writePlatform(folders, files) {
  for (const folder of folders) {
    const dir = path.join(vendorDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of files) {
      if (name === 'adb') fs.chmodSync(path.join(dir, name), 0o755);
    }
  }
}

function installEntries(folders, entries, sourceLabel) {
  for (const folder of folders) {
    const dir = path.join(vendorDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of entries) {
      const target = path.join(dir, name);
      fs.writeFileSync(target, data);
      if (name === 'adb') fs.chmodSync(target, 0o755);
    }
  }
  console.log(`  vendored ${sourceLabel} → ${folders.join(', ')}`);
}

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  const notes = [];

  let manifest = new Map();
  if (!offline) {
    try {
      manifest = await loadManifest();
      console.log(`Manifest: ${[...manifest.keys()].join(', ')}`);
    } catch (error) {
      console.warn(`Could not read the platform-tools manifest: ${error.message}`);
    }
  }

  const cacheDir = path.join(vendorDir, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const platform of wanted) {
    const spec = PLATFORMS[platform];
    const archive = manifest.get(spec.hostOs);
    console.log(`\n${platform}:`);

    let entries = null;

    if (archive) {
      const cacheFile = path.join(cacheDir, path.basename(archive.url));
      let zip = null;
      if (fs.existsSync(cacheFile) && !force) {
        zip = fs.readFileSync(cacheFile);
      } else {
        try {
          console.log(`  downloading ${archive.url}`);
          zip = await fetchBuffer(BASE + archive.url);
          fs.writeFileSync(cacheFile, zip);
        } catch (error) {
          console.warn(`  download failed: ${error.message}`);
        }
      }

      if (zip) {
        const digest = sha1(zip);
        if (archive.checksum && digest !== archive.checksum) {
          throw new Error(
            `checksum mismatch for ${archive.url}\n  expected ${archive.checksum}\n  got      ${digest}`
          );
        }
        const all = unzip(zip);
        entries = new Map();
        for (const file of all) {
          const base = path.basename(file.name);
          if (spec.files.includes(base)) entries.set(base, file.data);
        }
        if (entries.size !== spec.files.length) {
          console.warn(`  archive is missing some files (${[...entries.keys()].join(', ')})`);
        }
        notes.push(`${platform}: ${archive.url} sha1 ${digest}`);
      }
    }

    if (!entries) {
      const fallback = hostEntries(platform);
      if (!fallback) {
        console.error(
          platform === HOST_PLATFORM
            ? '  no download and no local adb; this build will use adb from PATH'
            : `  no download, and a ${HOST_PLATFORM} machine cannot supply ${platform} binaries`
        );
        notes.push(`${platform}: not vendored (fallback to PATH)`);
        continue;
      }
      console.warn(`  using this machine's adb instead: ${fallback.label}`);
      entries = fallback.entries;
      notes.push(`${platform}: copied local ${fallback.label}`);
    }

    installEntries(spec.folders, entries, platform);
  }

  fs.writeFileSync(
    path.join(vendorDir, 'SOURCES.txt'),
    [
      'adb binaries in this folder come from Google platform-tools.',
      `Generated ${new Date().toISOString()} by scripts/fetch-platform-tools.mjs`,
      '',
      ...notes,
      '',
    ].join('\n')
  );
  fs.rmSync(cacheDir, { recursive: true, force: true });

  console.log(`\nDone. ${path.relative(projectRoot, vendorDir)}/ is ready.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
