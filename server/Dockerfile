# The any-obs gateway — server half of the stack. Build context is the repo
# root so the gateway can reuse the client's embed pipeline unchanged.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY scripts/embed-vault.mjs ./scripts/embed-vault.mjs
COPY server ./server

ENV GATEWAY_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 21500
CMD ["node", "server/gateway.mjs"]
