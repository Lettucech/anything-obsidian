FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data && chown node:node /app /data \
    && ln -s /app/bin/anything-obsidian.mjs /usr/local/bin/anything-obsidian
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node bin/ bin/
COPY --chown=node:node dashboard/ dashboard/
COPY --chown=node:node lib/ lib/
COPY --chown=node:node mcp/ mcp/
COPY --chown=node:node scripts/ scripts/
COPY --chown=node:node server/ server/
COPY --chown=node:node docker/ docker/
ENV NODE_ENV=production AO_CONTAINER=1 ANYTHING_OBSIDIAN_HOME=/data HOME=/data/home
VOLUME ["/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=20s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "docker/entrypoint.mjs"]
CMD ["client"]
