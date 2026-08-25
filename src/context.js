'use strict';

const fs = require('node:fs');

// Resolves the pull request this run should review from the workflow event payload.
function getPullRequestContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;

  if (!eventPath || !fs.existsSync(eventPath)) {
    return null;
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pullRequest = event.pull_request;

  if (!pullRequest || !repository) {
    return null;
  }

  return {
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    number: pullRequest.number,
    repository,
    url: pullRequest.html_url,
  };
}

module.exports = { getPullRequestContext };
