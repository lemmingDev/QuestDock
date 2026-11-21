'use strict';

/**
 * The only bridge between the window and the main process. Every method is a
 * thin wrapper over an IPC channel; replies of the shape `{ ok, data }` are
 * unwrapped so the renderer can use plain try/catch.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply) throw new Error('No reply from the main process.');
  if (reply.ok === false) throw new Error(reply.error || 'Something went wrong.');
  return reply.data;
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('quest', {
  app: {
    info: () => call('app:info'),
    settings: () => call('settings:get'),
    saveSettings: (patch) => call('settings:set', patch),
    pickAdb: () => call('settings:pickAdb'),
    openLocalNetworkSettings: () => call('app:openLocalNetworkSettings'),
    launchScrcpy: () => call('app:launchScrcpy'),
  },

  devices: {
    list: () => call('devices:list'),
    info: (serial, force) => call('devices:info', serial, force),
    onChanged: (callback) => subscribe('devices:changed', callback),
  },

  fs: {
    list: (serial, dirPath) => call('fs:list', serial, dirPath),
    stat: (serial, remotePath) => call('fs:stat', serial, remotePath),
    volumes: (serial) => call('fs:volumes', serial),
    mkdir: (serial, dirPath) => call('fs:mkdir', serial, dirPath),
    rename: (serial, from, to) => call('fs:rename', serial, from, to),
    remove: (serial, paths) => call('fs:delete', serial, paths),
    copyMove: (serial, paths, destDir, mode) =>
      call('fs:copyMove', serial, paths, destDir, mode),
    usage: (serial, remotePath) => call('fs:usage', serial, remotePath),
  },

  local: {
    roots: () => call('local:roots'),
    list: (dirPath) => call('local:list', dirPath),
    mkdir: (dirPath) => call('local:mkdir', dirPath),
    rename: (from, to) => call('local:rename', from, to),
    remove: (paths) => call('local:delete', paths),
    reveal: (target) => call('local:reveal', target),
  },

  transfers: {
    add: (specs) => call('transfer:add', specs),
    list: () => call('transfer:list'),
    cancel: (id) => call('transfer:cancel', id),
    retry: (id) => call('transfer:retry', id),
    clear: () => call('transfer:clear'),
    pause: () => call('transfer:pause'),
    resume: () => call('transfer:resume'),
    cancelAll: () => call('transfer:cancelAll'),
    resolveConflict: (id, action, applyToAll) =>
      call('transfer:conflict', id, action, applyToAll),
    onUpdate: (callback) => subscribe('transfer:update', callback),
    onConflict: (callback) => subscribe('transfer:conflict', callback),
  },

  preview: {
    thumb: (serial, entry) => call('preview:thumb', serial, entry),
    media: (serial, entry) => call('preview:media', serial, entry),
    stats: () => call('preview:stats'),
    clear: () => call('preview:clear'),
    onThumb: (callback) => subscribe('preview:thumb', callback),
  },

  apps: {
    list: (serial) => call('apps:list', serial),
    inspect: (localPath) => call('apps:inspect', localPath),
    install: (serial) => call('apps:install', serial),
    installPaths: (serial, files) => call('apps:installPaths', serial, files),
    uninstall: (serial, packageName) => call('apps:uninstall', serial, packageName),
  },

  archive: {
    inspect: (localPath) => call('archive:inspect', localPath),
    extract: (serial, localPath, remoteDir, options) =>
      call('archive:extract', serial, localPath, remoteDir, options),
    extractLocal: (localPath, destDir, options) =>
      call('archive:extractLocal', localPath, destDir, options),
  },

  songs: {
    loader: (serial) => call('song:loader', serial),
    import: (serial, files, options) => call('song:import', serial, files, options),
  },

  device: {
    screenshot: (serial) => call('device:screenshot', serial),
    previewSnapshot: (serial) => call('device:preview:snapshot', serial),
    startRecording: (serial, options) => call('device:record:start', serial, options),
    stopRecording: () => call('device:record:stop'),
    recordingStatus: () => call('device:record:status'),
    wake: (serial) => call('device:wake', serial),
    keepAwake: (serial, enabled) => call('device:keepAwake', serial, enabled),
    startStream: (serial, options) => call('device:stream:start', serial, options),
    stopStream: () => call('device:stream:stop'),
    onStreamData: (callback) => subscribe('device:stream:data', callback),
    onStreamEnd: (callback) => subscribe('device:stream:end', callback),
  },

  net: {
    connect: (hostPort) => call('net:connect', hostPort),
    pair: (hostPort, code) => call('net:pair', hostPort, code),
    disconnect: (hostPort) => call('net:disconnect', hostPort),
    discover: () => call('net:discover'),
    enable: (serial) => call('net:enable', serial),
    reconnect: () => call('net:reconnect'),
    state: () => call('net:state'),
    forget: () => call('net:forget'),
    onWireless: (callback) => subscribe('devices:wireless', callback),
  },

  dialog: {
    files: (options) => call('dialog:files', options),
    folder: (options) => call('dialog:folder', options),
    save: (options) => call('dialog:save', options),
  },

  shell: {
    reveal: (target) => call('shell:reveal', target),
    open: (target) => call('shell:open', target),
  },

  ui: {
    on: (name, callback) => subscribe(`ui:${name}`, callback),
  },

  /** Real path of a dropped File, which the renderer cannot read itself. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
