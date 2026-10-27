import test from 'node:test';
import assert from 'node:assert/strict';
import {batches, collect, coordination, createClient, currentDeployment, deploymentInput, previewInput, pullRequestCommits, run}
  from './index.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const state = {report_id: 'previous', revision: a, repository: 'acme/web', environment: 'staging', prs: [], next_after: null};
const env = {GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_NUMBER: '20', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1'};
const deployment = {mode: 'deploy', revision: b, deployed_at: '2026-10-07T12:00:00Z', order: 20, deployment_id: 'd-20'};
const inputs = {'arch-token': 'arch-secret', 'github-token': 'github-secret',
  'deployed-sha': b, 'deployed-at': deployment.deployed_at, 'deployment-id': deployment.deployment_id,
  'commit-messages': 'false'};
const pr = (number, sha, body = 'Test checkout') => ({number, merge_commit_sha: sha, merged_at: '2026-10-01', title: 'Checkout', body,
  base: {repo: {full_name: 'acme/web'}},
  diff_url: 'do-not-send', head: {repo: {source: 'do-not-send'}}, user: {email: 'do-not-send'}});
const reply = (data, status = 200) => new Response(JSON.stringify(data), {status});
const comparison = (commits, base = a, trees = {}) => ({status: 'ahead',
  base_commit: {sha: base, commit: {tree: {sha: trees[base] || base}}},
  commits: commits.map(commit => ({...commit, commit: {...commit.commit, tree: {sha: trees[commit.sha] || commit.sha}}})),
});

test('direct input uses actual deployed SHA, not workflow SHA', () => {
  assert.deepEqual(deploymentInput(inputs, {}, {...env, GITHUB_SHA: a}, state), deployment);
  assert.throws(() => deploymentInput({}, {}, env, state), /Pass deployed-sha/);
  assert.throws(() => deploymentInput({...inputs, mode: 'refesh'}, {}, env, state), /Mode must be/);
});

test('timezone-free completion fails before GitHub reads or reporting', async () => {
  let calls = 0;
  await assert.rejects(run({...inputs, 'deployed-at': '2026-10-07T12:00:00'}, {}, env,
    async () => {calls++; return reply(state);}), /Invalid deployed commit, completion time or ordering/);
  assert.equal(calls, 1);
});

test('foreign PR associations never supply descriptions or membership', async () => {
  const foreign = {...pr(2, b, 'Foreign private description'), base: {repo: {full_name: 'other/repo'}}};
  const result = await collect(async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b, commit: {message: 'Local commit'}}]);
    if (path.includes('/pulls?state=closed')) return [foreign];
    if (path.includes(`/commits/${b}/pulls`)) return [foreign];
    throw Error(path);
  }, state.repository, state, deployment);
  assert.deepEqual(result.prs, []);
  assert.doesNotMatch(JSON.stringify(result), /Foreign private description|other\/repo/);
  assert.deepEqual(result.commits, []);
});

test('provider event filters success/environment and uses event identity/order', () => {
  const event = {deployment: {id: 12, environment: 'staging', sha: c}, deployment_status: {id: 99, state: 'success', created_at: deployment.deployed_at}};
  const actual = deploymentInput(inputs, event, {...env, GITHUB_EVENT_NAME: 'deployment_status'}, state);
  assert.equal(actual.revision, c);
  assert.equal(actual.order, 99);
  assert.equal(actual.deployment_id, 'github:12:99');
  assert.equal(deploymentInput(inputs, event, {...env, GITHUB_EVENT_NAME: 'deployment_status'}, {...state, environment: 'production'}), null);
  event.deployment_status.state = 'failure';
  assert.equal(deploymentInput(inputs, event, {...env, GITHUB_EVENT_NAME: 'deployment_status'}, state), null);
});

test('coordination retains malformed and duplicate blocks for server parser', () => {
  const section = '## Deployment coordination\n- Related PRs:\n  - https://github.com/acme/api/pull/2';
  assert.equal(coordination('Private unrelated\n' + section + '\n## QA\nSecret narrative'), section);
  assert.equal(coordination(section + '\n' + section), section + '\n' + section);
  assert.equal(coordination('## Deployment coordination\ninvalid'), '## Deployment coordination\ninvalid');
});

test('initialization includes merged, squash, rebase heads but not timestamp-only matches', async () => {
  const initial = {...state, revision: null, report_id: null};
  const get = async path => {
    if (path.includes('/commits?')) return [{sha: a}, {sha: b}, {sha: c}];
    if (path.includes('/pulls?state=closed')) return [pr(1, a), pr(2, b), pr(3, c), pr(4, 'd'.repeat(40))];
    if (path.includes(`/commits/${b}/pulls`)) return [pr(2, b)];
    throw Error(path);
  };
  const result = await collect(get, state.repository, initial, deployment);
  assert.equal(result.inventory, 'replace');
  assert.deepEqual(result.prs.map(p => p.number), [1, 2, 3]);
  assert.equal(result.prs[0].body, null);
  assert.equal(result.prs[1].body, 'Test checkout');
  assert.equal(result.prs[2].body, null);
  assert.doesNotMatch(JSON.stringify(result), /do-not-send|diff_url|merged_at|email/);
});

test('initial head without associated PR selects historical regression', async () => {
  const get = async path => {
    if (path.includes('/commits?')) return [{sha: b}];
    if (path.includes('/pulls')) return [];
    if (path.endsWith(`/commits/${b}`)) return {commit: {message: 'bootstrap'}};
    throw Error(path);
  };
  const result = await collect(get, state.repository, {...state, revision: null}, deployment);
  assert.equal(result.historical, true);
  assert.equal(result.no_code_change, false);
  assert.deepEqual(result.commits, []);
});

test('forward comparison reports numbered PRs and omits unmatched commits', async () => {
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}, {sha: c, commit: {message: "Merge commit 'old-branch' into HEAD"}, files: ['private code']}]);
    if (path.includes('/pulls?state=closed')) return [pr(2, b)];
    if (path.includes(`/commits/${b}/pulls`)) return [pr(2, b)];
    if (path.includes(`/commits/${c}/pulls`)) return [];
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.equal(result.inventory, 'delta');
  assert.equal(result.no_code_change, false);
  assert.equal(result.prs[0].number, 2);
  assert.deepEqual(result.commits, []);
  assert.doesNotMatch(JSON.stringify(result), /Merge commit|private code/);
});

for (const environment of ['staging', 'Staging', 'production']) test(`release synchronization in ${environment} preserves membership and filters only staging release QA`, async () => {
  const release = {...pr(876, b, 'Release stable issue IDs'),
    base: {...pr(876, b).base, ref: 'main'}, head: {ref: 'staging', repo: {full_name: 'ACME/web'}}};
  const feature = {...pr(386, b), base: {...pr(386, b).base, ref: 'staging'}, head: {ref: 'feature'}};
  const hotfix = {...pr(877, b), base: {...pr(877, b).base, ref: 'main'}, head: {ref: 'hotfix'},
    labels: [{name: 'production-now'}]};
  const fork = {...release, number: 878, body: 'Test checkout', head: {ref: 'staging', repo: {full_name: 'alice/web'}}};
  const unknownHead = {...release, number: 879, body: 'Test checkout', head: {ref: 'staging', repo: null}};
  for (const prs of [[release], [release, feature, hotfix, fork, unknownHead]]) {
    const result = await collect(async path => {
      if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}]);
      if (path.includes('/pulls?state=closed') || path.includes(`/commits/${b}/pulls`)) return prs;
      if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
      throw Error(path);
    }, state.repository, {...state, environment}, deployment);
    assert.equal(result.historical, false);
    assert.equal(result.prs.length, prs.length);
    assert.equal(result.prs.find(p => p.number === 876).body,
      environment.toLowerCase() === 'staging' ? null : release.body);
    for (const other of result.prs.filter(p => p.number !== 876)) assert.equal(other.body, 'Test checkout');
  }
});

test('forward deployment includes every stacked PR at a deployed merge commit', async () => {
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}]);
    if (path.includes('/pulls?state=closed')) return path.includes('page=2')
      ? [pr(2, b), pr(3, b)] : Array.from({length: 100}, (_, i) => pr(i + 10, c));
    if (path.includes(`/commits/${b}/pulls`)) return [pr(2, b)];
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.equal(result.inventory, 'delta');
  assert.equal(result.no_code_change, false);
  assert.deepEqual(result.prs.map(p => [p.number, p.body]), [[2, 'Test checkout'], [3, 'Test checkout']]);
  assert.deepEqual(result.commits, []);
});

test('a real redeployment recovers missing stack members as historical metadata', async () => {
  const get = async path => {
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical', commits: []};
    if (path.includes('/pulls?state=closed')) return [pr(1, a), pr(2, a), pr(3, c), pr(4, b)];
    throw Error(path);
  };
  const current = {...state, revision: b, prs: [{number: 1, revision: a}]};
  const result = await collect(get, state.repository, current, deployment);
  assert.equal(result.inventory, 'delta');
  assert.equal(result.no_code_change, false);
  assert.deepEqual(result.prs.map(p => [p.number, p.revision, p.body]), [[2, a, null], [4, b, null]]);
  assert.deepEqual(result.commits, []);
});

test('pagination never silently truncates commit ranges or closed PRs', async () => {
  const calls = [];
  const commits = Array.from({length: 100}, (_, i) => ({sha: i.toString(16).padStart(40, '0'), commit: {message: 'fix'}}));
  const get = async path => {
    calls.push(path);
    if (path.includes('/compare/')) return comparison(path.includes('page=2') ? [{sha: b, commit: {message: 'last'}}] : [...commits]);
    if (path.includes('/pulls?state=closed')) return [pr(2, b)];
    if (path.includes('/pulls')) return [];
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.deepEqual(result.prs.map(p => p.number), [2]);
  assert.deepEqual(result.commits, []);
  assert(calls.some(p => p.includes('page=2')));
});

for (const status of ['behind', 'diverged']) test(`${status} rebuilds membership and selects regression`, async () => {
  const get = async path => {
    if (path.includes('/compare/')) return {status};
    if (path.includes('/commits?')) return [{sha: a}];
    if (path.includes('/pulls?')) return [pr(1, a), pr(2, b)];
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.equal(result.inventory, 'replace');
  assert.equal(result.historical, true);
  assert.equal(result.no_code_change, false);
  assert.deepEqual(result.prs.map(p => p.number), [1]);
  assert.equal(result.prs[0].body, null);
});

test('manual refresh updates coordination without adding newly associated PRs', async () => {
  const get = async path => {
    if (path.includes('/pulls?')) return [pr(1, a, '## Deployment coordination\nEdited block'), pr(2, a)];
    throw Error(path);
  };
  const current = {...state, prs: [{number: 1, revision: a}]};
  const result = await collect(get, state.repository, current, {...deployment, mode: 'refresh'});
  assert.equal(result.historical, false);
  assert.deepEqual(result.prs.map(p => [p.number, p.revision]), [[1, a]]);
  assert.equal(result.prs[0].body, null);
  assert.match(result.prs[0].coordination, /Edited block/);
  assert.deepEqual(result.commits, []);
});

for (const available of [[], [pr(1, b)]]) test(`refresh rejects ${available.length ? 'changed' : 'missing'} recorded PRs`, async () => {
  const current = {...state, prs: [{number: 1, revision: a}]};
  await assert.rejects(collect(async () => available, state.repository, current,
    {...deployment, mode: 'refresh'}), /Metadata refresh/);
});

test('partial GitHub failure never submits an empty replacement', async () => {
  let posted = false;
  const fetcher = async (url, options) => {
    if (url.host === 'api.foothill.sh') {
      if (options.method === 'POST') posted = true;
      return reply({...state, revision: null, report_id: null});
    }
    if (url.pathname.endsWith('/commits')) return reply([{sha: b}]);
    return reply({private: 'never-log'}, 403);
  };
  await assert.rejects(run(inputs, {}, env, fetcher), /HTTP 403/);
  assert.equal(posted, false);
});

test('tokens remain on fixed origins and outgoing payload is metadata-only', async () => {
  const sent = [];
  const fetcher = async (url, options) => {
    if (url.host === 'api.github.com') {
      assert.equal(options.headers.Authorization, 'Bearer github-secret');
      assert.equal(options.redirect, 'error');
      if (url.pathname.endsWith('/pulls')) return reply([]);
      return reply({status: 'identical', commits: []});
    }
    assert.equal(url.origin, 'https://api.foothill.sh');
    assert.equal(options.headers.Authorization, 'Bearer arch-secret');
    if (options.method === 'GET') return reply(state);
    sent.push(JSON.parse(options.body));
    return reply({status: 'accepted', report_id: 'accepted'});
  };
  await run({...inputs, 'deployed-branch': 'staging', 'api-url': 'https://evil.example'}, {}, env, fetcher);
  assert.equal(sent[0].header.branch, 'staging');
  assert.equal(sent[0].header.revision, b);
  assert.doesNotMatch(JSON.stringify(sent), /github-secret|arch-secret|source|diff/);
  await assert.rejects(createClient('https://api.github.com', 'token')('https://evil.example/'), /Cross-origin/);
});

test('stale inventory refreshes cursor and recomputes without changing deployment identity', async () => {
  let gets = 0;
  const sent = [];
  const fetcher = async (url, options) => {
    if (url.host === 'api.github.com') return reply(url.pathname.endsWith('/pulls') ? [] : {status: 'identical', commits: []});
    if (options.method === 'GET') return reply({...state, report_id: ++gets === 1 ? 'old' : 'new'});
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? reply({code: 'stale_inventory'}, 409) : reply({status: 'accepted'});
  };
  await run(inputs, {}, env, fetcher);
  assert.deepEqual(sent.map(p => p.header.expected_report_id), ['old', 'new']);
  assert.equal(sent[0].header.deployment_id, sent[1].header.deployment_id);
});

test('inventory pagination pins report identity', async () => {
  const paths = [];
  const result = await currentDeployment(async path => {
    paths.push(path);
    return paths.length === 1 ? {...state, prs: [{number: 1}], next_after: 1} : {prs: [{number: 2}], next_after: null};
  });
  assert(paths[1].includes('report_id=previous'));
  assert.equal(result.prs.length, 2);
});

test('batching respects both count and UTF-8 byte size', () => {
  const prs = Array.from({length: 1001}, (_, i) => ({number: i + 1}));
  assert.deepEqual(batches({prs, removed: [], commits: []}).map(p => p.prs.length), [500, 500, 1]);
  assert.throws(() => batches({prs: [{body: 'x'.repeat(900000)}], removed: [], commits: []}), /exceeds batch/);
});

test('preview reports the event PR without reading or changing the deployed inventory', async () => {
  const sent = [];
  const current = {...pr(12, null, 'Private preview description'), state: 'open',
    head: {sha: c, ref: 'feature/checkout'}, user: {login: 'octo', id: 7}, labels: [{name: 'arch-qa'}]};
  const event = {pull_request: current};
  const receipt = await run({...inputs, mode: 'preview', 'deployed-sha': '', 'deployment-id': '',
    'preview-url': 'https://pr-12.preview.example', 'commit-messages': ''}, event, env, async (url, options) => {
    if (url.pathname === '/repos/acme/web/pulls/12') return reply(current);
    if (url.pathname === '/repos/acme/web/pulls/12/commits') return reply([
      {sha: a, parents: [{}], commit: {message: 'Add card form'}},
      {sha: b, parents: [{}, {}], commit: {message: "Merge branch 'staging' into feature/checkout"}},
    ]);
    sent.push([url.href, options.body && JSON.parse(options.body)]);
    return reply({status: 'accepted', goal_run_id: 'run-1', app_url: 'https://arch.example/run'});
  });
  assert.equal(receipt.goal_run_id, 'run-1');
  assert.deepEqual(sent, [['https://api.foothill.sh/v1/deployments/preview', {
    repository: 'acme/web', revision: c, url: 'https://pr-12.preview.example', deployment_id: '100:1',
    pr: {number: 12, title: 'Checkout', body: 'Private preview description',
      branch: 'feature/checkout', author: {login: 'octo', id: 7},
      commits: [{revision: a, message: 'Add card form'}]},
  }]]);
});

test('preview outside a PR event finds the one open PR serving that commit', async () => {
  const open = {...pr(7, null), state: 'open', head: {sha: c}, labels: [{name: 'arch-qa'}]};
  const fetcher = pulls => async url => {
    if (url.pathname === `/repos/acme/web/commits/${c}/pulls`) return reply(pulls);
    if (url.pathname === '/repos/acme/web/pulls/7') return reply(open);
    if (url.pathname === '/v1/deployments/preview') return reply({status: 'accepted'});
    throw Error(url.href);
  };
  const previewInputs = {...inputs, mode: 'preview', 'deployed-sha': c, 'preview-url': 'https://p.example'};
  assert.equal((await run(previewInputs, {}, env, fetcher([open, {...open, number: 8, state: 'closed'}]))).status, 'accepted');
  assert.equal(await run(previewInputs, {}, env, fetcher([{...open, head: {sha: a}}])), null);
  assert.throws(() => previewInput({...previewInputs, 'preview-url': ''}, {}, env), /preview-url/);
});

test('closed event PR sends no preview report', async () => {
  const event = {pull_request: {...pr(12, null), state: 'closed', head: {sha: c}}};
  assert.equal(await run({...inputs, mode: 'preview', 'preview-url': 'https://p.example'}, event, env,
    async url => { throw Error(url.href); }), null);
});

test('preview ambiguity is checked after rereading eligibility for every matching PR', async () => {
  const first = {...pr(7, null), state: 'open', head: {sha: c}, labels: [{name: 'arch-qa'}]};
  const second = {...first, number: 8};
  const previewInputs = {...inputs, mode: 'preview', 'deployed-sha': c, 'preview-url': 'https://p.example'};
  let currentSecond = {...second, labels: []};
  const reports = [];
  const fetcher = async (url, options) => {
    if (url.pathname === `/repos/acme/web/commits/${c}/pulls`) return reply([first, second]);
    if (url.pathname === '/repos/acme/web/pulls/7') return reply(first);
    if (url.pathname === '/repos/acme/web/pulls/8') return reply(currentSecond);
    if (url.pathname === '/v1/deployments/preview') {
      reports.push(JSON.parse(options.body));
      return reply({status: 'accepted'});
    }
    throw Error(url.href);
  };
  for (const other of [{...second, labels: []}, {...second, state: 'closed'}, {...second, head: {sha: b}}]) {
    currentSecond = other;
    assert.equal((await run(previewInputs, {}, env, fetcher)).status, 'accepted');
  }
  assert.deepEqual(reports.map(report => report.pr.number), [7, 7, 7]);
  currentSecond = second;
  await assert.rejects(run(previewInputs, {}, env, fetcher), /More than one arch-qa PR/);
  assert.equal(reports.length, 3);
});

test('labeling a ready preview and deployment success report the same deployment identity', async () => {
  const current = {...pr(7, null), state: 'open', head: {sha: c}, labels: [{name: 'arch-qa'}]};
  const deployment = {id: 12, sha: c, environment: 'Preview', production_environment: false};
  const status = {id: 99, state: 'success', environment_url: 'https://p.example'};
  const reports = [];
  const previewInputs = {'arch-token': inputs['arch-token'], 'github-token': inputs['github-token'], mode: 'preview',
    'commit-messages': 'false'};
  const fetcher = async (url, options) => {
    if (url.pathname === `/repos/acme/web/commits/${c}/pulls`) return reply([current]);
    if (url.pathname === '/repos/acme/web/pulls/7') return reply(current);
    if (url.pathname === '/repos/acme/web/deployments') {
      assert.equal(url.searchParams.get('sha'), c);
      assert.equal(url.searchParams.get('environment'), 'Preview');
      return reply([deployment]);
    }
    if (url.pathname === '/repos/acme/web/deployments/12/statuses') {
      assert.equal(url.searchParams.get('per_page'), '1');
      return reply([status]);
    }
    if (url.pathname === '/v1/deployments/preview') {
      reports.push(JSON.parse(options.body));
      return reply({status: 'accepted'});
    }
    throw Error(url.href);
  };
  await run(previewInputs, {deployment, deployment_status: status}, env, fetcher);
  // The queued label event is only a reference; current GitHub state controls opt-in.
  await run(previewInputs, {pull_request: {...current, labels: []}},
    {...env, GITHUB_RUN_ID: '101'}, fetcher);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(reports[0].deployment_id, 'github:12');
  // A deliberate job rerun requests fresh QA, while retries of that attempt still dedupe.
  const rerun = {...env, GITHUB_RUN_ATTEMPT: '2'};
  await run(previewInputs, {deployment, deployment_status: status}, rerun, fetcher);
  await run(previewInputs, {deployment, deployment_status: status}, rerun, fetcher);
  assert.equal(reports[2].deployment_id, 'github:12:retry:100:2');
  assert.deepEqual(reports[2], reports[3]);
  const direct = {...previewInputs, 'preview-url': status.environment_url, 'deployment-id': 'deploy-12'};
  assert.equal(previewInput(direct, {pull_request: current}, rerun).deployment_id, 'deploy-12:retry:100:2');
});

test('label before readiness waits; ready previews of new pushes get new identities', async () => {
  let head = c;
  let ready = false;
  const reports = [];
  const current = () => ({...pr(7, null), state: 'open', head: {sha: head}, labels: [{name: 'arch-qa'}]});
  const deployment = () => ({id: head === c ? 12 : 13, sha: head, environment: 'Preview'});
  const status = () => ({state: ready ? 'success' : 'in_progress', environment_url: 'https://p.example'});
  const previewInputs = {'arch-token': inputs['arch-token'], 'github-token': inputs['github-token'], mode: 'preview',
    'commit-messages': 'false'};
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('/pulls/7')) return reply(current());
    if (url.pathname.endsWith('/pulls')) return reply([current()]);
    if (url.pathname.endsWith('/deployments')) return reply([deployment()]);
    if (url.pathname.endsWith('/statuses')) return reply([status()]);
    if (url.pathname === '/v1/deployments/preview') {
      reports.push(JSON.parse(options.body));
      return reply({status: 'accepted'});
    }
    throw Error(url.href);
  };
  assert.equal(await run(previewInputs, {pull_request: current()}, env, fetcher), null);
  ready = true;
  await run(previewInputs, {deployment: deployment(), deployment_status: status()}, env, fetcher);
  head = b;
  await run(previewInputs, {deployment: deployment(), deployment_status: status()}, env, fetcher);
  assert.deepEqual(reports.map(({revision, deployment_id}) => [revision, deployment_id]),
    [[c, 'github:12'], [b, 'github:13']]);
});

test('preview rereads labels, state and head and skips events that are no longer eligible', async () => {
  const queued = {...pr(7, null), state: 'open', head: {sha: c}, labels: [{name: 'arch-qa'}]};
  const previewInputs = {...inputs, mode: 'preview', 'deployed-sha': c, 'preview-url': 'https://p.example'};
  for (const current of [
    {...queued, labels: []}, {...queued, state: 'closed'}, {...queued, head: {sha: b}},
  ]) {
    assert.equal(await run(previewInputs, {pull_request: queued}, env, async url => {
      assert.equal(url.pathname, '/repos/acme/web/pulls/7');
      return reply(current);
    }), null);
  }
});

test('failed, staging and production deployment events never report previews', async () => {
  const previewInputs = {...inputs, mode: 'preview'};
  for (const event of [
    {deployment: {environment: 'Preview'}, deployment_status: {state: 'failure'}},
    {deployment: {environment: 'staging'}, deployment_status: {state: 'success'}},
    {deployment: {environment: 'Preview', production_environment: true}, deployment_status: {state: 'success'}},
  ]) {
    assert.equal(await run(previewInputs, event, env, async url => {throw Error(url.href);}), null);
  }
});

for (const environment of ['staging', 'UAT', 'Production']) test(`identical trees report only metadata in ${environment}`, async () => {
  const body = 'Release\n## Deployment coordination\n- Related PRs:\n  - https://github.com/acme/api/pull/2';
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}], a, {[b]: a});
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    if (path.includes('/pulls')) return [pr(2, b, body)];
    throw Error(path);
  };
  const result = await collect(get, state.repository, {...state, environment}, deployment);
  assert.equal(result.no_code_change, true);
  assert.equal(result.historical, false);
  assert.equal(result.inventory, 'delta');
  assert.deepEqual(result.prs, [{number: 2, revision: b, title: '', body: null, coordination: coordination(body)}]);
});

for (const broken of [null, {}, {sha: c, commit: {tree: {sha: c}}}]) test(`invalid commit trees never suppress QA: ${JSON.stringify(broken)}`, async () => {
  let posted = false;
  await assert.rejects(run(inputs, {}, env, async (url, options) => {
    if (url.host === 'api.foothill.sh') {
      if (options.method === 'POST') posted = true;
      return reply(state);
    }
    if (url.pathname.includes('/compare/')) {
      return broken === null ? reply({}, 403) : reply({...comparison([{sha: b}]), base_commit: broken});
    }
    throw Error(url.href);
  }), /HTTP 403|Incomplete commit tree response/);
  assert.equal(posted, false);
});

test('unchanged-code decision is recomputed after a concurrent deployment changes the base', async () => {
  let reads = 0;
  const sent = [];
  const get = async (url, options) => {
    if (url.host === 'api.foothill.sh') {
      if (options.method === 'GET') return reply({...state, report_id: ++reads === 1 ? 'old' : 'new', revision: reads === 1 ? a : c});
      sent.push(JSON.parse(options.body));
      return sent.length === 1 ? reply({code: 'stale_inventory'}, 409) : reply({status: 'accepted'});
    }
    if (url.pathname.includes('/compare/')) return reply(comparison([{sha: b}], reads === 1 ? a : c, {[b]: a}));
    if (url.pathname.endsWith('/pulls')) return reply([pr(2, b)]);
    throw Error(url.href);
  };
  await run(inputs, {}, env, get);
  assert.equal(sent[0].header.no_code_change, true);
  assert.equal(sent[0].prs[0].body, null);
  assert.equal(sent[1].header.no_code_change, undefined);
  assert.equal(sent[1].prs[0].body, 'Test checkout');
  assert.equal(sent[0].header.deployment_id, sent[1].header.deployment_id);
});

test('redelivery reproduces the original unchanged-code report instead of treating it as a redeployment', async () => {
  const sent = [];
  await run({...inputs, 'deployed-branch': 'staging'}, {}, env, async (url, options) => {
    if (url.host === 'api.foothill.sh') {
      if (options.method === 'GET') return reply(url.searchParams.has('report_id') ? state : {
        ...state, report_id: 'accepted', revision: b, deployment_id: deployment.deployment_id, expected_report_id: state.report_id,
      });
      sent.push(JSON.parse(options.body));
      return reply({status: 'accepted'});
    }
    if (url.pathname.includes('/compare/')) return reply(comparison([{sha: b}], a, {[b]: a}));
    if (url.pathname.endsWith('/pulls')) return reply([pr(2, b)]);
    throw Error(url.href);
  });
  assert.equal(sent[0].header.no_code_change, true);
  assert.equal(sent[0].header.expected_report_id, state.report_id);
  assert.equal(sent[0].header.branch, undefined); // Preserve the pre-upgrade retry hash.
});

test('squash releases report the PRs behind the release PR head, once', async () => {
  const dev = 'd'.repeat(40), e = 'e'.repeat(40), f = 'f'.repeat(40), old = '0'.repeat(40);
  const release = {...pr(9, b, 'Release dev'), head: {sha: dev}};
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}]);
    if (path.includes(`/compare/${a}...${dev}`)) return {status: 'diverged', commits: [{sha: e}, {sha: f}, {sha: old}]};
    if (path.includes('/pulls?state=closed')) return [release, pr(5, e), pr(6, f), pr(4, old)];
    if (path.includes(`/commits/${b}/pulls`)) return [release];
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    throw Error(path);
  };
  const released = {...state, prs: [{number: 4, revision: old}]};
  const squash = await collect(get, state.repository, released, deployment, 'squash');
  assert.deepEqual(squash.prs.map(p => [p.number, p.body]),
    [[5, 'Test checkout'], [6, 'Test checkout'], [9, 'Release dev']]);
  const merge = await collect(get, state.repository, released, deployment);
  assert.deepEqual(merge.prs.map(p => p.number), [9]);
});

test('squash rebuilds on initialization and rollback keep source PRs as history', async () => {
  const dev = 'd'.repeat(40), e = 'e'.repeat(40);
  const release = {...pr(9, b, 'Release dev'), head: {sha: dev}};
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return {status: 'behind'};
    if (path.includes(`/commits?sha=${b}`)) return [{sha: b}, {sha: a}];
    if (path.includes(`/compare/${b}...${dev}`)) return {status: 'diverged', commits: [{sha: e}]};
    if (path.includes('/pulls?state=closed')) return [release, pr(5, e)];
    if (path.includes(`/commits/${b}/pulls`)) return [release];
    throw Error(path);
  };
  for (const base of [{...state, revision: null}, state]) {
    const squash = await collect(get, state.repository, base, deployment, 'squash');
    assert.equal(squash.inventory, 'replace');
    // Source PRs are history, never new QA context.
    assert.deepEqual(squash.prs.map(p => p.number), [5, 9]);
    assert.equal(squash.prs[0].body, null);
    const merge = await collect(get, state.repository, base, deployment);
    assert.deepEqual(merge.prs.map(p => p.number), [9]);
  }
});


test('deployment branch describes the artifact, not an unrelated workflow ref', () => {
  const workflow = {...env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: b};
  assert.equal(deploymentInput(inputs, {}, workflow, state).branch, 'main');
  assert.equal(deploymentInput(inputs, {}, {...workflow, GITHUB_SHA: a}, state).branch, undefined);
  assert.equal(deploymentInput({...inputs, 'deployed-branch': 'release'}, {}, workflow, state).branch, 'release');
  const event = {deployment: {id: 1, sha: c, ref: 'refs/heads/staging', environment: 'staging'},
    deployment_status: {id: 2, state: 'success', created_at: deployment.deployed_at}};
  assert.equal(deploymentInput(inputs, event, {...workflow, GITHUB_EVENT_NAME: 'deployment_status'}, state).branch, 'staging');
  for (const ref of [c, 'refs/tags/v2.0', 'v2.0', 'staging']) {
    event.deployment.ref = ref;
    assert.equal(deploymentInput(inputs, event, {...workflow, GITHUB_EVENT_NAME: 'deployment_status'}, state).branch, undefined);
  }
  assert.equal(deploymentInput({...inputs, mode: 'refresh'}, {}, workflow, {...state, branch: 'staging'}).branch, 'staging');
});


test('stale refresh replaces branch metadata when the current deployment has none', async () => {
  let gets = 0;
  const sent = [];
  const fetcher = async (url, options) => {
    if (url.host === 'api.github.com') return reply([]);
    if (options.method === 'GET') return reply(++gets === 1
      ? {...state, deployed_at: deployment.deployed_at, order: 20, branch: 'staging', report_id: 'old'}
      : {...state, deployed_at: deployment.deployed_at, order: 21, report_id: 'new'});
    sent.push(JSON.parse(options.body));
    return sent.length === 1 ? reply({code: 'stale_inventory'}, 409) : reply({status: 'accepted'});
  };
  await run({...inputs, mode: 'refresh'}, {}, env, fetcher);
  assert.deepEqual(sent.map(p => p.header.expected_report_id), ['old', 'new']);
  assert.equal(sent[0].header.branch, 'staging');
  assert.equal('branch' in sent[1].header, false);
});

test('deployed PRs send their own first and last 50 commits, except release PRs', async () => {
  const history = Array.from({length: 105}, (_, n) =>
    ({sha: n.toString(16).padStart(40, '0'), parents: [{}], commit: {message: `Step ${n}`}}));
  const listed = {...pr(2, b), head: {ref: 'feature', repo: {full_name: 'acme/web'}}};
  const release = {...pr(3, b), head: {ref: 'Dev', repo: {full_name: 'acme/web'}}};
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return comparison([{sha: b}]);
    if (path.includes('/pulls?state=closed')) return [listed, release];
    if (path.includes(`/commits/${b}/pulls`)) return [listed, release];
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    if (path.startsWith('/repos/acme/web/pulls/2/commits')) {
      const page = Number(new URL(path, 'https://x').searchParams.get('page'));
      return history.slice((page - 1) * 100, page * 100);
    }
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  const [sent, skipped] = result.prs;
  assert.equal(sent.commits.length, 100);
  assert.equal(sent.commits[49].message, 'Step 49');
  assert.equal(sent.commits[50].message, 'Step 55');
  assert.equal(sent.omitted_commits, 5);
  assert.equal(skipped.commits, undefined);
  const disabled = await collect(get, state.repository, state, deployment, 'merge', false);
  assert.equal(disabled.prs[0].commits, undefined);
  assert.deepEqual(await pullRequestCommits(async () => { throw Error('down'); }, 'acme/web', 2), {});

  // The PR commit list stops at 250; the newest commits come from compare pages.
  const long = Array.from({length: 270}, (_, n) =>
    ({sha: n.toString(16).padStart(40, '0'), parents: [{}], commit: {message: `Step ${n}`}}));
  const page = path => Number(new URL(path, 'https://x').searchParams.get('page'));
  const capped = await pullRequestCommits(async path => {
    if (path.startsWith('/repos/acme/web/pulls/4/commits')) return long.slice(0, 250).slice((page(path) - 1) * 100, page(path) * 100);
    if (path === '/repos/acme/web/pulls/4') return {base: {sha: a}, head: {sha: b}};
    if (path.startsWith(`/repos/acme/web/compare/${a}...${b}`)) return {commits: long.slice((page(path) - 1) * 100, page(path) * 100)};
    throw Error(path);
  }, 'acme/web', 4);
  assert.equal(capped.commits.at(-1).message, 'Step 269');
  assert.equal(capped.omitted_commits, 170);
});
