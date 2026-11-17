FROM node:24-alpine

ENV NODE_ENV=production \
    BRIDGE_CONFIG=/config/config.json

WORKDIR /app
# No runtime dependencies, so there is no install step.
COPY package.json ./
COPY src ./src

# Mapping database lives here; mount a volume to keep edit/delete tracking across restarts.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
