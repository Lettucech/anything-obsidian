FROM node:22-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /workspace

COPY scripts ./scripts
COPY .env.example ./.env.example

ENTRYPOINT ["node", "scripts/worker.mjs"]
CMD ["doctor"]
