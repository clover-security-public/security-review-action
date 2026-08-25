'use strict';

const { getInput, info, notice, setFailed, setOutput, warning } = require('./actions');
const { CloverClient, sleep } = require('./clover');
const { getPullRequestContext } = require('./context');
const { GithubClient } = require('./github');
const { renderReviewComment, renderTimeoutComment } = require('./render');

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

async function resolveSecurityReviewId(clover, createResponse, deadline) {
  if (createResponse.existingSecurityReviewId) {
    info(`A security review already exists for this pull request: ${createResponse.existingSecurityReviewId}`);
    return createResponse.existingSecurityReviewId;
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

  return creation.securityReviewId;
}

async function run() {
  const pullRequest = getPullRequestContext();
  const url = getInput('url') || pullRequest?.url;

  if (!url) {
    setFailed(
      'No pull request URL available. Run this action on a pull_request event, or pass the "url" input explicitly.',
    );
    return;
  }

  if (!pullRequest) {
    setFailed('This action must run in a GitHub Actions workflow triggered by a pull_request event.');
    return;
  }

  const failOnError = getInput('fail-on-error') !== 'false';
  const waitTimeoutSeconds = Number.parseInt(getInput('wait-timeout') || '900', 10);
  const deadline = Date.now() + waitTimeoutSeconds * 1000;

  const clover = new CloverClient({
    apiBaseUrl: getInput('base-url') || 'https://api.cloversec.io',
    authBaseUrl: getInput('auth-base-url') || 'https://auth.cloversec.io',
    clientId: getInput('client-id', { required: true }),
    secretKey: getInput('secret-key', { required: true }),
  });

  const github = new GithubClient({
    apiUrl: pullRequest.apiUrl,
    repository: pullRequest.repository,
    token: getInput('github-token', { required: true }),
  });

  info(`Requesting a Clover security review for ${url}`);

  const createResponse = await clover.createSecurityReview({
    applicationId: getInput('application-id') || undefined,
    url,
  });

  let securityReviewId;

  try {
    securityReviewId = await resolveSecurityReviewId(clover, createResponse, deadline);
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

  info('Analysis completed; fetching results…');

  const [summary, requirements, threats] = await Promise.all([
    clover.getSummary(securityReviewId),
    clover.getFrameworkRequirements(securityReviewId),
    clover.getThreats(securityReviewId),
  ]);

  const commentBody = renderReviewComment({
    requirements: requirements.data ?? [],
    summary,
    threats: threats.data ?? [],
  });

  const commentUrl = await github.upsertStickyComment(pullRequest.number, commentBody);

  setOutput('comment-url', commentUrl);
  setOutput('status', 'completed');
  notice(`Clover security review completed: ${commentUrl}`);
}

async function handleTimeout(github, pullRequest) {
  setOutput('status', 'timeout');
  warning(
    'Timed out waiting for the Clover security review to complete. The review continues in Clover; '
      + 'results will be posted on the next run of this workflow.',
  );

  try {
    await github.createStickyCommentIfAbsent(pullRequest.number, renderTimeoutComment());
  } catch (error) {
    warning(`Could not update the PR comment after the timeout: ${error.message}`);
  }
}

run().catch((error) => setFailed(error.message));
