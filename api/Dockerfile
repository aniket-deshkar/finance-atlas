FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY app.mjs main.mjs cloud-routes.mjs cloud-store.mjs assistant.mjs market.mjs ./
USER node
CMD ["node", "main.mjs"]
