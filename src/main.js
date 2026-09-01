'use strict';

const { getInput, info, notice, setFailed, setOutput, warning } = require('./actions');
const { CloverClient, sleep } = require('./clover');
const { getPullRequestContext, isReAnalyzeRequested } = require('./context');
const { GithubClient, STICKY_COMMENT_MARKER } = require('./github');
const { PRIORITY_ORDER, countBlockingFindings, countPendingFindings, evaluateBlockingRules, parseBlockingRules } = require('./policy');

const CREATION_POLL_INTERVAL_MS = 5_000;
const ANALYSIS_POLL_INTERVAL_MS = 15_000;

// The action posts server-rendered markdown verbatim; this run-outcome map is its only copy.
const RUN_OUTCOME_TO_API_OUTCOME = {
  'created': 'Created',
  'manual-skipped': 'RecalculationSkipped',
  'reanalyzed': 'Reanalyzed',
  'reanalyzed-on-request': 'ReanalyzedOnRequest',
  'up-to-date': 'UpToDate',
};

const TIMEOUT_COMMENT = [
  STICKY_COMMENT_MARKER,
  '## 🍀🛡️ Clover Security Review',
  '',
  '_The security review is taking longer than expected. Results will appear on the next run of this workflow._',
].join('\n');

// failureReason values are ResolutionStatus enum names from the Clover backend.
const UNSUPPORTED_DOCUMENT_TYPE = 'UnsupportedDocumentType';
const UNSUPPORTED_REPOSITORY_MESSAGE =
  'This repository is not marked as a design repository in Clover, so its pull requests cannot be '
  + 'reviewed by this action. Mark the repository as a design repository in Clover, or remove this workflow.';

class TimeoutError extends Error {}

async function pollUntil(fetchState, isDone, intervalMs, deadline) {
  for (;;) {
    const state = await fetchState();

    if (isDone(state)) {
      return state;
    }

    if (Date.now() + intervalMs > deadline) {
      throw new TimeoutError();
    }

    await sleep(intervalMs);
  }
}

// Returns the review id and how this run got there: 'created', 'reanalyzed', 'reanalyzed-on-request',
// 'up-to-date' or 'manual-skipped'.
async function resolveSecurityReviewId(clover, createResponse, deadline, run) {
  if (createResponse.existingSecurityReviewId) {
    const securityReviewId = createResponse.existingSecurityReviewId;
    info(`A security review already exists for this pull request: ${securityReviewId}`);

    if (run.recalculation === 'manual' && run.trigger !== 'comment') {
      info('Manual recalculation mode: the existing review is not re-analyzed on push.');
      return { outcome: 'manual-skipped', securityReviewId };
    }

    const queued = await recalculateExistingReview(clover, securityReviewId);
    const outcome = queued ? (run.trigger === 'comment' ? 'reanalyzed-on-request' : 'reanalyzed') : 'up-to-date';
    return { outcome, securityReviewId };
  }

  info(`Review creation started (job ${createResponse.jobId}); waiting for it to complete…`);

  const creation = await pollUntil(
    () => clover.getCreationStatus(createResponse.jobId),
    (state) => state.status !== 'Processing',
    CREATION_POLL_INTERVAL_MS,
    deadline,
  );

  if (creation.status === 'Failed') {
    const failure = new Error(creation.failureReason ?? 'Unknown failure');
    failure.failureReason = creation.failureReason;
    throw failure;
  }

  return { outcome: 'created', securityReviewId: creation.securityReviewId };
}

// Parses a non-negative integer input; returns null when the input is empty and NaN when invalid.
function parseNonNegativeIntegerInput(name) {
  const value = getInput(name);

  if (value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : Number.NaN;
}

// Re-pushes reuse the review; ask Clover to re-analyze it when the design changed. A 409 means a
// previous analysis is still running — the analysis-status polling that follows covers both cases.
// Returns whether an analysis is (or was already) running.
async function recalculateExistingReview(clover, securityReviewId) {
  try {
    const { recalculationQueued } = await clover.recalculateSecurityReview(securityReviewId);
    info(recalculationQueued ? 'The design changed since the last analysis; re-analysis queued…' : 'The review is already up to date.');
    return recalculationQueued;
  } catch (error) {
    if (error.status === 409) {
      info('A previous analysis is still running; waiting for it…');
      return true;
    }

    warning(`Could not request a re-analysis; posting the existing results. ${error.message}`);
    return false;
  }
}

async function run() {
  const pullRequest = getPullRequestContext();

  if (!pullRequest) {
    setFailed('This action must run in a GitHub Actions workflow triggered by a pull_request event (or an issue_comment event on a pull request, for the manual re-analyze checkbox).');
    return;
  }

  const recalculation = getInput('recalculation') || 'auto';

  if (!['auto', 'manual'].includes(recalculation)) {
    setFailed(`Invalid "recalculation" input "${recalculation}": expected "auto" or "manual".`);
    return;
  }

  const maxInlineComments = parseNonNegativeIntegerInput('max-inline-comments');

  if (Number.isNaN(maxInlineComments)) {
    setFailed(`Invalid "max-inline-comments" input "${getInput('max-inline-comments')}": expected a non-negative integer.`);
    return;
  }

  const maxPendingFindings = parseNonNegativeIntegerInput('max-pending-findings');

  if (Number.isNaN(maxPendingFindings)) {
    setFailed(`Invalid "max-pending-findings" input "${getInput('max-pending-findings')}": expected a non-negative integer, or empty to disable blocking.`);
    return;
  }

  const blockingPriority = (getInput('blocking-priority') || 'high').toLowerCase();

  if (!PRIORITY_ORDER.includes(blockingPriority)) {
    setFailed(`Invalid "blocking-priority" input "${getInput('blocking-priority')}": expected one of ${PRIORITY_ORDER.join(', ')}.`);
    return;
  }

  const minInlineCommentPriority = getInput('min-inline-comment-priority').toLowerCase();

  if (minInlineCommentPriority !== '' && !PRIORITY_ORDER.includes(minInlineCommentPriority)) {
    setFailed(`Invalid "min-inline-comment-priority" input "${getInput('min-inline-comment-priority')}": expected one of ${PRIORITY_ORDER.join(', ')}, or empty for no minimum.`);
    return;
  }

  // "blocking-rules" is the full policy language; when set it replaces the simple
  // max-pending-findings/blocking-priority pair, which is kept as one importance-blind rule.
  let blockingRules;

  try {
    blockingRules = parseBlockingRules(getInput('blocking-rules'));
  } catch (error) {
    setFailed(error.message);
    return;
  }

  if (blockingRules.length === 0 && maxPendingFindings !== null) {
    blockingRules = [{ maxPendingFindings, minFindingPriority: blockingPriority, minImportance: null }];
  }

  const github = new GithubClient({
    apiUrl: pullRequest.apiUrl,
    graphqlUrl: pullRequest.graphqlUrl,
    repository: pullRequest.repository,
    token: getInput('github-token', { required: true }),
  });

  if (pullRequest.trigger === 'comment') {
    // Only a tick of our own re-analyze checkbox is a request; any other comment edit is ignored.
    if (!pullRequest.commentBody.includes(STICKY_COMMENT_MARKER) || !isReAnalyzeRequested(pullRequest.commentBody)) {
      info('Comment edit is not a re-analyze request; nothing to do.');
      setOutput('status', 'skipped');
      return;
    }

    Object.assign(pullRequest, await github.getPullRequest(pullRequest.number));
    info('Re-analysis requested from the pull request comment.');
  }

  const url = getInput('url') || pullRequest.url;

  if (!url) {
    setFailed('No pull request URL available. Run this action on a pull_request event, or pass the "url" input explicitly.');
    return;
  }

  const run = { headSha: pullRequest.headSha, maxInlineComments, minInlineCommentPriority, recalculation, timestamp: Date.now(), trigger: pullRequest.trigger };
  const failOnError = getInput('fail-on-error') !== 'false';
  const waitTimeoutSeconds = Number.parseInt(getInput('wait-timeout') || '900', 10);
  const deadline = Date.now() + waitTimeoutSeconds * 1000;

  const clover = new CloverClient({
    apiBaseUrl: getInput('base-url') || 'https://api.cloversec.io',
    authBaseUrl: getInput('auth-base-url') || 'https://auth.cloversec.io',
    clientId: getInput('client-id', { required: true }),
    secretKey: getInput('secret-key', { required: true }),
  });

  info(`Requesting a Clover security review for ${url}`);

  const createResponse = await clover.createSecurityReview({
    applicationId: getInput('application-id') || undefined,
    url,
  });

  let securityReviewId;

  try {
    ({ outcome: run.outcome, securityReviewId } = await resolveSecurityReviewId(clover, createResponse, deadline, run));
  } catch (error) {
    if (error instanceof TimeoutError) {
      await handleTimeout(github, pullRequest);
      return;
    }

    if (error.failureReason === UNSUPPORTED_DOCUMENT_TYPE) {
      setOutput('status', 'unsupported-repository');
      (failOnError ? setFailed : warning)(UNSUPPORTED_REPOSITORY_MESSAGE);
      return;
    }

    setOutput('status', 'failed');
    (failOnError ? setFailed : warning)(`The security review could not be created: ${error.message}`);
    return;
  }

  setOutput('security-review-id', securityReviewId);
  info(`Security review ${securityReviewId}; waiting for analysis to complete…`);

  try {
    await pollUntil(
      () => clover.getAnalysisStatus(securityReviewId),
      (state) => state.analysisInProgress === false,
      ANALYSIS_POLL_INTERVAL_MS,
      deadline,
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      await handleTimeout(github, pullRequest);
      return;
    }

    throw error;
  }

  info('Analysis completed; fetching the rendered review content…');

  try {
    const { commentUrl, inlineCommentCount, pendingFindingCounts, reviewImportance } = await publishReviewContent(clover, github, pullRequest, run, securityReviewId);

    setOutput('comment-url', commentUrl);
    setOutput('inline-comments', String(inlineCommentCount));

    const pendingFindings = countPendingFindings(pendingFindingCounts);
    const blockingFindings = countBlockingFindings(pendingFindingCounts, blockingPriority);

    setOutput('pending-findings', String(pendingFindings));
    setOutput('blocking-findings', String(blockingFindings));
    setOutput('review-importance', String(reviewImportance ?? '').toLowerCase());

    // The results are always posted first, so developers see what blocked them.
    const violations = evaluateBlockingRules(pendingFindingCounts, reviewImportance, blockingRules);

    if (violations.length > 0) {
      setOutput('status', 'blocked');
      setFailed(`Clover security review blocked this pull request: ${violations.map((violation) => describeViolation(reviewImportance, violation)).join('; ')}. See ${commentUrl}`);
      return;
    }

    setOutput('status', 'completed');
    notice(`Clover security review completed: ${commentUrl}`);
  } catch (error) {
    setOutput('status', 'failed');
    (failOnError ? setFailed : warning)(`The review completed, but its results could not be posted: ${error.message}`);
  }
}

function describeViolation(reviewImportance, { blockingFindings, rule }) {
  const importancePart =
    rule.minImportance === null
      ? ''
      : ` for a review of "${rule.minImportance}" importance or above (this review: "${String(reviewImportance ?? 'unknown').toLowerCase()}")`;

  return `${blockingFindings} pending finding(s) at or above "${rule.minFindingPriority}" priority exceed the allowed maximum of ${rule.maxPendingFindings}${importancePart}`;
}

// Everything the run posts is rendered by Clover; this function only moves it onto GitHub:
// resolve the threads of findings no longer open, post the new inline comments as one review,
// and upsert the sticky summary comment. Existing inline comments are never edited or moved.
async function publishReviewContent(clover, github, pullRequest, run, securityReviewId) {
  const [existingFindingIds, files] = await Promise.all([
    github.listFindingCommentIds(pullRequest.number),
    github.getPullRequestFiles(pullRequest.number),
  ]);

  const content = await clover.getReviewContent(securityReviewId, {
    existingFindingIds: [...existingFindingIds],
    files,
    headSha: pullRequest.headSha ?? '',
    includeReAnalyzeCheckbox: run.recalculation === 'manual',
    maxInlineComments: run.maxInlineComments ?? undefined,
    minInlineCommentPriority: run.minInlineCommentPriority || undefined,
    outcome: RUN_OUTCOME_TO_API_OUTCOME[run.outcome],
  });

  const staleFindingIds = content.staleFindingIds ?? [];
  const inlineComments = content.inlineComments ?? [];
  const resolved = await github.resolveFindingThreads(pullRequest.number, staleFindingIds.map(String));

  if (resolved > 0) {
    info(`Resolved ${resolved} inline comment thread(s) for findings that are no longer open.`);
  }

  if (inlineComments.length > 0 && pullRequest.headSha) {
    await github.createFindingComments(pullRequest.number, pullRequest.headSha, inlineComments);
    info(`Posted ${inlineComments.length} inline comment(s).`);
  }

  const commentUrl = await github.upsertStickyComment(pullRequest.number, content.summaryComment);

  return {
    commentUrl,
    inlineCommentCount: existingFindingIds.size - staleFindingIds.length + inlineComments.length,
    pendingFindingCounts: content.priorityToPendingFindingCountMap ?? {},
    reviewImportance: content.reviewImportance,
  };
}

async function handleTimeout(github, pullRequest) {
  setOutput('status', 'timeout');
  warning(
    'Timed out waiting for the Clover security review to complete. The review continues in Clover; '
      + 'results will be posted on the next run of this workflow.',
  );

  try {
    await github.createStickyCommentIfAbsent(pullRequest.number, TIMEOUT_COMMENT);
  } catch (error) {
    warning(`Could not update the PR comment after the timeout: ${error.message}`);
  }
}

run().catch((error) => setFailed(error.message));
