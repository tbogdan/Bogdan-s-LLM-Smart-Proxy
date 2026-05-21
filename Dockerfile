FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY llm-proxy.js llm-discovery.js llm-mempalace.js github-copilot-auth.js seed-providers.json ./
COPY lib/ lib/
COPY scripts/ scripts/
COPY .env.example .env.example
EXPOSE 18900
CMD ["node", "llm-proxy.js"]
