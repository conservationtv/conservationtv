import { organisationAdmin, organisationMember } from '../roles.ts';

// The access shared by what devices report about subjects (observations, metrics and logs) and the state derived from
// them. Each record keeps its reporter (the device whose identity signed it) separate from its subject (what was
// observed), both named by the convention in `@conservationtv/reports`. Neither is a reference: both are recorded as
// given, and stay when the device or entity they name is deleted. Records go only with their organisation.
//
// Accepted reports are written by trusted ingestion code after their signatures are verified, and opinions and
// subject state by the state consumer, so request sessions only read: the application role has `select` alone.

export const observationAccess = {
  actions: { read: ['select'] },
  roles: {
    reader: {
      label: 'Reader',
      permissions: ['read'],
      assignableScopes: ['organisation'],
      includedIn: [organisationMember, organisationAdmin]
    }
  }
} as const;
