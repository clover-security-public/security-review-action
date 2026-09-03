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

const { FINDING_CLOSED_MARKER, GithubClient, closedFindingCommentBody } = require('../src/github');

const FINDING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORIGINAL_BODY = `${findingCommentMarker(FINDING_ID)}\n**🍀🛡️ Clover Security Review**\n\nLook at this line.`;
const NOTE = '✅ **No longer open in Clover**';
const FORBIDDEN_RESPONSE = {
  data: { resolveReviewThread: null },
  errors: [{ message: 'Resource not accessible by integration', type: 'FORBIDDEN' }],
};

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' }, status: 200 });
}

function threadsPayload(commentBody) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { comments: { nodes: [{ body: commentBody, databaseId: 42 }] }, id: 'THREAD_OPEN', isResolved: false },
              { comments: { nodes: [{ body: findingCommentMarker('other'), databaseId: 43 }] }, id: 'THREAD_RESOLVED', isResolved: true },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    },
  };
}

// Stubs global fetch for one test: GraphQL queries return the thread list, mutations the given payload.
async function withGithub(commentBody, mutationPayload, run) {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const call = { body: options.body ? JSON.parse(options.body) : undefined, method: options.method ?? 'GET', url: String(url) };
    calls.push(call);

    if (call.url.endsWith('/graphql')) {
      return jsonResponse(call.body.query.startsWith('mutation') ? mutationPayload : threadsPayload(commentBody));
    }

    return jsonResponse({ id: 42 });
  };

  try {
    const github = new GithubClient({ apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', repository: 'acme/design', token: 'token' });
    return await run(github, calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('stale threads are resolved when the token is allowed to', async () => {
  await withGithub(ORIGINAL_BODY, { data: { resolveReviewThread: { thread: { id: 'THREAD_OPEN' } } } }, async (github, calls) => {
    const result = await github.closeFindingThreads(7, [FINDING_ID], NOTE);

    assert.deepEqual(result, { marked: 0, resolutionForbidden: false, resolved: 1 });
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  });
});

test('a forbidden resolve mutation falls back to marking the comment, once', async () => {
  await withGithub(ORIGINAL_BODY, FORBIDDEN_RESPONSE, async (github, calls) => {
    const result = await github.closeFindingThreads(7, [FINDING_ID], NOTE);
    const patches = calls.filter((call) => call.method === 'PATCH');

    assert.deepEqual(result, { marked: 1, resolutionForbidden: true, resolved: 0 });
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.endsWith('/repos/acme/design/pulls/comments/42'));
    assert.equal(patches[0].body.body, closedFindingCommentBody(ORIGINAL_BODY, NOTE));
    assert.ok(patches[0].body.body.startsWith(FINDING_CLOSED_MARKER));
    assert.equal(FINDING_COMMENT_MARKER_REGEX.exec(patches[0].body.body)[1], FINDING_ID);
  });

  await withGithub(closedFindingCommentBody(ORIGINAL_BODY, NOTE), FORBIDDEN_RESPONSE, async (github, calls) => {
    const result = await github.closeFindingThreads(7, [FINDING_ID], NOTE);

    assert.deepEqual(result, { marked: 0, resolutionForbidden: true, resolved: 0 });
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  });
});

test('without a note from Clover nothing is marked and nothing fails', async () => {
  await withGithub(ORIGINAL_BODY, FORBIDDEN_RESPONSE, async (github, calls) => {
    const result = await github.closeFindingThreads(7, [FINDING_ID], undefined);

    assert.deepEqual(result, { marked: 0, resolutionForbidden: true, resolved: 0 });
    assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0);
  });
});

test('a non-permission GraphQL failure still surfaces', async () => {
  await withGithub(ORIGINAL_BODY, { errors: [{ message: 'Something went wrong', type: 'INTERNAL' }] }, async (github) => {
    await assert.rejects(() => github.closeFindingThreads(7, [FINDING_ID], NOTE), /Something went wrong/);
  });
});
