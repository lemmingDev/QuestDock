#!/usr/bin/env node
'use strict';

/**
 * Fills a folder with a believable Quest file tree, used together with
 * test/fake-adb.js when working on the interface without a headset.
 *
 *   node test/seed-demo.js /tmp/questdock-demo
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(process.argv[2] || '/tmp/questdock-demo');
const sd = path.join(root, 'sdcard');

function png(width, height, painter) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x / width, y / height);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc ^ 0xffffffff;
}

function put(relative, contents) {
  const full = path.join(sd, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

fs.rmSync(root, { recursive: true, force: true });

const gradients = [
  (x, y) => [30 + x * 200, 40 + y * 120, 160],
  (x, y) => [180 - y * 90, 60 + x * 110, 200 - x * 120],
  (x, y) => [20, 120 + y * 100, 120 + x * 100],
  (x, y) => [220 - x * 140, 90 + y * 140, 60 + x * 80],
  (x, y) => [90 + x * 60, 30 + y * 60, 190 - y * 90],
];

for (let i = 1; i <= 5; i += 1) {
  put(`Pictures/Capture-${String(i).padStart(2, '0')}.png`, png(480, 270, gradients[i - 1]));
}

put('Download/BeatSaber-1.34.2.apk', Buffer.alloc(48 * 1024 * 1024, 4));
put('Download/SideQuest-setup.pkg', Buffer.alloc(9 * 1024 * 1024, 5));
put('Download/Mod list.txt', 'Beat Saber — 12 mods\nBMBF 1.1.1\n');
put('Download/README.md', '# What is on this headset\n\nMostly captures and sideloaded builds.\n');
put('Download/Archive.zip', Buffer.alloc(2_400_000, 6));
put('Movies/QuestCapture-1120.mp4', Buffer.alloc(310 * 1024 * 1024, 7));
put('Movies/RecRoom-clip.mp4', Buffer.alloc(44 * 1024 * 1024, 8));
put('Movies/Tutorial.mp4', Buffer.alloc(120 * 1024 * 1024, 9));
put('Music/Podcast-44.mp3', Buffer.alloc(12 * 1024 * 1024, 10));
put('Android/data/com.beatgames.beatsaber/files/mods/README.txt', 'mods live here\n');
put('Oculus/Android/com.example.demo.apk', Buffer.alloc(1024, 1));
put('Documents/notes.json', '{"ok":true}\n');
put('.nomedia', '');
put('Download/Mods/BMBF.apk', Buffer.alloc(2048, 2));
put('Download/Mods/CoreMods.zip', Buffer.alloc(4096, 3));

const old = new Date('2024-03-04T09:12:00');
fs.utimesSync(path.join(sd, 'Music/Podcast-44.mp3'), old, old);

console.log(`Seeded ${sd}`);
