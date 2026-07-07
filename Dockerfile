# EquiAlgo Alert Service - Docker image with Puppeteer (Chromium)
FROM node:22-bookworm-slim

# Runtime deps for Puppeteer's bundled Chrome headless shell
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer downloads its own Chrome headless shell; store in /app so the
# node user can access it at runtime (build runs as root, runtime as node)
ENV PUPPETEER_HEADLESS=shell
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Install dependencies (production + dev for build)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile && npx puppeteer browsers install chrome-headless-shell

# Build the app
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
RUN cd ui && pnpm install --frozen-lockfile && pnpm run build
RUN rm -rf ui/node_modules ui/src ui/package.json ui/pnpm-lock.yaml ui/tsconfig.json ui/tsconfig.node.json ui/tsconfig.tsbuildinfo ui/vite.config.ts ui/index.html
RUN pnpm run build

# Drop devDependencies to shrink image (optional; comment out if you need them at runtime)
RUN pnpm prune --prod

EXPOSE 3000

RUN chown -R node:node /app

USER node

# Use --init in docker run so Puppeteer child processes are reaped (e.g. docker run --init ...)
CMD ["node", "dist/index.js"]
