'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { section, test, equal, ok, includes } = require('./harness');
const zip = require('../src/main/zip');
const { makeZip } = require('./zip-fixtures');

async function withZip(files, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'questdock-ziptest-'));
  const file = path.join(dir, 'archive.zip');
  await fsp.writeFile(file, makeZip(files));
  try {
    return await fn(file, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

section('zip');

test('lists and reads stored and deflated entries', async () => {
  await withZip(
    [
      { name: 'stored.txt', data: 'hello', stored: true },
      { name: 'nested/deflated.txt', data: 'a'.repeat(500) },
      { name: 'folder/', data: '' },
    ],
    async (file) => {
      const listing = await zip.listZip(file);
      const names = listing.entries.map((entry) => entry.name);
      equal(names, ['stored.txt', 'nested/deflated.txt', 'folder/']);
      equal(listing.entries[0].method, 'stored');
      equal(listing.entries[1].method, 'deflate');
      ok(listing.entries[2].isDirectory, 'trailing slash is a directory');

      const handle = await zip.openZip(file);
      const stored = handle.entries.find((entry) => entry.name === 'stored.txt');
      const deflated = handle.entries.find((entry) => entry.name === 'nested/deflated.txt');
      equal((await handle.read(stored)).toString(), 'hello');
      equal((await handle.read(deflated)).toString(), 'a'.repeat(500));
      await handle.close();
    }
  );
});

test('extracts a tree and keeps its shape', async () => {
  await withZip(
    [
      { name: 'song/info.dat', data: '{"_songName":"Test"}' },
      { name: 'song/Expert.dat', data: '{}' },
    ],
    async (file, dir) => {
      const out = path.join(dir, 'out');
      const result = await zip.extractToFile(file, out);
      equal(result.files.length, 2);
      equal(await fsp.readFile(path.join(out, 'song', 'info.dat'), 'utf8'), '{"_songName":"Test"}');
      ok(result.files.every((target) => target.startsWith(out)), 'all files stay inside');
    }
  );
});

test('stripRoot removes one shared wrapper folder', async () => {
  await withZip(
    [
      { name: 'My Song/info.dat', data: '{}' },
      { name: 'My Song/hard.dat', data: '{}' },
    ],
    async (file, dir) => {
      const out = path.join(dir, 'out');
      await zip.extractToFile(file, out, { stripRoot: true });
      ok(await fsp.stat(path.join(out, 'info.dat')).then(() => true), 'info.dat at the root');
      ok(await fsp.stat(path.join(out, 'hard.dat')).then(() => true), 'level at the root');
    }
  );
});

test('a flat archive is not stripped', async () => {
  await withZip(
    [
      { name: 'info.dat', data: '{}' },
      { name: 'song.egg', data: 'audio' },
    ],
    async (file, dir) => {
      const out = path.join(dir, 'out');
      await zip.extractToFile(file, out, { stripRoot: true });
      ok(await fsp.stat(path.join(out, 'info.dat')).then(() => true), 'info.dat kept');
    }
  );
});

test('rejects path traversal, absolute paths and symlinks', async () => {
  for (const name of ['../escape.txt', 'song/../../escape.txt', '/etc/passwd', 'C:\\Windows\\x.txt']) {
    await withZip([{ name, data: 'nope' }], async (file, dir) => {
      const out = path.join(dir, 'out');
      let threw = '';
      try {
        await zip.extractToFile(file, out, { stripRoot: false });
      } catch (error) {
        threw = error.message;
      }
      ok(threw, `${name} should be rejected`);
      equal(await fsp.stat(path.join(dir, 'escape.txt')).then(() => true).catch(() => false), false);
    });
  }

  await withZip([{ name: 'link', symlink: true, data: '/etc/passwd' }], async (file, dir) => {
    let threw = '';
    try {
      await zip.extractToFile(file, path.join(dir, 'out'), { stripRoot: false });
    } catch (error) {
      threw = error.message;
    }
    includes(threw, 'symlink');
  });
});

test('reports an unsupported compression method instead of writing garbage', async () => {
  await withZip([{ name: 'x.bin', data: 'hello' }], async (file, dir) => {
    const buffer = await fsp.readFile(file);
    // Switch both headers to method 12 (bzip2), which the app does not ship.
    buffer.writeUInt16LE(12, buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) + 8);
    buffer.writeUInt16LE(12, buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    const patched = path.join(dir, 'patched.zip');
    await fsp.writeFile(patched, buffer);

    const handle = await zip.openZip(patched);
    const entry = handle.entries[0];
    let threw = '';
    try {
      await handle.read(entry);
    } catch (error) {
      threw = error.message;
    }
    await handle.close();
    includes(threw, 'not supported');
  });
});

test('safeRelative normalises separators and dots', () => {
  equal(zip.safeRelative('a\\b\\c.txt'), 'a/b/c.txt');
  equal(zip.safeRelative('./a//b.txt'), 'a/b.txt');
  for (const bad of ['..', '../x', 'a/../../b', '/abs', 'D:/x']) {
    let threw = false;
    try {
      zip.safeRelative(bad);
    } catch {
      threw = true;
    }
    ok(threw, `${bad} should be rejected`);
  }
});

test('commonRoot only accepts one wrapper folder', () => {
  equal(
    zip.commonRoot([{ name: 'Song/info.dat' }, { name: 'Song/E.dat' }, { name: 'Song/' }]),
    'Song'
  );
  equal(zip.commonRoot([{ name: 'info.dat' }, { name: 'Song/E.dat' }]), '');
});
