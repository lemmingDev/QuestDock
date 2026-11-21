'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { section, test, equal, ok, includes } = require('./harness');
const bundle = require('../src/main/apk-bundle');
const { makeZip } = require('./zip-fixtures');

async function withFile(name, files, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'questdock-apktest-'));
  const file = path.join(dir, name);
  if (files) await fsp.writeFile(file, makeZip(files));
  try {
    return await fn(file, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const MANIFEST = JSON.stringify({
  package_name: 'com.beatgames.beatsaber',
  name: 'Beat Saber',
  version_name: '1.37.0',
});

section('apk bundles');

test('recognises a plain APK', async () => {
  await withFile('game.apk', null, async (file) => {
    const info = await bundle.inspect(file);
    equal(info.type, 'apk');
    equal(info.packageName, '');
    equal(info.apks, []);
  });
});

test('inspects an XAPK with splits and OBB data', async () => {
  await withFile(
    'game.xapk',
    [
      { name: 'manifest.json', data: MANIFEST },
      { name: 'com.beatgames.beatsaber.apk', data: 'base', stored: true },
      { name: 'config.arm64_v8a.apk', data: 'split', stored: true },
      { name: 'Android/obb/com.beatgames.beatsaber/main.37.com.beatgames.beatsaber.obb', data: 'obb' },
    ],
    async (file) => {
      const info = await bundle.inspect(file);
      equal(info.type, 'xapk');
      equal(info.packageName, 'com.beatgames.beatsaber');
      equal(info.label, 'Beat Saber');
      equal(info.versionName, '1.37.0');
      equal(info.apks.map((entry) => entry.name), [
        'com.beatgames.beatsaber.apk',
        'config.arm64_v8a.apk',
      ]);
      equal(info.obb.length, 1);
      equal(info.obb[0].fileName, 'main.37.com.beatgames.beatsaber.obb');
    }
  );
});

test('stages split APKs and OBB files as absolute paths', async () => {
  await withFile(
    'game.xapk',
    [
      { name: 'manifest.json', data: MANIFEST },
      { name: 'base.apk', data: 'base', stored: true },
      { name: 'split.arm.apk', data: 'split', stored: true },
      { name: 'obb/com.beatgames.beatsaber/main.obb', data: 'obb' },
    ],
    async (file, dir) => {
      const info = await bundle.inspect(file);
      const output = path.join(dir, 'staged');
      const staged = await bundle.stage(info, output);
      equal(staged.apkPaths.length, 2);
      ok(staged.apkPaths.every((target) => path.isAbsolute(target)), 'APK paths are absolute');
      equal(staged.obbPaths.length, 1);
      equal(
        staged.obbPaths[0].localPath,
        path.join(output, 'obb', 'com.beatgames.beatsaber', 'main.obb')
      );
      equal(await fsp.readFile(staged.apkPaths[0], 'utf8'), 'base');
    }
  );
});

test('an APKS with universal.apk installs only that build', async () => {
  await withFile(
    'game.apks',
    [
      { name: 'universal.apk', data: 'universal', stored: true },
      { name: 'splits/base-master.apk', data: 'base', stored: true },
      { name: 'splits/base-arm64.apk', data: 'arm', stored: true },
    ],
    async (file) => {
      const info = await bundle.inspect(file);
      equal(info.type, 'apks');
      equal(info.apks.map((entry) => entry.name), ['universal.apk']);
    }
  );
});

test('an APKS without universal.apk installs every split', async () => {
  await withFile(
    'game.apks',
    [
      { name: 'splits/base-master.apk', data: 'base', stored: true },
      { name: 'splits/base-arm64.apk', data: 'arm', stored: true },
    ],
    async (file) => {
      const info = await bundle.inspect(file);
      equal(info.apks.length, 2);
      equal(info.apks[0].name, 'splits/base-master.apk');
    }
  );
});

test('reads package metadata from APKM info.json', async () => {
  await withFile(
    'game.apkm',
    [
      { name: 'info.json', data: JSON.stringify({ pname: 'com.example.vr', apkm_name: 'Demo', versionname: '2.1' }) },
      { name: 'base.apk', data: 'base', stored: true },
    ],
    async (file) => {
      const info = await bundle.inspect(file);
      equal(info.packageName, 'com.example.vr');
      equal(info.label, 'Demo');
      equal(info.versionName, '2.1');
    }
  );
});

test('finds a package name in a bundletool toc.pb', () => {
  equal(
    bundle.packageFromProtobuf(Buffer.from('\u0000com.beatgames.beatsaber\u0001')),
    'com.beatgames.beatsaber'
  );
});

test('rejects a bundle without APKs', async () => {
  await withFile('empty.xapk', [{ name: 'manifest.json', data: MANIFEST }], async (file) => {
    let threw = '';
    try {
      await bundle.inspect(file);
    } catch (error) {
      threw = error.message;
    }
    includes(threw, 'does not contain any APKs');
  });
});

test('sanitizePackage refuses traversal', () => {
  equal(bundle.sanitizePackage('com.example.app'), 'com.example.app');
  for (const bad of ['../etc', 'com/example', 'com example', '']) {
    let threw = false;
    try {
      bundle.sanitizePackage(bad);
    } catch {
      threw = true;
    }
    ok(threw, `${bad} should be rejected`);
  }
});
