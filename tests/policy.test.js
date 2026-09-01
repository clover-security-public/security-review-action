'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { countBlockingFindings, countPendingFindings, evaluateBlockingRules, parseBlockingRules } = require('../src/policy');

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

test('blocking rules parse the importance/findings/max grammar with defaults', () => {
  const rules = parseBlockingRules('importance >= high, findings >= medium, max 0\nfindings>=critical, max=1\nmax 3\n');

  assert.deepEqual(rules, [
    { maxPendingFindings: 0, minFindingPriority: 'medium', minImportance: 'high' },
    { maxPendingFindings: 1, minFindingPriority: 'critical', minImportance: null },
    { maxPendingFindings: 3, minFindingPriority: 'insignificant', minImportance: null },
  ]);
  assert.deepEqual(parseBlockingRules(''), []);
});

test('blocking rules reject unknown clauses and a missing max', () => {
  assert.throws(() => parseBlockingRules('findings >= gigantic, max 0'), /Invalid blocking rule clause/);
  assert.throws(() => parseBlockingRules('importance >= high'), /missing its "max <count>" clause/);
});

test('an importance-gated rule applies only to reviews at or above the gate', () => {
  const counts = { Medium: 1 };
  const rules = parseBlockingRules('importance >= high, findings >= medium, max 0');

  assert.equal(evaluateBlockingRules(counts, 'High', rules).length, 1);
  assert.equal(evaluateBlockingRules(counts, 'Critical', rules).length, 1);
  assert.equal(evaluateBlockingRules(counts, 'Low', rules).length, 0);
  assert.equal(evaluateBlockingRules(counts, 'Unknown', rules).length, 0);
  assert.equal(evaluateBlockingRules(counts, undefined, rules).length, 0);
});

test('an ungated rule blocks regardless of the review importance', () => {
  const rules = parseBlockingRules('findings >= critical, max 0');

  assert.equal(evaluateBlockingRules({ Critical: 1 }, 'Low', rules).length, 1);
  assert.equal(evaluateBlockingRules({ High: 5 }, 'Low', rules).length, 0);
});

test('violations carry the counted findings and the exceeded rule', () => {
  const rules = parseBlockingRules('findings >= high, max 1');
  const violations = evaluateBlockingRules({ Critical: 1, High: 2, Low: 9 }, 'Medium', rules);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].blockingFindings, 3);
  assert.equal(violations[0].rule.maxPendingFindings, 1);
});
