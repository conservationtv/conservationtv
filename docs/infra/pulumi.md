This project uses Pulumi to manage the infrastructure for the project. There are several deployments across the controlplane, agent, studio and desktop projects. There are dependancies between them which are described in the respective project README files.

Pulumi state is kept in the Cloudflare R2 bucket `conservationtv-pulumi-state`, which each project names as its `backend.url` in `Pulumi.yaml`; Pulumi reaches it as S3 with an R2 API token scoped to that bucket (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`). Additionally, encryption is managed by a 'passphrase' secret provider. Both the passphrase and the bucket's credentials are found in the organisation 1Password vault. Most people will be deploying via CI/CD pipelines so access these credentials is not needed by most contributors and is restricted. Github actions are configured with those credentials.

If you do have access to the 1Password vault, ensure the `op` cli is working on your machine and then run `op run --env-file=.env.pulumi -- pulumi <command>` to run pulumi commands locally with your credentials.

`.env.pulumi` must not set `PULUMI_BACKEND_URL`: it would override the projects' `backend.url`.

State moved here from a PlanetScale Postgres database, which GitHub's runners intermittently lost their connection to mid-command, stalling Pulumi for about 17 minutes before `failed to load checkpoint … read: connection timed out`. That database is kept, untouched, as a fallback until the bucket has proven itself.
