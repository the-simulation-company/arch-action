import {readFileSync, appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, code = '') {
    super(`Request failed (HTTP ${status}${code ? ', ' + code : ''})`);
    this.status = status;
    this.code = code;
  }
}

export function coordination(body = '') {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {0,3}##\s+Deployment\s+coordination\s*#*\s*$/i.test(lines[i])) continue;
    const start = i++;
    while (i < lines.length && !/^ {0,3}#{1,2}\s/.test(lines[i])) i++;
    sections.push(lines.slice(start, i).join('\n'));
    i--;
  }
  return sections.join('\n');
}

export function deploymentInput(inputs, event, env, state) {
  if (inputs.mode && !['deploy', 'refresh'].includes(inputs.mode)) {
    throw new Error('Mode must be deploy, refresh or preview');
  }
  if (inputs.mode === 'refresh') {
    if (!state.report_id) throw new Error('Initialize this target with a real deployment first');
    return {
      mode: 'refresh', revision: state.revision, deployed_at: state.deployed_at,
      ...(state.branch ? {branch: state.branch} : {}),
      order: state.order, deployment_id: `refresh:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${state.report_id}`,
    };
  }
  const ref = inputs['deployed-branch'] || (env.GITHUB_EVENT_NAME === 'deployment_status'
    ? (event.deployment?.ref?.startsWith('refs/heads/') ? event.deployment.ref : null)
    : env.GITHUB_REF_TYPE === 'branch' && env.GITHUB_SHA === inputs['deployed-sha']
      ? env.GITHUB_REF_NAME : null);
  const branch = ref && !shaPattern.test(ref) ? {branch: ref.replace(/^refs\/heads\//, '')} : {};
  if (env.GITHUB_EVENT_NAME === 'deployment_status') {
    if (event.deployment_status?.state !== 'success') return null;
    if (event.deployment?.environment !== state.environment) return null;
    return {
      mode: 'deploy', revision: event.deployment.sha, ...branch,
      deployed_at: event.deployment_status.created_at,
      order: event.deployment_status.id,
      deployment_id: `github:${event.deployment.id}:${event.deployment_status.id}`,
    };
  }
  if (!inputs['deployed-sha'] || !inputs['deployment-id'] || !inputs['deployed-at']) {
    throw new Error('Pass deployed-sha, deployment-id and deployed-at from the completed deployment');
  }
  return {
    mode: 'deploy', revision: inputs['deployed-sha'], ...branch,
    deployment_id: inputs['deployment-id'], deployed_at: inputs['deployed-at'],
    order: Number(inputs['deployment-order'] || env.GITHUB_RUN_NUMBER),
  };
}

export function previewInput(inputs, event, env) {
  const revision = event.deployment?.sha || inputs['deployed-sha'] || event.pull_request?.head?.sha;
  const url = event.deployment_status?.environment_url || inputs['preview-url'];
  if (!revision || !url) {
    throw new Error('Pass deployed-sha and preview-url for the ready preview');
  }
  if (!shaPattern.test(revision)) throw new Error('Invalid preview commit');
  let deploymentId = event.deployment?.id ? `github:${event.deployment.id}` : inputs['deployment-id'];
  // Re-running a job explicitly requests new QA; duplicate events and HTTP retries do not.
  if (deploymentId && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    deploymentId += `:retry:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
  }
  return {
    revision, url,
    deployment_id: deploymentId || `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
  };
}

// A pull_request event names its PR even when the preview serves the merge ref.
export async function previewPR(github, repository, revision, event) {
  let candidates;
  if (event.pull_request && inRepository(event.pull_request, repository)) {
    candidates = [event.pull_request];
  } else {
    if (!shaPattern.test(revision)) throw new Error('Invalid preview commit');
    candidates = (await pages(github, `/repos/${repository}/commits/${revision}/pulls`))
      .filter(pr => pr.state === 'open' && pr.head?.sha === revision && inRepository(pr, repository));
  }
  const expectedHead = event.pull_request?.head?.sha || revision;
  const eligible = [];
  for (const candidate of candidates) {
    if (candidate.state !== 'open') continue;
    const pr = await github(`/repos/${repository}/pulls/${candidate.number}`);
    if (pr.state === 'open' && inRepository(pr, repository) && pr.head?.sha === expectedHead
        && pr.labels?.some(label => label.name === 'arch-qa')) eligible.push(pr);
  }
  if (eligible.length > 1) throw new Error('More than one arch-qa PR serves this preview commit');
  return eligible[0] || null;
}

async function reportPreview(arch, github, inputs, event, env) {
  const environment = inputs['preview-environment'] || 'Preview';
  if (event.deployment_status && (event.deployment_status.state !== 'success'
      || event.deployment?.environment !== environment || event.deployment.production_environment)) return null;
  const revision = event.deployment?.sha || inputs['deployed-sha'] || event.pull_request?.head?.sha;
  const pr = await previewPR(github, env.GITHUB_REPOSITORY, revision, event);
  if (!pr) return null;
  if (!inputs['preview-url'] && !event.deployment_status) {
    const deployments = await pages(github, `/repos/${env.GITHUB_REPOSITORY}/deployments`
      + `?sha=${pr.head.sha}&environment=${encodeURIComponent(environment)}`);
    const deployment = deployments.find(item => item.sha === pr.head.sha
      && item.environment === environment && !item.production_environment);
    if (!deployment) return null;
    const statuses = await github(`/repos/${env.GITHUB_REPOSITORY}/deployments/${deployment.id}/statuses?per_page=1`);
    if (!Array.isArray(statuses)) throw new Error('Incomplete GitHub response');
    if (statuses[0]?.state !== 'success') return null;
    event = {deployment, deployment_status: statuses[0]};
  }
  const preview = previewInput(inputs, event, env);
  return arch('/v1/deployments/preview', {
    repository: env.GITHUB_REPOSITORY, ...preview,
    pr: {
      number: pr.number, title: pr.title || '', body: pr.body || '',
      // Arch keys the branch preview by PR and names it after the head ref.
      ...(pr.head?.ref ? {branch: pr.head.ref} : {}),
      ...(pr.user?.login && pr.user?.id ? {author: {login: pr.user.login, id: pr.user.id}} : {}),
      ...(inputs['commit-messages'] !== 'false' && !release(pr)
        ? await pullRequestCommits(github, env.GITHUB_REPOSITORY, pr.number) : {}),
    },
  });
}

function member(pr, withBody, environment) {
  // Release synchronization advances membership without repeating staging QA.
  if (environment?.toLowerCase() === 'staging' && pr.base?.ref === 'main' && pr.head?.ref === 'staging'
      && pr.head.repo?.full_name
      && pr.head.repo.full_name.toLowerCase() === pr.base.repo?.full_name?.toLowerCase()) {
    withBody = false;
  }
  return {
    number: pr.number, revision: pr.merge_commit_sha,
    coordination: coordination(pr.body || ''),
    title: withBody ? pr.title : '', body: withBody ? (pr.body || '') : null,
  };
}

const releaseBranches = new Set(['main', 'master', 'staging', 'dev', 'develop', 'production']);

// A long-lived branch merge (staging -> main) would list a whole release history.
export function release(pr) {
  const head = pr.head?.repo?.full_name;
  return typeof head === 'string' && head.toLowerCase() === pr.base?.repo?.full_name?.toLowerCase()
    && (releaseBranches.has(pr.head.ref?.toLowerCase()) || pr.head.ref === pr.base.repo.default_branch);
}

// The PR's own commits survive squash and rebase merges. Keep the first and last 50.
export async function pullRequestCommits(github, repository, number) {
  let listed;
  try {
    listed = await pages(github, `/repos/${repository}/pulls/${number}/commits`);
  } catch (error) {
    // Commit messages only supplement the PR description.
    console.log(`::warning::Commit messages unavailable for PR #${number}: ${error.message}`);
    return {};
  }
  const commits = listed
    // Branch synchronization merges carry no PR intent.
    .filter(commit => (commit.parents?.length ?? 0) <= 1)
    .map(commit => {
      const message = commit.commit?.message || '';
      return {revision: commit.sha,
        message: message.length > 2000 ? message.slice(0, 2000) + '\n[Message truncated.]' : message};
    });
  if (!commits.length) return {};
  if (commits.length <= 100) return {commits};
  return {commits: [...commits.slice(0, 50), ...commits.slice(-50)], omitted_commits: commits.length - 100};
}

function inRepository(pr, repository) {
  const base = pr.base?.repo?.full_name;
  if (typeof base !== 'string') throw new Error('Incomplete PR repository identity');
  return base.toLowerCase() === repository.toLowerCase();
}

export function createClient(origin, token, fetcher = fetch, github = false) {
  const root = new URL(origin);
  if (root.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(root.hostname)) {
    throw new Error('API origin must use HTTPS');
  }
  if (root.username || root.password || root.search || root.hash || root.pathname !== '/') {
    throw new Error('Use a plain API origin');
  }
  return async (path, body) => {
    const url = new URL(path, root);
    if (url.origin !== root.origin) throw new Error('Cross-origin API request rejected');
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error', signal: AbortSignal.timeout(60000),
          headers: {
            Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            ...(github ? {'X-GitHub-Api-Version': '2022-11-28'} : {}),
            ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
          },
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
      } catch {
        if (attempt === 4) throw new Error('API request failed; retry this deployment report');
        await delay(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) return response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      // Never surface response bodies: GitHub errors can contain private source context.
      let code = '';
      if (!github) {
        const error = await response.json().catch(() => ({}));
        code = error.code || error.error?.code || '';
      }
      throw new HttpError(response.status, code);
    }
  };
}

async function pages(get, path, field) {
  const result = [];
  for (let page = 1; ; page++) {
    const value = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = field ? value[field] : value;
    if (!Array.isArray(entries)) throw new Error('Incomplete GitHub response');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
}

export async function currentDeployment(arch, reportId) {
  const first = await arch('/v1/deployments/current' + (reportId ? `?report_id=${reportId}` : ''));
  let after = first.next_after;
  while (after !== null) {
    const page = await arch(`/v1/deployments/current?report_id=${first.report_id}&after=${after}`);
    first.prs.push(...page.prs);
    after = page.next_after;
  }
  return first;
}

export async function collect(github, repository, state, deployment, releaseMerge = 'merge',
    commitMessages = true) {
  const repo = `/repos/${repository}`;
  const pulls = new Map();
  const sources = new Map();
  const add = (pr, withBody) => {
    inventory.set(pr.number, member(pr, withBody, state.environment));
    sources.set(pr.number, pr);
  };
  const associated = sha => {
    if (!pulls.has(sha)) pulls.set(sha, pages(github, `${repo}/commits/${sha}/pulls`));
    return pulls.get(sha);
  };
  let replace = !state.revision || deployment.mode === 'refresh';
  let historical = false;
  let noCodeChange = false;
  let commits = [];
  if (!replace) {
    let comparison;
    try {
      comparison = await github(`${repo}/compare/${state.revision}...${deployment.revision}?per_page=100&page=1`);
    } catch (error) {
      if (![404, 409, 422].includes(error.status)) throw error;
      replace = true;
      historical = true;
    }
    if (comparison) {
      if (['behind', 'diverged'].includes(comparison.status)) {
        replace = true; historical = true;
      } else if (['ahead', 'identical'].includes(comparison.status)) {
        commits = comparison.commits;
        if (!Array.isArray(commits)) throw new Error('Incomplete comparison response');
        if (commits.length === 100) {
          for (let page = 2; ; page++) {
            const next = await github(`${repo}/compare/${state.revision}...${deployment.revision}?per_page=100&page=${page}`);
            if (!Array.isArray(next.commits)) throw new Error('Incomplete comparison page');
            commits.push(...next.commits);
            if (next.commits.length < 100) break;
          }
        }
        if (comparison.status === 'ahead' && state.revision !== deployment.revision) {
          // Reuse the full comparison, including a head commit on a later page.
          const base = comparison.base_commit;
          const head = commits.find(commit => commit.sha === deployment.revision);
          const baseTree = base?.commit?.tree?.sha;
          const headTree = head?.commit?.tree?.sha;
          if (base?.sha !== state.revision || !shaPattern.test(baseTree || '') || !shaPattern.test(headTree || '')) {
            throw new Error('Incomplete commit tree response');
          }
          noCodeChange = baseTree === headTree;
        }
      } else throw new Error('Unrecognized comparison status');
    }
  }
  const inventory = new Map();
  if (replace) {
    const recorded = deployment.mode === 'refresh'
      ? new Map(state.prs.map(p => [p.number, p.revision])) : null;
    const reachable = recorded ? null
      : new Set((await pages(github, `${repo}/commits?sha=${deployment.revision}`)).map(c => c.sha));
    const closed = await pages(github, `${repo}/pulls?state=closed`);
    if (reachable && releaseMerge === 'squash') {
      // Squashed releases keep only their own merge commit; add the history behind the latest one.
      // ponytail: expands only the newest squash-merged PR's head; an older source outside its
      // history is recovered by the next forward release.
      const latest = closed
        .filter(pr => pr.merged_at && inRepository(pr, repository) && reachable.has(pr.merge_commit_sha)
          && shaPattern.test(pr.head?.sha || '') && !reachable.has(pr.head.sha))
        .sort((x, y) => Date.parse(y.merged_at) - Date.parse(x.merged_at))[0];
      if (latest) {
        const source = await pages(github, `${repo}/compare/${deployment.revision}...${latest.head.sha}`, 'commits');
        for (const commit of source) reachable.add(commit.sha);
      }
    }
    for (const pr of closed) {
      if (pr.merged_at && inRepository(pr, repository)
          && (recorded ? recorded.has(pr.number) : reachable.has(pr.merge_commit_sha))) {
        if (recorded && recorded.get(pr.number) !== pr.merge_commit_sha) {
          throw new Error('Metadata refresh cannot change a recorded PR revision');
        }
        add(pr, false);
      }
    }
    if (recorded && inventory.size !== recorded.size) {
      throw new Error('Metadata refresh could not find every recorded PR');
    }
  } else {
    const added = new Set(commits.map(commit => commit.sha));
    const recorded = new Set(state.prs.map(pr => pr.number));
    const previous = new Set([state.revision, ...state.prs.map(pr => pr.revision)]);
    // A squash release lands as one commit; the PRs it carries are behind its release PR's head.
    const squashed = new Set();
    if (releaseMerge === 'squash') {
      for (const commit of commits) {
        for (const release of await associated(commit.sha)) {
          if (!release.merged_at || release.merge_commit_sha !== commit.sha
              || !inRepository(release, repository) || !shaPattern.test(release.head?.sha || '')) continue;
          // ponytail: compares from the fork point, so cost grows with source history since it.
          const source = await pages(github, `${repo}/compare/${state.revision}...${release.head.sha}`, 'commits');
          for (const sourceCommit of source) squashed.add(sourceCommit.sha);
        }
      }
    }
    // A commit's associated-PR endpoint can omit inner PRs in a merged stack.
    for (const pr of await pages(github, `${repo}/pulls?state=closed`)) {
      if (!pr.merged_at || !inRepository(pr, repository)) continue;
      if (added.has(pr.merge_commit_sha)) {
        add(pr, !noCodeChange);
      } else if (!recorded.has(pr.number) && squashed.has(pr.merge_commit_sha)) {
        add(pr, !noCodeChange);
      } else if (!recorded.has(pr.number) && previous.has(pr.merge_commit_sha)) {
        // Recover old omissions without treating their descriptions as new changes.
        add(pr, false);
      }
    }
  }
  if (!state.revision && deployment.mode !== 'refresh') {
    commits = [{sha: deployment.revision}];
  }
  if (deployment.mode !== 'refresh' && !historical) {
    for (const commit of commits) {
      const merged = (await associated(commit.sha))
        .filter(pr => pr.merged_at && inRepository(pr, repository));
      for (const pr of merged) {
        let included = inventory.has(pr.number);
        if (!replace) {
          const result = await github(`${repo}/compare/${pr.merge_commit_sha}...${deployment.revision}?per_page=1`);
          included = ['ahead', 'identical'].includes(result.status);
        }
        if (included) {
          add(pr, !noCodeChange);
        }
      }
    }
  }
  if (!state.revision && ![...inventory.values()].some(pr => pr.body !== null)) {
    historical = true;
  }
  if (commitMessages) {
    for (const item of inventory.values()) {
      if (item.body !== null && !release(sources.get(item.number))) {
        Object.assign(item, await pullRequestCommits(github, repository, item.number));
      }
    }
  }
  return {
    inventory: replace ? 'replace' : 'delta', historical, no_code_change: noCodeChange,
    prs: [...inventory.values()].sort((a, b) => a.number - b.number),
    removed: [], commits: [],
  };
}

export function batches(data) {
  const result = [];
  let batch = {prs: [], removed: [], commits: []};
  for (const key of ['prs', 'removed', 'commits']) {
    for (const item of data[key]) {
      const next = {...batch, [key]: [...batch[key], item]};
      if (next[key].length > (key === 'commits' ? 100 : 500)
          || Buffer.byteLength(JSON.stringify(next)) > 800000) {
        if (!Object.values(batch).some(items => items.length)) throw new Error('PR metadata exceeds batch limit');
        result.push(batch);
        batch = {prs: [], removed: [], commits: []};
        if (Buffer.byteLength(JSON.stringify(item)) > 799000) throw new Error('PR metadata exceeds batch limit');
      }
      batch[key].push(item);
    }
  }
  if (Object.values(batch).some(items => items.length) || !result.length) result.push(batch);
  return result;
}

export async function run(inputs, event, env, fetcher = fetch) {
  const arch = createClient('https://api.foothill.sh', inputs['arch-token'], fetcher);
  const github = createClient('https://api.github.com', inputs['github-token'], fetcher, true);
  if (!['', 'true', 'false'].includes(inputs['commit-messages'] || '')) {
    throw new Error('commit-messages must be true or false');
  }
  if (inputs.mode === 'preview') return reportPreview(arch, github, inputs, event, env);
  if (!['', 'merge', 'squash'].includes(inputs['release-merge'] || '')) {
    throw new Error('release-merge must be merge or squash');
  }
  let state = await currentDeployment(arch);
  if (state.repository.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    throw new Error('The Arch token belongs to a different repository');
  }
  let deployment = deploymentInput(inputs, event, env, state);
  if (!deployment) return null;
  if (!shaPattern.test(deployment.revision) || !Number.isSafeInteger(deployment.order)
      || deployment.order < 0 || !Number.isFinite(Date.parse(deployment.deployed_at))
      || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(deployment.deployed_at)) {
    throw new Error('Invalid deployed commit, completion time or ordering');
  }
  // A rerun for the current deployment must reproduce its original report base.
  if (state.deployment_id === deployment.deployment_id) {
    if (state.branch) deployment.branch = state.branch;
    else delete deployment.branch;
    state = state.expected_report_id ? await currentDeployment(arch, state.expected_report_id)
      : {...state, report_id: null, revision: null, prs: []};
  }
  for (let attempt = 0; attempt < 5; attempt++) {
  const data = await collect(github, state.repository, state, deployment, inputs['release-merge'] || 'merge',
    inputs['commit-messages'] !== 'false');
  const parts = batches(data);
  const header = {...deployment, expected_report_id: state.report_id,
    inventory: data.inventory, historical: data.historical, batch_count: parts.length,
    ...(data.no_code_change ? {no_code_change: true} : {})};
  let receipt;
  try {
  for (let batch = 0; batch < parts.length; batch++) {
    receipt = await arch('/v1/deployments', {
      header, batch, ...parts[batch], complete: batch === parts.length - 1,
    });
  }
  if (!['accepted', 'stale'].includes(receipt.status)) throw new Error('Deployment acceptance not confirmed');
  return receipt;
  } catch (error) {
    if (error.status !== 409 || error.code !== 'stale_inventory' || attempt === 4) throw error;
    state = await currentDeployment(arch);
    if (deployment.mode === 'refresh') deployment = deploymentInput(inputs, event, env, state);
  }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const names = ['arch-token', 'github-token', 'deployed-sha', 'deployed-branch', 'deployment-id',
      'deployed-at', 'deployment-order', 'mode', 'preview-url', 'preview-environment', 'release-merge', 'commit-messages'];
    const inputs = Object.fromEntries(names.map(name => [name, process.env['INPUT_' + name.toUpperCase()] || '']));
    for (const name of ['arch-token', 'github-token']) {
      if (!inputs[name]) throw new Error(`Missing ${name}`);
      console.log('::add-mask::' + inputs[name].replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
    }
    const receipt = await run(inputs, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env);
    if (receipt) {
      console.log(`Arch deployment ${receipt.status}. ${receipt.app_url || receipt.app_path}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
        (receipt.report_id ? `report-id=${receipt.report_id}\n` : '')
        + `app-url=${receipt.app_url || receipt.app_path}\n`);
    } else console.log('No matching deployment or ready arch-qa PR preview; no report sent.');
  } catch (error) {
    console.error('Arch reporting failed: ' + error.message);
    process.exitCode = 1;
  }
}
