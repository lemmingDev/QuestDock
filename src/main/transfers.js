'use strict';

/**
 * The transfer queue: one job runs at a time over USB, because two adb
 * transfers on the same link mostly compete for the same bandwidth.
 *
 * Every job is a push or a pull. Both write to a temporary name inside the
 * destination folder and rename afterwards, so a cancelled or failed job
 * never leaves a half file where the user expects a whole one.
 */

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const { EventEmitter } = require('events');

const adb = require('./adb');
const P = require('../shared/paths');

const POLL_MS = 1000;
const KILL_GRACE_MS = 2000;

let counter = 0;
function nextId() {
  counter += 1;
  return `job-${counter}`;
}

/** Recursive local size; symlinks are counted, not followed. */
async function localSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let stats;
    try {
      stats = await fsp.lstat(current);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      let names = [];
      try {
        names = await fsp.readdir(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      total += stats.size;
    }
  }
  return total;
}

/** `name (1).ext`, `name (2).ext`, ... using the first free name. */
function bumpName(name, isDir, index) {
  if (index === 0) return name;
  if (isDir) return `${name} (${index})`;
  const ext = P.extension(name);
  if (!ext) return `${name} (${index})`;
  return `${P.stripExtension(name)} (${index}).${ext}`;
}

function remoteJoin(dir, name) {
  return P.joinPosix(dir, name);
}

class TransferQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.running = null;
    this.paused = false;
    this._wake = null;
    this._loop = null;
    this._emitTimer = null;
    this._pendingConflict = null;
  }

  /* ---------------- public API ---------------- */

  /**
   * Queue a transfer.
   *
   * @param {object} spec
   * @param {'push'|'pull'} spec.direction
   * @param {string} spec.serial
   * @param {string} spec.localPath   absolute source/destination on this computer
   * @param {string} spec.remotePath  absolute source/destination on the headset
   * @param {boolean} spec.isDir
   * @param {number} [spec.totalBytes] known size, else measured
   * @param {'ask'|'overwrite'|'rename'|'skip'} [spec.conflict]
   * @param {string} [spec.label]     name shown in the UI
   */
  add(spec) {
    const name = spec.label || P.baseName(spec.direction === 'push' ? spec.localPath : spec.remotePath);
    const job = {
      id: nextId(),
      direction: spec.direction,
      serial: spec.serial,
      localPath: spec.localPath,
      remotePath: spec.remotePath,
      sourcePath: spec.direction === 'push' ? spec.localPath : spec.remotePath,
      isDir: Boolean(spec.isDir),
      name,
      totalBytes: Number.isFinite(spec.totalBytes) ? spec.totalBytes : null,
      bytesDone: 0,
      percent: 0,
      speed: 0,
      eta: null,
      state: 'queued',
      error: '',
      conflict: spec.conflict || 'ask',
      cleanupPath: spec.cleanupPath || '',
      startedAt: null,
      finishedAt: null,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this._emit();
    this._kick();
    return job.id;
  }

  pause() {
    this.paused = true;
    this._emit();
  }

  resume() {
    this.paused = false;
    this._emit();
    this._kick();
  }

  cancel(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return false;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      this._emit();
      return true;
    }
    if (job.id === this.running) {
      job.cancelRequested = true;
      this._killActive();
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const job of this.jobs) {
      if (job.state === 'queued' || job.state === 'running') this.cancel(job.id);
    }
  }

  retry(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return false;
    if (job.state !== 'failed' && job.state !== 'cancelled') return false;
    job.state = 'queued';
    job.error = '';
    job.bytesDone = 0;
    job.percent = 0;
    job.speed = 0;
    job.eta = null;
    job.finishedAt = null;
    job.startedAt = null;
    job.cancelRequested = false;
    // A retry after a conflict should ask again, not silently overwrite.
    job.conflict = 'ask';
    this._emit();
    this._kick();
    return true;
  }

  clearFinished() {
    this.jobs = this.jobs.filter(
      (job) => job.state === 'queued' || job.state === 'running'
    );
    this._emit();
  }

  /** Reply to a `conflict` event. `action` is overwrite | rename | skip | cancel. */
  resolveConflict(jobId, action, applyToAll = false) {
    const pending = this._pendingConflict;
    if (!pending || pending.job.id !== jobId) return false;
    this._pendingConflict = null;
    if (applyToAll) {
      this._conflictPolicy = action;
    }
    pending.resolve(action);
    this._emit();
    return true;
  }

  snapshot() {
    return {
      paused: this.paused,
      runningId: this.running,
      active: this.jobs.filter((job) => job.state === 'running').length,
      jobs: this.jobs.map((job) => ({
        id: job.id,
        direction: job.direction,
        name: job.name,
        localPath: job.localPath,
        remotePath: job.remotePath,
        isDir: job.isDir,
        totalBytes: job.totalBytes,
        bytesDone: job.bytesDone,
        percent: job.percent,
        speed: job.speed,
        eta: job.eta,
        state: job.state,
        error: job.error,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      })),
    };
  }

  /* ---------------- internals ---------------- */

  _emit() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('update', this.snapshot());
    }, 120);
  }

  _kick() {
    if (this._loop || this.paused) return;
    this._loop = this._drain().finally(() => {
      this._loop = null;
    });
  }

  async _drain() {
    for (;;) {
      if (this.paused) return;
      const job = this.jobs.find((item) => item.state === 'queued');
      if (!job) return;
      this.running = job.id;
      job.state = 'running';
      job.startedAt = Date.now();
      this._emit();
      try {
        await this._runJob(job);
        if (job.state === 'running') {
          job.state = 'done';
          job.percent = 100;
          job.bytesDone = job.totalBytes || job.bytesDone;
          job.speed = 0;
          job.eta = 0;
        }
      } catch (error) {
        if (job.cancelRequested) {
          job.state = 'cancelled';
        } else {
          job.state = 'failed';
          job.error = error && error.message ? error.message : String(error);
        }
      } finally {
        job.finishedAt = Date.now();
        job.speed = 0;
        this.running = null;
        if (job.cleanupPath && (job.state === 'done' || job.state === 'cancelled')) {
          // Extracted archives are staged in a temp folder; once the push is
          // over it has no further use.
          fsp.rm(job.cleanupPath, { recursive: true, force: true }).catch(() => {});
          job.cleanupPath = '';
        }
        this._emit();
      }
    }
  }

  _killActive() {
    const child = this._child;
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
  }

  /**
   * Ask the UI what to do about an existing destination. Resolves to the
   * action string; a cancelled queue resolves to 'cancel'.
   */
  _askConflict(job, existsKind) {
    if (this._conflictPolicy) return Promise.resolve(this._conflictPolicy);
    const destination = job.direction === 'push' ? job.remotePath : job.localPath;
    return new Promise((resolve) => {
      this._pendingConflict = { job, existsKind, resolve };
      this.emit('conflict', {
        id: job.id,
        name: P.baseName(destination),
        direction: job.direction,
        destination,
        existsKind,
        remaining: this.jobs.filter(
          (item) => item.state === 'queued' && item.direction === job.direction
        ).length,
      });
      this._emit();
    });
  }

  /** Resolve the final destination name for a job, honouring conflicts. */
  async _resolveTarget(job) {
    if (job.direction === 'push') {
      let exists = false;
      try {
        exists = await adb.exists(job.serial, job.remotePath);
      } catch {
        exists = false;
      }
      const kind = job.isDir ? 'folder' : 'file';
      return this._pickTarget(
        job,
        exists,
        kind,
        async (candidate) => adb.exists(job.serial, candidate),
        (name) => remoteJoin(P.parentPosix(job.remotePath), name)
      );
    }

    let exists = false;
    try {
      await fsp.lstat(job.localPath);
      exists = true;
    } catch {
      exists = false;
    }
    const kind = job.isDir ? 'folder' : 'file';
    return this._pickTarget(
      job,
      exists,
      kind,
      async (candidate) => {
        try {
          await fsp.lstat(candidate);
          return true;
        } catch {
          return false;
        }
      },
      (name) => path.join(path.dirname(job.localPath), name)
    );
  }

  async _pickTarget(job, exists, kind, check, build) {
    const destination = job.direction === 'push' ? job.remotePath : job.localPath;
    if (!exists) return { target: destination, action: 'create' };

    const baseName = P.baseName(destination);
    const dirIsDir = kind === 'folder';
    let action = job.conflict;
    if (action === 'ask') action = await this._askConflict(job, kind);

    if (action === 'cancel') {
      const error = new Error('Cancelled.');
      error.cancelled = true;
      throw error;
    }
    if (action === 'skip') return { target: null, action: 'skip' };

    if (action === 'rename') {
      for (let index = 1; index < 500; index += 1) {
        const candidate = build(bumpName(baseName, dirIsDir, index));
        if (!(await check(candidate))) {
          return { target: candidate, action: 'rename' };
        }
      }
      throw new Error('Could not find a free name next to that file.');
    }

    return { target: job.direction === 'push' ? job.remotePath : job.localPath, action: 'overwrite' };
  }

  async _runJob(job) {
    job.cancelRequested = false;
    job.bytesDone = 0;
    job.percent = 0;
    job.samples = [];

    if (job.direction === 'push') await this._runPush(job);
    else await this._runPull(job);
  }

  /* ---------------- progress ---------------- */

  _progress(job) {
    const sample = { at: Date.now(), bytes: job.bytesDone };
    job.samples = (job.samples || []).concat(sample);
    if (job.samples.length > 8) job.samples.shift();

    const first = job.samples[0];
    const elapsed = (sample.at - first.at) / 1000;
    if (elapsed >= 0.4 && sample.bytes >= first.bytes) {
      const speed = (sample.bytes - first.bytes) / elapsed;
      if (Number.isFinite(speed) && speed > 0) {
        job.speed = speed;
        if (job.totalBytes) {
          job.eta = Math.max(0, (job.totalBytes - job.bytesDone) / speed);
        }
      }
    }
    if (job.totalBytes) {
      job.percent = Math.min(99.9, (job.bytesDone / job.totalBytes) * 100);
    }
    this._emit();
  }

  _setBytes(job, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (job.totalBytes && bytes > job.totalBytes) bytes = job.totalBytes;
    if (bytes <= job.bytesDone) return;
    job.bytesDone = bytes;
    this._progress(job);
  }

  /* ---------------- push ---------------- */

  async _runPush(job) {
    const resolved = await this._resolveTarget(job);
    if (resolved.action === 'skip' || !resolved.target) {
      job.skipped = true;
      job.state = 'done';
      return;
    }
    const target = resolved.target;
    if (job.cancelRequested) throw cancelledError();

    if (!job.totalBytes) {
      job.totalBytes = await localSize(job.localPath).catch(() => null);
      this._emit();
    }
    if (job.cancelRequested) throw cancelledError();

    // Pre-flight: don't start a transfer the destination can't hold.
    if (job.totalBytes) {
      const space = await adb.dfBytes(job.serial, P.parentPosix(target)).catch(() => null);
      if (space && space.freeBytes < job.totalBytes + (1 << 20)) {
        throw new Error(
          `Not enough free space on the headset (${P.formatBytes(space.freeBytes)} available, ${P.formatBytes(job.totalBytes)} needed).`
        );
      }
    }

    const parent = P.parentPosix(target);
    await adb.mkdir(job.serial, parent);

    const tempName = `.questdock-${job.id}.part`;
    const temp = remoteJoin(parent, tempName);
    await adb.remove(job.serial, temp).catch(() => {});

    job.remotePath = target;
    job.name = P.baseName(target);

    await this._spawnTransferJob(job, ['push', job.localPath, temp], async () => {
      try {
        const bytes = await adb.folderSize(job.serial, temp);
        if (bytes != null) this._setBytes(job, bytes);
      } catch {
        /* the folder may not exist yet */
      }
    }).catch(async (error) => {
      await adb.remove(job.serial, temp).catch(() => {});
      throw job.cancelRequested ? cancelledError() : error;
    });

    if (job.cancelRequested) {
      await adb.remove(job.serial, temp).catch(() => {});
      throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    }

    await this._commitPush(job, temp, target, resolved.action);
  }

  /** Swap the finished temp into place, keeping the old copy briefly. */
  async _commitPush(job, temp, target, action) {
    job.percent = 99.9;
    this._emit();
    const exists = await adb.exists(job.serial, target).catch(() => false);

    if (!exists) {
      await adb.rename(job.serial, temp, target).catch(async (error) => {
        await adb.remove(job.serial, temp).catch(() => {});
        throw error;
      });
      return;
    }

    if (action !== 'overwrite') {
      await adb.remove(job.serial, temp).catch(() => {});
      throw new Error('That name was taken while the transfer was running.');
    }

    const backup = `${target}.questdock-old`;
    await adb.remove(job.serial, backup).catch(() => {});
    await adb.rename(job.serial, target, backup);
    try {
      await adb.rename(job.serial, temp, target);
    } catch (error) {
      await adb.rename(job.serial, backup, target).catch(() => {});
      await adb.remove(job.serial, temp).catch(() => {});
      throw error;
    }
    await adb.remove(job.serial, backup).catch(() => {});
  }

  /* ---------------- pull ---------------- */

  async _runPull(job) {
    const resolved = await this._resolveTarget(job);
    if (resolved.action === 'skip' || !resolved.target) {
      job.skipped = true;
      job.state = 'done';
      return;
    }
    const target = resolved.target;
    if (job.cancelRequested) throw cancelledError();

    if (!job.totalBytes) {
      job.totalBytes = job.isDir
        ? await adb.folderSize(job.serial, job.remotePath)
        : await adb.statSize(job.serial, job.remotePath);
      this._emit();
    }
    if (job.cancelRequested) throw cancelledError();

    const parent = path.dirname(target);

    // Pre-flight: don't start a transfer this computer can't hold.
    if (job.totalBytes) {
      try {
        const stats = await fsp.statfs(parent);
        const free = Number(stats.bavail) * Number(stats.bsize);
        if (Number.isFinite(free) && free < job.totalBytes + (1 << 20)) {
          throw new Error(
            `Not enough free space on this computer (${P.formatBytes(free)} available, ${P.formatBytes(job.totalBytes)} needed).`
          );
        }
      } catch (error) {
        if (error && /Not enough free space/.test(error.message)) throw error;
      }
    }

    await fsp.mkdir(parent, { recursive: true }).catch(() => {});

    const temp = path.join(parent, `.questdock-${job.id}.part`);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});

    job.localPath = target;
    job.name = path.basename(target);

    await this._spawnTransferJob(job, ['pull', job.remotePath, temp], async () => {
      const bytes = await localSize(temp);
      if (bytes > 0) this._setBytes(job, bytes);
    }).catch(async (error) => {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw job.cancelRequested ? cancelledError() : error;
    });

    if (job.cancelRequested) {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    }

    job.percent = 99.9;
    this._emit();
    await this._commitPull(job, temp, target, resolved.action);
  }

  async _commitPull(job, temp, target, action) {
    let exists = false;
    try {
      await fsp.lstat(target);
      exists = true;
    } catch {
      exists = false;
    }

    let backup = null;
    if (exists) {
      if (action !== 'overwrite') {
        await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
        throw new Error('That name was taken while the transfer was running.');
      }
      backup = `${target}.questdock-old`;
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(target, backup);
    }

    try {
      await fsp.rename(temp, target);
    } catch (error) {
      if (backup) await fsp.rename(backup, target).catch(() => {});
      throw error;
    }
    if (backup) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }

  /* ---------------- the adb child ---------------- */

  /**
   * Run one adb push/pull, feeding percentage from its output and from a
   * poller, whichever gives the larger number.
   */
  _spawnTransferJob(job, args, poll) {
    return new Promise((resolve, reject) => {
      const child = adb.spawnAdb([...serialArgs(job.serial), ...args]);
      this._child = child;
      let stderr = '';
      let settled = false;
      let pollTimer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        this._child = null;
        if (pollTimer) clearInterval(pollTimer);
        fn(value);
      };

      const readPercent = (chunk) => {
        const text = chunk.toString('utf8');
        // New adb prints one line with \r; old adb prints [ 45%] per line.
        const matches = text.match(/\[\s*(\d{1,3})%\]/g);
        if (matches && job.totalBytes) {
          const last = matches[matches.length - 1];
          const value = Number(last.replace(/[^\d]/g, ''));
          if (Number.isFinite(value)) {
            this._setBytes(job, (value / 100) * job.totalBytes);
          }
        }
      };

      child.stdout.on('data', readPercent);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        readPercent(chunk);
      });
      child.on('error', (error) => finish(reject, new Error(adb.describeError(error))));
      child.on('close', (code) => {
        if (job.cancelRequested) {
          finish(reject, Object.assign(new Error('Cancelled.'), { cancelled: true }));
          return;
        }
        if (code === 0) {
          finish(resolve, true);
          return;
        }
        finish(reject, new Error(adb.describeError({ stderr })));
      });

      pollTimer = setInterval(() => {
        if (settled) return;
        poll().catch(() => {});
      }, POLL_MS);
      pollTimer.unref?.();
      poll().catch(() => {});
    });
  }
}

function serialArgs(serial) {
  return serial ? ['-s', serial] : [];
}

function cancelledError() {
  return Object.assign(new Error('Cancelled.'), { cancelled: true });
}

module.exports = { TransferQueue, localSize, bumpName };
