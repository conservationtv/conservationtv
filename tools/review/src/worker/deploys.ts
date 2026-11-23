import { Hono, type Context } from 'hono';
import type { Deploy, Deploys } from '../shared/deploys.ts';
import {
  CompareStatusSchema,
  DeploymentsSchema,
  DeploymentStatusesSchema,
  PullDetailSchema,
  useGitHub,
  WorkflowRunSchema,
  type Deployments,
  type DeploymentStatuses
} from './github.ts';
import { healthAround, tracedServices, type GrafanaConfig } from './grafana.ts';
import type { AppEnv } from './session.ts';

// Where a merged pull request went: for each environment GitHub records deploys to, the first deploy of a commit that
// contains its merge commit, with its workflow, its state and its run; and, where Grafana is set up, how each service of
// that environment did in the hour either side of it.

type Deployment = Deployments[number];

/** Whether `sha` contains `merge`: GitHub's comparison says so, and a commit's history never changes. */
async function contains(sha: string, merge: string): Promise<boolean> {
  const github = useGitHub();
  const compare = await github.api(`compare/${merge}...${sha}`, CompareStatusSchema, 'immutable');
  return compare.status === 'ahead' || compare.status === 'identical';
}

/** A candidate deploy, with what ran it and how it ended. */
interface Candidate {
  deployment: Deployment;
  workflow: string | null;
  statuses: DeploymentStatuses;
}

/** How many deploys after the merge are looked through: enough for a few days of releases. */
const MAX_CANDIDATES = 40;

/** A deploy's statuses, newest first, and the workflow its run belongs to. */
async function candidateOf(deployment: Deployment): Promise<Candidate> {
  const github = useGitHub();
  const statuses = await github.api(`deployments/${deployment.id}/statuses`, DeploymentStatusesSchema, 'recent');
  return { deployment, workflow: await workflowOf(statuses[0]?.log_url), statuses };
}

/**
 * Each environment's and workflow's first successful deploy, after the merge, of a commit containing it; or, where
 * none succeeded yet, its first attempt. An environment two workflows deploy to (staging) is told apart by them.
 */
async function firstDeploys(merge: string, mergedAt: string): Promise<Candidate[]> {
  const github = useGitHub();
  const recent = await github.api('deployments?per_page=100', DeploymentsSchema, 'recent');
  const after = recent
    .filter(each => each.created_at >= mergedAt)
    .toSorted((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_CANDIDATES);
  const found = new Map<string, Candidate>();
  for (const deployment of after) {
    // Oldest first: a key's first deploy carrying the merge is kept until one of them succeeds, which is final.
    const candidate = await candidateOf(deployment);
    const key = `${deployment.environment}:${candidate.workflow}`;
    const kept = found.get(key);
    if (kept?.statuses[0]?.state === 'success' || !(await contains(deployment.sha, merge))) continue;
    if (!kept || candidate.statuses[0]?.state === 'success') found.set(key, candidate);
  }
  return [...found.values()];
}

/** The workflow a deploy's run belongs to, from its log's run id. */
async function workflowOf(url: string | null | undefined): Promise<string | null> {
  const run = url?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!run) return null;
  const github = useGitHub();
  return (await github.api(`actions/runs/${run}`, WorkflowRunSchema, 'immutable')).name;
}

function grafanaOf(c: Context<AppEnv>): GrafanaConfig | null {
  return c.env.GRAFANA_URL && c.env.GRAFANA_TOKEN ? { url: c.env.GRAFANA_URL, token: c.env.GRAFANA_TOKEN } : null;
}

/**
 * The traced services a deploy shipped, by Workers' naming (`<script>-<environment>`) and its workflow's name
 * (`studio` deploys `studio-api-staging`), each around when it finished.
 */
function healthOf(grafana: GrafanaConfig | null, services: string[], candidate: Candidate, at: number) {
  if (!grafana) return Promise.resolve(null);
  const { environment } = candidate.deployment;
  const shipped = services.filter(
    service => service.endsWith(`-${environment}`) && service.startsWith(`${candidate.workflow ?? ''}-`)
  );
  return Promise.all(shipped.map(service => healthAround(grafana, service, at)));
}

/** A deploy as the review shows it: its latest status, workflow and, with Grafana, each shipped service's health. */
async function deployOf(candidate: Candidate, grafana: GrafanaConfig | null, services: string[]): Promise<Deploy> {
  const { deployment, statuses, workflow } = candidate;
  const [latest] = statuses;
  const updatedAt = latest?.created_at ?? deployment.created_at;
  return {
    environment: deployment.environment,
    workflow,
    sha: deployment.sha,
    state: latest?.state ?? 'pending',
    createdAt: deployment.created_at,
    updatedAt,
    url: latest?.log_url ?? null,
    health: await healthOf(grafana, services, candidate, Math.floor(Date.parse(updatedAt) / 1000))
  };
}

export const deploys = new Hono<AppEnv>().get('/pulls/:number{[0-9]+}/deploys', async c => {
  const github = useGitHub();
  const pull = await github.api(`pulls/${c.req.param('number')}`, PullDetailSchema, 'live');
  if (!pull.merged_at || !pull.merge_commit_sha) {
    return c.json({ mergeSha: null, deploys: [] } satisfies Deploys, 200, { 'cache-control': 'no-store' });
  }
  const grafana = grafanaOf(c);
  const services = grafana ? await tracedServices(grafana).catch(() => []) : [];
  const found = await firstDeploys(pull.merge_commit_sha, pull.merged_at);
  const list = await Promise.all(found.map(candidate => deployOf(candidate, grafana, services)));
  const body: Deploys = { mergeSha: pull.merge_commit_sha, deploys: list };
  return c.json(body, 200, { 'cache-control': 'no-store' });
});
