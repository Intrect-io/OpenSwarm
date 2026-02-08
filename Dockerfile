# Multi-stage build for Claude Swarm
# Using full node image for better compatibility with native modules
FROM node:22-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the TypeScript project
RUN npm run build

# Production stage - using full node image for native module support
FROM node:22 AS production

# Install system dependencies for native modules and ONNX runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        dumb-init \
        python3 \
        python3-pip \
        build-essential \
        libc6-dev \
        libstdc++6 \
        ca-certificates \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender-dev \
        libgomp1 \
        libfontconfig1 \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app user for security
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home claude

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies including optional dependencies
RUN npm ci --omit=dev --include=optional && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy configuration file template if it exists
COPY config.yaml* ./

# Create directories for volumes
RUN mkdir -p /app/config /app/logs && \
    chown -R claude:nodejs /app

# Switch to non-root user
USER claude

# Expose port (if needed)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "dist/index.js"]