FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/bot.mjs"]
