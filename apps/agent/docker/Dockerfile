# syntax=docker/dockerfile:1

# The agent runner as an image. Build from the repository root, which holds the workspace the runner depends on:
#   docker build -f apps/agent/docker/Dockerfile .
# or `docker compose up --build` from this directory.

FROM node:24-slim AS build
RUN npm install --global pnpm@12.10.1
WORKDIR /repo
COPY . .
# The runner with only its production dependencies, the workspace packages among them, as a standalone directory.
# The store is cached between builds.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @conservationtv/agent-runner deploy --prod --store-dir /pnpm/store /app

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
USER node
# Nothing to expose: the agent dials out to iroh's relays and peers reach it through them, or hole-punch directly.
# One Node process as PID 1, with tsx loaded in-process rather than through its CLI's child process, so `docker stop`'s
# SIGTERM reaches close-with-grace directly and stops the agent gracefully.
CMD ["node", "--import", "tsx", "src/index.ts"]
