import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * Relational queries (`db.query`), keyed by schema.ts's export names. Better Auth's generated `authRelations` names
 * its tables by model instead, so its relations are declared here too, against the protected `users` table.
 *
 * Request sessions run these queries under row-level security: related rows the principal cannot read are left out,
 * so every `one` stays optional. Members read each other's profiles, for instance, but not their accounts or
 * memberships.
 */
export const relations = defineRelations(schema, r => ({
  users: {
    sessions: r.many.session({ from: r.users.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.users.id, to: r.account.userId }),
    passkeys: r.many.passkeys({ from: r.users.id, to: r.passkeys.userId }),
    memberships: r.many.organisationMemberships({ from: r.users.id, to: r.organisationMemberships.userId }),
    profiles: r.many.organisationProfiles({ from: r.users.id, to: r.organisationProfiles.userId }),
    invitations: r.many.organisationInvitations({ from: r.users.id, to: r.organisationInvitations.userId }),
    browsers: r.many.browsers({ from: r.users.id, to: r.browsers.userId })
  },
  session: {
    user: r.one.users({ from: r.session.userId, to: r.users.id }),
    browsers: r.many.browsers({ from: r.session.id, to: r.browsers.sessionId })
  },
  account: {
    user: r.one.users({ from: r.account.userId, to: r.users.id })
  },
  passkeys: {
    user: r.one.users({ from: r.passkeys.userId, to: r.users.id })
  },
  organisations: {
    memberships: r.many.organisationMemberships({
      from: r.organisations.id,
      to: r.organisationMemberships.organisationId
    }),
    profiles: r.many.organisationProfiles({ from: r.organisations.id, to: r.organisationProfiles.organisationId }),
    invitations: r.many.organisationInvitations({
      from: r.organisations.id,
      to: r.organisationInvitations.organisationId
    }),
    networks: r.many.networks({ from: r.organisations.id, to: r.networks.organisationId }),
    devices: r.many.devices({ from: r.organisations.id, to: r.devices.organisationId }),
    cameras: r.many.cameras({ from: r.organisations.id, to: r.cameras.organisationId }),
    agents: r.many.agents({ from: r.organisations.id, to: r.agents.organisationId }),
    browsers: r.many.browsers({ from: r.organisations.id, to: r.browsers.organisationId }),
    gateways: r.many.gateways({ from: r.organisations.id, to: r.gateways.organisationId }),
    streams: r.many.streams({ from: r.organisations.id, to: r.streams.organisationId })
  },
  organisationMemberships: {
    organisation: r.one.organisations({ from: r.organisationMemberships.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationMemberships.userId, to: r.users.id }),
    profile: r.one.organisationProfiles({
      from: [r.organisationMemberships.organisationId, r.organisationMemberships.userId],
      to: [r.organisationProfiles.organisationId, r.organisationProfiles.userId]
    })
  },
  organisationProfiles: {
    organisation: r.one.organisations({ from: r.organisationProfiles.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationProfiles.userId, to: r.users.id }),
    membership: r.one.organisationMemberships({
      from: [r.organisationProfiles.organisationId, r.organisationProfiles.userId],
      to: [r.organisationMemberships.organisationId, r.organisationMemberships.userId]
    })
  },
  organisationInvitations: {
    organisation: r.one.organisations({ from: r.organisationInvitations.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationInvitations.userId, to: r.users.id }),
    inviter: r.one.users({ from: r.organisationInvitations.invitedBy, to: r.users.id })
  },
  // The stream topology. Every reference stays inside one organisation (composite foreign keys), and IDs are unique, so
  // relations join on the ID alone. A device's kind is one of `camera`, `agent` or `browser`: the others are null.
  networks: {
    organisation: r.one.organisations({ from: r.networks.organisationId, to: r.organisations.id }),
    devices: r.many.devices({ from: r.networks.id, to: r.devices.networkId }),
    agents: r.many.agents({ from: r.networks.id, to: r.agents.networkId }),
    activeAgent: r.one.agents({ from: r.networks.id, to: r.agents.networkId, where: { active: true } }),
    gateways: r.many.gateways({ from: r.networks.id, to: r.gateways.networkId })
  },
  devices: {
    organisation: r.one.organisations({ from: r.devices.organisationId, to: r.organisations.id }),
    network: r.one.networks({ from: r.devices.networkId, to: r.networks.id }),
    camera: r.one.cameras({ from: r.devices.id, to: r.cameras.id }),
    agent: r.one.agents({ from: r.devices.id, to: r.agents.id }),
    browser: r.one.browsers({ from: r.devices.id, to: r.browsers.id }),
    sourcedStreams: r.many.streams({ from: r.devices.id, to: r.streams.sourceDeviceId }),
    publishedExposures: r.many.exposures({ from: r.devices.id, to: r.exposures.publisherDeviceId })
  },
  cameras: {
    organisation: r.one.organisations({ from: r.cameras.organisationId, to: r.organisations.id }),
    device: r.one.devices({ from: r.cameras.id, to: r.devices.id })
  },
  agents: {
    organisation: r.one.organisations({ from: r.agents.organisationId, to: r.organisations.id }),
    device: r.one.devices({ from: r.agents.id, to: r.devices.id }),
    network: r.one.networks({ from: r.agents.networkId, to: r.networks.id })
  },
  gateways: {
    organisation: r.one.organisations({ from: r.gateways.organisationId, to: r.organisations.id }),
    network: r.one.networks({ from: r.gateways.networkId, to: r.networks.id }),
    exposures: r.many.exposures({ from: r.gateways.id, to: r.exposures.gatewayId })
  },
  browsers: {
    organisation: r.one.organisations({ from: r.browsers.organisationId, to: r.organisations.id }),
    device: r.one.devices({ from: r.browsers.id, to: r.devices.id }),
    user: r.one.users({ from: r.browsers.userId, to: r.users.id }),
    session: r.one.session({ from: r.browsers.sessionId, to: r.session.id }),
    membership: r.one.organisationMemberships({
      from: [r.browsers.organisationId, r.browsers.userId],
      to: [r.organisationMemberships.organisationId, r.organisationMemberships.userId]
    })
  },
  streams: {
    organisation: r.one.organisations({ from: r.streams.organisationId, to: r.organisations.id }),
    sourceDevice: r.one.devices({ from: r.streams.sourceDeviceId, to: r.devices.id }),
    exposures: r.many.exposures({ from: r.streams.id, to: r.exposures.streamId }),
    recorders: r.many.recorders({ from: r.streams.id, to: r.recorders.streamId })
  },
  exposures: {
    organisation: r.one.organisations({ from: r.exposures.organisationId, to: r.organisations.id }),
    stream: r.one.streams({ from: r.exposures.streamId, to: r.streams.id }),
    gateway: r.one.gateways({ from: r.exposures.gatewayId, to: r.gateways.id }),
    publisherDevice: r.one.devices({ from: r.exposures.publisherDeviceId, to: r.devices.id }),
    upstream: r.one.exposures({
      from: r.exposures.upstreamExposureId,
      to: r.exposures.id,
      alias: 'exposure_upstream'
    }),
    downstreams: r.many.exposures({
      from: r.exposures.id,
      to: r.exposures.upstreamExposureId,
      alias: 'exposure_upstream'
    }),
    recorders: r.many.recorders({ from: r.exposures.id, to: r.recorders.exposureId })
  },
  recorders: {
    organisation: r.one.organisations({ from: r.recorders.organisationId, to: r.organisations.id }),
    stream: r.one.streams({ from: r.recorders.streamId, to: r.streams.id }),
    exposure: r.one.exposures({ from: r.recorders.exposureId, to: r.exposures.id })
  },
  // Reports name their reporter and subject by convention (`@conservationtv/reports`), recorded as given rather than
  // referenced, so their only relation is their organisation.
  observations: {
    organisation: r.one.organisations({ from: r.observations.organisationId, to: r.organisations.id })
  },
  metricSeries: {
    organisation: r.one.organisations({ from: r.metricSeries.organisationId, to: r.organisations.id }),
    points: r.many.metricPoints({ from: r.metricSeries.id, to: r.metricPoints.seriesId })
  },
  metricPoints: {
    series: r.one.metricSeries({ from: r.metricPoints.seriesId, to: r.metricSeries.id })
  },
  logRecords: {
    organisation: r.one.organisations({ from: r.logRecords.organisationId, to: r.organisations.id })
  },
  reporterOpinions: {
    organisation: r.one.organisations({ from: r.reporterOpinions.organisationId, to: r.organisations.id })
  },
  subjectStates: {
    organisation: r.one.organisations({ from: r.subjectStates.organisationId, to: r.organisations.id })
  }
}));
