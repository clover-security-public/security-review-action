'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { isReAnalyzeRequested } = require('../src/context');
const { FINDING_COMMENT_MARKER_REGEX, findingCommentMarker } = require('../src/github');

test('finding comment markers round-trip through the parse regex', () => {
  const body = `${findingCommentMarker('11111111-2222-3333-4444-555555555555')}\n**🍀🛡️ Clover Security Review**\n\nSome comment.`;
  const match = FINDING_COMMENT_MARKER_REGEX.exec(body);

  assert.ok(match);
  assert.equal(match[1], '11111111-2222-3333-4444-555555555555');
  assert.equal(FINDING_COMMENT_MARKER_REGEX.exec('no marker here'), null);
});

test('re-analyze checkbox tick is detected only when checked', () => {
  const unchecked = '- [ ] 🔁 **Re-analyze this pull request** <!-- clover-button:re-analyze -->';

  assert.equal(isReAnalyzeRequested(unchecked), false);
  assert.equal(isReAnalyzeRequested(unchecked.replace('- [ ]', '- [x]')), true);
  assert.equal(isReAnalyzeRequested('- [x] some other checkbox'), false);
});
