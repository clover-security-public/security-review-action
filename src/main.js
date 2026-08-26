'use strict';

const { getInput, info, notice, setFailed, setOutput, warning } = require('./actions');
const { CloverClient, sleep } = require('./clover');
const { getPullRequestContext, isReAnalyzeRequested } = require('./context');
const { matchLocations, planInlineComments, selectActionItems } = require('./findings');
const { GithubClient, STICKY_COMMENT_MARKER } = require('./github');
const { renderFindingComment, renderReviewComment, renderTimeoutComment } = require('./render');

const CREATION_POLL_INTERVAL_MS = 5_000;
const ANALYSIS_POLL_INTERVAL_MS = 15_000;

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

  const run = { headSha: pullRequest.headSha, recalculation, timestamp: Date.now(), trigger: pullRequest.trigger };
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
      await handleTimeout(github, pullRequest, run);
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
      await handleTimeout(github, pullRequest, run);
      return;
    }

    throw error;
  }

  info('Analysis completed; fetching results…');

  const [summary, requirements, threats] = await Promise.all([
    clover.getSummary(securityReviewId),
    clover.getFrameworkRequirements(securityReviewId),
    clover.getThreats(securityReviewId),
  ]);

  const inlineFindingCount = await postInlineComments(clover, github, pullRequest, securityReviewId, {
    requirements: requirements.data ?? [],
    threats: threats.data ?? [],
  });

  const commentBody = renderReviewComment({
    inlineFindingCount,
    requirements: requirements.data ?? [],
    run,
    summary,
    threats: threats.data ?? [],
  });

  const commentUrl = await github.upsertStickyComment(pullRequest.number, commentBody);

  setOutput('comment-url', commentUrl);
  setOutput('inline-comments', String(inlineFindingCount));
  setOutput('status', 'completed');
  notice(`Clover security review completed: ${commentUrl}`);
}

// Places newly open findings on the diff lines they apply to and resolves the threads of findings
// that are no longer open. Existing inline comments are never edited or moved. Best effort: any
// failure here leaves the sticky summary comment as the single source of results.
async function postInlineComments(clover, github, pullRequest, securityReviewId, findings) {
  if (!pullRequest.headSha) {
    return 0;
  }

  try {
    const actionItems = selectActionItems(findings);
    const existingFindingIds = await github.listFindingCommentIds(pullRequest.number);
    const { newItems, staleFindingIds } = planInlineComments(actionItems, existingFindingIds);

    const resolved = await github.resolveFindingThreads(pullRequest.number, staleFindingIds);

    if (resolved > 0) {
      info(`Resolved ${resolved} inline comment thread(s) for findings that are no longer open.`);
    }

    if (newItems.length === 0) {
      return existingFindingIds.size - staleFindingIds.length;
    }

    const files = await github.getPullRequestFiles(pullRequest.number);

    if (files.length === 0) {
      return existingFindingIds.size - staleFindingIds.length;
    }

    info(`Locating ${newItems.length} new action item(s) on the diff…`);

    const { locations = [] } = await clover.locateFindings(securityReviewId, {
      files,
      requirementIds: newItems.filter((item) => item.kind === 'Requirement').map((item) => item.finding.id),
      threatIds: newItems.filter((item) => item.kind === 'Threat').map((item) => item.finding.id),
    });

    const placed = matchLocations(newItems, locations);

    if (placed.length === 0) {
      info('No new action item could be placed on a specific line of the diff.');
    } else {
      await github.createFindingComments(
        pullRequest.number,
        pullRequest.headSha,
        placed.map((item) => ({
          body: renderFindingComment(item),
          endLine: item.location.endLine,
          path: item.location.path,
          startLine: item.location.startLine,
        })),
      );

      info(`Posted ${placed.length} inline comment(s).`);
    }

    return existingFindingIds.size - staleFindingIds.length + placed.length;
  } catch (error) {
    warning(`Could not post inline comments; results are in the summary comment. ${error.message}`);
    return 0;
  }
}

async function handleTimeout(github, pullRequest, run) {
  setOutput('status', 'timeout');
  warning(
    'Timed out waiting for the Clover security review to complete. The review continues in Clover; '
      + 'results will be posted on the next run of this workflow.',
  );

  try {
    await github.createStickyCommentIfAbsent(pullRequest.number, renderTimeoutComment(run));
  } catch (error) {
    warning(`Could not update the PR comment after the timeout: ${error.message}`);
  }
}

run().catch((error) => setFailed(error.message));
