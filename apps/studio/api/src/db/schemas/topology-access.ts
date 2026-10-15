import { organisationAdmin, organisationMember } from '../roles.ts';

// The actions and roles shared by the stream topology an organisation owns: its networks, devices and the agents that
// run on them, its streams with their exposures and recorders, its provider registrations, and the subjects its agents
// report about.
//
// Every row binds to its organisation's scope through `organisation_id`, so `organisationMember` reads all of it and
// `organisationAdmin` manages it. Relationships between rows carry `organisation_id` in composite foreign keys, which
// keeps every reference inside one organisation in the database itself: an agent's network and host device, a
// stream's source device, an exposure's network and provider registration, and every entity's subject.

export const topologyActions = {
  read: ['select'],
  create: ['insert'],
  edit: ['update'],
  remove: ['delete']
} as const;

export const topologyRoles = {
  member: {
    label: 'Member',
    permissions: ['read'],
    assignableScopes: ['organisation'],
    includedIn: [organisationMember]
  },
  admin: {
    label: 'Administrator',
    permissions: ['read', 'create', 'edit', 'remove'],
    assignableScopes: ['organisation'],
    includedIn: [organisationAdmin]
  }
} as const;
