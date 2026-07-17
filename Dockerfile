FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs

ENV PORT=3010
EXPOSE 3010

CMD ["node", "server.js"]
