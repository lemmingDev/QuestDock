'use strict';

/**
 * Local preview cache.
 *
 * Thumbnails are pulled from the headset, shrunk with Electron's nativeImage
 * and stored as small JPEGs, because a 12 MP screenshot is a terrible thing to
 * send down a USB cable just to draw a 96 px tile. Full-size previews and
 * videos are pulled at most once and served from a size-capped LRU folder.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const adb = require('./adb');
const P = require('../shared/paths');

const THUMB_WIDTH = 320;
const THUMB_BUDGET = 96 * 1024 * 1024; // 96 MB of thumbnails
const PREVIEW_BUDGET = 3 * 1024 * 1024 * 1024; // 3 GB of cached originals
const PREVIEW_MAX_BYTES = 400 * 1024 * 1024; // refuse to cache bigger media

function keyFor(parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

/** Lazy require so unit tests never need Electron. */
function nativeImage() {
  return require('electron').nativeImage;
}

async function dirSize(dir) {
  let total = 0;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const stats = await fsp.stat(path.join(dir, name));
      total += stats.isDirectory() ? await dirSize(path.join(dir, name)) : stats.size;
    } catch {
      /* vanished mid-walk */
    }
  }
  return total;
}

/** Delete least-recently-used files until the folder fits its budget. */
async function prune(dir, budget) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stats = await fsp.stat(full);
      if (!stats.isFile()) continue;
      files.push({ full, size: stats.size, used: stats.atimeMs || stats.mtimeMs });
      total += stats.size;
    } catch {
      /* skip */
    }
  }
  if (total <= budget) return 0;

  files.sort((a, b) => a.used - b.used);
  let freed = 0;
  for (const file of files) {
    if (total - freed <= budget) break;
    try {
      await fsp.rm(file.full, { force: true });
      freed += file.size;
    } catch {
      /* skip */
    }
  }
  return freed;
}

class PreviewCache {
  /**
   * @param {object} options
   * @param {string} options.root        folder for every cached file
   * @param {number} [options.thumbWidth]
   */
  constructor({ root, thumbWidth = THUMB_WIDTH }) {
    this.root = root;
    this.thumbs = path.join(root, 'thumbs');
    this.media = path.join(root, 'media');
    this.thumbWidth = thumbWidth;
    this.inflight = new Map();
    this.bytesPulled = 0;
  }

  async ready() {
    await fsp.mkdir(this.thumbs, { recursive: true });
    await fsp.mkdir(this.media, { recursive: true });
    return this;
  }

  /** Cache key: serial + path + size + mtime, so edits invalidate it. */
  keyFor(entry) {
    return keyFor([
      entry.serial || '',
      entry.path,
      String(entry.size == null ? '' : entry.size),
      String(entry.mtime == null ? '' : entry.mtime),
    ]);
  }

  /** Where a thumbnail would live, without doing any work. */
  thumbPathFor(entry) {
    return path.join(this.thumbs, `${this.keyFor(entry)}.jpg`);
  }

  /**
   * Pull once per key even when the grid asks for the same tile twice.
   * `produce(dest)` writes the cached file and resolves its size.
   */
  _once(key, produce) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = produce().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * A small JPEG for the file grid. Resolves to an absolute path, or null when
   * the format cannot be decoded by Chromium.
   */
  async thumbnail(serial, entry) {
    if (!entry || entry.kind !== 'image') return null;
    if (entry.size != null && entry.size > 64 * 1024 * 1024) return null;
    const key = this.keyFor({ ...entry, serial });
    const dest = path.join(this.thumbs, `${key}.jpg`);
    if (await this._fresh(dest)) return dest;

    return this._once(`t:${key}`, async () => {
      const temp = path.join(this.thumbs, `${key}.src`);
      try {
        await this._pull(serial, entry.path, temp);
        const image = nativeImage().createFromPath(temp);
        if (image.isEmpty()) return null;
        const width = Math.min(this.thumbWidth, image.getSize().width || this.thumbWidth);
        const resized = image.resize({ width, quality: 'good' });
        await fsp.writeFile(dest, resized.toJPEG(82));
        return dest;
      } catch {
        return null;
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => {});
        if (Math.random() < 0.05) prune(this.thumbs, THUMB_BUDGET).catch(() => {});
      }
    });
  }

  /** Full image, for the preview pane. */
  async image(serial, entry) {
    const key = this.keyFor({ ...entry, serial });
    return this._once(`i:${key}`, async () => {
      const ext = P.extension(entry.path) || 'jpg';
      const dest = path.join(this.media, `${key}.${ext}`);
      if (await this._fresh(dest)) return dest;
      await this._pull(serial, entry.path, dest);
      await prune(this.media, PREVIEW_BUDGET).catch(() => {});
      return dest;
    });
  }

  /**
   * Pull a video for playback. Returns null when it is too large to cache.
   * The caller gets a path it can hand to a <video> element.
   */
  async video(serial, entry) {
    const size = entry.size == null ? await adb.statSize(serial, entry.path) : entry.size;
    if (size != null && size > PREVIEW_MAX_BYTES) return null;

    const key = this.keyFor({ ...entry, serial });
    return this._once(`v:${key}`, async () => {
      const ext = P.extension(entry.path) || 'mp4';
      const dest = path.join(this.media, `${key}.${ext}`);
      if (await this._fresh(dest)) return dest;
      await this._pull(serial, entry.path, dest, PREVIEW_MAX_BYTES);
      await prune(this.media, PREVIEW_BUDGET).catch(() => {});
      return dest;
    });
  }

  /** Stream a file out of the cache; used by the audio player too. */
  async anyFile(serial, entry) {
    const key = this.keyFor({ ...entry, serial });
    const ext = P.extension(entry.path) || 'bin';
    return this._once(`a:${key}`, async () => {
      const dest = path.join(this.media, `${key}.${ext}`);
      if (await this._fresh(dest)) return dest;
      await this._pull(serial, entry.path, dest, PREVIEW_MAX_BYTES);
      return dest;
    });
  }

  async _fresh(file) {
    try {
      const stats = await fsp.stat(file);
      if (stats.size === 0) {
        await fsp.rm(file, { force: true });
        return null;
      }
      const now = new Date();
      await fsp.utimes(file, now, stats.mtime).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** adb pull into `dest`, through a temp file so a failure leaves nothing. */
  _pull(serial, remotePath, dest, maxBytes) {
    return new Promise((resolve, reject) => {
      const temp = `${dest}.part-${process.pid}`;
      const child = adb.spawnAdb([...(serial ? ['-s', serial] : []), 'pull', remotePath, temp]);
      let stderr = '';
      let killed = false;

      const cleanup = () => {
        fsp.rm(temp, { force: true }).catch(() => {});
      };

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        cleanup();
        reject(new Error(adb.describeError(error)));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          cleanup();
          reject(new Error(adb.describeError({ stderr })));
          return;
        }
        const finish = async () => {
          try {
            const stats = await fsp.stat(temp);
            if (maxBytes && stats.size > maxBytes) {
              await fsp.rm(temp, { force: true });
              throw new Error('That file is too large to preview.');
            }
            this.bytesPulled += stats.size;
            await fsp.rename(temp, dest);
            resolve(dest);
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        finish();
      });

      if (maxBytes) {
        // Cheap guard: abort huge files early when the size is already known.
        setTimeout(() => {
          if (killed) return;
          fsp
            .stat(temp)
            .then((stats) => {
              if (stats.size > maxBytes) {
                killed = true;
                child.kill('SIGTERM');
                cleanup();
                reject(new Error('That file is too large to preview.'));
              }
            })
            .catch(() => {});
        }, 4000).unref?.();
      }
    });
  }

  async stats() {
    const thumbs = await dirSize(this.thumbs);
    const media = await dirSize(this.media);
    return { thumbs, media, total: thumbs + media };
  }

  async clear() {
    await fsp.rm(this.thumbs, { recursive: true, force: true });
    await fsp.rm(this.media, { recursive: true, force: true });
    await fsp.mkdir(this.thumbs, { recursive: true });
    await fsp.mkdir(this.media, { recursive: true });
    this.bytesPulled = 0;
  }
}

module.exports = { PreviewCache, prune, dirSize, THUMB_BUDGET, PREVIEW_BUDGET };
