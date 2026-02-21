# Multi-stage build for Claude Swarm
# Stage 1: Builder (using Alpine for smaller image)
FROM node:22-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci --include=dev

# Copy all source code
COPY . .

# Build the TypeScript project
RUN npx tsc

# Stage 2: Production (use slim instead of alpine for better compatibility)
FROM node:22-slim AS production

# Install runtime dependencies for native modules and ONNX
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        dumb-init \
        python3 \
        ca-certificates \
        curl \
        gnupg \
        git \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
        dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
        tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force

# Create app user for security
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home claude

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --include=optional && \
    npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy configuration (use config.yaml from project root)
COPY config.yaml ./config.yaml

# Create necessary directories and set permissions
RUN mkdir -p /app/config /app/logs /app/data /home/claude/dev && \
    ln -sf /app /home/claude/dev/claude-swarm && \
    chown -R claude:nodejs /app && \
    chown -R claude:nodejs /home/claude

# Switch to non-root user
USER claude

# Expose web dashboard port
EXPOSE 3847

# Health check via web API
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3847/api/stats || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]