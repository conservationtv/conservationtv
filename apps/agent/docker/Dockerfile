# syntax=docker/dockerfile:1

# The agent runner as an image. Build from the repository root, which holds the workspace the runner depends on:
#   docker build -f apps/agent/docker/Dockerfile .
# or `docker compose up --build` from this directory.

# Alpine, so the build and the image share musl, and pnpm installs iroh's musl addon for the build's architecture.
FROM node:24-alpine AS build
RUN apk add --no-cache binutils && npm install --global pnpm@12.10.1
WORKDIR /repo
COPY . .
# The runner and its workspace dependencies, bundled by esbuild into one file. The store is cached between builds.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @conservationtv/agent-runner... \
 && pnpm --filter @conservationtv/agent-runner build
# The image's whole filesystem: the bundle, and iroh, the one dependency left external for its native addon, with
# only its loader and the addon itself. The bundle imports the loader as @number0/iroh, which may be an alias; the
# loader requires its addon by the addon package's own name. Node ships with debug symbols; stripping them saves a
# tenth of the image.
RUN mkdir -p /out/app/node_modules/@number0/iroh \
 && cp apps/agent/runner/dist/index.js /out/app/ \
 && echo '{"type":"module"}' > /out/app/package.json \
 && iroh=$(cd apps/agent/core && node -p "require('node:path').dirname(require.resolve('@number0/iroh/package.json'))") \
 && addon=$(echo "$iroh"-linux-*) \
 && addon_name=$(node -p "require('$addon/package.json').name") \
 && mkdir -p /out/app/node_modules/"$addon_name" \
 && cp -L "$iroh"/package.json "$iroh"/index.js /out/app/node_modules/@number0/iroh/ \
 && cp -L "$addon"/package.json "$addon"/*.node /out/app/node_modules/"$addon_name"/ \
 && mkdir -p /out/usr/local/bin /out/usr/lib /out/lib /out/tmp \
 && strip -o /out/usr/local/bin/node /usr/local/bin/node \
 && cp -L /lib/ld-musl-*.so.1 /out/lib/ \
 && cp -L /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /out/usr/lib/ \
 && chmod 1777 /out/tmp

# Nothing but Node, the C and C++ runtimes it links against, and the agent: no shell, no package manager.
FROM scratch
COPY --from=build /out /
ENV NODE_ENV=production
WORKDIR /app
# Node's own user in the official images, by number: there is no /etc/passwd to name it.
USER 1000:1000
# Nothing to expose: the agent dials out to iroh's relays and peers reach it through them, or hole-punch directly.
# One Node process as PID 1, so `docker stop`'s SIGTERM reaches close-with-grace directly and stops the agent
# gracefully.
CMD ["/usr/local/bin/node", "index.js"]
