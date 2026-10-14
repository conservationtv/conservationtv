import { role } from '../src/index.js';

export const admin = role('admin', { label: 'Administrator', description: 'Manage participating resources.' });
export const reader = role('reader', { label: 'Reader', description: 'Read participating resources.' });
export const auditor = role('auditor', { label: 'Auditor', description: 'Reserved for future audit features.' });
export const organisationAdmin = role('organisationAdmin', {
  label: 'Organisation administrator',
  description: 'Manage an organisation, its memberships, projects, devices, locations, and metrics.',
  assignableScopes: ['organisation']
});
