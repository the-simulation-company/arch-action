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
    throw new Error('Mode must be deploy or refresh');
  }
  if (inputs.mode === 'refresh') {
    if (!state.report_id) throw new Error('Initialize this target with a real deployment first');
    return {
      mode: 'refresh', revision: state.revision, deployed_at: state.deployed_at,
      order: state.order, deployment_id: `refresh:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${state.report_id}`,
    };
  }
  if (env.GITHUB_EVENT_NAME === 'deployment_status') {
    if (event.deployment_status?.state !== 'success') return null;
    if (event.deployment?.environment !== state.environment) return null;
    return {
      mode: 'deploy', revision: event.deployment.sha,
      deployed_at: event.deployment_status.created_at,
      order: event.deployment_status.id,
      deployment_id: `github:${event.deployment.id}:${event.deployment_status.id}`,
    };
  }
  if (!inputs['deployed-sha'] || !inputs['deployment-id'] || !inputs['deployed-at']) {
    throw new Error('Pass deployed-sha, deployment-id and deployed-at from the completed deployment');
  }
  return {
    mode: 'deploy', revision: inputs['deployed-sha'],
    deployment_id: inputs['deployment-id'], deployed_at: inputs['deployed-at'],
    order: Number(inputs['deployment-order'] || env.GITHUB_RUN_NUMBER),
  };
}

function member(pr, withBody) {
  return {
    number: pr.number, revision: pr.merge_commit_sha,
    coordination: coordination(pr.body || ''),
    title: withBody ? pr.title : '', body: withBody ? (pr.body || '') : null,
  };
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

export async function collect(github, repository, state, deployment) {
  const repo = `/repos/${repository}`;
  let replace = !state.revision || deployment.mode === 'refresh';
  let historical = false;
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
      } else throw new Error('Unrecognized comparison status');
    }
  }
  const inventory = new Map();
  if (replace) {
    const reachable = new Set((await pages(github, `${repo}/commits?sha=${deployment.revision}`)).map(c => c.sha));
    for (const pr of await pages(github, `${repo}/pulls?state=closed`)) {
      if (pr.merged_at && inRepository(pr, repository) && reachable.has(pr.merge_commit_sha)) {
        inventory.set(pr.number, member(pr, false));
      }
    }
  }
  const direct = [];
  if (!state.revision && deployment.mode !== 'refresh') {
    commits = [{sha: deployment.revision}];
  }
  if (deployment.mode !== 'refresh' && !historical) {
    for (const commit of commits) {
      const associated = (await pages(github, `${repo}/commits/${commit.sha}/pulls`))
        .filter(pr => pr.merged_at && inRepository(pr, repository));
      let matched = false;
      for (const pr of associated) {
        let included = inventory.has(pr.number);
        if (!replace) {
          const result = await github(`${repo}/compare/${pr.merge_commit_sha}...${deployment.revision}?per_page=1`);
          included = ['ahead', 'identical'].includes(result.status);
        }
        if (included) {
          inventory.set(pr.number, member(pr, true));
          matched = true;
        }
      }
      if (!matched) {
        const detail = commit.commit ? commit : await github(`${repo}/commits/${commit.sha}`);
        direct.push({revision: commit.sha, message: (detail.commit?.message || '').slice(0, 20000)});
      }
    }
  }
  if (!state.revision && ![...inventory.values()].some(pr => pr.body !== null)) {
    historical = true;
    direct.length = 0;
  }
  return {
    inventory: replace ? 'replace' : 'delta', historical,
    prs: [...inventory.values()].sort((a, b) => a.number - b.number),
    removed: [], commits: direct,
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
  const arch = createClient(inputs['api-url'], inputs['arch-token'], fetcher);
  const github = createClient('https://api.github.com', inputs['github-token'], fetcher, true);
  let state = await currentDeployment(arch);
  if (state.repository.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    throw new Error('The Arch token belongs to a different repository');
  }
  const deployment = deploymentInput(inputs, event, env, state);
  if (!deployment) return null;
  if (!shaPattern.test(deployment.revision) || !Number.isSafeInteger(deployment.order)
      || deployment.order < 0 || !Number.isFinite(Date.parse(deployment.deployed_at))
      || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(deployment.deployed_at)) {
    throw new Error('Invalid deployed commit, completion time or ordering');
  }
  // A rerun for the current deployment must reproduce its original report base.
  if (state.deployment_id === deployment.deployment_id) {
    state = state.expected_report_id ? await currentDeployment(arch, state.expected_report_id)
      : {...state, report_id: null, revision: null, prs: []};
  }
  for (let attempt = 0; attempt < 5; attempt++) {
  const data = await collect(github, state.repository, state, deployment);
  const parts = batches(data);
  const header = {...deployment, expected_report_id: state.report_id,
    inventory: data.inventory, historical: data.historical, batch_count: parts.length};
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
    if (deployment.mode === 'refresh') Object.assign(deployment, deploymentInput(inputs, event, env, state));
  }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const names = ['arch-token', 'api-url', 'github-token', 'deployed-sha', 'deployment-id',
      'deployed-at', 'deployment-order', 'mode'];
    const inputs = Object.fromEntries(names.map(name => [name, process.env['INPUT_' + name.toUpperCase()] || '']));
    for (const name of ['arch-token', 'github-token']) {
      if (!inputs[name]) throw new Error(`Missing ${name}`);
      console.log('::add-mask::' + inputs[name].replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
    }
    const receipt = await run(inputs, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env);
    if (receipt) {
      console.log(`Arch deployment ${receipt.status}. ${receipt.app_url || receipt.app_path}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
        `report-id=${receipt.report_id}\napp-url=${receipt.app_url || receipt.app_path}\n`);
    } else console.log('Deployment does not match this target; no report sent.');
  } catch (error) {
    console.error('Arch reporting failed: ' + error.message);
    process.exitCode = 1;
  }
}
