FROM node:22-slim
WORKDIR /app
COPY llm-proxy.js llm-discovery.js seed-providers.json package.json ./
COPY .env.example .env.example
EXPOSE 18900
CMD ["node", "llm-proxy.js"]
