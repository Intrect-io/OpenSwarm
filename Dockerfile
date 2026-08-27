# ============================================
# OpenSwarm - deployable daemon image
# ============================================
#
# Two stages on the SAME libc (node:22-slim / glibc): the native addons
# (better-sqlite3, lancedb) are compiled once in the builder and copied into
# the runtime, so the runtime stage needs no toolchain and cannot drift from
# what was built. The previous Alpine(musl) builder + slim(glibc) runtime pair
# forced a second, toolchain-less rebuild in the runtime stage that only worked
# while every native dependency happened to ship a prebuilt binary.
#
# The image runs the headless daemon (web dashboard on 3847) and bundles the
# `openswarm` CLI. Provider CLIs (claude/codex/cursor) are NOT baked in — the
# default codex-responses adapter runs OpenSwarm's own tool loop against
# mounted OAuth state (~/.openswarm, ~/.codex). See README "Run with Docker".

# ---- Stage 1: build ----
FROM node:22-slim AS builder

# Toolchain for native-addon source builds when a prebuilt binary is missing.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .

# Full build script, not bare tsc: postbuild sets the CLI exec bit and copies
# web/static into dist/web-static — without it the dashboard serves nothing.
RUN npm run build

# Drop devDependencies in place so the runtime copies exactly the node_modules
# the build compiled (natives included), nothing more.
RUN npm prune --omit=dev && npm cache clean --force

# ---- Stage 2: runtime ----
FROM node:22-slim AS production

# git + gh: workers commit and open PRs. bubblewrap: the verify sandbox —
# fail-closed under Docker's default seccomp profile; see README for the flags
# that enable it. curl: healthcheck. dumb-init: PID-1 signal handling.
# python3 is a runtime dependency, not a build one: the security-audit gate runs
# CodeQL over every language present in the analysed repository, and CodeQL's
# Python extractor shells out to an interpreter. Without it a single tracked
# .py file makes `codeql database create --build-mode=none` fail, which the
# pipeline reports as an infra error and parks the task.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        dumb-init ca-certificates curl git bubblewrap gnupg python3 && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 openswarm && \
    useradd --uid 1001 --gid openswarm --shell /bin/bash --create-home openswarm

WORKDIR /app

COPY --from=builder --chown=openswarm:openswarm /app/node_modules ./node_modules
COPY --from=builder --chown=openswarm:openswarm /app/dist ./dist
COPY --chown=openswarm:openswarm package.json config.example.yaml ./
COPY --chown=openswarm:openswarm templates ./templates
# The repository's CodeQL *configuration*. The CodeQL CLI itself is not shipped:
# the bundle is roughly a gigabyte and would be carried by every pull, so the
# image expects it to be provided by the deployment. Without it the security
# audit reports `unavailable` and the pipeline parks the task rather than
# skipping the gate — mount a bundle and put it on PATH, e.g.
#   volumes: [ /opt/codeql-bundle:/opt/codeql:ro ]
#   environment: [ "PATH=/opt/codeql:/usr/local/bin:/usr/bin:/bin" ]
COPY --chown=openswarm:openswarm .codeql ./.codeql

# The CLI on PATH; node resolves modules from the symlink target, so this is
# equivalent to a global install without a second copy of the package.
RUN ln -s /app/dist/cli.js /usr/local/bin/openswarm

# /work is where repositories are mounted; ~/.openswarm holds daemon state and
# must be a volume or every restart forgets task state, auth profiles, and the
# coordination board.
RUN mkdir -p /work /home/openswarm/.openswarm && \
    chown -R openswarm:openswarm /work /home/openswarm

USER openswarm
ENV HOME=/home/openswarm \
    NODE_ENV=production

# Mounted repositories belong to arbitrary host UIDs; without this every git
# operation inside /work dies with "dubious ownership". The container's whole
# job is operating on mounted repos, so the blanket opt-in is the intent.
RUN git config --global safe.directory '*'

EXPOSE 3847

# /api/health is the token-less diagnostics endpoint (INT-3388) — /api/* reads
# are otherwise auth-gated, so a healthcheck against them reports auth policy,
# not process health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:3847/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
