'use strict';

/**
 * Runs every *.test.js in this folder in one process and exits non-zero when
 * anything fails. Usage: npm test
 */

const fs = require('fs');
const path = require('path');
const { run, summary } = require('./harness');

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}

for (const file of files) {
  require(path.join(__dirname, file));
}

run()
  .then((results) => {
    summary();
    process.exit(results.failed ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
