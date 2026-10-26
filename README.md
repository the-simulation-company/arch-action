# Arch Action

Report successful deployments to Arch without giving Arch's hosted service access
to your repository. Your runner reads GitHub; Arch receives selected deployment
and PR metadata, records what is live, and coordinates QA across linked PRs.

## Install

An **Arch admin** configures your app's URL, saved test login, notification settings,
and one target for each repository/environment. They supply a target-scoped token
and a workflow using the automatically updated `@latest` Action. You save the token as the
repository secret `ARCH_DEPLOYMENT_TOKEN` and add that workflow.

The Action always reports to `https://api.foothill.sh`; no API URL configuration is
needed. Install the latest published release:

```yaml
uses: the-simulation-company/arch-action@latest
```

This is the Action reference, not a complete workflow. Use the admin-generated
template for your deployment system and target environment.

`latest` automatically advances after a stable release passes tests, including
across major versions. Subsequent runs pick up updates without a workflow edit.
Existing commit-pinned workflows need a one-time change to `@latest` to opt in.

### Your deployment workflow

Insert the Action after readiness in the existing deployment job. Map `deployed-sha`
to the actual deployed artifact, `deployment-id` to a unique deployment identity,
and `deployed-at` to the UTC completion time captured immediately after readiness.
`deployment-order` defaults to the workflow run number and breaks timestamp ties.
Serialize the entire environment deployment job with `cancel-in-progress: false`.
Do not assume `github.sha` identifies a separately selected deployment artifact.
`deployed-branch` optionally supplies that artifact's Git branch for Slack notifications.
It is inferred from a deployment status's qualified `refs/heads/` ref, or from the
workflow branch when its SHA matches `deployed-sha`. Bare provider refs can name
either branches or tags, so they are omitted unless `deployed-branch` is supplied. A separately selected artifact needs an explicit
`deployed-branch`; otherwise Arch shows just the environment. Deploy Core's branch-report
support before publishing this Action version, because older Core rejects the new field.

### Your hosting provider

Use the generated `deployment_status` workflow on the default branch. It filters
successes to your environment and derives identity, version and ordering from the
event, not the workflow SHA. Your provider must publish GitHub deployment statuses.
Events written by a workflow's `GITHUB_TOKEN` do not normally trigger another
workflow, so call this Action directly from existing deployment jobs.

### PR previews

Add the admin-generated preview workflow to your default branch, then add the
`arch-qa` label to PRs you want tested. It reuses `ARCH_DEPLOYMENT_TOKEN`:

```yaml
name: Arch PR preview QA
on:
  pull_request_target:
    types: [labeled]
  deployment_status:
permissions:
  contents: read
  pull-requests: read
  deployments: read
jobs:
  arch:
    if: >-
      (github.event_name == 'pull_request_target' && github.event.label.name == 'arch-qa') ||
      (github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success')
    runs-on: ubuntu-latest
    steps:
      - uses: the-simulation-company/arch-action@latest
        with:
          arch-token: ${{ secrets.ARCH_DEPLOYMENT_TOKEN }}
          mode: preview
```

Adding the label reports the current head's ready preview, or sends no report
until the provider publishes deployment success. New pushes run QA when their
previews become ready while the label remains. The Action rereads the PR's current
label, state and head before reporting: unlabeled or closed PRs and old commits
are skipped. The two events share `github:<deployment ID>`, so labeling an already
reported preview returns the same Arch run, even after QA finishes. HTTP retries
reuse that run too. To request fresh QA, use GitHub Actions **Re-run jobs**:
subsequent workflow attempts get a new QA identity for the same deployment.

Your provider must publish GitHub deployment statuses with an `environment_url`.
The environment defaults to `Preview`, matching Vercel; set `preview-environment`
for another preview environment. Production deployments are ignored. The URL
must be one of the app's allowed origins. This workflow runs only the published
Action; it never checks out or executes PR code.

For an existing deployment job, call `mode: preview` after readiness with explicit
`deployed-sha`, `preview-url` and a stable `deployment-id`. The label is still
required. Re-running the job requests fresh QA here too, including with an explicit
`deployment-id`. Automatic late-label lookup requires GitHub deployment records.
A preview never changes what Arch records as deployed for the target.

Deploy and refresh use `contents: read` and `pull-requests: read`; automatic previews
also need `deployments: read`. Install the Action in every
participating repository; no cross-repository credential or Arch GitHub App is needed.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `arch-token` | Required target-scoped secret issued by your Arch admin |
| `github-token` | Defaults to the repository's temporary `github.token` |
| `deployed-sha` | Full deployed commit SHA for direct workflow calls |
| `deployment-id` | Unique actual deployment identity; HTTP retries keep it |
| `deployed-at` | ISO completion timestamp captured at readiness, with timezone |
| `deployment-order` | Numeric tie breaker; defaults to `github.run_number` |
| `mode` | `deploy` (default), manual `refresh` of already-deployed PR links, or `preview` |
| `preview-url` | Ready PR preview URL for direct calls; otherwise inferred from deployment statuses |
| `preview-environment` | GitHub preview deployment environment; defaults to `Preview` |
| `release-merge` | How PRs reach this environment's branch: `merge` (default, also fast-forward) or `squash` |

The Action emits `app-url`, plus `report-id` for deploy and refresh, then exits after acceptance. It never
polls QA or waits for linked repositories. An actual redeployment uses a new ID,
even for the same commit. Do not change completion time on an HTTP retry.

## What leaves the runner

- Deployment identity, deployed commit, completion order and accepted-report cursor.
- Included PR numbers and merged revisions, original deployment-coordination sections.
- Titles and descriptions for newly shipped PRs.
- In preview mode: the open PR's number, title, description, head branch name and author (GitHub login and user ID), the preview commit and its URL.

GitHub credentials, files, diffs and raw API responses are not sent. This Action
does access repository APIs inside your runner. Using `@latest` means trusting
Arch's future releases, not just the code you reviewed today. Organizations that
require immutable Action references must approve that policy or retain a commit
pin. No executable dependencies are downloaded at runtime: this is a
Node 24 JavaScript Action using only the standard library.

## How reporting works

The Action reads `GET /v1/deployments/current`, computes metadata against the
accepted SHA, then submits bounded batches to `POST /v1/deployments`. Forward
history uses commit ancestry and PR associations, never merge timestamps alone.
It also scans merged PRs for merge commits in the deployed range, so every member
of a merged stack is included even when GitHub associates only its outer PR.
For forward deployments with a new commit, the Action compares the previous and
incoming Git commit trees. Identical tracked files produce a `no_code_change`
report: deployment/PR metadata advances without adding QA context or canceling
existing QA. This is local to the configured target, regardless of branch names.
First deployments, rollback/divergence, same-commit redeployments, refresh, and
explicit preview reruns keep their existing behavior. Tree reads must succeed;
configuration or external-service changes are not represented by a Git tree.

Deploy the Arch backend's `no_code_change` support before publishing this Action
version to `latest`; older backends reject the new field.

With `release-merge: squash`, an environment that receives another branch through
squash-merged release PRs (for example dev into staging) also reports the PRs behind
each deployed release PR's head that this target has not recorded yet. Releases
squashed without a PR report only their own commit.

Only numbered PRs supply QA change context. Unmatched commits, including branch
merge commits and direct pushes, still advance the recorded deployment but are
not reported as separate changes to test.
A later real deployment recovers omitted PRs at already-recorded merge commits
as historical coordination metadata, without resending their old QA descriptions.
Initialization and rollback/divergence rebuild the included-PR inventory; initial
history sends coordination sections without full old PR descriptions. Failed
GitHub reads fail the Action and cannot become an empty inventory.

Arch atomically accepts complete reports, handles duplicate HTTP requests and
delayed events, and rejects conflicting identity reuse. Stale inventory bases are
refreshed and recomputed. `@arch skip qa` is evaluated by Arch after recording the
deployment, so a skipped PR can satisfy another repository's dependency.
For staging targets (case-insensitive), same-repository staging-to-main release PRs are automatically reported as
metadata only, preserving membership and coordination without repeating QA.
Ordinary staging PRs and production hotfixes still supply QA context; no manual
skip directive is required on release PRs.

An admin-provided manual `workflow_dispatch` template with `mode: refresh` rereads
coordination metadata for the current deployed commit. It does not create new QA
context or invent another deployment. Arch preserves malformed blocks as visible
errors; fix the PR and rerun the refresh workflow.

## Development

Run `node --test` on Node 24. Tests use injected HTTP responses and cover trigger
selection, ancestry, inventories, pagination, stale bases and credential boundaries.

## Publishing

Merging into `main` automatically publishes a stable patch release; required
backend compatibility must be deployed before merging. The `Publish latest` workflow tests the code
on Node 24, then advances `latest` to the stable release's commit. Drafts and prereleases
are not promoted. The workflow can also be dispatched manually to retry promotion
or initialize the tag. Version tags stay unchanged; do not create a GitHub release
for the moving `latest` tag itself.

For a backport that should not reach all customers, leave "Set as the latest
release" unchecked. To roll back, mark the previous stable release as latest in
GitHub, then manually dispatch `Publish latest`; editing a release does not trigger
promotion automatically.

GitHub references: [deployment events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[token behavior](https://docs.github.com/en/actions/concepts/security/github_token),
[PR merge identities](https://docs.github.com/en/rest/pulls/pulls).
