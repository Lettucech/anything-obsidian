FROM node:22-alpine

WORKDIR /workspace

COPY dashboard ./dashboard

ENV DASHBOARD_PORT=3000

CMD ["node", "dashboard/server.mjs"]
