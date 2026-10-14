/** The docker-compose Postgres used by `cf dev` and migrations, as its two roles: the owner and the application. */
export const LOCAL_ADMIN_DATABASE_URL = 'postgres://studio:studio@localhost:5434/studio';
export const LOCAL_APP_DATABASE_URL = 'postgres://studio_app:studio_app@localhost:5434/studio';
