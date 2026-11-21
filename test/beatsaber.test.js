'use strict';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { section, test, equal, ok, includes } = require('./harness');
const beatsaber = require('../src/main/beatsaber');
const { makeZip } = require('./zip-fixtures');

const INFO = JSON.stringify({
  _songName: 'Lone Digger',
  _songAuthorName: 'Caravan Palace',
  _levelAuthorName: 'MajorPickle',
  _beatsPerMinute: 124,
  _songFilename: 'song.egg',
  _difficultyBeatmapSets: [
    {
      _beatmapCharacteristicName: 'Standard',
      _difficultyBeatmaps: [{ _difficulty: 'ExpertPlus' }, { _difficulty: 'Expert' }],
    },
    {
      _beatmapCharacteristicName: 'OneSaber',
      _difficultyBeatmaps: [{ _difficulty: 'Expert' }],
    },
  ],
});

async function withSong(files, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'questdock-songtest-'));
  const file = path.join(dir, 'song.zip');
  await fsp.writeFile(file, makeZip(files));
  try {
    return await fn(file, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

section('beat saber');

test('reads song metadata and difficulties from info.dat', async () => {
  await withSong(
    [
      { name: 'Lone Digger/info.dat', data: INFO },
      { name: 'Lone Digger/ExpertPlusStandard.dat', data: '{}' },
      { name: 'Lone Digger/song.egg', data: 'audio' },
    ],
    async (file) => {
      const song = await beatsaber.inspectSong(file);
      ok(song, 'recognised as a song');
      equal(song.songName, 'Lone Digger');
      equal(song.songAuthor, 'Caravan Palace');
      equal(song.mapper, 'MajorPickle');
      equal(song.bpm, 124);
      equal(song.folderName, 'Lone Digger (MajorPickle)');
      equal(song.difficulties.length, 3);
      equal(song.difficulties[0], { characteristic: 'Standard', difficulty: 'ExpertPlus' });
      equal(song.hasAudio, true);
    }
  );
});

test('extracts a wrapped song below a safe folder name', async () => {
  await withSong(
    [
      { name: 'Wrapper/info.dat', data: INFO },
      { name: 'Wrapper/Expert.dat', data: '{}' },
      { name: 'Wrapper/song.egg', data: 'audio' },
    ],
    async (file, dir) => {
      const out = path.join(dir, 'songs');
      const result = await beatsaber.extractSong(file, out, { folderName: 'Lone Digger (MajorPickle)' });
      equal(result.files.length, 3);
      equal(
        await fsp.readFile(path.join(out, 'Lone Digger (MajorPickle)', 'info.dat'), 'utf8'),
        INFO
      );
      ok(
        await fsp.stat(path.join(out, 'Lone Digger (MajorPickle)', 'song.egg')).then(() => true),
        'audio extracted'
      );
    }
  );
});

test('a flat song zip still lands in its own folder', async () => {
  await withSong(
    [
      { name: 'info.dat', data: INFO },
      { name: 'song.egg', data: 'audio' },
    ],
    async (file, dir) => {
      const result = await beatsaber.extractSong(file, path.join(dir, 'songs'), {
        folderName: 'Flat Song',
      });
      ok(await fsp.stat(path.join(result.dir, 'info.dat')).then(() => true), 'info.dat present');
    }
  );
});

test('returns null for an archive that is not a song', async () => {
  await withSong([{ name: 'readme.txt', data: 'hello' }], async (file) => {
    equal(await beatsaber.inspectSong(file), null);
  });
});

test('supports v4 song/audio metadata', async () => {
  await withSong(
    [
      {
        name: 'Modern/info.dat',
        data: JSON.stringify({
          song: { title: 'Modern Song', author: 'Someone', mapper: 'Mapper X' },
          audio: { bpm: 150, songFilename: 'song.ogg' },
          difficulties: [{ difficulty: 'Expert' }],
        }),
      },
      { name: 'Modern/song.ogg', data: 'audio' },
    ],
    async (file) => {
      const song = await beatsaber.inspectSong(file);
      equal(song.songName, 'Modern Song');
      equal(song.mapper, 'Mapper X');
      equal(song.bpm, 150);
      equal(song.hasAudio, true);
      equal(song.difficulties.length, 1);
    }
  );
});

test('folder names lose path characters and trailing dots', () => {
  equal(beatsaber.safeFolderName('A/B\\C:D*E?F"G<H>I|J'), 'ABCDEFGHIJ');
  equal(beatsaber.safeFolderName('  Name...  '), 'Name');
  equal(beatsaber.safeFolderName(''), 'Imported song');
  equal(beatsaber.folderNameFor({ songName: 'Song', mapper: 'M' }), 'Song (M)');
  equal(beatsaber.folderNameFor({ songName: 'Song', mapper: '' }), 'Song');
});

test('uniqueName avoids an existing folder and increments', () => {
  const existing = new Set(['Song', 'Song (2)']);
  equal(beatsaber.uniqueName('Song', existing), 'Song (3)');
  equal(beatsaber.uniqueName('Other', existing), 'Other');
});

test('detectLoader prefers the configured folder, otherwise probes', async () => {
  const adb = {
    async exists(_serial, target) {
      return target === beatsaber.LOADERS[1].path;
    },
  };
  equal((await beatsaber.detectLoader(adb, 's', '')).id, 'songloader');
  const preferred = await beatsaber.detectLoader(adb, 's', '/sdcard/MySongs');
  equal(preferred.id, 'custom');
  equal(preferred.path, '/sdcard/MySongs');
});
