import { defineAuthorization } from '@conservationtv/umbrella';
import { self } from './db/roles.ts';
import * as schema from './db/schema.ts';

/**
 * The compiled access definitions, once per isolate. Request handlers get a session over the application
 * connection through `services().session(principal)`; only trusted code (Better Auth's provisioning hooks) reaches
 * `authorization.access(admin)`.
 */
export const authorization = defineAuthorization({ schema, roles: { self } });
