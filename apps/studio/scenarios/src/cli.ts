import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { pagesOf } from './capture/pages.ts';
import { DEFAULT_WEB_ROOT, startServer } from './serve.ts';
import type { World } from './world/model.ts';
import { findScenario, NAMED_SCENARIOS, worldOf } from './world/scenarios.ts';

// The scenarios command:
//
//   list                       the named scenarios
//   world <scenario>           a scenario's world: counts and incidents, or the whole of it with --json
//   serve                      the mock API and the built web app, to browse a scenario at /__scenario/<id>
//   dev <scenario>             the web app's dev server, against the mock API, for working on the UI
//   report                     screenshot every scenario's pages into an HTML report; see src/capture/report.ts
//   compare <dir>              compare a report with a baseline taken elsewhere, in place; see src/capture/merge.ts
//   summary <dir>              a report as Markdown, for a pull request's comment

const USAGE = `Usage: pnpm --filter @conservationtv/studio-scenarios scenarios <command>

  list                     List the named scenarios.
  world <scenario> [--json]
                           Summarise a scenario's world (or print all of it).
  serve [--port 6431] [--web <dir>]
                           Serve the mock API and the built web app; open /__scenario/<id> to browse one.
  dev <scenario> [--port 6431]
                           Run the web app's dev server against the mock API, on a scenario.
  report [options]         Screenshot scenarios into an HTML report (--help for options).
  compare <dir> --baseline <dir>
                           Compare a report with another, in place.
  merge --out <dir> <dir>...
                           Merge the shards of a run (report --shard) into one report.
  summary <dir> [--url <index.html>]
                           Write a report up as Markdown, linking to it where it is hosted.

Scenarios are the named ones, or random-<n> for a world sampled from seed n.`;

function scenarioOrExit(id: string | undefined) {
  const scenario = id ? findScenario(id) : undefined;
  if (!scenario) {
    console.error(id ? `No scenario ${id}. Try \`list\`, or random-<n>.` : USAGE);
    process.exit(1);
  }
  return scenario;
}

function list() {
  for (const scenario of NAMED_SCENARIOS)
    console.log(`${scenario.id.padEnd(20)} ${scenario.title}: ${scenario.description}`);
  console.log(`${'random-<n>'.padEnd(20)} A world sampled from seed n.`);
}

/** A world's size, in counts of what is in it. */
function countsOf(world: World) {
  return {
    organisations: world.organisations.length,
    networks: world.networks.length,
    agents: world.agents.length,
    cameras: world.cameras.length,
    gateways: world.gateways.length,
    streams: world.streams.length,
    deliveries: world.streams.reduce((sum, stream) => sum + stream.exposures.length, 0),
    'shared pushed': world.sharedStreams.length,
    personal: world.personalStreams.length,
    publishing: world.publishing.length,
    shows: world.shows.length,
    slots: world.shows.map(show => show.slots).join(' ') || 'none',
    takeovers: world.shows.filter(show => show.takeoverStreamId).length,
    'on air': world.shows.filter(show => show.takeoverLive).length,
    outputs: world.outputs.length,
    channels: world.channels.length,
    states: world.states.length
  };
}

/** A world's states, counted by freshness, activity and health: `active/healthy 25, stale 3`. */
function healthSummary(world: World): string {
  const healths = Object.groupBy(world.states, state =>
    state.freshness === 'stale' ? 'stale' : `${state.activity}/${state.health}`
  );
  const summary = Object.entries(healths)
    .map(([key, rows]) => `${key} ${rows?.length}`)
    .join(', ');
  return summary || 'none';
}

/** A scenario's world: all of it as JSON, or its counts, states, incidents and pages. */
function world(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const scenario = scenarioOrExit(positionals[0]);
  const generated = worldOf(scenario);
  if (values.json) {
    console.log(JSON.stringify(generated, null, 2));
    return;
  }
  console.log(`${scenario.title} (${scenario.id}): ${scenario.description}\n`);
  for (const [name, count] of Object.entries(countsOf(generated))) console.log(`  ${name.padEnd(14)} ${count}`);
  console.log(`\n  states: ${healthSummary(generated)}`);
  console.log(`\n  incidents:${generated.incidents.length ? '' : ' none'}`);
  for (const incident of generated.incidents) console.log(`    - ${incident.summary}`);
  console.log(`\n  pages: ${pagesOf(generated).length}`);
}

async function serveCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string', default: '6431' }, web: { type: 'string', default: DEFAULT_WEB_ROOT } }
  });
  const served = await startServer(values.web, Number(values.port));
  console.log(`Mock API and web app on ${served.origin}`);
  for (const scenario of NAMED_SCENARIOS) console.log(`  ${served.origin}/__scenario/${scenario.id}`);
  console.log(`  ${served.origin}/__scenario/random-<n>`);
}

async function dev(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: 'string', default: '6431' } }
  });
  const scenario = scenarioOrExit(positionals[0]);
  const served = await startServer(DEFAULT_WEB_ROOT, Number(values.port));
  const apiUrl = `${served.origin.replace('127.0.0.1', 'localhost')}/w/${scenario.id}`;
  console.log(`Mock API for ${scenario.id} at ${apiUrl}; starting the web app's dev server against it.`);
  const child = spawn('pnpm', ['--filter', '@conservationtv/web', 'dev'], {
    stdio: 'inherit',
    env: { ...process.env, API_URL: apiUrl }
  });
  child.on('exit', code => process.exit(code ?? 0));
}

async function reportCommand(args: string[]) {
  const { report } = await import('./capture/report.ts');
  await report(args);
}

async function compare(args: string[]) {
  const { compareCommand } = await import('./capture/merge.ts');
  await compareCommand(args);
}

async function merge(args: string[]) {
  const { mergeCommand } = await import('./capture/combine.ts');
  mergeCommand(args);
}

async function summary(args: string[]) {
  const { summaryCommand } = await import('./capture/summary.ts');
  summaryCommand(args);
}

type Command = (args: string[]) => void | Promise<void>;

const COMMANDS = new Map(
  Object.entries({
    list,
    world,
    serve: serveCommand,
    dev,
    report: reportCommand,
    compare,
    merge,
    summary
  } satisfies Record<string, Command>)
);

const [name, ...rest] = process.argv.slice(2);
const command = name ? COMMANDS.get(name) : undefined;
if (command) await command(rest);
else {
  console.log(USAGE);
  process.exit(name ? 1 : 0);
}
