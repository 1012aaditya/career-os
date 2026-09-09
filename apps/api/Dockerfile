# The API image.
#
# Multi-stage, so the thing that ships contains the built JavaScript and
# the production dependency tree - not the toolchain, the test suite, the
# source, or the dev dependencies that pull in a compiler.
#
# Built from the REPOSITORY ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile .
# because this is a pnpm workspace and the lockfile that makes the build
# reproducible lives at the root. A build context of apps/api cannot see
# it, and would resolve versions afresh on every build.

# ---------- build ----------
FROM node:24-slim AS build

# openssl is required by Prisma's query engine at generate time. Absent, the
# failure is a runtime "could not locate the Query Engine" rather than a
# build error, which is a bad place to discover a missing package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

# pnpm refuses to purge node_modules non-interactively without this, which
# is exactly what the --prod re-resolve below does. Without it the build
# fails at the very last install step with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR.
ENV CI=true

WORKDIR /repo

# Manifests and lockfile first, so the dependency layer is cached and only
# reinstalls when a manifest actually changes - not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile --filter api...

COPY apps/api apps/api

# `prisma generate && nest build`. Generate must run inside the image: the
# client is built against the platform's engine, so one generated on a
# developer's macOS is the wrong binary for a Linux container.
RUN pnpm --filter api build

# Re-resolve with dev dependencies pruned. `--prod` after the build rather
# than before it, because the build needs the toolchain and the runtime
# must not carry it.
RUN pnpm install --frozen-lockfile --filter api... --prod \
  && pnpm store prune

# ---------- runtime ----------
FROM node:24-slim AS runtime

# tini, and it is not optional - see the ENTRYPOINT note below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /repo

# node:24-slim already provides an unprivileged `node` user. A process that
# does not need root should not have it - a container escape starts from
# whatever the process was.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/
# The migrations travel with the image so that the release step applies
# exactly the migrations this image was built from, rather than whatever
# happens to be on the branch when the release runs.
COPY --from=build --chown=node:node /repo/apps/api/prisma ./apps/api/prisma
# prisma.config.ts too, and it is load-bearing: schema.prisma's datasource
# block declares only a provider, so the connection URL comes from this
# config file reading DATABASE_URL. Without it `prisma migrate deploy`
# inside the image fails with "The datasource.url property is required",
# which is a release step that fails after the image is already built.
COPY --from=build --chown=node:node /repo/apps/api/prisma.config.ts ./apps/api/

USER node

WORKDIR /repo/apps/api

EXPOSE 3000

# tini as PID 1, then node. MEASURED, not cargo-culted.
#
# Without it this image ignored SIGTERM completely: `docker stop` waited
# the full grace period and then SIGKILLed, exit 137, even at 40 seconds.
# With tini it stops in under a second, exit 143.
#
# The reason is PID 1. The kernel does not apply default signal
# dispositions to PID 1, so a signal arriving before Node has its handler
# fully wired is simply discarded - and Nest's shutdown hooks never run.
# The consequence is exactly what PR-2 added those hooks to prevent: every
# deploy abandons in-flight requests and leaves the database pool open for
# the server to reap, on a pooler whose capacity is shared with the worker.
#
# `docker run --init` does the same thing, but Render does not pass it, so
# it has to be in the image.
ENTRYPOINT ["/usr/bin/tini", "--"]

# node directly, not `pnpm start:prod`. A package manager in between is a
# second process that also does not forward SIGTERM.
CMD ["node", "dist/main"]
