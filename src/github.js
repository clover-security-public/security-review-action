'use strict';

// Hidden marker identifying the action's sticky comment, so re-runs update it in place.
const STICKY_COMMENT_MARKER = '<!-- clover-security-review -->';

// Hidden per-finding marker on inline review comments, so re-runs update rather than duplicate them.
const FINDING_COMMENT_MARKER_PREFIX = '<!-- clover-finding:';

const FINDING_COMMENT_MARKER_REGEX = /<!-- clover-finding:([^\s>]+) -->/;

// Hidden marker prepended to a stale finding's comment when its thread could not be resolved, so the
// note is written once. Deliberately not of the "clover-finding:<id>" shape the regex above parses.
const FINDING_CLOSED_MARKER = '<!-- clover-finding-closed -->';

const RESOLVE_THREAD_MUTATION =
  'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }';

const FINDING_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { endCursor hasNextPage }
        nodes { id isResolved comments(first: 1) { nodes { body databaseId } } }
      }
    }
  }
}`;

function findingCommentMarker(findingId) {
  return `${FINDING_COMMENT_MARKER_PREFIX}${findingId} -->`;
}

function closedFindingCommentBody(body, staleFindingNote) {
  return `${FINDING_CLOSED_MARKER}\n${staleFindingNote}\n\n${body}`;
}

class GithubGraphqlError extends Error {
  constructor(message, { forbidden }) {
    super(message);
    this.name = 'GithubGraphqlError';
    this.forbidden = forbidden;
  }
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

  async getPullRequest(pullRequestNumber) {
    const pullRequest = await this.#send('GET', `pulls/${pullRequestNumber}`);
    return { headSha: pullRequest.head?.sha, url: pullRequest.html_url };
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

  // Closes the open review threads of findings that are no longer open. Resolving a thread exists only
  // in GraphQL, and GitHub gates that mutation on "contents: write"; when the token lacks it, each
  // thread's comment is prepended with the note instead — a REST edit "pull-requests: write" allows.
  // Returns how many threads were resolved, how many comments were marked, and whether resolution
  // was refused for lack of permission.
  async closeFindingThreads(pullRequestNumber, findingIds, staleFindingNote) {
    const result = { marked: 0, resolutionForbidden: false, resolved: 0 };

    if (findingIds.length === 0) {
      return result;
    }

    const threads = await this.#listOpenFindingThreads(pullRequestNumber, new Set(findingIds));

    for (const thread of threads) {
      try {
        await this.#graphql(RESOLVE_THREAD_MUTATION, { threadId: thread.id });
        result.resolved += 1;
      } catch (error) {
        if (!error.forbidden) {
          throw error;
        }

        result.resolutionForbidden = true;
        result.marked = await this.#markFindingCommentsClosed(threads.slice(result.resolved), staleFindingNote);
        return result;
      }
    }

    return result;
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
      const errors = payload.errors ?? [];
      const detail = errors.length > 0 ? errors.map((error) => error.message).join('; ') : `HTTP ${response.status}`;
      const forbidden =
        response.status === 403
        || errors.some((error) => error.type === 'FORBIDDEN' || /not accessible by integration/i.test(error.message ?? ''));

      throw new GithubGraphqlError(`GitHub GraphQL request failed: ${detail}.`, { forbidden });
    }

    return payload.data;
  }

  // Unresolved threads whose first comment carries one of the finding markers, with that comment's
  // REST id so the thread can be marked when it cannot be resolved.
  async #listOpenFindingThreads(pullRequestNumber, findingIds) {
    const [owner, name] = this.#repository.split('/');
    const threads = [];
    let cursor = null;

    do {
      const data = await this.#graphql(FINDING_THREADS_QUERY, { cursor, name, number: pullRequestNumber, owner });
      const page = data.repository.pullRequest.reviewThreads;

      for (const thread of page.nodes) {
        const comment = thread.comments.nodes[0];
        const match = FINDING_COMMENT_MARKER_REGEX.exec(comment?.body ?? '');

        if (!thread.isResolved && match && findingIds.has(match[1])) {
          threads.push({ commentBody: comment.body, commentId: comment.databaseId, id: thread.id });
        }
      }

      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    return threads;
  }

  async #markFindingCommentsClosed(threads, staleFindingNote) {
    if (!staleFindingNote) {
      return 0;
    }

    let marked = 0;

    for (const thread of threads) {
      if (thread.commentBody.includes(FINDING_CLOSED_MARKER)) {
        continue;
      }

      await this.#send('PATCH', `pulls/comments/${thread.commentId}`, {
        body: closedFindingCommentBody(thread.commentBody, staleFindingNote),
      });
      marked += 1;
    }

    return marked;
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
      const permissionHint = response.status === 403 ? ' Ensure the workflow grants "pull-requests: write" permission.' : '';

      throw new Error(
        `GitHub API ${method} ${path} failed (HTTP ${response.status})${responseText ? `: ${responseText.slice(0, 300)}` : ''}.${permissionHint}`,
      );
    }

    return response.json();
  }
}

module.exports = {
  FINDING_CLOSED_MARKER,
  FINDING_COMMENT_MARKER_PREFIX,
  FINDING_COMMENT_MARKER_REGEX,
  GithubClient,
  STICKY_COMMENT_MARKER,
  closedFindingCommentBody,
  findingCommentMarker,
};
