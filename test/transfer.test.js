'use strict';

/**
 * End-to-end tests for the ADB layer and the transfer queue, run against
 * test/fake-adb.js so they work with no headset plugged in.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { section, test, equal, ok, includes } = require('./harness');

const fakeAdb = path.join(__dirname, 'fake-adb.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'questdock-'));
const deviceRoot = path.join(root, 'device');
const localRoot = path.join(root, 'local');
const SERIAL = 'FAKEQUEST3';

/* Prepare a believable headset before the modules resolve adb. */
fs.mkdirSync(path.join(deviceRoot, 'sdcard', 'Download'), { recursive: true });
fs.mkdirSync(path.join(deviceRoot, 'sdcard', 'Movies'), { recursive: true });
fs.mkdirSync(path.join(deviceRoot, 'sdcard', 'Pictures'), { recursive: true });
fs.mkdirSync(localRoot, { recursive: true });
fs.writeFileSync(path.join(deviceRoot, 'sdcard', 'Download', 'notes.txt'), 'hello quest\n');
fs.writeFileSync(path.join(deviceRoot, 'sdcard', 'Download', 'clip.mp4'), Buffer.alloc(4096, 3));
fs.writeFileSync(path.join(deviceRoot, 'sdcard', 'Pictures', 'shot one.png'), Buffer.alloc(300, 9));

process.env.FAKE_DEVICE_ROOT = deviceRoot;
process.env.FAKE_SERIAL = SERIAL;

const adb = require('../src/main/adb');
const { TransferQueue } = require('../src/main/transfers');

adb.setAdbPath(fakeAdb);
adb.resolveAdb(true);

function remote(...parts) {
  return path.join(deviceRoot, 'sdcard', ...parts);
}

/** Wait until every job in `ids` has settled, or throw on the first failure. */
function settle(queue, ids) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transfer timed out')), 30_000);
    const check = (snapshot) => {
      const jobs = snapshot.jobs.filter((job) => ids.includes(job.id));
      if (jobs.length !== ids.length || jobs.some((job) => ['queued', 'running'].includes(job.state))) {
        return;
      }
      clearTimeout(timer);
      queue.off('update', check);
      resolve(jobs);
    };
    queue.on('update', check);
    queue.emit('update', queue.snapshot());
  });
}

section('adb against a fake device');

test('lists the headset and reads its model', async () => {
  const devices = await adb.listDevices();
  equal(devices.length, 1);
  equal(devices[0].serial, SERIAL);
  equal(devices[0].model, 'Quest 3');
  equal(devices[0].authorized, true);
});

test('reads battery, storage and build facts', async () => {
  const info = await adb.deviceInfo(SERIAL);
  equal(info.battery.level, 76);
  equal(info.battery.charging, true);
  equal(info.model, 'Quest 3');
  equal(info.android, '12');
  ok(info.storage && info.storage.totalBytes > 0, 'storage total');
  equal(info.storage.freeBytes, 58870272 * 1024);
});

test('lists a folder with sizes and timestamps', async () => {
  const listing = await adb.listDir(SERIAL, '/sdcard/Download');
  equal(listing.path, '/sdcard/Download');
  const names = listing.entries.map((entry) => entry.name);
  equal(names, ['clip.mp4', 'notes.txt']);
  equal(listing.entries[1].size, 12);
  ok(listing.entries[1].mtime > 0, 'mtime parsed');
});

test('lists through the symlinked /sdcard root', async () => {
  const listing = await adb.listDir(SERIAL, '/sdcard');
  ok(listing.entries.length > 1, 'the root lists its contents, not the link');
  ok(!listing.entries.some((entry) => entry.name === '/sdcard'), 'not the link itself');
  ok(listing.entries.some((entry) => entry.name === 'Download'), 'Download is visible');
});

test('stat, du and exists agree', async () => {
  equal(await adb.statSize(SERIAL, '/sdcard/Download/notes.txt'), 12);
  ok((await adb.folderSize(SERIAL, '/sdcard/Download')) >= 4);
  equal(await adb.exists(SERIAL, '/sdcard/Download/notes.txt'), true);
  equal(await adb.exists(SERIAL, '/sdcard/Download/missing.txt'), false);
});

test('mkdir, rename and remove work on the device', async () => {
  await adb.mkdir(SERIAL, '/sdcard/Download/New Folder');
  ok(fs.existsSync(remote('Download', 'New Folder')), 'folder created');
  await adb.rename(SERIAL, '/sdcard/Download/New Folder', '/sdcard/Download/Renamed');
  ok(fs.existsSync(remote('Download', 'Renamed')), 'folder renamed');
  await adb.remove(SERIAL, ['/sdcard/Download/Renamed']);
  ok(!fs.existsSync(remote('Download', 'Renamed')), 'folder removed');
});

test('lists sideloaded packages and installs an APK', async () => {
  const before = await adb.listPackages(SERIAL);
  ok(before.includes('com.example.beat saber'), 'seeded package');

  const apk = path.join(localRoot, 'My Game.apk');
  fs.writeFileSync(apk, Buffer.from('not really a zip'));
  const result = await adb.installApk(SERIAL, apk);
  equal(result.packageName, '');

  const after = await adb.listPackages(SERIAL);
  ok(after.includes('com.example.My.Game'), `installed package: ${after.join(', ')}`);
  await adb.uninstall(SERIAL, 'com.example.My.Game');
  ok(!(await adb.listPackages(SERIAL)).includes('com.example.My.Game'), 'uninstalled');
});

section('transfer queue');

test('pushes a single file and leaves no temp behind', async () => {
  const source = path.join(localRoot, 'upload.txt');
  fs.writeFileSync(source, 'from the computer\n');

  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: source,
    remotePath: '/sdcard/Download/upload.txt',
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.readFileSync(remote('Download', 'upload.txt'), 'utf8'), 'from the computer\n');
  const leftovers = fs.readdirSync(remote('Download')).filter((name) => name.includes('.part'));
  equal(leftovers, []);
});

test('pushes a whole folder with its tree', async () => {
  const folder = path.join(localRoot, 'Album');
  fs.mkdirSync(path.join(folder, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
  fs.writeFileSync(path.join(folder, 'inner', 'b.txt'), 'bb');

  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: folder,
    remotePath: '/sdcard/Download/Album',
    isDir: true,
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.readFileSync(remote('Download', 'Album', 'inner', 'b.txt'), 'utf8'), 'bb');
});

test('overwriting replaces the old file', async () => {
  const source = path.join(localRoot, 'replace.txt');
  fs.writeFileSync(source, 'second version');

  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: source,
    remotePath: '/sdcard/Download/notes.txt',
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.readFileSync(remote('Download', 'notes.txt'), 'utf8'), 'second version');
});

test('a name clash can keep both files', async () => {
  const source = path.join(localRoot, 'notes.txt');
  fs.writeFileSync(source, 'the other notes');
  fs.writeFileSync(remote('Download', 'clash.txt'), 'original\n');

  const queue = new TransferQueue();
  const asked = [];
  queue.on('conflict', (payload) => {
    asked.push(payload.name);
    queue.resolveConflict(payload.id, 'rename');
  });

  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: source,
    remotePath: '/sdcard/Download/clash.txt',
    conflict: 'ask',
  });
  const [job] = await settle(queue, [id]);
  equal(asked, ['clash.txt']);
  equal(job.state, 'done');
  equal(fs.readFileSync(remote('Download', 'clash (1).txt'), 'utf8'), 'the other notes');
  equal(fs.readFileSync(remote('Download', 'clash.txt'), 'utf8'), 'original\n');
});

test('a skipped clash does nothing', async () => {
  const source = path.join(localRoot, 'skip.txt');
  fs.writeFileSync(source, 'ignored');
  fs.writeFileSync(remote('Download', 'keep.txt'), 'untouched\n');

  const queue = new TransferQueue();
  queue.on('conflict', (payload) => queue.resolveConflict(payload.id, 'skip'));
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: source,
    remotePath: '/sdcard/Download/keep.txt',
    conflict: 'ask',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.readFileSync(remote('Download', 'keep.txt'), 'utf8'), 'untouched\n');
  ok(!fs.existsSync(remote('Download', 'skip.txt')), 'nothing was copied');
});

test('pulls a file down to a chosen folder', async () => {
  const dest = path.join(localRoot, 'pulled');
  fs.mkdirSync(dest, { recursive: true });

  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'pull',
    serial: SERIAL,
    remotePath: '/sdcard/Download/clip.mp4',
    localPath: path.join(dest, 'clip.mp4'),
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.statSync(path.join(dest, 'clip.mp4')).size, 4096);
});

test('pulls a folder and keeps its structure', async () => {
  const dest = path.join(localRoot, 'downloaded-album');
  fs.mkdirSync(dest, { recursive: true });

  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'pull',
    serial: SERIAL,
    remotePath: '/sdcard/Download/Album',
    localPath: path.join(dest, 'Album'),
    isDir: true,
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'done');
  equal(fs.readFileSync(path.join(dest, 'Album', 'inner', 'b.txt'), 'utf8'), 'bb');
});

test('cancelling stops a slow push and cleans up', async () => {
  const source = path.join(localRoot, 'big.bin');
  fs.writeFileSync(source, Buffer.alloc(1024 * 1024, 5));

  process.env.FAKE_SLOW_MS = '60';
  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: source,
    remotePath: '/sdcard/Download/big.bin',
    conflict: 'overwrite',
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  queue.cancel(id);
  const [job] = await settle(queue, [id]);
  delete process.env.FAKE_SLOW_MS;

  equal(job.state, 'cancelled');
  ok(!fs.existsSync(remote('Download', 'big.bin')), 'no half-written file');
  const leftovers = fs.readdirSync(remote('Download')).filter((name) => name.includes('.part'));
  equal(leftovers, []);
});

test('a failed job can be retried', async () => {
  const queue = new TransferQueue();
  const id = queue.add({
    direction: 'push',
    serial: SERIAL,
    localPath: path.join(localRoot, 'does-not-exist.bin'),
    remotePath: '/sdcard/Download/nope.bin',
    conflict: 'overwrite',
  });
  const [job] = await settle(queue, [id]);
  equal(job.state, 'failed');
  ok(job.error.length > 0, 'error message');

  fs.writeFileSync(path.join(localRoot, 'does-not-exist.bin'), 'now it exists');
  queue.retry(id);
  const [retried] = await settle(queue, [id]);
  equal(retried.state, 'done');
});

section('cleanup');

test('remove the scratch folder', async () => {
  await fsp.rm(root, { recursive: true, force: true });
  ok(!fs.existsSync(root), 'scratch removed');
});
