# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# mcp-coordinator — production image
# Two-stage build keeps the runtime image small (~150MB) by leaving the dev
# toolchain (typescript, tsx, vitest) and the npm cache in the builder stage.
# ---------------------------------------------------------------------------

# ---- Stage 1: builder ------------------------------------------------------
# Compiles TypeScript -> dist/ using the full devDependency set. This stage
# never ships; only its dist/ + production node_modules are copied forward.
FROM node:22-alpine AS builder

WORKDIR /build

# Copy manifest first so this layer caches as long as deps don't change.
# Subsequent code edits won't bust npm install.
COPY package.json package-lock.json ./

# Install build tools for tree-sitter native bindings (node-gyp).
# These are needed when prebuilt binaries are unavailable on Alpine/musl.
RUN apk add --no-cache python3 make g++

# `npm ci` is reproducible (uses the lockfile) and faster than `npm install`
# in CI/Docker. We need devDependencies here for tsc, so no --omit=dev.
RUN npm ci --no-audit --no-fund

# Copy the rest of the sources needed for `tsc`.
# We deliberately do NOT copy tests, docs, or .git — see .dockerignore.
COPY tsconfig.json ./
COPY src ./src
COPY cli ./cli

# Produce dist/src and dist/cli per tsconfig "outDir".
RUN npm run build

# Re-resolve node_modules with production-only deps. We need a dedicated
# directory because the builder's node_modules above contains devDeps.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ------------------------------------------------------
# Minimal alpine + a non-root user. Only the compiled output, prod modules,
# dashboard assets, and package metadata land here.
FROM node:22-alpine AS runtime

# wget is used by HEALTHCHECK below; busybox in alpine ships it but we make
# it explicit so the probe still works if the base image is swapped.
# tini gives us a real PID 1 so SIGTERM reaches Node and graceful shutdown
# (see src/serve-http.ts handle.stop()) actually runs on `docker stop`.
# git is required for Layer 4 (git_cochange) which runs git log via child_process.
RUN apk add --no-cache wget tini git

# Non-root user — runs the coordinator with reduced blast radius. UID 1001
# matches the convention used by GitHub Actions runners and most k8s
# securityContext examples, so volume permissions are predictable when the
# host bind-mounts /data.
RUN addgroup -g 1001 -S coordinator \
  && adduser -u 1001 -S coordinator -G coordinator

WORKDIR /app

# Copy build output + production-only node_modules from the builder stage.
# Each COPY is its own layer so re-publishes only invalidate what changed.
COPY --from=builder --chown=coordinator:coordinator /build/dist ./dist
COPY --from=builder --chown=coordinator:coordinator /build/node_modules ./node_modules
COPY --from=builder --chown=coordinator:coordinator /build/package.json ./package.json

# Dashboard is served as static files by serve-http.ts; ship it next to the
# code (getDashboardDir() walks up from dist/src looking for dashboard/public).
COPY --chown=coordinator:coordinator dashboard ./dashboard
COPY --chown=coordinator:coordinator LICENSE ./LICENSE

# Persistent data lives under /data — SQLite DB, run config, registration
# files. Declaring VOLUME signals the contract; users mount a named volume
# or host path here. COORDINATOR_DATA_DIR points serve-http.ts at /data/data
# (the default subdir is "./data" relative to dataDir, so we pin it).
ENV COORDINATOR_DATA_DIR=/data/data \
  NODE_ENV=production \
  PORT=3100

VOLUME ["/data"]

# Pre-create the data dir with the right ownership so the non-root user can
# write on first boot even when /data is a fresh anonymous volume.
RUN mkdir -p /data/data && chown -R coordinator:coordinator /data

# 3100 = HTTP (MCP + REST + SSE + dashboard)
# 1883 = embedded MQTT TCP broker
EXPOSE 3100 1883

USER coordinator

# Use 127.0.0.1 inside the container — the probe runs in the same net
# namespace as the server, so loopback is correct and avoids DNS surprises.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3100/health || exit 1

# tini reaps zombies and forwards signals; the actual entrypoint is the
# compiled CLI which dispatches to `server start` by default (CMD below).
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli/index.js"]
CMD ["server", "start"]
