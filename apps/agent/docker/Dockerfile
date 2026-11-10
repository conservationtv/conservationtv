# syntax=docker/dockerfile:1

# The agent runner as an image, for linux/amd64 and linux/arm64 (Raspberry Pis on a 64-bit OS). Build from the
# repository root, which holds the workspace the runner depends on:
#   docker build -f apps/agent/docker/Dockerfile .
# or `docker compose up --build` from this directory. CI publishes it as ghcr.io/conservationtv/agent
# (.github/workflows/agent-image.yml).

# Debian, glibc, in both stages: the binaries the agent downloads for linux-x64 and linux-arm64 are glibc builds (moq
# has no musl one), so the build installs iroh's glibc addon to match.
FROM node:24-trixie-slim AS build
RUN apt-get update \
 && apt-get install --yes --no-install-recommends binutils ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@12.10.1
WORKDIR /repo
COPY . .
# The runner and its workspace dependencies, bundled by esbuild into one file. The store is cached between builds.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @conservationtv/agent-runner... \
 && pnpm --filter @conservationtv/agent-runner build
# The app: the bundle, and iroh, the one dependency left external for its native addon, with only its loader and the
# addon itself. The bundle imports the loader as @number0/iroh, which may be an alias; the loader requires its addon by
# the addon package's own name. Node ships with debug symbols; stripping them saves a tenth of the image.
RUN mkdir -p /out/app/node_modules/@number0/iroh /out/usr/local/bin \
 && cp apps/agent/runner/dist/index.js /out/app/ \
 && echo '{"type":"module"}' > /out/app/package.json \
 && iroh=$(cd apps/agent/core && node -p "require('node:path').dirname(require.resolve('@number0/iroh/package.json'))") \
 && addon=$(echo "$iroh"-linux-*-gnu) \
 && test -d "$addon" \
 && addon_name=$(node -p "require('$addon/package.json').name") \
 && mkdir -p /out/app/node_modules/"$addon_name" \
 && cp -L "$iroh"/package.json "$iroh"/index.js /out/app/node_modules/@number0/iroh/ \
 && cp -L "$addon"/package.json "$addon"/*.node /out/app/node_modules/"$addon_name"/ \
 && strip -o /out/usr/local/bin/node /usr/local/bin/node \
 && mkdir -p /out/app/data

# Debian's slim image, for what the agent needs to download and run its own binaries: glibc and libstdc++, tar to
# unpack them, and certificates for MediaMTX and moq, which read the system's (Node has its own). Node beside it: no
# npm, no package manager left behind.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/usr/local/bin/node /usr/local/bin/node
# The agent's directory, data/, holds the binaries it installs beside MediaMTX's config, certificates and log. Mount
# a volume there so an upgraded container keeps them rather than downloading them again; a new named volume starts
# with this empty directory, owned by the agent's user.
COPY --from=build --chown=1000:1000 /out/app /app
ENV NODE_ENV=production HOME=/app
WORKDIR /app
USER 1000:1000
# Nothing to expose: the agent dials out to iroh's relays and peers reach it through them, or hole-punch directly. On a
# device, run it on the host's network (docker-compose.device.yml), so MediaMTX's endpoints are the host's addresses.
# One Node process as PID 1, so `docker stop`'s SIGTERM reaches close-with-grace directly and stops the agent
# gracefully.
CMD ["/usr/local/bin/node", "index.js"]
