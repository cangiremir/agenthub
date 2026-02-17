FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/push-worker/package.json services/push-worker/package.json
RUN npm install --workspace @agenthub/push-worker --include-workspace-root
COPY . .
RUN npm --workspace @agenthub/push-worker run build
CMD ["node", "services/push-worker/dist/index.js"]
