import { cancel, isCancel, select } from '@clack/prompts';
import type { Client } from '@conservationtv/studio-sdk';
import type { Credentials, Device } from './credentials.js';
import { LoginError } from './errors.js';

/** An organisation, or anything else `choose` offers: a profile is offered by its name, as `id`. */
export interface Organisation {
  id: string;
  name: string;
}

// Prompts draw on stderr: stdout carries the command's result.
const output = process.stderr;

/** The organisations the session's account is a member of. */
export async function listOrganisations(studio: Client): Promise<Organisation[]> {
  const result = await studio.organisations.list.v1();
  if (result instanceof Error) throw result;
  return result.organisations.map(organisation => ({ id: organisation.id, name: organisation.name }));
}

function describe(choices: Organisation[]) {
  return choices.map(choice => `${choice.name} (${choice.id})`).join(', ');
}

/** Ask which one on the terminal. A run without one must say instead, the way `how` describes. */
async function pick(message: string, choices: Organisation[], how: string): Promise<Organisation> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new LoginError(`Choose with ${how}: ${describe(choices)}.`);
  const options = choices.map(choice => ({ value: choice.id, label: choice.name, hint: choice.id }));
  const id = await select({ message, options, output });
  if (isCancel(id)) {
    cancel('Cancelled.', { output });
    throw new LoginError('Cancelled.');
  }
  return choices.find(choice => choice.id === id)!;
}

export interface Choice {
  /** What the person passed, by id or name; omitted, they pick (or get the only choice). */
  requested: string | undefined;
  message: string;
  /** How to pass a choice without a terminal, for the error that asks for one. */
  how: string;
}

export async function choose(choices: Organisation[], { requested, message, how }: Choice): Promise<Organisation> {
  if (requested === undefined) return choices.length === 1 ? choices[0]! : pick(message, choices, how);
  const wanted = requested.toLowerCase();
  const match = choices.find(choice => choice.id === requested || choice.name.toLowerCase() === wanted);
  if (match === undefined) throw new LoginError(`"${requested}" is not one of: ${describe(choices)}.`);
  return match;
}

/** Register the session's browser device in the organisation (get or create, with its private key): a profile's. */
export async function registerDevice(studio: Client, organisation: Organisation): Promise<Device> {
  const browser = await studio.organisations.browser.ensure.v1({ id: organisation.id });
  if (browser instanceof Error) throw browser;
  return {
    id: browser.id,
    name: browser.name,
    publicKey: browser.publicKey,
    publicId: browser.publicId,
    privateKey: browser.privateKey
  };
}

/** A profile's device as commands report it: never its private key. */
export interface DeviceSummary {
  id: string;
  name: string;
  publicKey: string;
}

export interface ProfileSummary {
  name: string;
  env: string;
  email: string | undefined;
  organisationId: string;
  organisation: string;
  device: DeviceSummary;
  current: boolean;
}

export function summarise(name: string, credentials: Credentials): ProfileSummary {
  const profile = credentials.profiles[name]!;
  const session = credentials.sessions[profile.session]!;
  const device = profile.device;
  return {
    name,
    env: session.env,
    email: session.email,
    organisationId: profile.organisationId,
    organisation: profile.organisationName,
    device: { id: device.id, name: device.name, publicKey: device.publicKey },
    current: name === credentials.current
  };
}
