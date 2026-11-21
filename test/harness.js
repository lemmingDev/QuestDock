'use strict';

/**
 * Tiny test runner: no dependencies, exit code 1 on failure.
 *
 * Tests are queued as files are required, then run in order by run-tests.js so
 * async work (real child processes against the fake adb) behaves predictably.
 */

const items = [];
const results = { passed: 0, failed: 0, failures: [] };

function section(title) {
  items.push({ type: 'section', title });
}

function test(name, fn) {
  items.push({ type: 'test', name, fn });
}

// Same signature; kept so call sites read clearly.
const testAsync = test;

function equal(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label || 'value'} mismatch\n         actual:   ${a}\n         expected: ${b}`);
  }
}

function ok(value, label = 'value') {
  if (!value) throw new Error(`${label} should be truthy, got ${JSON.stringify(value)}`);
}

function includes(haystack, needle, label = 'value') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label} should include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`);
  }
}

async function run() {
  for (const item of items) {
    if (item.type === 'section') {
      console.log(`\n${item.title}`);
      continue;
    }
    try {
      await item.fn();
      results.passed += 1;
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      results.failed += 1;
      results.failures.push({ name: item.name, error });
      console.log(`  FAIL ${item.name}`);
      const message = error && error.message ? error.message : String(error);
      console.log(`       ${message.split('\n').join('\n       ')}`);
    }
  }
  return results;
}

function summary() {
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  if (results.failed) {
    console.log('\nFailures:');
    for (const failure of results.failures) console.log(`  · ${failure.name}`);
  }
  return results;
}

module.exports = { test, testAsync, equal, ok, includes, section, run, summary, results, items };
