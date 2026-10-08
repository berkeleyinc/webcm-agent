# Runs the agent server container: Node.js + the webcm wasm VM artifacts.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Immutable runtime assets: VM wasm, launcher, static assets.
# `make artifacts` writes server/agent/{webcm.mjs,webcm.wasm} before the image
# is built, so this COPY fails loudly if you ran `docker compose up --build`
# without `make artifacts` first.
COPY server/agent/ /app/agent/
COPY server/public/ /app/public/
COPY server/launcher.js /app/launcher.js
COPY server/src/ /app/src/

RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=8080 \
    AGENT_DIR=/app/agent \
    PUBLIC_DIR=/app/public \
    DATA_DIR=/app/data

USER node
EXPOSE 8080
CMD ["node", "launcher.js"]
