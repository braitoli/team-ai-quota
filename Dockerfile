FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY package.json ./
COPY src/ ./src/

# Create persistent data volume directory
RUN mkdir -p /data

# Default environment variables
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 8787

# Container healthcheck hitting the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8787}/health || exit 1

CMD ["node", "src/standalone-server.js"]
