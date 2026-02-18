# EquiAlgo Alert Service - Docker image with Puppeteer (Chromium)
FROM node:22-bookworm-slim

# Install Chromium and runtime deps for headless Puppeteer (no bundled Chrome download)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
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
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium; skip Puppeteer's download to save space and avoid version mismatch
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Install dependencies (production + dev for build)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Build the app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Drop devDependencies to shrink image (optional; comment out if you need them at runtime)
RUN pnpm prune --prod

# Run as non-root if possible (Chromium may need specific permissions; use --cap-add=SYS_ADMIN if needed)
USER node

# Use --init in docker run so Puppeteer child processes are reaped (e.g. docker run --init ...)
CMD ["node", "dist/index.js"]
