This project uses Pulumi to manage the infrastructure for the project. There are several deployments across the controlplane, agent, studio and desktop projects. There are dependancies between them which are described in the respective project README files.

We use a central Postgres database, hosted on planetscale, for storing and authenticating pulumi state. Additionally, encryption is managed by a 'passphrase' secret provider. Both the passphrase and database credentials are found in the organisation 1Password vault. Most people will be deploying via CI/CD pipelines so access these credentials is not needed by most contributors and is restricted. Github actions are configured with those credentials. 

If you do have access to the 1Password vault, ensure the `op` cli is working on your machine and then run `op run --env-file=.env.pulumi -- pulumi <command>` to run pulumi commands locally with your credentials.
