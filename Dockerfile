FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs

ENV PORT=3010
EXPOSE 3010

CMD ["node", "server.js"]
