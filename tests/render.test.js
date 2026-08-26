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

test('prefers the line-specific comment returned with the location', () => {
  const { findingCommentMarker } = require('../src/github');
  const { renderFindingComment } = require('../src/render');

  const comment = renderFindingComment({
    finding: { frameworkName: 'OWASP ASVS', id: 'req-9', priority: 'High', requirementIdNumber: '2.1.1' },
    kind: 'Requirement',
    location: { comment: 'The callback accepts any signer. Verify the HMAC before parsing.' },
  });

  assert.ok(comment.startsWith(findingCommentMarker('req-9')));
  assert.match(comment, /^\*\*🛡️ \[Clover Security Review\]\(.*\)\*\*$/m);
  assert.match(comment, /Verify the HMAC before parsing\./);
  assert.match(comment, /_Security requirement · High · OWASP ASVS 2\.1\.1_/);
  assert.doesNotMatch(comment, /Countermeasures/);
});

test('falls back to the finding text when no comment was returned', () => {
  const { findingCommentMarker } = require('../src/github');
  const { renderFindingComment } = require('../src/render');

  const requirementComment = renderFindingComment({
    finding: {
      countermeasures: 'Rotate the secret.',
      frameworkName: 'OWASP ASVS',
      id: 'req-1',
      priority: 'High',
      requirementIdNumber: '2.1.1',
      tailoredDescription: 'The webhook secret is static.',
      tailoredRequirement: 'Rotate webhook signing secrets',
    },
    kind: 'Requirement',
  });

  assert.ok(requirementComment.startsWith(findingCommentMarker('req-1')));
  assert.match(requirementComment, /\*\*🛡️ \[Clover Security Review\]/);
  assert.match(requirementComment, /_Security requirement · High · OWASP ASVS 2\.1\.1_/);
  assert.match(requirementComment, /Rotate webhook signing secrets/);
  assert.match(requirementComment, /OWASP ASVS 2\.1\.1/);
  assert.match(requirementComment, /Countermeasures/);

  const threatComment = renderFindingComment({
    finding: { id: 'thr-1', severity: 'Medium', summary: 'Replay of callbacks.', threat: 'Token replay' },
    kind: 'Threat',
  });

  assert.ok(threatComment.startsWith(findingCommentMarker('thr-1')));
  assert.match(threatComment, /_Threat · Medium_/);
  assert.match(threatComment, /Replay of callbacks\./);
});

test('mentions inline comments in the summary when some were posted', () => {
  const comment = renderReviewComment({
    inlineFindingCount: 2,
    requirements: [],
    summary: { summary: 'Summary.' },
    threats: [],
  });

  assert.match(comment, /2 action items are also posted as inline comments/);
});

test('renders the last-run footer and, in manual mode, the re-analyze checkbox', () => {
  const { RE_ANALYZE_BUTTON_MARKER, isReAnalyzeRequested } = require('../src/context');

  const auto = renderReviewComment({
    requirements: [],
    run: { headSha: 'abcdef1234567', outcome: 'up-to-date', recalculation: 'auto', timestamp: Date.UTC(2026, 7, 26, 9, 30) },
    summary: { summary: 'Summary.' },
    threats: [],
  });

  assert.match(auto, /Last run: 2026-08-26 09:30 UTC · commit `abcdef1` — review already up to date/);
  assert.doesNotMatch(auto, /Re-analyze this pull request/);

  const manual = renderReviewComment({
    requirements: [],
    run: { headSha: 'abcdef1234567', outcome: 'manual-skipped', recalculation: 'manual', timestamp: Date.UTC(2026, 7, 26, 9, 30) },
    summary: { summary: 'Summary.' },
    threats: [],
  });

  assert.match(manual, /- \[ \] 🔁 \*\*Re-analyze this pull request\*\*/);
  assert.ok(manual.includes(RE_ANALYZE_BUTTON_MARKER));
  assert.equal(isReAnalyzeRequested(manual), false);
  assert.equal(isReAnalyzeRequested(manual.replace('- [ ] 🔁', '- [x] 🔁')), true);
});
