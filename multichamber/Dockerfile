# syntax=docker/dockerfile:1
# MultiChamber image: OpenChamber web + OpenCode for one user per container.
# Build context is the repository root:  docker build -f multichamber/Dockerfile .
#
# BUN_VERSION and OPENCODE_VERSION follow the upstream Dockerfile; the sync job
# (multichamber/sync-upstream.sh) rewrites them after every upstream merge.
ARG BUN_VERSION=1.4.2
ARG OPENCODE_VERSION=2.0.21

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY bun-patches ./bun-patches
COPY packages/ui/package.json ./packages/ui/
COPY packages/web/package.json ./packages/web/
COPY packages/electron/package.json ./packages/electron/
COPY packages/vscode/package.json ./packages/vscode/
COPY packages/mobile/package.json ./packages/mobile/
COPY packages/sdk/package.json ./packages/sdk/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
COPY . .
RUN bun run --cwd packages/sdk build
RUN bun run build:web

# Baseline builds run on x86-64 CPUs without AVX2 as well as with it.
FROM debian:trixie-slim AS bun-baseline
ARG BUN_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/bun
RUN curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" \
  && curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" \
  && grep ' bun-linux-x64-baseline.zip$' SHASUMS256.txt | sha256sum -c - \
  && unzip -q bun-linux-x64-baseline.zip \
  && install -m 0755 bun-linux-x64-baseline/bun /usr/local/bin/bun

FROM debian:trixie-slim AS runtime
ARG OPENCODE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash bzip2 build-essential ca-certificates curl fd-find git jq less nano nodejs npm \
    openssh-client procps python3 python3-pip python3-venv ripgrep tini unzip vim-tiny \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun-baseline /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Always the baseline OpenCode build: the npm wrapper would pick the binary for
# the build machine's CPU, not for the CPU the container runs on.
RUN npm install -g --prefix /opt/opencode "@opencode/cli-linux-x64-baseline@${OPENCODE_VERSION}" \
  && ln -s /opt/opencode/lib/node_modules/@opencode/cli-linux-x64-baseline/bin/opencode /usr/local/bin/opencode \
  && opencode --version

RUN groupadd -g 1000 dev && useradd -u 1000 -g 1000 -m -s /bin/bash dev

WORKDIR /opt/multichamber
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/web/bin ./packages/web/bin
COPY --from=builder /app/packages/web/server ./packages/web/server
COPY --from=builder /app/packages/web/dist ./packages/web/dist

COPY multichamber/policy.json /etc/openchamber/policy.json
COPY multichamber/opencode.json /etc/multichamber/opencode.json
COPY multichamber/entrypoint.sh /usr/local/bin/multichamber-entrypoint

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    HOME=/home/dev \
    OPENCODE_CONFIG=/etc/multichamber/opencode.json \
    OPENCHAMBER_HOST=0.0.0.0

USER dev
EXPOSE 3000
ENTRYPOINT ["tini", "--", "sh", "/usr/local/bin/multichamber-entrypoint"]
