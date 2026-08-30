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
#
# postgresql-client / sqlite3 / openssh-client / jq / netcat-openbsd are the
# agent's toolchain, not the daemon's. Repository credentials already reach an
# isolated worktree — cgf-portal links .env, apps/pipelines/.env and friends in
# via its post-checkout hook, and AGT-4061 lets the sandbox read through those
# links — so an agent holding a working DSN and no `psql`, or reachable NAS
# credentials and no `ssh`, can do nothing but ask the operator to verify for it.
#
# sqlite3 is the same argument for a file rather than a service: a repository
# whose tests `execFileSync("sqlite3", ...)` fails on the missing binary, and the
# worker cannot tell that from a real regression. Measured on cgf-portal:
# 42 of 940 `npm run verify` failures were this, and it cost an operator
# question (AGT-4096). The daemon's own better-sqlite3 is a Node addon and puts
# nothing on PATH, so it does not cover this.
#
# These grant no new access: they are clients for services the container can
# already reach with credentials it already has. Evidence and the measured
# effect are on AGT-4081.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        dumb-init ca-certificates curl git bubblewrap gnupg python3 \
        postgresql-client sqlite3 openssh-client jq netcat-openbsd && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# The docker CLI and its compose plugin, for repositories whose gates validate a
# compose file. `docker compose config` renders and interpolates the YAML from
# disk and never opens a socket, so the CLI alone is what those gates need.
#
# Deliberately no /var/run/docker.sock: mounting it would give every agent
# control of the host's containers, which is a container escape by another name.
# Subcommands that do need a daemon (up, build, ps) will fail to connect — that
# is the boundary, not a bug to be fixed by mounting the socket.
RUN apt-get update && apt-get install -y --no-install-recommends gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# cxt, the code-exploration CLI. An agent dropped into an unfamiliar repository
# otherwise answers "where is X / what calls X / is this tested" with dozens of
# grep and read calls, and its context fills with file dumps before it starts
# work. `cxt scan` once, then `cxt check`/`who-calls`/`impact`/`bs` answer those
# from a local registry.
#
# Pinned exactly: an agent-facing tool that changed behaviour under us would
# change every agent's reading of a repository at once.
RUN npm install -g @intrect/cxt@0.3.0 && npm cache clean --force

# uv, for repositories that are uv projects. Copied from the official image
# rather than piped from an installer, and pinned by digest rather than tag —
# a tag can be repointed, so only the digest makes this build reproducible.
# The digest is the multi-arch index for v0.12.7; bump both together.
#
# Held at 0.5.11 until 2026-08-29, where it cost the daemon its event loop.
# 0.5.11 caches wheels as archives and re-extracts them into every venv: of 129
# files sampled in a fresh venv, 0 were hardlinks, and `UV_LINK_MODE=hardlink`
# made no difference. 0.12.7 keeps an extracted `archive-v0` store and links
# from it — 349 of 400 files in a real `uv sync` of apps/pipelines, whose venv
# is 392MB. With 23 worktrees each building their own (the venv is deliberately
# never shared: a linked one makes a worktree import the main checkout's src/),
# rebuilding three or four at once wrote ~1.49GB and blocked the loop for 28-33s,
# observed seven times. Verified against the real lockfile before bumping:
# `uv.lock` is version 1, 0.12.7 reads it unmigrated and `sync --frozen`
# completed in 1.7s.
COPY --from=ghcr.io/astral-sh/uv@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 /uv /uvx /usr/local/bin/

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
    NODE_ENV=production \
    UV_PYTHON_INSTALL_DIR=/home/openswarm/.local/share/uv/python

# Bake the interpreter in rather than letting uv fetch it on first use: that
# download lands under $HOME, which is not a mounted volume, so every container
# recreate would pay for it again — and an agent whose first act is a 30 MB
# fetch looks like a hung task. The distribution `python3` above stays: CodeQL's
# Python extractor shells out to it, and that is a separate need from a project
# runtime (Debian ships 3.11, and repositories here are on 3.12).
RUN uv python install 3.12

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
