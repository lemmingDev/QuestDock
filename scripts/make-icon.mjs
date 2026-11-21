#!/usr/bin/env node
'use strict';

/**
 * Draws build/icon.png: a squircle with the two-lens mark from the toolbar.
 *
 * Everything is rendered at 4x and box-filtered down, which is the only way to
 * get clean curves without a graphics library.
 *
 *   node scripts/make-icon.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SCALE = 4;
const W = SIZE * SCALE;

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const outFile = path.join(outDir, 'icon.png');

/* ------------------------------------------------------------------ *
 *  Shape helpers, all in 0..1 coordinates
 * ------------------------------------------------------------------ */

function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const TOP = [92, 124, 255];
const BOTTOM = [158, 107, 255];

/** Paint one pixel of the icon; returns [r,g,b,a] with a in 0..255. */
function sample(x, y) {
  // Background squircle with a diagonal gradient and a soft top highlight.
  const background = insideRoundedRect(x, y, 0.03, 0.03, 0.97, 0.97, 0.235);
  if (!background) return [0, 0, 0, 0];

  const t = Math.min(1, Math.max(0, (x + y) / 2));
  let color = mix(TOP, BOTTOM, t);
  const glow = Math.max(0, 1 - Math.hypot(x - 0.32, y - 0.18) * 1.7);
  color = mix(color, [214, 224, 255], glow * 0.28);

  // Inner shadow at the bottom, so the tile has some depth.
  const shade = Math.max(0, (y - 0.55) / 0.45);
  color = mix(color, [32, 38, 74], shade * 0.18);

  // The two lenses.
  const left = insideRoundedRect(x, y, 0.165, 0.325, 0.475, 0.685, 0.095);
  const right = insideRoundedRect(x, y, 0.525, 0.325, 0.835, 0.685, 0.095);

  // Bridge between them, slightly dimmer.
  const bridge = insideRoundedRect(x, y, 0.455, 0.445, 0.545, 0.56, 0.03);
  if (bridge) color = mix(color, [236, 241, 255], 0.72);

  if (left) color = mix(color, [242, 245, 255], 0.88);
  if (right) color = mix(color, [255, 255, 255], 1);

  return [color[0], color[1], color[2], 255];
}

/* ------------------------------------------------------------------ *
 *  Render and downsample
 * ------------------------------------------------------------------ */

console.log(`Rendering ${W}x${W}…`);
const big = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y += 1) {
  const fy = (y + 0.5) / W;
  for (let x = 0; x < W; x += 1) {
    const [r, g, b, a] = sample((x + 0.5) / W, fy);
    const offset = (y * W + x) * 4;
    big[offset] = r;
    big[offset + 1] = g;
    big[offset + 2] = b;
    big[offset + 3] = a;
  }
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const offset = ((y * SCALE + sy) * W + (x * SCALE + sx)) * 4;
        r += big[offset];
        g += big[offset + 1];
        b += big[offset + 2];
        a += big[offset + 3];
      }
    }
    const n = SCALE * SCALE;
    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(r / n);
    pixels[offset + 1] = Math.round(g / n);
    pixels[offset + 2] = Math.round(b / n);
    pixels[offset + 3] = Math.round(a / n);
  }
}

/* ------------------------------------------------------------------ *
 *  PNG encoding
 * ------------------------------------------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6; // RGBA

const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  rows[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, png);
console.log(`Wrote ${path.relative(process.cwd(), outFile)} (${(png.length / 1024).toFixed(0)} KB)`);
