import { readFile } from 'node:fs/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { device, rlsMigration, user, withAuthorization, type Database, type Principal } from '../src/index.js';
import * as schema from './schema.js';
import { admin, reader, auditor, organisationAdmin } from './roles.js';

type QueryArguments = Parameters<PGlite['query']>;
/**
 * PGlite runs one database session, so this demo simulates the application's login by running each of its
 * statements under `set local role`. A real deployment gives the application its own connection string instead.
 */
function loginAs(pg: PGlite, role: string): PGlite {
  const enter = `set local role ${role}`;
  const client = {
    query: async (...args: QueryArguments) =>
      pg.transaction(async tx => {
        await tx.query(enter);
        return tx.query(...args);
      }),
    transaction: async <R>(run: (tx: Transaction) => Promise<R>) =>
      pg.transaction(async tx => {
        await tx.query(enter);
        return run(tx);
      })
  };
  // SAFETY: Drizzle's PGlite driver calls only query and transaction, which this forwards with the same shapes.
  return client as never;
}

const postgres = new PGlite();
try {
  await postgres.exec(await readFile(new URL('../migrations/0000_authz.sql', import.meta.url), 'utf8'));
  await postgres.exec(`
    create table organisations (id text primary key, name text not null);
    insert into organisations values ('acme', 'Acme'), ('globex', 'Globex'), ('initech', 'Initech');
    create table devices (id integer primary key, name text not null, organisation_id text not null references organisations(id));
    create table metrics (
      id serial primary key, device_id integer not null references devices(id),
      value double precision not null,
      recorded_at timestamptz not null default now()
    );
    insert into devices values (1, 'Workshop sensor', 'acme'), (2, 'Office sensor', 'globex');
    insert into metrics (device_id, value) values (1, 10), (2, 20);
    create table locations (id serial primary key, organisation_id text not null references organisations(id), name text not null);
    insert into locations (organisation_id, name) values ('acme', 'Workshop'), ('globex', 'Office');
    create table projects (id text primary key, organisation_id text not null references organisations(id), name text not null);
    insert into projects values ('apollo', 'acme', 'Apollo'), ('gemini', 'globex', 'Gemini');
    create table users (id text primary key, name text not null);
    insert into users values ('james', 'James'), ('alex', 'Alex'), ('sam', 'Sam'), ('guest', 'Guest');
    create table organisation_users (
      organisation_id text not null references organisations(id),
      user_id text not null references users(id),
      primary key (organisation_id, user_id)
    );
    insert into organisation_users values ('acme', 'james'), ('acme', 'sam'), ('globex', 'sam'), ('initech', 'guest');
  `);
  await postgres.exec(rlsMigration(schema));
  await postgres.exec(`
    create role app login;
    grant select, insert, update, delete on all tables in schema public to app;
    grant usage on all sequences in schema public to app;
  `);
  // The owner manages grants; the application connection logs in as "app", which cannot bypass the policies.
  const rawDb = drizzle({ client: postgres });
  const appDb = drizzle({ client: loginAs(postgres, 'app') });
  const db = withAuthorization({ app: appDb, admin: rawDb }, { schema, roles: { admin, reader, auditor } });
  const { devices, metrics, locations, projects, users, organisations, organisationUsers } = schema;
  const as = <R>(who: Principal, run: (tx: Database) => Promise<R>) => db.as(who).transaction(run);

  // Includes discovered table memberships and the explicitly registered, unused Auditor role.
  console.dir(db.access.catalog(), { depth: null });

  // One shared reader grant covers every participating table.
  const james = user('james');
  await db.access.root().grant({ principal: james, role: reader });

  const alex = user('alex');
  await db.access.root().grant({ principal: alex, role: admin });

  // "project" is the scope name above; "apollo" selects one project within it.
  const sam = user('sam');
  await db.access.at(projects.$access.scope.at('apollo')).grant({
    principal: sam,
    role: projects.$access.roles.reader
  });

  // One scoped admin grant manages the organisation and its resources, including descendant device scopes.
  await db.access.at(organisations.$access.scope.at('acme')).grant({ principal: james, role: organisationAdmin });
  console.log(
    'James updates Acme:',
    await as(james, tx => tx.update(organisations).set({ name: 'Acme Ltd' }).returning())
  );
  console.log('James lists Acme memberships:', await as(james, tx => tx.select().from(organisationUsers)));
  console.log(
    'James adds an Acme member:',
    await as(james, tx => tx.insert(organisationUsers).values({ organisationId: 'acme', userId: 'guest' }).returning())
  );
  console.log(
    'James removes that member:',
    await as(james, tx => tx.delete(organisationUsers).where(eq(organisationUsers.userId, 'guest')).returning())
  );
  console.log('James manages Acme devices:', await as(james, tx => tx.select().from(devices)));
  console.log(
    'James renames an Acme device:',
    await as(james, tx => tx.update(devices).set({ name: 'Workshop thermostat' }).where(eq(devices.id, 1)).returning())
  );
  console.log(
    'James cannot update Gemini yet:',
    await as(james, tx => tx.update(projects).set({ name: 'Denied' }).where(eq(projects.id, 'gemini')).returning())
  );
  console.log(
    'Sam belongs to both, but has no organisation admin role:',
    await as(sam, tx => tx.select().from(organisationUsers))
  );
  const globexAdmin = await db.access
    .at(organisations.$access.scope.at('globex'))
    .grant({ principal: james, role: organisationAdmin });
  console.log(
    'James can now update Gemini:',
    await as(james, tx =>
      tx.update(projects).set({ name: 'Gemini Enterprise' }).where(eq(projects.id, 'gemini')).returning()
    )
  );
  await db.access.revoke(globexAdmin.id);
  console.log(
    'James retains Acme administration after revoking Globex:',
    await as(james, tx => tx.select().from(organisations))
  );

  // Joins, projections and aggregates run under the same policies: each table contributes only readable rows.
  console.log(
    'James joins Acme metrics to their devices:',
    await as(james, tx =>
      tx
        .select({ device: devices.name, value: metrics.value })
        .from(metrics)
        .innerJoin(devices, eq(metrics.deviceId, devices.id))
    )
  );

  const sensor = device(1);
  const writer = await db.access
    .at(devices.$access.scope.at(sensor.id))
    .grant({ principal: sensor, role: metrics.$access.roles.writer });

  console.log(
    'Sam access to Apollo:',
    await db.access.inspect({
      principal: sam,
      resource: projects,
      scope: projects.$access.scope.at('apollo')
    })
  );

  // One aggregated access row per principal keeps pagination over users predictable.
  const projectAccess = db.access
    .inspectQuery({
      resource: projects,
      scope: projects.$access.scope.at('apollo')
    })
    .as('project_access');
  console.dir(
    await rawDb
      .select({
        id: users.id,
        name: users.name,
        roles: projectAccess.roles,
        permissions: projectAccess.permissions
      })
      .from(users)
      .leftJoin(projectAccess, and(eq(projectAccess.principalKind, 'user'), eq(projectAccess.principalId, users.id)))
      .orderBy(users.id),
    { depth: null }
  );

  // Native arrays let SQL filter effective permissions, including shared-role contributions.
  console.log(
    'Users who can write Apollo:',
    await rawDb
      .select({ name: users.name })
      .from(users)
      .innerJoin(projectAccess, and(eq(projectAccess.principalKind, 'user'), eq(projectAccess.principalId, users.id)))
      .where(arrayContains(projectAccess.permissions, ['write']))
  );

  // Exact stored-role filtering, with distinct devices even if several grant windows overlap.
  const writers = db.access.grantsQuery({ role: metrics.$access.roles.writer, active: true }).as('writers');
  console.log(
    'Devices with the metrics writer role:',
    await rawDb
      .selectDistinct({ id: devices.id })
      .from(devices)
      .innerJoin(writers, and(eq(writers.principalKind, 'device'), eq(writers.principalId, sql`${devices.id}::text`)))
  );

  console.log('James reads all locations:', await as(james, tx => tx.select().from(locations)));
  console.log('Sam reads only Apollo:', await as(sam, tx => tx.select().from(projects)));
  console.log(
    'Shared admin writes a location:',
    await as(alex, tx => tx.insert(locations).values({ organisationId: 'globex', name: 'Lab' }).returning())
  );
  console.log('Device 1 reads its metrics:', await as(sensor, tx => tx.select().from(metrics)));
  console.log(
    'Device 1 writes:',
    await as(sensor, tx => tx.insert(metrics).values({ deviceId: 1, value: 42 }).returning())
  );
  console.log('Access at device 1:', await db.access.at(devices.$access.scope.at(1)).list({ includeInherited: true }));

  try {
    await as(sensor, tx => tx.insert(metrics).values({ deviceId: 2, value: 99 }));
  } catch (error) {
    console.log("Writing another device's metrics:", error instanceof Error ? error.cause : error);
  }

  await db.access.revoke(writer.id);
  console.log('Device 1 after revocation:', await as(sensor, tx => tx.select().from(metrics)));
} finally {
  await postgres.close();
}
