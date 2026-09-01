'use strict';

const AUTH_TOKEN_ENDPOINT = 'identity/resources/auth/v2/api-token';
const PUBLIC_API_PREFIX = 'api/public';

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 2_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CloverApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CloverApiError';
    this.status = status;
  }
}

class CloverClient {
  #apiBaseUrl;
  #authBaseUrl;
  #clientId;
  #secretKey;
  #token = null;
  #tokenExpiresAt = 0;

  constructor({ apiBaseUrl, authBaseUrl, clientId, secretKey }) {
    this.#apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.#authBaseUrl = authBaseUrl.replace(/\/+$/, '');
    this.#clientId = clientId;
    this.#secretKey = secretKey;
  }

  createSecurityReview({ applicationId, url }) {
    const body = { url };

    if (applicationId) {
      body.applicationId = applicationId;
    }

    return this.#request('POST', 'security-review/create-by-url/github-action', body);
  }

  getAnalysisStatus(securityReviewId) {
    return this.#request('GET', `security-review/${securityReviewId}/analysis-status`);
  }

  // Ready-to-post markdown for the PR: sticky summary, new inline comments, stale finding ids,
  // plus the pending-finding counts per priority and the review's importance the blocking policy reads.
  getReviewContent(securityReviewId, { existingFindingIds, files, headSha, includeReAnalyzeCheckbox, maxInlineComments, minInlineCommentPriority, outcome }) {
    return this.#request('POST', `security-review/${securityReviewId}/github-pull-request-review-content`, {
      existingFindingIds,
      files,
      headSha,
      includeReAnalyzeCheckbox,
      maxInlineComments,
      minInlineCommentPriority,
      outcome,
    });
  }

  getCreationStatus(jobId) {
    return this.#request('GET', `security-review/creation-status/${jobId}`);
  }



  recalculateSecurityReview(securityReviewId) {
    return this.#request('POST', `security-review/${securityReviewId}/recalculate/github-action`);
  }




  async #getToken() {
    if (this.#token && Date.now() < this.#tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.#token;
    }

    const response = await fetch(`${this.#authBaseUrl}/${AUTH_TOKEN_ENDPOINT}`, {
      body: JSON.stringify({ clientId: this.#clientId, secret: this.#secretKey }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    if (!response.ok) {
      throw new CloverApiError(
        `Clover authentication failed (HTTP ${response.status}). Check the client-id and secret-key secrets.`,
        response.status,
      );
    }

    const payload = await response.json();
    this.#token = payload.access_token;
    this.#tokenExpiresAt = Date.now() + payload.expires_in * 1000;

    return this.#token;
  }

  async #request(method, path, body) {
    let lastError;

    for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.#requestOnce(method, path, body);
      } catch (error) {
        const transient =
          error.name !== 'CloverApiError' || error.status >= 500 || error.status === 429;

        if (!transient || attempt === TRANSIENT_RETRY_ATTEMPTS) {
          throw error;
        }

        lastError = error;
        await sleep(TRANSIENT_RETRY_BASE_DELAY_MS * attempt);
      }
    }

    throw lastError;
  }

  async #requestOnce(method, path, body) {
    let response = await this.#send(method, path, body);

    // A 401 means the cached bearer went stale server-side — refresh once and retry.
    if (response.status === 401) {
      this.#token = null;
      response = await this.#send(method, path, body);
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new CloverApiError(
        `Clover API ${method} /${path} failed (HTTP ${response.status})${responseText ? `: ${responseText.slice(0, 500)}` : ''}`,
        response.status,
      );
    }

    return response.json();
  }

  async #send(method, path, body) {
    const token = await this.#getToken();

    if (method === 'POST' && body === undefined) {
      body = {};
    }

    return fetch(`${this.#apiBaseUrl}/${PUBLIC_API_PREFIX}/${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method,
    });
  }
}

module.exports = { CloverApiError, CloverClient, sleep };
