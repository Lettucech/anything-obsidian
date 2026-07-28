FROM node:22-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /workspace

COPY scripts ./scripts
COPY lib ./lib
COPY .env.example ./.env.example
RUN chmod +x ./scripts/git-askpass.sh

ENTRYPOINT ["node", "scripts/worker.mjs"]
CMD ["doctor"]
