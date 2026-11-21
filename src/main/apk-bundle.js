'use strict';

/**
 * Split-package installs: `.apks`, `.xapk` and `.apkm` are ZIP containers that
 * hold a base APK plus per-architecture / per-density splits, and sometimes
 * OBB expansion files.
 *
 * The container format is only a convention, so this module is deliberately
 * tolerant: it looks for the metadata file each tool writes, then falls back
 * to "every .apk in the archive". Nothing is installed from here; it stages
 * the files and lets the main process drive `adb install-multiple`.
 */

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const zip = require('./zip');

const BUNDLE_EXT = new Set(['apks', 'xapk', 'apkm']);
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function extensionOf(file) {
  const name = String(file || '');
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isBundle(file) {
  return BUNDLE_EXT.has(extensionOf(file));
}

function looksLikeApk(file) {
  return extensionOf(file) === 'apk';
}

async function readJsonEntry(archive, entry) {
  try {
    const data = await archive.read(entry);
    return JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function pickString(object, keys) {
  for (const key of keys) {
    const value = object && object[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** Scan a protobuf (toc.pb) for the first bundle-like package name. */
function packageFromProtobuf(buffer) {
  const text = buffer.toString('latin1');
  const matches = text.match(/[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}/g) || [];
  return matches.find((value) => PACKAGE_NAME.test(value)) || '';
}

/**
 * Read metadata without trusting the extension too much.
 * Returns `{ packageName, label, versionName }`.
 */
async function readMetadata(archive, files, type) {
  const byName = new Map(files.map((entry) => [entry.name.toLowerCase(), entry]));
  const meta = { packageName: '', label: '', versionName: '' };

  if (type === 'xapk') {
    const entry = byName.get('manifest.json') || byName.get('xapk.json');
    if (entry) {
      const json = await readJsonEntry(archive, entry);
      if (json) {
        meta.packageName = pickString(json, ['package_name', 'packageName', 'package']);
        meta.label = pickString(json, ['name', 'label', 'app_name']);
        meta.versionName = pickString(json, ['version_name', 'versionName']);
      }
    }
  }

  if (type === 'apkm') {
    const entry = byName.get('info.json');
    if (entry) {
      const json = await readJsonEntry(archive, entry);
      if (json) {
        meta.packageName = pickString(json, ['pname', 'package_name', 'package']);
        meta.label = pickString(json, ['apkm_name', 'name', 'label']);
        meta.versionName = pickString(json, ['versionname', 'version_name']);
      }
    }
  }

  if (type === 'apks') {
    const entry = byName.get('toc.pb');
    if (entry) {
      const buffer = await archive.read(entry);
      meta.packageName = packageFromProtobuf(buffer);
    }
    const jsonEntry = byName.get('meta.json') || byName.get('info.json');
    if (jsonEntry) {
      const json = await readJsonEntry(archive, jsonEntry);
      if (json) {
        meta.packageName = meta.packageName || pickString(json, ['package', 'package_name', 'pname']);
        meta.label = pickString(json, ['name', 'label', 'app_name']);
        meta.versionName = pickString(json, ['version', 'version_name', 'versionname']);
      }
    }
  }

  if (!PACKAGE_NAME.test(meta.packageName)) meta.packageName = '';
  return meta;
}

/** Choose installable APKs, preferring a universal build when it exists. */
function chooseApks(files, type) {
  const apks = files.filter((entry) => looksLikeApk(entry.name));
  if (!apks.length) return [];

  if (type === 'apks') {
    const universal = apks.find((entry) => /(^|\/)universal\.apk$/i.test(entry.name));
    if (universal) return [universal];
    const standalone = apks.filter((entry) => /(^|\/)standalones\//i.test(entry.name));
    if (standalone.length === 1) return standalone;
  }

  // Split installs need the base first; adb does not care about order, but a
  // stable order makes logs and tests readable.
  const rank = (name) => {
    if (/(^|\/)universal\.apk$/i.test(name)) return 0;
    if (/(^|\/)base(-master)?\.apk$/i.test(name)) return 0;
    if (/(^|\/)base-/i.test(name)) return 1;
    return 2;
  };
  return apks.sort((a, b) => {
    const diff = rank(a.name) - rank(b.name);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

function chooseObb(files) {
  const found = [];
  for (const entry of files) {
    const match = entry.name.match(/^(?:Android\/obb|obb)\/([^/]+)\/([^/]+\.obb)$/i);
    if (!match) continue;
    const packageName = match[1];
    if (!PACKAGE_NAME.test(packageName)) continue;
    found.push({ entry: entry.name, packageName, fileName: match[2] });
  }
  return found;
}

/**
 * Inspect an APK or bundle without extracting it.
 * @returns {Promise<object>} descriptor used by the UI and the installer
 */
async function inspect(file) {
  const type = extensionOf(file);
  if (!type || (type !== 'apk' && !BUNDLE_EXT.has(type))) {
    throw new Error('Choose an .apk, .apks, .xapk or .apkm file.');
  }
  if (type === 'apk') {
    return {
      file,
      type: 'apk',
      packageName: '',
      label: path.basename(file, path.extname(file)),
      versionName: '',
      apks: [],
      obb: [],
      totalBytes: 0,
    };
  }

  const archive = await zip.openZip(file);
  try {
    const files = archive.entries.filter((entry) => !entry.isDirectory);
    const meta = await readMetadata(archive, files, type);
    const apks = chooseApks(files, type).map((entry) => ({
      name: entry.name,
      size: entry.size,
    }));
    const obb = chooseObb(files).map((item) => ({
      name: item.entry,
      packageName: item.packageName,
      fileName: item.fileName,
    }));
    if (!apks.length) {
      throw new Error(
        'That bundle does not contain any APKs. It may be an OBB-only or unsupported archive.'
      );
    }
    return {
      file,
      type,
      packageName: meta.packageName,
      label: meta.label || meta.packageName || path.basename(file, path.extname(file)),
      versionName: meta.versionName,
      apks,
      obb,
      totalBytes: apks.reduce((total, entry) => total + entry.size, 0),
    };
  } finally {
    await archive.close();
  }
}

function sanitizePackage(packageName) {
  const value = String(packageName || '').trim();
  if (!PACKAGE_NAME.test(value)) throw new Error(`"${value}" is not a valid package name.`);
  return value;
}

/**
 * Extract the chosen APKs (and OBB files) below `destination`.
 * Returns absolute paths ready for `adb install-multiple` / `adb push`.
 */
async function stage(descriptor, destination) {
  const dir = path.resolve(destination);
  await fsp.mkdir(dir, { recursive: true });

  if (descriptor.type === 'apk') {
    return { apkPaths: [descriptor.file], obbPaths: [], packageName: descriptor.packageName };
  }

  const archive = await zip.openZip(descriptor.file);
  try {
    const files = archive.entries.filter((entry) => !entry.isDirectory);
    const byName = new Map(files.map((entry) => [entry.name, entry]));

    const apkPaths = [];
    for (let index = 0; index < descriptor.apks.length; index += 1) {
      const entryName = descriptor.apks[index].name;
      const entry = byName.get(entryName);
      if (!entry) throw new Error(`"${entryName}" disappeared from the bundle.`);
      const target = path.join(dir, `${String(index).padStart(2, '0')}-${path.basename(entryName)}`);
      await fsp.writeFile(target, await archive.read(entry));
      apkPaths.push(target);
    }

    const obbPaths = [];
    for (const item of descriptor.obb) {
      const entry = byName.get(item.name);
      if (!entry) continue;
      const target = path.join(dir, 'obb', sanitizePackage(item.packageName), item.fileName);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, await archive.read(entry));
      obbPaths.push({
        localPath: target,
        packageName: item.packageName,
        fileName: item.fileName,
      });
    }

    return { apkPaths, obbPaths, packageName: descriptor.packageName };
  } finally {
    await archive.close();
  }
}

async function makeTempDir(prefix = 'questdock-apk-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

module.exports = {
  isBundle,
  looksLikeApk,
  inspect,
  stage,
  makeTempDir,
  chooseApks,
  chooseObb,
  packageFromProtobuf,
  sanitizePackage,
  BUNDLE_EXT,
};
