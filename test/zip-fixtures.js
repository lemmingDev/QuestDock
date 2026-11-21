'use strict';

/**
 * Minimal ZIP writer for tests.
 *
 * It writes stored or deflated entries with a Unix mode in the external
 * attributes, which is exactly what the reader inspects. No CRC is needed:
 * the app never trusts a checksum it cannot verify against a downloaded
 * manifest, and the tests only care about structure and safety rules.
 */

const zlib = require('zlib');

function makeEntry(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
  const method = entry.stored ? 0 : 8;
  const payload = method === 0 ? data : zlib.deflateRawSync(data);
  const mode = entry.mode || (entry.symlink ? 0o120777 : 0o100644);
  return { name, data, payload, method, mode, isDirectory: entry.name.endsWith('/') };
}

/**
 * @param {Array<{name: string, data?: string|Buffer, stored?: boolean,
 *                symlink?: boolean, mode?: number}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const entries = files.map(makeEntry);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(entry.payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(entry.payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, entry.name, entry.payload);
    centralParts.push(central, entry.name);
    offset += local.length + entry.name.length + entry.payload.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

module.exports = { makeZip };
