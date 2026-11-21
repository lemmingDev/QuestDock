'use strict';

/**
 * Settings that survive restarts, kept in one small JSON file. Unknown keys
 * are preserved so an older build never wipes a newer one's preferences.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULTS = {
  adbPath: '',
  localDir: '',
  remoteDir: '/sdcard',
  allowAnywhere: false,
  showHidden: true,
  thumbnails: true,
  keepAwake: true,
  lastSerial: '',
  remoteHistory: [],
  wirelessHost: '',
  wirelessSerial: '',
  wirelessAutoReconnect: true,
  autoEnableWireless: true,
  beatsaberPath: '',
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this._timer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      /* first run, or a file we cannot read: start from defaults */
    }
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  set(patch) {
    if (!patch || typeof patch !== 'object') return this.all();
    this.data = { ...this.data, ...patch };
    this._schedule();
    return this.all();
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, 250);
  }

  async flush() {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
      await fsp.rename(temp, this.file);
    } catch {
      /* losing a preference is not worth crashing over */
    }
  }

  async flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this.flush();
  }
}

module.exports = { Store, DEFAULTS };
