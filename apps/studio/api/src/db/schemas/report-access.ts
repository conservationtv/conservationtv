import { organisationAdmin, organisationMember } from '../roles.ts';

// The access shared by what agents report about subjects (observations, metrics and logs) and the state derived from
// them. Each record keeps its reporter (the agent whose host device signed it) separate from its subject (what was observed,
// named by the convention in src/reports/subjects.ts). A composite foreign key keeps the reporter in the record's
// organisation; the subject is a string, and only means something within that organisation.
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
