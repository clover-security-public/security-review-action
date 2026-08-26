'use strict';

const fs = require('node:fs');

// Hidden marker on the sticky comment's re-analyze checkbox, so a checked box can be recognised reliably.
const RE_ANALYZE_BUTTON_MARKER = '<!-- clover-button:re-analyze -->';

function isReAnalyzeRequested(commentBody) {
  return /- \[x\][^\n]*<!-- clover-button:re-analyze -->/i.test(commentBody ?? '');
}

// Resolves the pull request this run should review from the workflow event payload. Supports the
// pull_request event and, for the manual re-analyze checkbox, issue_comment edits on a pull request.
function getPullRequestContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;

  if (!eventPath || !fs.existsSync(eventPath) || !repository) {
    return null;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const base = {
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: process.env.GITHUB_GRAPHQL_URL,
    repository,
  };

  if (event.pull_request) {
    return {
      ...base,
      headSha: event.pull_request.head?.sha,
      number: event.pull_request.number,
      trigger: 'push',
      url: event.pull_request.html_url,
    };
  }

  if (eventName === 'issue_comment' && event.issue?.pull_request) {
    return {
      ...base,
      commentBody: event.comment?.body ?? '',
      number: event.issue.number,
      trigger: 'comment',
      // headSha and url are filled in from the API, the issue payload does not carry them.
      headSha: undefined,
      url: undefined,
    };
  }

  return null;
}

module.exports = { RE_ANALYZE_BUTTON_MARKER, getPullRequestContext, isReAnalyzeRequested };
