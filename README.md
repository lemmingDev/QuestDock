# QuestDock

**QuestDock** is a cross‑platform desktop file browser for **Meta Quest 2/3** that transfers
files and folders over ADB (wired or wireless), runs **Beat Saber song imports**, installs
**split‑APKs**, and gives you a wireless‑ADB picker with auto‑reconnect.

It runs on **macOS, Windows and Linux** (universal binary, no native modules).

## What it does

- **Two‑pane browser**: "This computer" and "Headset" — browse, search, copy/move within a
  pane, drag between panes.
- **Transfers**: queue with progress, cancel, retry; conflict handling (overwrite/rename/skip);
  `.questdock-*.part` → rename on commit; one USB transfer at a time.
- **Headset actions**: screenshots, screen recording (video + audio), keep‑awake, wake.
- **File previews**: image/video/audio thumbnails and lightbox previews (cached, ≤ 400 MB).
- **Beat Saber import**: auto‑detects SongCore/MBF/BMBF loader, parses `info.dat` (v2/v3/v4),
  unwraps wrappers, renames to `Name (Mapper)`, pushes into the loader folder.
- **Archives**: ZIP reader (stored + deflate, ZIP64), safe extraction with zip‑slip/symlink
  rejection; extract a ZIP into the headset.
- **Apps**: package list (`pm list packages -3`), install/uninstall, XAPK/APKS/APKM/OBB
  support with universal‑vs‑split selection and OBB staging.
- **USB storage**: detects drives mounted under `/storage` (ID from the RAW line).
- **Wireless ADB**: USB‑plugged "Enable wireless" (reads the headset Wi‑Fi IP, `tcpip 5555`,
  connect), mDNS discovery of wireless devices, auto‑reconnect after reboot/port change.
- **Live stream**: WebCodecs‑decoded H.264 from `screenrecord` to a canvas — Eye selector
  (Left/Right/Both) and "Fix view" (crop + ±21° straightening).

## Requirements

- Meta Quest 2 or Quest 3 (USB debugging enabled, developer mode on).
- On macOS ≥ 14, **Local Network** permission for the app (System Settings › Privacy & Security
  › Local Network).
- Optional: [scrcpy](https://github.com/Genymobile/scrcpy) installed (`brew install scrcpy`)
  for an external mirror window.

## Install

Download an installer from [releases](https://github.com/lemmingDev/QuestDock/releases)
or build it yourself:

```sh
npm install
npm run dist          # builds mac DMG/ZIP, Windows .exe, Linux AppImage + .deb
```

Platform builds:

```sh
npm run dist:mac      # DMG + ZIP (arm64 + x64)
npm run dist:win      # Setup .exe
npm run dist:linux    # AppImage + .deb
```

## Development

```sh
npm test              # 78 tests (ZIP, APK/XAPK/APKS/APKM, songs, volumes, parsers)
npm run start         # electron .
```

**Fake device for testing:**

```sh
QUESTDOCK_ADB="$PWD/test/fake-adb.js" FAKE_DEVICE_ROOT=/tmp/questdock-demo ./node_modules/.bin/electron .
```

## Architecture

- `src/main/` — Electron main process: `adb.js` (thin wrapper over `vendor/*` tools),
  `transfers.js` (queue), `zip.js` (ZIP engine), `apk-bundle.js` (split APK/OBB),
  `beatsaber.js` (song parsing), `preview.js` (cached media pulls), `main.js` (IPC + lifecycle),
  `store.js` (settings), `preload.js` (bridge).
- `src/renderer/` — Vue‑less vanilla JS UI (`app.js`, `index.html`, `styles.css`).
- `vendor/darwin`, `vendor/win32-x64`, `vendor/linux-x64` — platform‑bundled
  [Google platform‑tools](https://dl.google.com/android/repository/repository2-3.xml)
  (reproducible via `scripts/fetch-platform-tools.mjs`).
- `test/` — test runner (`harness.js`, `run-tests.js`), fixtures, fake ADB.

### Safety

All writes to the headset are restricted to `/sdcard` and below unless `allowAnywhere` is set.
Commands use `execFile`/`spawn` with argv arrays (no shell). Sideloaded APK paths come from the
app's own staging area.

## Tests

```sh
npm test   # 78 passed, 0 failed
```

## CI

GitHub Actions builds **macOS, Windows and Linux** on every push/PR. The macOS and Windows
jobs generate temporary self-signed development certificates, sign the builds and verify the
signatures. Linux packages are not signed. These certificates are not trusted by other machines;
each run creates a new identity, and the macOS builds are not notarized. Normal public distribution
requires appropriate trusted signing credentials; macOS also requires Apple notarization.

`scripts/gen-selfsign-certs.sh` generates local development certificates in `certs/`. The private
keys and password are for development only; never use them for production or publish them.

## Layout

```
QuestDock/
  package.json      — scripts, electron-builder config, versions
  README.md
  src/main/*.js     — main-process modules (adb, transfers, zip, apk-bundle, beatsaber, preview, store, main, preload)
  src/renderer/*    — UI (app.js, index.html, styles.css)
  src/shared/*      — shared paths util
  test/*            — tests
  scripts/*         — build/test helpers (fetch-platform-tools, make-icon, gen-selfsign-certs)
  .github/workflows/build.yml
  vendor/*/         — platform adb
  certs/            — generated development certificates (not tracked)
```

## License

MIT.
