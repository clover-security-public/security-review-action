'use strict';

// Hidden marker identifying the action's sticky comment, so re-runs update it in place.
const STICKY_COMMENT_MARKER = '<!-- clover-security-review -->';

// Hidden per-finding marker on inline review comments, so re-runs update rather than duplicate them.
const FINDING_COMMENT_MARKER_PREFIX = '<!-- clover-finding:';

function findingCommentMarker(findingId) {
  return `${FINDING_COMMENT_MARKER_PREFIX}${findingId} -->`;
}

class GithubClient {
  #apiUrl;
  #repository;
  #token;

  constructor({ apiUrl, repository, token }) {
    this.#apiUrl = apiUrl.replace(/\/+$/, '');
    this.#repository = repository;
    this.#token = token;
  }

  async upsertStickyComment(pullRequestNumber, body) {
    const existing = await this.#findStickyComment(pullRequestNumber);

    if (existing) {
      const updated = await this.#send('PATCH', `issues/comments/${existing.id}`, { body });
      return updated.html_url;
    }

    const created = await this.#send('POST', `issues/${pullRequestNumber}/comments`, { body });
    return created.html_url;
  }

  // Used for the timeout placeholder: never replace an earlier run's full results.
  async createStickyCommentIfAbsent(pullRequestNumber, body) {
    const existing = await this.#findStickyComment(pullRequestNumber);

    if (existing) {
      return existing.html_url;
    }

    const created = await this.#send('POST', `issues/${pullRequestNumber}/comments`, { body });
    return created.html_url;
  }

  // Changed files with their unified-diff patches; binary and patch-less files are skipped.
  async getPullRequestFiles(pullRequestNumber) {
    const files = [];

    for (let page = 1; page <= 30; page += 1) {
      const pageFiles = await this.#send(
        'GET',
        `pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
      );

      files.push(...pageFiles);

      if (pageFiles.length < 100) {
        break;
      }
    }

    return files
      .filter((file) => file.status !== 'removed' && typeof file.patch === 'string' && file.patch.length > 0)
      .map((file) => ({ patch: file.patch, path: file.filename }));
  }

  // Creates or updates one inline review comment per finding; all new comments land in a single review.
  async upsertFindingComments(pullRequestNumber, headSha, findingComments) {
    const existing = await this.#listReviewComments(pullRequestNumber);
    const created = [];
    const updated = [];

    for (const findingComment of findingComments) {
      const marker = findingCommentMarker(findingComment.findingId);
      const existingComment = existing.find((comment) => comment.body?.includes(marker));

      if (existingComment) {
        await this.#send('PATCH', `pulls/comments/${existingComment.id}`, { body: findingComment.body });
        updated.push(existingComment.html_url);
      } else {
        created.push(findingComment);
      }
    }

    if (created.length > 0) {
      await this.#send('POST', `pulls/${pullRequestNumber}/reviews`, {
        body: '',
        comments: created.map((findingComment) => ({
          body: findingComment.body,
          line: findingComment.endLine,
          path: findingComment.path,
          side: 'RIGHT',
          ...(findingComment.startLine < findingComment.endLine
            ? { start_line: findingComment.startLine, start_side: 'RIGHT' }
            : {}),
        })),
        commit_id: headSha,
        event: 'COMMENT',
      });
    }

    return { created: created.length, updated: updated.length };
  }

  async #listReviewComments(pullRequestNumber) {
    const comments = [];

    for (let page = 1; page <= 10; page += 1) {
      const pageComments = await this.#send(
        'GET',
        `pulls/${pullRequestNumber}/comments?per_page=100&page=${page}`,
      );

      comments.push(...pageComments);

      if (pageComments.length < 100) {
        break;
      }
    }

    return comments;
  }

  async #findStickyComment(pullRequestNumber) {
    for (let page = 1; page <= 10; page += 1) {
      const comments = await this.#send(
        'GET',
        `issues/${pullRequestNumber}/comments?per_page=100&page=${page}`,
      );

      const sticky = comments.find((comment) => comment.body?.includes(STICKY_COMMENT_MARKER));

      if (sticky) {
        return sticky;
      }

      if (comments.length < 100) {
        return null;
      }
    }

    return null;
  }

  async #send(method, path, body) {
    const response = await fetch(`${this.#apiUrl}/repos/${this.#repository}/${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${response.status})${responseText ? `: ${responseText.slice(0, 300)}` : ''}. `
          + 'Ensure the workflow grants "pull-requests: write" permission.',
      );
    }

    return response.json();
  }
}

module.exports = { FINDING_COMMENT_MARKER_PREFIX, GithubClient, STICKY_COMMENT_MARKER, findingCommentMarker };
