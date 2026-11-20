FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
USER node
CMD ["node", "src/bot.mjs"]
