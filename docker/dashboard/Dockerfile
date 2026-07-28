FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /workspace

COPY dashboard ./dashboard
COPY lib ./lib

ENV DASHBOARD_PORT=3000

CMD ["node", "dashboard/server.mjs"]
