FROM node:24-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages ./packages
RUN HUSKY=0 pnpm install --frozen-lockfile

COPY src ./src
COPY tests ./tests
RUN pnpm build

ENV NODE_ENV=production

RUN mkdir -p /app/data /workspaces \
    && chown -R node:node /app /workspaces

USER node
EXPOSE 8787
VOLUME ["/app/data", "/workspaces"]

ENTRYPOINT ["node", "dist/src/cli/main.js"]
CMD ["--config", "/app/data/agent-pigeon.json", "start"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
