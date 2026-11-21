'use strict';

/**
 * Fixtures are verbatim shapes of real output from Quest 2 (Android 10) and
 * Quest 3 (Android 12) running toybox, plus older `ls` and `df` variants.
 */

const { section, test, equal, ok } = require('./harness');
const P = require('../src/shared/paths');
const adb = require('../src/main/adb');

section('paths');

test('normalizePosix collapses slashes and ..', () => {
  equal(P.normalizePosix('/sdcard//Download/../Movies/'), '/sdcard/Movies');
  equal(P.normalizePosix('/'), '/');
  equal(P.normalizePosix('sdcard/Android'), 'sdcard/Android');
  equal(P.normalizePosix('/sdcard/../../etc'), '/etc');
});

test('joinPosix ignores empty parts and keeps leading slash', () => {
  equal(P.joinPosix('/sdcard', 'Download'), '/sdcard/Download');
  equal(P.joinPosix('/', 'sdcard'), '/sdcard');
  equal(P.joinPosix('/sdcard/', '/Download/'), '/sdcard/Download');
  equal(P.joinPosix('/sdcard', ''), '/sdcard');
});

test('parentPosix stops at root', () => {
  equal(P.parentPosix('/sdcard/Download'), '/sdcard');
  equal(P.parentPosix('/sdcard'), '/');
  equal(P.parentPosix('/'), '/');
});

test('baseName handles trailing slashes', () => {
  equal(P.baseName('/sdcard/Download/'), 'Download');
  equal(P.baseName('/sdcard/a.b.c'), 'a.b.c');
  equal(P.baseName('/'), '');
});

test('shellQuote survives quotes and spaces', () => {
  equal(P.shellQuote('/sdcard/My Files'), "'/sdcard/My Files'");
  equal(P.shellQuote("it's"), "'it'\\''s'");
  equal(P.shellQuote(''), "''");
  equal(P.shellQuote('$HOME `x`'), "'$HOME `x`'");
});

test('isInside respects segment boundaries', () => {
  ok(P.isInside('/sdcard', '/sdcard/Download'));
  ok(P.isInside('/sdcard', '/sdcard'));
  ok(!P.isInside('/sdcard', '/sdcardX/file'));
  ok(!P.isInside('/sdcard/Download', '/sdcard'));
});

test('kindForName picks the right family', () => {
  equal(P.kindForName('movie.MP4', false), 'video');
  equal(P.kindForName('shot.png', false), 'image');
  equal(P.kindForName('app.apk', false), 'apk');
  equal(P.kindForName('notes.txt', false), 'text');
  equal(P.kindForName('Archive.ZIP', false), 'archive');
  equal(P.kindForName('Download', true), 'folder');
  equal(P.kindForName('.nomedia', false), 'file');
});

test('formatBytes uses decimal units', () => {
  equal(P.formatBytes(0), '0 B');
  equal(P.formatBytes(999), '999 B');
  equal(P.formatBytes(1500), '1.5 KB');
  equal(P.formatBytes(1234567), '1.2 MB');
  equal(P.formatBytes(150_000_000_000), '150 GB');
  equal(P.formatBytes(null), '—');
});

test('formatDuration counts down like a media player', () => {
  equal(P.formatDuration(8), '8 s');
  equal(P.formatDuration(64), '1:04');
  equal(P.formatDuration(3723), '1:02:03');
});

test('prettyModel turns quest_3 into Quest 3', () => {
  equal(P.prettyModel('Quest 3'), 'Quest 3');
  equal(P.prettyModel('quest_3'), 'Quest 3');
  equal(P.prettyModel(''), 'Quest');
});

section('adb: devices');

test('parseDevices reads serials, state and model', () => {
  const stdout = [
    'List of devices attached',
    '1WMHH815A12345\tdevice product:hollywood model:Quest_3 device:hollywood transport_id:4',
    '192.168.1.24:5555\tdevice product:monterey model:Quest_2 device:monterey transport_id:7',
    'ZY22ABCDEF\tunauthorized usb:1-1 transport_id:2',
    'emulator-5554\toffline transport_id:1',
    '',
  ].join('\n');

  const devices = adb.parseDevices(stdout);
  equal(devices.length, 4);
  equal(devices[0].serial, '1WMHH815A12345');
  equal(devices[0].model, 'Quest 3');
  equal(devices[0].wireless, false);
  equal(devices[0].authorized, true);
  equal(devices[0].transportId, '4');
  equal(devices[1].wireless, true);
  equal(devices[1].model, 'Quest 2');
  equal(devices[2].authorized, false);
  equal(devices[2].state, 'unauthorized');
  equal(devices[3].state, 'offline');
});

test('parseDevices ignores daemon chatter', () => {
  const stdout = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    '',
  ].join('\n');
  equal(adb.parseDevices(stdout).length, 0);
});

section('adb: battery and storage');

test('parseBattery reads level, status and temperature', () => {
  const out = [
    'Current Battery Service state:',
    '  AC powered: false',
    '  USB powered: true',
    '  status: 2',
    '  level: 87',
    '  temperature: 301',
  ].join('\n');
  const battery = adb.parseBattery(out);
  equal(battery.level, 87);
  equal(battery.charging, true);
  equal(Number(battery.temperature.toFixed(1)), 30.1);
});

test('parseDf handles the /storage/emulated mount', () => {
  const out = [
    'Filesystem       1K-blocks      Used Available Use% Mounted on',
    '/dev/block/dm-44 109871104  51000832  58870272  47% /storage/emulated',
  ].join('\n');
  const storage = adb.parseDf(out);
  equal(storage.totalBytes, 109871104 * 1024);
  equal(storage.usedBytes, 51000832 * 1024);
  equal(storage.freeBytes, 58870272 * 1024);
  equal(storage.mount, '/storage/emulated');
});

test('parseDf picks shared storage out of a full mount table', () => {
  const out = [
    'Filesystem     1K-blocks    Used Available Use% Mounted on',
    '/dev/block/dm-1    524288  100000    424288  19% /system',
    '/dev/block/dm-2   2097152 1200000    897152  57% /data',
    '/dev/block/dm-9 109871104 51000832 58870272  47% /storage/emulated',
  ].join('\n');
  equal(adb.parseDf(out).totalBytes, 109871104 * 1024);
});

test('parseDf survives a wrapped device name and no rows', () => {
  equal(adb.parseDf(''), null);
  equal(adb.parseDf('Filesystem 1K-blocks Used Available Use% Mounted on\n'), null);
});

section('adb: directory listings');

const QUEST3_LS = [
  'total 24',
  'drwxrwx--x   4 root   sdcard_rw    4096 2024-06-11 14:32 Alarms',
  'drwxrwx--x   2 root   sdcard_rw    4096 2026-11-19 09:02 Download',
  '-rw-rw----   1 u0_a123 sdcard_rw 1234567 2024-06-11 14:33 Vacation video.mp4',
  '-rw-rw----   1 u0_a123 sdcard_rw    9126 2026-11-18 21:44 notes.txt',
  'lrwxrwxrwx   1 root   root          21 2024-06-11 14:32 self -> /storage/self/primary',
  '-rw-rw----   1 u0_a123 sdcard_rw       0 2026-11-01 08:00 .nomedia',
].join('\n');

test('parseListing reads ISO dates, spaces, symlinks and dotfiles', () => {
  const entries = adb.parseListing(QUEST3_LS, '/sdcard');
  const names = entries.map((entry) => entry.name);
  equal(names, ['Alarms', 'Download', '.nomedia', 'notes.txt', 'self', 'Vacation video.mp4']);
  equal(entries[0].isDir, true);
  equal(entries[0].size, null);
  equal(entries[2].name, '.nomedia');
  equal(entries[2].size, 0);
  equal(entries[3].size, 9126);
  equal(entries[3].kind, 'text');
  equal(entries[4].name, 'self');
  equal(entries[4].isSymlink, true);
  equal(entries[4].linkTarget, '/storage/self/primary');
  equal(entries[4].isDir, false);
  equal(entries[5].path, '/sdcard/Vacation video.mp4');
  equal(entries[5].kind, 'video');
  equal(entries[5].size, 1234567);
});

test('parseListing understands the Jun 11 14:32 clock form', () => {
  const out = [
    'drwxrwx--x 4 root sdcard_rw 4096 Jun 11 14:32 Alarms',
    '-rw-rw---- 1 root sdcard_rw 55 Jun  1 09:05 a.txt',
  ].join('\n');
  const entries = adb.parseListing(out, '/sdcard');
  equal(entries.map((entry) => entry.name), ['Alarms', 'a.txt']);
  const stamp = new Date(entries[0].mtime);
  equal(stamp.getMonth(), 5);
  equal(stamp.getDate(), 11);
  equal(stamp.getHours(), 14);
  equal(stamp.getMinutes(), 32);
});

test('parseListing reads the year form for old files', () => {
  const out = '-rw-rw---- 1 root sdcard_rw 55 Jun 11  2021 old.txt';
  const entries = adb.parseListing(out, '/sdcard');
  equal(entries.length, 1);
  equal(entries[0].name, 'old.txt');
  equal(new Date(entries[0].mtime).getFullYear(), 2021);
});

test('parseListing rolls a future clock date back a year', () => {
  const now = new Date();
  const day = now.getDate() === 1 ? 2 : 1;
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    now.getMonth()
  ];
  const out = `-rw-rw---- 1 root sdcard_rw 1 ${monthName} ${String(day).padStart(2)} 23:59 future.txt`;
  const entries = adb.parseListing(out, '/sdcard');
  ok(entries[0].mtime <= Date.now() + 60_000, 'mtime should not be in the future');
});

test('parseListing copes with owner/group that are numeric', () => {
  const out = '-rw-r--r-- 1 1000 1015 2048 2024-06-11 14:32 file.bin';
  const entries = adb.parseListing(out, '/sdcard/Download');
  equal(entries[0].owner, '1000');
  equal(entries[0].group, '1015');
  equal(entries[0].size, 2048);
  equal(entries[0].name, 'file.bin');
});

test('parseListing ignores SELinux dots and blank lines', () => {
  const out = [
    '',
    'total 8',
    'drwxrwx--x. 4 root sdcard_rw 4096 2024-06-11 14:32 Movies',
    '',
  ].join('\n');
  const entries = adb.parseListing(out, '/sdcard');
  equal(entries.length, 1);
  equal(entries[0].name, 'Movies');
  equal(entries[0].mode, 'drwxrwx--x');
});

test('parseListing sorts folders first then natural name order', () => {
  const out = [
    '-rw-rw---- 1 root sdcard_rw 1 2024-06-11 14:32 file10.txt',
    '-rw-rw---- 1 root sdcard_rw 1 2024-06-11 14:32 file2.txt',
    'drwxrwx--x 1 root sdcard_rw 1 2024-06-11 14:32 zeta',
    'drwxrwx--x 1 root sdcard_rw 1 2024-06-11 14:32 Alpha',
  ].join('\n');
  const names = adb.parseListing(out, '/sdcard').map((entry) => entry.name);
  equal(names, ['Alpha', 'zeta', 'file2.txt', 'file10.txt']);
});

section('adb: error messages');

test('describeError translates the common adb failures', () => {
  const unauthorized = adb.describeError({
    stderr: 'error: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set',
  });
  ok(/accept the USB debugging/i.test(unauthorized));

  const offline = adb.describeError({ stderr: 'error: device offline' });
  ok(/replug/i.test(offline));

  const gone = adb.describeError({ stderr: 'error: no devices/emulators found' });
  ok(/not connected/i.test(gone));
});

section('adb: storage volumes');

test('parseVolumeNames keeps USB volumes and drops Android internals', () => {
  const out = [
    'total 4',
    'drwxr-xr-x 4 root root 4096 2024-06-11 14:32 emulated',
    'drwxr-xr-x 2 root root 4096 2024-06-11 14:32 self',
    'drwxrwx--x 3 media_rw media_rw 4096 2024-06-11 14:32 1A2B-3C4D',
    'drwxrwx--x 2 media_rw media_rw 4096 2024-06-11 14:32 9Z8Y-7X6W',
  ].join('\n');
  equal(adb.parseVolumeNames(out), ['1A2B-3C4D', '9Z8Y-7X6W']);
});

test('parseVolumeNames tolerates a bare listing', () => {
  equal(adb.parseVolumeNames(''), []);
  equal(adb.parseVolumeNames('total 0\n'), []);
});

section('adb: wireless discovery');

test('parseMdns reads TPS endpoints and strips the token from the serial', () => {
  const out = [
    'List of discovered mdns services',
    'adb-2G97C5ZJ22004Q-8ezFHi\t_adb-tls-connect._tcp\t192.168.1.42:46289',
    'adb-1WMHH81234567-abcde\t_adb-tls-pairing._tcp\t192.168.1.77:37001',
    'random\t_adb._tcp\t192.168.1.9:5555',
    'garbage',
  ].join('\n');
  const services = adb.parseMdns(out);
  equal(services.length, 3);
  equal(services[0].hostPort, '192.168.1.42:46289');
  equal(services[0].serial, '2G97C5ZJ22004Q');
  equal(services[0].service, '_adb-tls-connect._tcp');
  equal(services[2].hostPort, '192.168.1.9:5555');
});

test('parseMdns returns nothing for empty output', () => {
  equal(adb.parseMdns(''), []);
});
