# Clover Security Review Action

Runs a [Clover](https://clover.security) **lean security review** on every pull request in an
architectural design repository, and posts the results — a summary and tailored security framework
requirements (plus threats, when enabled for your tenant) — as a single sticky comment on the PR,
and posts open action items as inline review comments on the changed lines they apply to.
Re-pushing to the PR updates the comments in place.

## Prerequisites

1. **A Clover tenant API token** — create one in Clover, and store its client id and secret key as
   repository (or organization) secrets, e.g. `CLOVER_CLIENT_ID` and `CLOVER_SECRET_KEY`.
2. **The repository must be marked as a design repository in Clover** — the action reviews design
   PRs, not application code. If the repository is not flagged, the action reports a configuration
   error.

## Usage

```yaml
name: Clover Security Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  security-review:
    runs-on: ubuntu-latest
    steps:
      - uses: clover-security-public/security-review-action@v1
        with:
          client-id: ${{ secrets.CLOVER_CLIENT_ID }}
          secret-key: ${{ secrets.CLOVER_SECRET_KEY }}
```

A copy-paste-ready version of this workflow lives in
[`examples/clover-security-review.yml`](examples/clover-security-review.yml).

### <a name="permissions"></a>Permissions

`contents: read` and `pull-requests: write` are all the action needs to post and update the PR
comments. Resolving review threads is the one exception: GitHub allows the `resolveReviewThread`
mutation only for tokens with `contents: write` (a GitHub rule, see
[this discussion](https://github.com/orgs/community/discussions/44650)). With `contents: read`, the
action instead prepends "✅ No longer open in Clover" to the inline comment of a finding that is no
longer open and leaves the thread for a human to resolve. Grant `contents: write` to have those
threads resolved automatically — bearing in mind it also lets the job push to the repository.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `client-id` | yes | — | Client id of a Clover tenant API token. |
| `secret-key` | yes | — | Secret key of a Clover tenant API token. |
| `base-url` | no | `https://api.cloversec.io` | Clover API base URL for your region or dedicated environment. |
| `auth-base-url` | no | `https://auth.cloversec.io` | Clover authentication base URL. Dedicated environments usually keep the default. |
| `url` | no | the triggering PR | URL of the pull request to review. |
| `application-id` | no | resolved from the repository | Clover application to create the review under. |
| `wait-timeout` | no | `900` | Max seconds to wait for the review before giving up (a timeout never fails the build). |
| `fail-on-error` | no | `true` | Whether a failed review creation fails the build. |
| `recalculation` | no | `auto` | `auto` re-analyzes the existing review on every push that changed the design; `manual` only refreshes the summary and offers a "Re-analyze this pull request" checkbox in it (requires the workflow to also run on `issue_comment: [edited]`). |
| `max-inline-comments` | no | `10` | Maximum number of new inline review comments posted per run (server-clamped to 50; `0` posts the summary only). |
| `max-pending-findings` | no | — | Fail the run when pending findings at or above `blocking-priority` exceed this number. Empty (the default) never blocks. Ignored when `blocking-rules` is set. |
| `blocking-priority` | no | `high` | Lowest priority that counts toward `max-pending-findings`: `insignificant`, `low`, `medium`, `high` or `critical`. Ignored when `blocking-rules` is set. |
| `blocking-rules` | no | — | Blocking policy combining the review's importance with finding thresholds, one rule per line (see [Blocking pull requests](#blocking)). Replaces the two inputs above. |
| `min-inline-comment-priority` | no | all priorities | Lowest finding priority that gets an inline comment; findings below it stay in the summary only. |
| `paths` | no | all files | Glob patterns (newline- or comma-separated) of the files the review addresses. |
| `paths-ignore` | no | — | Glob patterns of files the review ignores, applied after `paths` (e.g. `.github/**`, `**/*.sh`). |
| `github-token` | no | `${{ github.token }}` | Token used to write the PR comments (see [Permissions](#permissions)). |

## Outputs

| Output | Description |
|---|---|
| `security-review-id` | Id of the created (or pre-existing) Clover security review. |
| `status` | `completed`, `blocked`, `timeout`, `failed`, `unsupported-repository` or `skipped`. |
| `comment-url` | URL of the sticky PR comment, when one was written. |
| `inline-comments` | Number of action items posted as inline review comments on the diff. |
| `pending-findings` | Total number of the review's pending findings, across all priorities. |
| `blocking-findings` | Number of pending findings at or above `blocking-priority`. |
| `review-importance` | The review's importance (the Clover public API's security-review importance), lowercased. |

## Behavior

- **Sticky comment** — the action writes one comment per PR (identified by a hidden marker) and
  updates it in place on subsequent runs.
- **Inline comments** — open requirements and threats (most severe first, up to
  `max-inline-comments` new ones per run, 10 by default) are placed by Clover on the specific
  changed lines they concern and posted as review comments written for those lines; findings without
  a precise location stay in the summary comment only. With `min-inline-comment-priority` set,
  findings below that priority never get an inline comment (existing comments on them are still
  resolved when the finding closes).
- **Design files only** — with `paths` / `paths-ignore` set, files outside the patterns (CI
  configuration, scripts, …) are excluded from the analysis, never receive inline comments, and do
  not count as design changes — a push touching only ignored files leaves the review "already up to
  date" instead of re-analyzing. The patterns sent by each run replace the ones stored on the
  review, so workflow edits take effect on the next push.
- <a name="blocking"></a>**Blocking pull requests** — the run fails after posting the results
  (`status: blocked`) when the blocking policy is exceeded. Make the workflow a required status
  check in branch protection to actually block merging. Timeouts and runs that could not reach
  Clover never block. Two ways to configure the policy:
  - **Simple**: `max-pending-findings` + `blocking-priority` — block when pending findings at or
    above the priority exceed the number.
  - **Rules** (`blocking-rules`, replaces the simple inputs): one rule per line, comma-separated
    clauses — `importance >= <priority>` gates the rule on the review's own importance (the value
    the Clover public API exposes as the review's importance; omitted = every review),
    `findings >= <priority>` sets the lowest finding priority counted (omitted = every priority),
    and `max <count>` (required) is the highest allowed count. The run fails when **any** rule is
    exceeded. Example — block high-importance reviews on any medium+ finding, and every review on
    any critical finding:

    ```yaml
    blocking-rules: |
      importance >= high, findings >= medium, max 0
      findings >= critical, max 0
    ```
- **Server-rendered content** — every comment body is rendered by Clover; the action only posts the
  returned markdown, so wording and layout update without a new action release.
- **Re-pushes** — pushing new commits re-runs the action; the existing review for the PR is reused.
  With `recalculation: auto` (default) it is re-analyzed when its design content changed (unchanged
  pushes cost nothing); with `recalculation: manual` nothing is re-analyzed until someone ticks the
  **Re-analyze this pull request** checkbox in the summary comment. Existing inline comments are
  never edited or moved: a re-run only adds comments for findings that have none yet, and closes
  the threads of findings that are no longer open (addressed by the change, or covered/dismissed in
  Clover) — resolving them with `contents: write`, otherwise marking the comment as no longer open
  (see [Permissions](#permissions)).
- **Every run is visible** — the summary comment always ends with a `Last run` line (time, commit,
  and what happened: new review, re-analysis completed, review already up to date, re-analysis
  skipped in manual mode, or still analyzing), so a run that changed nothing still leaves a trace.
- **Overlapping pushes** — the workflow template declares a per-PR `concurrency` group with
  `cancel-in-progress: true`, so a newer push cancels the previous run instead of two runs racing to
  comment. If the backend is still analyzing when a run asks for a re-analysis, the run simply waits
  for it; no error is reported.
- **Timeouts** — if the review takes longer than `wait-timeout`, the action logs a warning and
  exits successfully; the review keeps running in Clover and the next run posts its results.
- **Not a design repository** — if the PR's repository is not marked as a design repository in
  Clover, the action fails (or warns, with `fail-on-error: false`) with a message explaining how to
  fix it.

## Regions and dedicated environments

| Environment | `base-url` | `auth-base-url` |
|---|---|---|
| US | `https://api.cloversec.io` (default) | `https://auth.cloversec.io` (default) |
| UK | _contact Clover support_ | _contact Clover support_ |
| Dedicated (single-tenant) | your environment's API URL, e.g. `https://api-<name>.cloversec.io` | the default, unless Clover gave you a dedicated one |

Both inputs accept any HTTPS base URL — custom domains work the same way; ask Clover support for
your environment's values if you're unsure.

## Development

```sh
npm test
```

The action is dependency-free (Node 24, global `fetch`) — there is no build or bundling step.
