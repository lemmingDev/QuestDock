'use strict';

/**
 * Beat Saber custom-song helpers.
 *
 * A song is a folder with `info.dat` plus one difficulty file per map and an
 * audio file. Song zips usually wrap all of that in one folder, so importing
 * means: read the metadata, strip the wrapper, give the folder a safe name,
 * and push it into whichever loader the headset actually has.
 */

const fsp = require('fs/promises');
const path = require('path');

const zip = require('./zip');

/**
 * Custom-level folders, most common first. SongCore is what modern modded
 * installs use; BMBF is the older standalone loader; the rest are fallbacks.
 */
const LOADERS = [
  {
    id: 'songcore',
    name: 'SongCore / MBF',
    path: '/sdcard/ModData/com.beatgames.beatsaber/Mods/SongCore/CustomLevels',
  },
  {
    id: 'songloader',
    name: 'SongLoader',
    path: '/sdcard/ModData/com.beatgames.beatsaber/Mods/SongLoader/CustomLevels',
  },
  { id: 'bmbf', name: 'BMBF', path: '/sdcard/BMBFData/CustomSongs' },
  { id: 'customlevels', name: 'CustomLevels', path: '/sdcard/CustomLevels' },
];

const AUDIO_EXT = new Set(['egg', 'ogg', 'wav', 'mp3']);

function cleanKey(key) {
  return String(key || '')
    .replace(/^_/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/** Case-insensitive field lookup, because map formats disagree on casing. */
function field(object, names) {
  if (!object || typeof object !== 'object') return '';
  const wanted = new Set(names.map(cleanKey));
  for (const [key, value] of Object.entries(object)) {
    if (wanted.has(cleanKey(key)) && value != null && typeof value !== 'object') {
      return value;
    }
  }
  return '';
}

function findInfoEntry(entries) {
  const candidates = entries.filter(
    (entry) => !entry.isDirectory && /(^|\/)info\.dat$/i.test(entry.name)
  );
  // Prefer the shallowest info.dat so a zip with a wrapper folder wins over
  // an unrelated nested example.
  candidates.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  return candidates[0] || null;
}

function findAudioEntry(entries, fileName) {
  const audio = entries.find(
    (entry) => !entry.isDirectory && AUDIO_EXT.has(extensionOf(entry.name))
  );
  if (audio) return audio;
  if (!fileName) return null;
  const wanted = String(fileName).toLowerCase();
  return (
    entries.find((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(wanted)) ||
    null
  );
}

function extensionOf(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function normalizeInfo(json) {
  if (!json || typeof json !== 'object') return null;
  // v2/v3 maps keep fields at the top level with leading underscores; v4 maps
  // group them under song/audio.
  const song = json.song && typeof json.song === 'object' ? json.song : {};
  const audio = json.audio && typeof json.audio === 'object' ? json.audio : {};
  const info = {
    songName:
      String(field(song, ['title']) || field(json, ['songName', 'songname', 'title'])) || '',
    songAuthor:
      String(field(song, ['author']) || field(json, ['songAuthorName', 'songauthor'])) || '',
    mapper:
      String(
        field(song, ['mapper']) ||
          field(json, ['levelAuthorName', 'levelauthor', 'mapper', 'mapAuthor'])
      ) || '',
    bpm: Number(field(audio, ['bpm']) || field(json, ['beatsPerMinute', 'bpm'])) || 0,
    duration: Number(field(audio, ['songDuration', 'duration']) || field(json, ['songDuration'])) || 0,
    audioFile: String(
      field(audio, ['songFilename', 'audioFilename']) ||
        field(json, ['songFilename', 'audioFilename'])
    ) || '',
    difficulties: [],
  };

  const sets = Array.isArray(json._difficultyBeatmapSets)
    ? json._difficultyBeatmapSets
    : Array.isArray(json.difficultyBeatmapSets)
      ? json.difficultyBeatmapSets
      : [];
  for (const set of sets) {
    const characteristic = String(field(set, ['beatmapCharacteristicName', 'characteristic']) || '');
    const maps = Array.isArray(set._difficultyBeatmaps)
      ? set._difficultyBeatmaps
      : Array.isArray(set.difficultyBeatmaps)
        ? set.difficultyBeatmaps
        : [];
    for (const map of maps) {
      const difficulty = String(field(map, ['difficulty', 'difficultyLabel']) || '');
      if (difficulty) info.difficulties.push({ characteristic, difficulty });
    }
  }
  if (!info.difficulties.length && Array.isArray(json.difficulties)) {
    for (const map of json.difficulties) {
      const difficulty = String(field(map, ['difficulty', 'difficultyLabel']) || '');
      if (difficulty) info.difficulties.push({ characteristic: '', difficulty });
    }
  }

  return info;
}

/** Read `info.dat` from an already-open archive. */
async function readInfo(archive) {
  const entries = archive.entries;
  const infoEntry = findInfoEntry(entries);
  if (!infoEntry) return null;
  let json;
  try {
    json = JSON.parse((await archive.read(infoEntry)).toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The song\'s info.dat is not valid JSON.');
  }
  const info = normalizeInfo(json);
  if (!info) return null;
  const audio = findAudioEntry(entries, info.audioFile);
  return {
    info,
    infoEntry: infoEntry.name,
    audioEntry: audio ? audio.name : '',
    hasAudio: Boolean(audio),
  };
}

/** Strip characters that break paths on any host or the headset shell. */
function safeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, 100);
  return cleaned || 'Imported song';
}

/** `Song Name (Mapper)` is the convention SongCore and BeatSaver use. */
function folderNameFor(info, fallback) {
  const title = String(info && info.songName ? info.songName : fallback || '').trim();
  const mapper = String(info && info.mapper ? info.mapper : '').trim();
  if (title && mapper) return safeFolderName(`${title} (${mapper})`);
  return safeFolderName(title || fallback);
}

/** Append ` (2)`, ` (3)` until the name is free, using a Set of existing names. */
function uniqueName(desired, existing) {
  const taken = existing instanceof Set ? existing : new Set(existing || []);
  if (!taken.has(desired)) return desired;
  for (let index = 2; index < 500; index += 1) {
    const candidate = safeFolderName(`${desired} (${index})`);
    if (!taken.has(candidate)) return candidate;
  }
  return safeFolderName(`${desired} ${Date.now()}`);
}

/**
 * Inspect a ZIP without extracting it.
 * @returns {Promise<object|null>} null when the archive is not a Beat Saber song
 */
async function inspectSong(file) {
  const archive = await zip.openZip(file);
  try {
    const found = await readInfo(archive);
    if (!found) return null;
    const files = archive.entries.filter((entry) => !entry.isDirectory);
    return {
      file,
      isSong: true,
      ...found.info,
      infoEntry: found.infoEntry,
      audioEntry: found.audioEntry,
      hasAudio: found.hasAudio,
      folderName: folderNameFor(found.info, path.basename(file, path.extname(file))),
      fileCount: files.length,
      bytes: files.reduce((total, entry) => total + entry.size, 0),
    };
  } finally {
    await archive.close();
  }
}

/**
 * Extract one song below `destination/songName`, stripping the wrapper folder.
 * Returns `{ dir, info, hasAudio }`.
 */
async function extractSong(file, destination, options = {}) {
  const archive = await zip.openZip(file);
  try {
    const found = await readInfo(archive);
    if (!found) throw new Error('That ZIP does not contain a Beat Saber info.dat.');
    const name =
      options.folderName ||
      folderNameFor(found.info, path.basename(file, path.extname(file)));
    const dir = path.join(destination, name);
    await fsp.mkdir(dir, { recursive: true });
    const result = await zip.extractZip(archive, dir, {
      stripRoot: options.stripRoot !== false,
      skipDotfiles: true,
    });
    return {
      dir,
      root: result.root,
      files: result.files,
      info: found.info,
      hasAudio: found.hasAudio,
    };
  } finally {
    await archive.close();
  }
}

/**
 * Find the custom-level folder on the headset. An explicitly configured path
 * wins, then the known loader locations in order of popularity.
 */
async function detectLoader(adb, serial, preferred) {
  if (preferred) return { id: 'custom', name: 'Custom folder', path: preferred };
  for (const loader of LOADERS) {
    try {
      if (await adb.exists(serial, loader.path)) return loader;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Folder names already present in a remote directory, for de-duplication. */
async function existingNames(adb, serial, dir) {
  try {
    const listing = await adb.listDir(serial, dir);
    return new Set(listing.entries.map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

module.exports = {
  LOADERS,
  inspectSong,
  extractSong,
  detectLoader,
  existingNames,
  folderNameFor,
  safeFolderName,
  uniqueName,
  normalizeInfo,
  readInfo,
  findInfoEntry,
};
