FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
ARG INSTALL_CODEX=false
ARG CODEX_VERSION=0.165.0
RUN if [ "$INSTALL_CODEX" = "true" ]; then npm install -g "@openai/codex@$CODEX_VERSION"; fi
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/src/server.js"]

