FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY llm-proxy.js llm-discovery.js llm-mempalace.js seed-providers.json ./
COPY lib/ lib/
COPY .env.example .env.example
EXPOSE 18900
CMD ["node", "llm-proxy.js"]
