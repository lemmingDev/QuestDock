/**
 * Path, quoting and display helpers shared by the main process and the UI.
 *
 * Remote paths are POSIX paths on the headset ("/sdcard/Download"). Local
 * paths are whatever the host OS uses. Keeping the two apart matters: a
 * Windows backslash must never reach the device shell as an escape.
 *
 * Loads as CommonJS in Node and as a plain <script> in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PathUtil = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Normalise a POSIX absolute path: no trailing slash, no "." or "..". */
  function normalizePosix(input) {
    const raw = String(input == null ? '' : input).replace(/\\/g, '/');
    const absolute = raw.startsWith('/');
    const parts = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length) parts.pop();
        continue;
      }
      parts.push(part);
    }
    const joined = parts.join('/');
    if (!absolute) return joined || '.';
    return joined ? `/${joined}` : '/';
  }

  function joinPosix(...parts) {
    const cleaned = parts.filter((part) => part != null && String(part) !== '');
    if (cleaned.length === 0) return '.';
    const joined = cleaned
      .map((part, index) =>
        index === 0 ? String(part) : String(part).replace(/^\/+/, '')
      )
      .join('/');
    return normalizePosix(joined);
  }

  function parentPosix(input) {
    const path = normalizePosix(input);
    if (path === '/' || !path.includes('/')) return '/';
    const cut = path.slice(0, path.lastIndexOf('/'));
    return cut || '/';
  }

  function baseName(input) {
    const path = String(input == null ? '' : input).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path) return '';
    const cut = path.lastIndexOf('/');
    return cut === -1 ? path : path.slice(cut + 1);
  }

  function extension(input) {
    const name = baseName(input);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function stripExtension(input) {
    const name = baseName(input);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  /** True when `target` is `root` itself or sits below it. */
  function isInside(root, target) {
    const a = normalizePosix(root);
    const b = normalizePosix(target);
    return a === b || b.startsWith(a === '/' ? '/' : `${a}/`);
  }

  /**
   * Quote one value for the headset's shell (mksh). Single quotes stop every
   * expansion; an embedded quote is closed, escaped and reopened.
   */
  function shellQuote(value) {
    const text = String(value == null ? '' : value);
    if (text === '') return "''";
    return `'${text.replace(/'/g, `'\\''`)}'`;
  }

  const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif']);
  const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', '3gp', 'ts', 'mts']);
  const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma']);
  const APK_EXT = new Set(['apk', 'apks', 'xapk']);
  const ARCHIVE_EXT = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz']);
  const TEXT_EXT = new Set(['txt', 'md', 'json', 'xml', 'log', 'csv', 'ini', 'yaml', 'yml']);

  /** Broad file kind used to pick an icon and decide what can be previewed. */
  function kindForName(name, isDir, isSymlink) {
    if (isSymlink) return 'symlink';
    if (isDir) return 'folder';
    const ext = extension(name);
    if (IMAGE_EXT.has(ext)) return 'image';
    if (VIDEO_EXT.has(ext)) return 'video';
    if (AUDIO_EXT.has(ext)) return 'audio';
    if (APK_EXT.has(ext)) return 'apk';
    if (ARCHIVE_EXT.has(ext)) return 'archive';
    if (TEXT_EXT.has(ext)) return 'text';
    return 'file';
  }

  function formatBytes(bytes, options = {}) {
    if (bytes == null || bytes === '') return '—';
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    const decimals = options.decimals == null ? 1 : options.decimals;
    if (value < 1000) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1000;
    let unit = 0;
    while (size >= 1000 && unit < units.length - 1) {
      size /= 1000;
      unit += 1;
    }
    return `${size.toFixed(size >= 100 || decimals === 0 ? 0 : decimals)} ${units[unit]}`;
  }

  /** Countdown-style duration for queue items: 12 s, 1:04, 1:02:03. */
  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
    return `${s} s`;
  }

  /** 2026-11-19 13:44, or an em dash when the device gave us nothing useful. */
  function formatStamp(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  }

  /** "Quest 3" and "quest_3" both become "Quest 3". */
  function prettyModel(model) {
    const text = String(model || '').replace(/_/g, ' ').trim();
    if (!text) return 'Quest';
    return text
      .split(/\s+/)
      .map((word) =>
        /^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word
      )
      .join(' ');
  }

  /* ------------------------------------------------------------------ *
   *  Local (host) paths
   *
   *  The renderer cannot call Node's path module, and the rules differ from
   *  POSIX: a Windows drive and a UNC share are roots, and a UNC path starts
   *  with two backslashes that are part of the root, not an empty segment.
   * ------------------------------------------------------------------ */

  function isDriveRoot(value) {
    return /^[A-Za-z]:$/.test(value);
  }

  function isUncServer(value) {
    return /^[\\/]{2}[^\\/]+$/.test(value);
  }

  function separatorFor(input) {
    return String(input).includes('\\') ? '\\' : '/';
  }

  function parentLocal(input) {
    const raw = String(input);
    const clean = raw.replace(/[\\/]+$/, '');
    if (!clean || isDriveRoot(clean) || isUncServer(clean)) return raw;
    const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    if (cut < 0) return clean;
    const base = clean.slice(0, cut);
    if (base === '') return clean[0] === '\\' ? '\\' : '/';
    return isDriveRoot(base) ? `${base}\\` : base;
  }

  function baseNameLocal(input) {
    const clean = String(input).replace(/[\\/]+$/, '');
    const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return cut === -1 ? clean : clean.slice(cut + 1);
  }

  function joinLocal(dir, name) {
    const sep = separatorFor(dir);
    return String(dir).endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  /** Breadcrumb segments for a host path, root first. */
  function localCrumbs(input) {
    const parts = [];
    let current = String(input);
    for (let guard = 0; guard < 64; guard += 1) {
      const trimmed = current.replace(/[\\/]+$/, '');
      let label;
      if (current === '/') label = '/';
      else if (isDriveRoot(trimmed)) label = `${trimmed}\\`;
      else if (isUncServer(trimmed)) label = trimmed.replace(/\//g, '\\');
      else label = baseNameLocal(current) || current;

      parts.unshift({ label, path: current });
      const parent = parentLocal(current);
      if (parent === current) break;
      current = parent;
    }
    return parts;
  }

  return {
    normalizePosix,
    joinPosix,
    parentPosix,
    baseName,
    extension,
    stripExtension,
    isInside,
    shellQuote,
    kindForName,
    formatBytes,
    formatDuration,
    formatStamp,
    prettyModel,
    parentLocal,
    baseNameLocal,
    joinLocal,
    localCrumbs,
  };
});
