'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { STICKY_COMMENT_MARKER } = require('../src/github');
const { renderReviewComment, renderTimeoutComment } = require('../src/render');

test('renders summary, requirements and threats', () => {
  const comment = renderReviewComment({
    requirements: [
      {
        frameworkName: 'OWASP ASVS',
        priority: 'Medium',
        requirementIdNumber: '2.1.1',
        tailoredDescription: 'Use a vetted password policy.',
        tailoredRequirement: 'Enforce strong passwords',
      },
      {
        frameworkName: 'OWASP ASVS',
        priority: 'High',
        requirementIdNumber: '4.1.1',
        tailoredRequirement: 'Enforce access control on the new endpoint',
      },
    ],
    summary: { summary: 'A new payment flow is introduced.' },
    threats: [
      { category: 'Spoofing', severity: 'High', threat: 'Token replay on the callback' },
    ],
  });

  assert.ok(comment.startsWith(STICKY_COMMENT_MARKER));
  assert.match(comment, /A new payment flow is introduced\./);
  assert.match(comment, /Security requirements \(2\)/);
  assert.match(comment, /Threats \(1\)/);

  // High priority requirement sorts before Medium.
  assert.ok(comment.indexOf('Enforce access control') < comment.indexOf('Enforce strong passwords'));
});

test('renders a no-findings note when the review is empty', () => {
  const comment = renderReviewComment({ requirements: [], summary: {}, threats: [] });

  assert.match(comment, /completed without findings/);
});

test('falls back to the short summary', () => {
  const comment = renderReviewComment({
    requirements: [],
    summary: { shortSummary: 'Short version.' },
    threats: [],
  });

  assert.match(comment, /Short version\./);
});

test('escapes pipes and newlines in threat table cells', () => {
  const comment = renderReviewComment({
    requirements: [],
    summary: {},
    threats: [{ category: 'Tampering', severity: 'Low', threat: 'a | b\nc' }],
  });

  assert.match(comment, /a \\\| b c/);
});

test('timeout comment carries the sticky marker', () => {
  assert.ok(renderTimeoutComment().startsWith(STICKY_COMMENT_MARKER));
});
