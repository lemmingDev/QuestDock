'use strict';

/**
 * A small ZIP reader that needs no external binary.
 *
 * APKS/XAPK/APKM bundles and Beat Saber songs are all ZIP files, and shipping
 * an unzip tool per platform (or calling PowerShell on Windows) is fragile.
 * Node already has zlib, so reading the central directory and inflating each
 * entry is enough.
 *
 * Safety rules, because archives are untrusted input:
 *   - absolute paths and drive letters are rejected
 *   - `..` segments are rejected, so nothing can escape the destination
 *   - symlink entries are rejected instead of being materialised
 *   - encrypted entries are reported, not silently skipped
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_TAIL = 22 + 0xffff;

const METHODS = {
  0: 'stored',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstd',
};

function findEocd(buffer) {
  const last = buffer.length - 22;
  const first = Math.max(0, buffer.length - MAX_TAIL);
  for (let offset = last; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

function decodeName(buffer) {
  const text = buffer.toString('utf8');
  if (!text.includes('\uFFFD')) return text;
  return buffer.toString('latin1');
}

function readZip64Extra(extra, entry) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + length);
    if (id === 0x0001) {
      let cursor = 0;
      const take64 = () => {
        if (cursor + 8 > body.length) return null;
        const value = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
        return value;
      };
      if (entry.size === 0xffffffff) entry.size = take64();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = take64();
      if (entry.localOffset === 0xffffffff) entry.localOffset = take64();
      return;
    }
    offset += 4 + length;
  }
}

function modeFromExternal(attributes) {
  return (attributes >>> 16) & 0xffff;
}

/** True when the entry's Unix mode marks it as a symlink. */
function isSymlinkMode(mode) {
  return (mode & 0o170000) === 0o120000;
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * Open a ZIP and read its central directory.
 *
 * @returns {Promise<{entries: Array<object>, size: number, close: Function}>}
 */
async function openZip(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (stats.size < 22) throw new Error('That file is not a ZIP archive.');

    const tailLength = Math.min(stats.size, MAX_TAIL);
    const tail = await readAt(handle, stats.size - tailLength, tailLength);
    const eocdOffset = findEocd(tail);
    if (eocdOffset === -1) throw new Error('That file is not a ZIP archive.');

    const eocd = tail.subarray(eocdOffset);
    let count = eocd.readUInt16LE(10);
    let centralSize = eocd.readUInt32LE(12);
    let centralOffset = eocd.readUInt32LE(16);

    // ZIP64 keeps the real values in a second record just before the EOCD.
    if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      const absoluteEocd = stats.size - tailLength + eocdOffset;
      if (absoluteEocd >= 20) {
        const locator = await readAt(handle, absoluteEocd - 20, 20);
        if (locator.length === 20 && locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
          const zip64Offset = Number(locator.readBigUInt64LE(8));
          const record = await readAt(handle, zip64Offset, 56);
          if (record.length >= 56 && record.readUInt32LE(0) === SIG_ZIP64_EOCD) {
            count = Number(record.readBigUInt64LE(32));
            centralSize = Number(record.readBigUInt64LE(40));
            centralOffset = Number(record.readBigUInt64LE(48));
          }
        }
      }
    }

    const central = await readAt(handle, centralOffset, centralSize);
    if (central.length < centralSize) throw new Error('The ZIP central directory is damaged.');

    const entries = [];
    let offset = 0;
    for (let index = 0; index < count && offset + 46 <= central.length; index += 1) {
      if (central.readUInt32LE(offset) !== SIG_CENTRAL) {
        throw new Error('The ZIP central directory is damaged.');
      }
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const time = central.readUInt16LE(offset + 12);
      const date = central.readUInt16LE(offset + 14);
      const crc = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const size = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const external = central.readUInt32LE(offset + 38);
      const localOffset = central.readUInt32LE(offset + 42);
      const name = decodeName(central.subarray(offset + 46, offset + 46 + nameLength));
      const extra = central.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength
      );

      const entry = {
        name,
        method,
        methodName: METHODS[method] || `method ${method}`,
        encrypted: Boolean(flags & 1),
        size,
        compressedSize,
        crc,
        localOffset,
        external,
        mode: modeFromExternal(external),
        isSymlink: isSymlinkMode(modeFromExternal(external)),
        isDirectory: name.endsWith('/'),
        time,
        date,
      };
      if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        readZip64Extra(extra, entry);
      }
      entries.push(entry);
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return {
      entries,
      size: stats.size,
      async read(entry) {
        return readEntry(handle, entry);
      },
      async close() {
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readEntry(handle, entry) {
  if (entry.encrypted) throw new Error(`"${entry.name}" is password protected.`);
  if (entry.isDirectory) return Buffer.alloc(0);

  const header = await readAt(handle, entry.localOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`"${entry.name}" has a damaged header.`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = await readAt(handle, start, entry.compressedSize);
  if (raw.length < entry.compressedSize) throw new Error(`"${entry.name}" is truncated.`);

  if (entry.method === 0) {
    const data = Buffer.from(raw);
    if (data.length !== entry.size) throw new Error(`"${entry.name}" is truncated.`);
    return data;
  }
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      throw new Error(`"${entry.name}" could not be decompressed.`);
    }
  }
  throw new Error(`"${entry.name}" uses ${entry.methodName}, which is not supported.`);
}

function listZip(filePath) {
  return openZip(filePath).then(async (zip) => {
    const entries = zip.entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      compressedSize: entry.compressedSize,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      encrypted: entry.encrypted,
      method: entry.methodName,
    }));
    await zip.close();
    return { path: filePath, entries };
  });
}

/**
 * Turn an archive member name into a safe relative path.
 * Throws when the name tries to leave the destination or is not a file path.
 */
function safeRelative(name) {
  const normal = String(name == null ? '' : name).replace(/\\/g, '/');
  if (!normal) throw new Error('The archive contains an empty file name.');
  if (normal.startsWith('/')) throw new Error(`"${normal}" is an absolute path.`);
  if (/^[A-Za-z]:/.test(normal)) throw new Error(`"${normal}" is an absolute path.`);
  const parts = [];
  for (const part of normal.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`"${normal}" tries to leave the destination folder.`);
    parts.push(part);
  }
  if (!parts.length) throw new Error('The archive contains an empty file name.');
  return parts.join('/');
}

/** First path segment, used to decide whether a wrapper folder can be stripped. */
function topSegment(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/\/+$/, '');
  const cut = clean.indexOf('/');
  return cut === -1 ? null : clean.slice(0, cut);
}

/**
 * A wrapper folder is strippable only when every file lives below one folder
 * and that folder itself has no sibling files. Beat Saber zips are usually
 * `<song>/info.dat`, but a completely flat zip must stay flat.
 */
function commonRoot(entries) {
  const isDirEntry = (entry) => entry.isDirectory || /\/$/.test(entry.name);
  const files = entries.filter((entry) => !isDirEntry(entry));
  if (files.length < 1) return '';
  const first = topSegment(files[0].name);
  if (!first) return '';
  for (const entry of entries) {
    if (isDirEntry(entry) && entry.name.replace(/\/+$/, '') === first) continue;
    if (topSegment(entry.name) !== first) return '';
  }
  return first;
}

function shouldSkip(name, options) {
  const parts = name.split('/');
  if (parts.includes('__MACOSX')) return true;
  const base = parts[parts.length - 1];
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  if (options.skipDotfiles && parts.some((part) => part.startsWith('.'))) return true;
  return false;
}

/**
 * Extract every file in `zip` below `destination`.
 *
 * @param {object} zip            from openZip()
 * @param {string} destination    existing or new folder
 * @param {object} [options]
 * @param {boolean} [options.stripRoot]  remove one shared wrapper folder
 * @param {(info: object) => void} [options.onEntry]
 * @returns {Promise<{root: string, files: string[]}>}
 */
async function extractZip(zip, destination, options = {}) {
  const root = path.resolve(destination);
  await fsp.mkdir(root, { recursive: true });

  const strip = Boolean(options.stripRoot);
  const shared = strip ? commonRoot(zip.entries) : '';
  const files = [];
  const total = zip.entries.filter((entry) => !entry.isDirectory).length;
  let index = 0;

  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    if (entry.encrypted) throw new Error(`"${entry.name}" is password protected.`);
    if (entry.isSymlink) throw new Error(`"${entry.name}" is a symlink, which is not allowed.`);
    if (shouldSkip(entry.name, options)) continue;

    let relative = safeRelative(entry.name);
    if (shared && relative.startsWith(`${shared}/`)) relative = relative.slice(shared.length + 1);
    if (!relative) continue;

    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`"${entry.name}" tries to leave the destination folder.`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const data = await zip.read(entry);
    await fsp.writeFile(target, data);
    files.push(target);
    index += 1;
    if (options.onEntry) {
      options.onEntry({ name: relative, index, total, entry });
    }
  }

  return { root, files };
}

async function extractToFile(filePath, destination, options = {}) {
  const zip = await openZip(filePath);
  try {
    return await extractZip(zip, destination, options);
  } finally {
    await zip.close();
  }
}

async function removeTree(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 });
}

module.exports = {
  openZip,
  listZip,
  readEntry,
  extractZip,
  extractToFile,
  safeRelative,
  commonRoot,
  topSegment,
  removeTree,
  isSymlinkMode,
};
