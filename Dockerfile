FROM node:22-bookworm-slim AS build
WORKDIR /app/web
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY web/package.json web/package-lock.json ./
RUN npm ci --legacy-peer-deps --include=optional
COPY web/monoform-studio/package.json web/monoform-studio/package-lock.json ./monoform-studio/
RUN npm ci --prefix monoform-studio --include=optional
COPY web/ ./
RUN npm run build:all

FROM node:22-bookworm-slim AS runtime
ARG CODEX_CLI_VERSION=0.153.4
RUN npm install --global @openai/codex@${CODEX_CLI_VERSION} && npm cache clean --force \
    && mkdir -p /data /app/web && chown -R node:node /data /app
WORKDIR /app/web
COPY --from=build --chown=node:node /app/web/node_modules ./node_modules
COPY --from=build --chown=node:node /app/web/dist ./dist
COPY --from=build --chown=node:node /app/web/server ./server
COPY --from=build --chown=node:node /app/web/local-bridge ./local-bridge
COPY --from=build --chown=node:node /app/web/vite.config.ts /app/web/package.json /app/web/package-lock.json ./
ENV NODE_ENV=production ATELIER_DATA_DIR=/data ATELIER_ALLOW_REGISTRATION=false
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/account/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
