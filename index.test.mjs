import test from 'node:test';
import assert from 'node:assert/strict';
import {batches, collect, coordination, createClient, currentDeployment, deploymentInput, run} from './index.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const state = {report_id: 'previous', revision: a, repository: 'acme/web', environment: 'staging', prs: [], next_after: null};
const env = {GITHUB_REPOSITORY: 'acme/web', GITHUB_RUN_NUMBER: '20', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1'};
const deployment = {mode: 'deploy', revision: b, deployed_at: '2026-10-07T12:00:00Z', order: 20, deployment_id: 'd-20'};
const inputs = {'arch-token': 'arch-secret', 'github-token': 'github-secret',
  'deployed-sha': b, 'deployed-at': deployment.deployed_at, 'deployment-id': deployment.deployment_id};
const pr = (number, sha, body = 'Test checkout') => ({number, merge_commit_sha: sha, merged_at: '2026-10-01', title: 'Checkout', body,
  base: {repo: {full_name: 'acme/web'}},
  diff_url: 'do-not-send', head: {repo: {source: 'do-not-send'}}, user: {email: 'do-not-send'}});
const reply = (data, status = 200) => new Response(JSON.stringify(data), {status});

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
    if (path.includes(`/compare/${a}...${b}`)) return {status: 'ahead', commits: [{sha: b, commit: {message: 'Local commit'}}]};
    if (path.includes(`/commits/${b}/pulls`)) return [foreign];
    throw Error(path);
  }, state.repository, state, deployment);
  assert.deepEqual(result.prs, []);
  assert.doesNotMatch(JSON.stringify(result), /Foreign private description|other\/repo/);
  assert.deepEqual(result.commits, [{revision: b, message: 'Local commit'}]);
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
  assert.deepEqual(result.commits, []);
});

test('forward comparison proves PR ancestry; commit metadata is allowlisted', async () => {
  const get = async path => {
    if (path.includes(`/compare/${a}...${b}`)) return {status: 'ahead', commits: [{sha: b}, {sha: c, commit: {message: 'Direct fix'}, files: ['private code']}]};
    if (path.includes(`/commits/${b}/pulls`)) return [pr(2, b)];
    if (path.includes(`/commits/${c}/pulls`)) return [];
    if (path.includes(`/compare/${b}...${b}`)) return {status: 'identical'};
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.equal(result.inventory, 'delta');
  assert.equal(result.prs[0].number, 2);
  assert.deepEqual(result.commits, [{revision: c, message: 'Direct fix'}]);
});

test('pagination never silently truncates commit ranges or closed PRs', async () => {
  const calls = [];
  const commits = Array.from({length: 100}, (_, i) => ({sha: i.toString(16).padStart(40, '0'), commit: {message: 'fix'}}));
  const get = async path => {
    calls.push(path);
    if (path.includes('/compare/')) return {status: 'ahead', commits: path.includes('page=2') ? [{sha: c, commit: {message: 'last'}}] : [...commits]};
    if (path.includes('/pulls')) return [];
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, deployment);
  assert.equal(result.commits.length, 101);
  assert(calls.some(p => p.includes('page=2')));
  assert.equal(batches(result).length, 2);
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
  assert.deepEqual(result.prs.map(p => p.number), [1]);
  assert.equal(result.prs[0].body, null);
});

test('manual refresh updates coordination only; no invented deployment context', async () => {
  const get = async path => {
    if (path.includes('/commits?')) return [{sha: a}];
    if (path.includes('/pulls?')) return [pr(1, a, '## Deployment coordination\nEdited block')];
    throw Error(path);
  };
  const result = await collect(get, state.repository, state, {...deployment, mode: 'refresh'});
  assert.equal(result.historical, false);
  assert.equal(result.prs[0].body, null);
  assert.match(result.prs[0].coordination, /Edited block/);
  assert.deepEqual(result.commits, []);
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
      return reply({status: 'identical', commits: []});
    }
    assert.equal(url.origin, 'https://api.foothill.sh');
    assert.equal(options.headers.Authorization, 'Bearer arch-secret');
    if (options.method === 'GET') return reply(state);
    sent.push(JSON.parse(options.body));
    return reply({status: 'accepted', report_id: 'accepted'});
  };
  await run({...inputs, 'api-url': 'https://evil.example'}, {}, env, fetcher);
  assert.equal(sent[0].header.revision, b);
  assert.doesNotMatch(JSON.stringify(sent), /github-secret|arch-secret|source|diff/);
  await assert.rejects(createClient('https://api.github.com', 'token')('https://evil.example/'), /Cross-origin/);
});

test('stale inventory refreshes cursor and recomputes without changing deployment identity', async () => {
  let gets = 0;
  const sent = [];
  const fetcher = async (url, options) => {
    if (url.host === 'api.github.com') return reply({status: 'identical', commits: []});
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
