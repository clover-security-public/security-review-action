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

test('threads are closed by the comment ids Clover names, leaving its other comments open', async () => {
  await withGithub(ORIGINAL_BODY, { data: { resolveReviewThread: { thread: { id: 'THREAD_OPEN' } } } }, async (github, calls) => {
    const resolvedNamed = await github.closeCommentThreads(7, ['42'], NOTE);
    const resolveCalls = calls.filter((call) => call.url.endsWith('/graphql') && call.body.query.startsWith('mutation'));

    assert.deepEqual(resolvedNamed, { marked: 0, resolutionForbidden: false, resolved: 1 });
    assert.equal(resolveCalls.length, 1);
    assert.equal(resolveCalls[0].body.variables.threadId, 'THREAD_OPEN');
  });

  await withGithub(ORIGINAL_BODY, { data: { resolveReviewThread: { thread: { id: 'THREAD_OPEN' } } } }, async (github) => {
    const resolvedOther = await github.closeCommentThreads(7, ['999'], NOTE);

    assert.deepEqual(resolvedOther, { marked: 0, resolutionForbidden: false, resolved: 0 });
  });
});

test('thread comments are the thread-opening comments, with the body only when it carries a finding marker', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    jsonResponse([
      { body: ORIGINAL_BODY, id: 42 },
      { body: `${findingCommentMarker(FINDING_ID)} quoted in a reply`, id: 43, in_reply_to_id: 42 },
      { body: 'A human review comment.', id: 44 },
    ]);

  try {
    const github = new GithubClient({ apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', repository: 'acme/design', token: 'token' });

    assert.deepEqual(await github.listThreadComments(7), [{ body: ORIGINAL_BODY, commentId: '42' }, { commentId: '44' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a comment without a finding marker is closed by the comment id Clover names', async () => {
  await withGithub('**🍀🛡️ Clover Security Review**\n\nNo marker here.', { data: { resolveReviewThread: { thread: { id: 'THREAD_OPEN' } } } }, async (github) => {
    assert.deepEqual(await github.closeCommentThreads(7, ['42'], NOTE), { marked: 0, resolutionForbidden: false, resolved: 1 });
  });
});

test('posted comments are matched to the GitHub comments of the review by file, line and body', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: options.method ?? 'GET', url: String(url) });

    return String(url).endsWith('/reviews')
      ? jsonResponse({ id: 900 })
      : jsonResponse([
        { body: 'Second.\r\n', id: 2, line: 12, path: 'design.md' },
        { body: 'First.', id: 1, line: 10, path: 'design.md' },
      ]);
  };

  try {
    const github = new GithubClient({ apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', repository: 'acme/design', token: 'token' });
    const posted = await github.createFindingComments(7, 'sha', [
      { body: 'First.', endLine: 10, inlineCommentId: 'a', path: 'design.md', startLine: 10 },
      { body: 'Second.', endLine: 12, inlineCommentId: 'b', path: 'design.md', startLine: 11 },
      { body: 'Not posted.', endLine: 20, inlineCommentId: 'c', path: 'design.md', startLine: 20 },
    ]);

    assert.deepEqual(posted, [{ commentId: '1', inlineCommentId: 'a' }, { commentId: '2', inlineCommentId: 'b' }]);
    assert.ok(calls.some((call) => call.url.endsWith('/pulls/7/reviews/900/comments?per_page=100')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('comments from a Clover that records nothing are posted without reading them back', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ method: options.method ?? 'GET', url: String(url) });

    return jsonResponse({ id: 900 });
  };

  try {
    const github = new GithubClient({ apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', repository: 'acme/design', token: 'token' });

    assert.deepEqual(await github.createFindingComments(7, 'sha', [{ body: ORIGINAL_BODY, endLine: 10, path: 'design.md', startLine: 10 }]), []);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a non-permission GraphQL failure still surfaces', async () => {
  await withGithub(ORIGINAL_BODY, { errors: [{ message: 'Something went wrong', type: 'INTERNAL' }] }, async (github) => {
    await assert.rejects(() => github.closeFindingThreads(7, [FINDING_ID], NOTE), /Something went wrong/);
  });
});

const { resolveSecurityReviewId } = require('../src/main');

const CREATE_RESPONSE = { jobId: 'job-1' };
const RUN = { recalculation: 'auto', trigger: 'push' };

function cloverReturningCreation(creation) {
  return { getCreationStatus: async () => creation };
}

test('a skipped creation resolves to no review id', async () => {
  const result = await resolveSecurityReviewId(cloverReturningCreation({ status: 'Skipped' }), CREATE_RESPONSE, Date.now() + 60_000, RUN);

  assert.deepEqual(result, { outcome: 'skipped', securityReviewId: null });
});

test('a completed creation resolves to its review id', async () => {
  const result = await resolveSecurityReviewId(cloverReturningCreation({ securityReviewId: 'review-1', status: 'Completed' }), CREATE_RESPONSE, Date.now() + 60_000, RUN);

  assert.deepEqual(result, { outcome: 'created', securityReviewId: 'review-1' });
});

test('a finished creation without a review id fails instead of polling an undefined review', async () => {
  await assert.rejects(
    () => resolveSecurityReviewId(cloverReturningCreation({ status: 'Unexpected' }), CREATE_RESPONSE, Date.now() + 60_000, RUN),
    /ended as Unexpected without a security review id/,
  );
});
