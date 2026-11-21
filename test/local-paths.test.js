'use strict';

/**
 * Host paths look different on each OS, and the renderer cannot use Node's
 * path module. These cover the cases the breadcrumb and file list rely on:
 * POSIX roots, Windows drive roots, and UNC shares.
 */

const { section, test, equal } = require('./harness');
const P = require('../src/shared/paths');

section('local paths');

test('parentLocal walks POSIX paths and stops at /', () => {
  equal(P.parentLocal('/Users/me/Downloads'), '/Users/me');
  equal(P.parentLocal('/Users'), '/');
  equal(P.parentLocal('/'), '/');
});

test('parentLocal keeps a drive letter rooted', () => {
  equal(P.parentLocal('C:\\Users\\me\\Downloads'), 'C:\\Users\\me');
  equal(P.parentLocal('C:\\Users'), 'C:\\');
  equal(P.parentLocal('C:\\'), 'C:\\');
  equal(P.parentLocal('D:'), 'D:');
});

test('parentLocal treats a UNC server as the root', () => {
  // The bug that started this: "\\\\Mac" must not become a lone backslash.
  equal(P.parentLocal('\\\\Mac\\Home\\Downloads'), '\\\\Mac\\Home');
  equal(P.parentLocal('\\\\Mac\\Home'), '\\\\Mac');
  equal(P.parentLocal('\\\\Mac'), '\\\\Mac');
});

test('baseNameLocal reads both separators', () => {
  equal(P.baseNameLocal('/Users/me/Downloads'), 'Downloads');
  equal(P.baseNameLocal('C:\\Users\\me\\Downloads\\'), 'Downloads');
  equal(P.baseNameLocal('\\\\Mac\\Home\\Downloads'), 'Downloads');
  equal(P.baseNameLocal('/'), '');
});

test('joinLocal keeps the separator of its parent', () => {
  equal(P.joinLocal('/Users/me', 'Downloads'), '/Users/me/Downloads');
  equal(P.joinLocal('C:\\Users\\me', 'Downloads'), 'C:\\Users\\me\\Downloads');
  equal(P.joinLocal('C:\\', 'Users'), 'C:\\Users');
  equal(P.joinLocal('\\\\Mac\\Home', 'x'), '\\\\Mac\\Home\\x');
});

test('localCrumbs starts a POSIX path at /', () => {
  const crumbs = P.localCrumbs('/Users/me/Downloads');
  equal(crumbs.map((part) => part.label), ['/', 'Users', 'me', 'Downloads']);
  equal(crumbs.map((part) => part.path), [
    '/',
    '/Users',
    '/Users/me',
    '/Users/me/Downloads',
  ]);
});

test('localCrumbs labels a drive root once', () => {
  const crumbs = P.localCrumbs('C:\\Users\\me');
  equal(crumbs.map((part) => part.label), ['C:\\', 'Users', 'me']);
  equal(crumbs[0].path, 'C:\\');
});

test('localCrumbs does not invent a root above a UNC server', () => {
  const crumbs = P.localCrumbs('\\\\Mac\\Home\\Downloads');
  equal(crumbs.map((part) => part.label), ['\\\\Mac', 'Home', 'Downloads']);
  equal(crumbs.map((part) => part.path), [
    '\\\\Mac',
    '\\\\Mac\\Home',
    '\\\\Mac\\Home\\Downloads',
  ]);
});
