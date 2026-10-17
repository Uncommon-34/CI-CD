ARG NODE_VERSION=20-slim
FROM node:${NODE_VERSION}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY server.js .
RUN npm init -y && npm install --save crypto

RUN mkdir -p /workspace

ENV REPO_URL="" \
    BRANCH="main" \
    GITHUB_TOKEN="" \
    WEBHOOK_SECRET="" \
    WEBHOOK_PORT="9000" \
    NODE_ENV="production"

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:${WEBHOOK_PORT:-9000}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

CMD ["node", "server.js"]
