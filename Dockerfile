FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY llm-proxy.js llm-discovery.js *-auth.js seed-providers.json ./
COPY lib/ lib/
COPY vendor/ vendor/
COPY config/ config/
COPY data/model-catalog-evidence.json data/model-catalog-evidence.json
COPY scripts/ scripts/
COPY .env.example .env.example
EXPOSE 18900
CMD ["node", "llm-proxy.js"]
