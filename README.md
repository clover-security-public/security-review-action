# Clover Security Review Action

Runs a [Clover](https://clover.security) **lean security review** on every pull request in an
architectural design repository, and posts the results — a summary and tailored security framework
requirements (plus threats, when enabled for your tenant) — as a single sticky comment on the PR.
Re-pushing to the PR updates the comment in place.

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

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `client-id` | yes | — | Client id of a Clover tenant API token. |
| `secret-key` | yes | — | Secret key of a Clover tenant API token. |
| `base-url` | no | `https://api.cloversec.io` | Clover API base URL for your region. |
| `auth-base-url` | no | `https://auth.cloversec.io` | Clover authentication base URL for your region. |
| `url` | no | the triggering PR | URL of the pull request to review. |
| `application-id` | no | resolved from the repository | Clover application to create the review under. |
| `wait-timeout` | no | `900` | Max seconds to wait for the review before giving up (a timeout never fails the build). |
| `fail-on-error` | no | `true` | Whether a failed review creation fails the build. |
| `github-token` | no | `${{ github.token }}` | Token used to write the sticky PR comment. |

## Outputs

| Output | Description |
|---|---|
| `security-review-id` | Id of the created (or pre-existing) Clover security review. |
| `status` | `completed`, `timeout`, `failed`, `unsupported-repository` or `skipped`. |
| `comment-url` | URL of the sticky PR comment, when one was written. |

## Behavior

- **Sticky comment** — the action writes one comment per PR (identified by a hidden marker) and
  updates it in place on subsequent runs.
- **Re-pushes** — pushing new commits re-runs the action; the existing review for the PR is reused
  and the comment refreshed.
- **Timeouts** — if the review takes longer than `wait-timeout`, the action logs a warning and
  exits successfully; the review keeps running in Clover and the next run posts its results.
- **Not a design repository** — if the PR's repository is not marked as a design repository in
  Clover, the action fails (or warns, with `fail-on-error: false`) with a message explaining how to
  fix it.

## Regions

| Region | `base-url` | `auth-base-url` |
|---|---|---|
| US | `https://api.cloversec.io` | `https://auth.cloversec.io` |
| UK | _contact Clover support_ | _contact Clover support_ |

## Development

```sh
npm test
```

The action is dependency-free (Node 24, global `fetch`) — there is no build or bundling step.
