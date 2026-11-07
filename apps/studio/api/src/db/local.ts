/** Direct Postgres connection for migrations and schema tooling, which need session semantics. */
export const LOCAL_ADMIN_DATABASE_URL = 'postgres://studio:studio@localhost:5434/studio';

/** Local Hyperdrive does not pool: route request connections through docker-compose's PgBouncer instead. */
export const LOCAL_POOLED_ADMIN_DATABASE_URL = 'postgres://studio:studio@localhost:6434/studio';
export const LOCAL_POOLED_APP_DATABASE_URL = 'postgres://studio_app:studio_app@localhost:6434/studio';
