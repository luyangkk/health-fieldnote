FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY .openai/ ./.openai/
COPY index.html vite.config.js ./
COPY src/ ./src/
COPY worker/ ./worker/
COPY scripts/ ./scripts/
COPY drizzle/ ./drizzle/
COPY selfhost/ ./selfhost/
COPY docs/api/openapi.json ./docs/api/openapi.json
COPY test/ ./test/
COPY deploy/init-tls.sh ./deploy/init-tls.sh
RUN npm run build && npm test
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production FIELDNOTE_DB=/data/health.sqlite
RUN mkdir -p /data && chown 1000:1000 /data
COPY package.json ./
COPY --from=build /app/dist/server/ ./dist/server/
COPY --from=build /app/drizzle/ ./drizzle/
COPY --from=build /app/selfhost/ ./selfhost/
COPY --from=build /app/src/lib.js ./src/lib.js
COPY --from=build /app/docs/api/openapi.json ./docs/api/openapi.json
COPY --from=build /app/node_modules/ ./node_modules/
USER 1000:1000
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD ["node","selfhost/healthcheck.js"]
CMD ["node","selfhost/server.js"]
