'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { matchLocations, selectActionItems } = require('../src/findings');

const requirement = (id, status, priority) => ({ id, priority, status, tailoredRequirement: `R ${id}` });
const threat = (id, status, severity) => ({ id, severity, status, threat: `T ${id}` });

test('selects only open findings, most severe first, requirements before threats on ties', () => {
  const items = selectActionItems({
    requirements: [
      requirement('r-covered', 'CoveredByClover', 'Critical'),
      requirement('r-medium', 'SuggestedByClover', 'Medium'),
      requirement('r-high', 'SentToDevelopers', 'High'),
    ],
    threats: [
      threat('t-mitigated', 'MitigatedByRequirement', 'Critical'),
      threat('t-high', 'SuggestedByClover', 'High'),
      threat('t-low', 'SentToDevelopers', 'Low'),
    ],
  });

  assert.deepEqual(
    items.map((item) => item.finding.id),
    ['r-high', 't-high', 'r-medium', 't-low'],
  );
  assert.deepEqual(items.map((item) => item.kind), ['Requirement', 'Threat', 'Requirement', 'Threat']);
});

test('caps the number of action items', () => {
  const requirements = Array.from({ length: 20 }, (_, index) =>
    requirement(`r-${index}`, 'SuggestedByClover', 'High'));

  assert.equal(selectActionItems({ requirements, threats: [] }).length, 15);
  assert.equal(selectActionItems({ requirements, threats: [] }, 3).length, 3);
});

test('matches locations to selected findings and drops weak or unknown ones', () => {
  const items = selectActionItems({
    requirements: [requirement('r-1', 'SuggestedByClover', 'High')],
    threats: [threat('t-1', 'SuggestedByClover', 'High')],
  });

  const placed = matchLocations(items, [
    { confidence: 5, endLine: 14, findingId: 'r-1', path: 'design.md', startLine: 12 },
    { confidence: 2, endLine: 20, findingId: 't-1', path: 'design.md', startLine: 20 },
    { confidence: 5, endLine: 30, findingId: 'unknown', path: 'design.md', startLine: 30 },
  ]);

  assert.equal(placed.length, 1);
  assert.equal(placed[0].finding.id, 'r-1');
  assert.equal(placed[0].location.startLine, 12);
});
