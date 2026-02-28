# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install --ignore-scripts --omit=dev

COPY . .

ENV OPENAPI_MCP_HEADERS="{}"

ENTRYPOINT ["node", "/app/bin/cli.mjs"]
