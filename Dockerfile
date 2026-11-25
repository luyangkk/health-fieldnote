FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY .openai/ ./.openai/
COPY index.html vite.config.js ./
COPY src/ ./src/
COPY worker/ ./worker/
COPY scripts/ ./scripts/
COPY drizzle/ ./drizzle/
COPY selfhost/ ./selfhost/
COPY test/ ./test/
RUN npm run build && npm test

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 FIELDNOTE_DB=/data/health.sqlite
RUN mkdir -p /data && chown 1000:1000 /data
COPY package.json ./
COPY --from=build /app/dist/server/ ./dist/server/
COPY --from=build /app/drizzle/ ./drizzle/
COPY --from=build /app/selfhost/ ./selfhost/
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD ["node","-e","fetch('http://127.0.0.1:8080/healthz').then(x=>process.exit(x.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","selfhost/server.js"]
