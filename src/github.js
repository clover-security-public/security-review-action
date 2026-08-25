'use strict';

// Hidden marker identifying the action's sticky comment, so re-runs update it in place.
const STICKY_COMMENT_MARKER = '<!-- clover-security-review -->';

// Hidden per-finding marker on inline review comments, so re-runs update rather than duplicate them.
const FINDING_COMMENT_MARKER_PREFIX = '<!-- clover-finding:';

const FINDING_COMMENT_MARKER_REGEX = /<!-- clover-finding:([^\s>]+) -->/;

function findingCommentMarker(findingId) {
  return `${FINDING_COMMENT_MARKER_PREFIX}${findingId} -->`;
}

class GithubClient {
  #apiUrl;
  #graphqlUrl;
  #repository;
  #token;

  constructor({ apiUrl, graphqlUrl, repository, token }) {
    this.#apiUrl = apiUrl.replace(/\/+$/, '');
    this.#graphqlUrl = graphqlUrl || `${this.#apiUrl}/graphql`;
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

  // Finding ids that already have an inline comment on the PR, keyed from the hidden marker.
  async listFindingCommentIds(pullRequestNumber) {
    const comments = await this.#listReviewComments(pullRequestNumber);
    const findingIds = new Set();

    for (const comment of comments) {
      const match = FINDING_COMMENT_MARKER_REGEX.exec(comment.body ?? '');

      if (match) {
        findingIds.add(match[1]);
      }
    }

    return findingIds;
  }

  // Posts all new inline comments as a single review so they appear together.
  async createFindingComments(pullRequestNumber, headSha, findingComments) {
    if (findingComments.length === 0) {
      return;
    }

    await this.#send('POST', `pulls/${pullRequestNumber}/reviews`, {
      body: '',
      comments: findingComments.map((findingComment) => ({
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

  // Resolves the review threads of findings that are no longer open. Thread resolution exists only in GraphQL.
  async resolveFindingThreads(pullRequestNumber, findingIds) {
    if (findingIds.length === 0) {
      return 0;
    }

    const [owner, name] = this.#repository.split('/');
    const staleFindingIds = new Set(findingIds);
    let resolved = 0;
    let cursor = null;

    do {
      const data = await this.#graphql(
        `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { endCursor hasNextPage }
                nodes { id isResolved comments(first: 1) { nodes { body } } }
              }
            }
          }
        }`,
        { cursor, name, number: pullRequestNumber, owner },
      );

      const threads = data.repository.pullRequest.reviewThreads;

      for (const thread of threads.nodes) {
        const match = FINDING_COMMENT_MARKER_REGEX.exec(thread.comments.nodes[0]?.body ?? '');

        if (!thread.isResolved && match && staleFindingIds.has(match[1])) {
          await this.#graphql(
            'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }',
            { threadId: thread.id },
          );
          resolved += 1;
        }
      }

      cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);

    return resolved;
  }

  async #graphql(query, variables) {
    const response = await fetch(this.#graphqlUrl, {
      body: JSON.stringify({ query, variables }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.errors?.length) {
      const detail = payload.errors?.map((error) => error.message).join('; ') ?? `HTTP ${response.status}`;
      throw new Error(`GitHub GraphQL request failed: ${detail}. Ensure the workflow grants "pull-requests: write" permission.`);
    }

    return payload.data;
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

module.exports = {
  FINDING_COMMENT_MARKER_PREFIX,
  FINDING_COMMENT_MARKER_REGEX,
  GithubClient,
  STICKY_COMMENT_MARKER,
  findingCommentMarker,
};
