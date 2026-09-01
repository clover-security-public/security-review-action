'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { countBlockingFindings, countPendingFindings } = require('../src/policy');

test('blocking findings count everything at or above the blocking priority', () => {
  const counts = { Critical: 1, High: 2, Low: 4, Medium: 3 };

  assert.equal(countBlockingFindings(counts, 'critical'), 1);
  assert.equal(countBlockingFindings(counts, 'high'), 3);
  assert.equal(countBlockingFindings(counts, 'insignificant'), 10);
});

test('blocking findings tolerate camel-cased keys and ignore unknown priorities', () => {
  assert.equal(countBlockingFindings({ high: 2, Unknown: 5 }, 'high'), 2);
  assert.equal(countBlockingFindings(undefined, 'high'), 0);
});

test('pending findings sum every priority, unknown included', () => {
  assert.equal(countPendingFindings({ High: 2, Low: 1, Unknown: 5 }), 8);
  assert.equal(countPendingFindings(undefined), 0);
});
