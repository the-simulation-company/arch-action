# Arch Action

Report successful deployments to Arch without giving Arch's hosted service access
to your repository. Your runner reads GitHub; Arch receives selected deployment
and PR metadata, records what is live, and coordinates QA across linked PRs.

## Install

An **Arch admin** configures your app's URL, saved test login, notification settings,
and one target for each repository/environment. They supply a target-scoped token
and a workflow pinned to the reviewed full commit SHA. You save the token as the
repository secret `ARCH_DEPLOYMENT_TOKEN` and add that workflow.

The production API is `https://api.foothill.sh`. Pin the reviewed release, not a
moving branch or tag:

```yaml
uses: the-simulation-company/arch-action@717b2f967670c59d06a77f17a905376d19b89254 # v1.0.0
```

This is the Action reference, not a complete workflow. Use the admin-generated
template for your deployment system and target environment.

### Your deployment workflow

Insert the Action after readiness in the existing deployment job. Map `deployed-sha`
to the actual deployed artifact, `deployment-id` to a unique deployment identity,
and `deployed-at` to the UTC completion time captured immediately after readiness.
`deployment-order` defaults to the workflow run number and breaks timestamp ties.
Serialize the entire environment deployment job with `cancel-in-progress: false`.
Do not assume `github.sha` identifies a separately selected deployment artifact.

### Your hosting provider

Use the generated `deployment_status` workflow on the default branch. It filters
successes to your environment and derives identity, version and ordering from the
event, not the workflow SHA. Your provider must publish GitHub deployment statuses.
Events written by a workflow's `GITHUB_TOKEN` do not normally trigger another
workflow, so call this Action directly from existing deployment jobs.

The Action uses only `contents: read` and `pull-requests: read`. Install it in every
participating repository; no cross-repository credential or Arch GitHub App is needed.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `arch-token` | Required target-scoped secret issued by your Arch admin |
| `api-url` | Required Arch API HTTPS origin supplied by your admin |
| `github-token` | Defaults to the repository's temporary `github.token` |
| `deployed-sha` | Full deployed commit SHA for direct workflow calls |
| `deployment-id` | Unique actual deployment identity; HTTP retries keep it |
| `deployed-at` | ISO completion timestamp captured at readiness, with timezone |
| `deployment-order` | Numeric tie breaker; defaults to `github.run_number` |
| `mode` | `deploy` (default) or manual `refresh` of already-deployed PR links |

The Action emits `report-id` and `app-url`, then exits after acceptance. It never
polls QA or waits for linked repositories. An actual redeployment uses a new ID,
even for the same commit. Do not change completion time on an HTTP retry.

## What leaves the runner

- Deployment identity, deployed commit, completion order and accepted-report cursor.
- Included PR numbers and merged revisions, original deployment-coordination sections.
- Titles and descriptions for newly shipped changes; bounded direct-commit messages.

GitHub credentials, files, diffs and raw API responses are not sent. This Action
does access repository APIs inside your runner, so inspect the code and pin a
reviewed commit. No executable dependencies are downloaded at runtime: this is a
Node 24 JavaScript Action using only the standard library.

## How reporting works

The Action reads `GET /v1/deployments/current`, computes metadata against the
accepted SHA, then submits bounded batches to `POST /v1/deployments`. Forward
history uses commit ancestry and PR associations, never merge timestamps alone.
Initialization and rollback/divergence rebuild the included-PR inventory; initial
history sends coordination sections without full old PR descriptions. Failed
GitHub reads fail the Action and cannot become an empty inventory.

Arch atomically accepts complete reports, handles duplicate HTTP requests and
delayed events, and rejects conflicting identity reuse. Stale inventory bases are
refreshed and recomputed. `@arch skip qa` is evaluated by Arch after recording the
deployment, so a skipped PR can satisfy another repository's dependency.

An admin-provided manual `workflow_dispatch` template with `mode: refresh` rereads
coordination metadata for the current deployed commit. It does not create new QA
context or invent another deployment. Arch preserves malformed blocks as visible
errors; fix the PR and rerun the refresh workflow.

## Development

Run `node --test` on Node 24. Tests use injected HTTP responses and cover trigger
selection, ancestry, inventories, pagination, stale bases and credential boundaries.

GitHub references: [deployment events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[token behavior](https://docs.github.com/en/actions/concepts/security/github_token),
[PR merge identities](https://docs.github.com/en/rest/pulls/pulls).
