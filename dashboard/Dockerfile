# Build context: project root (see docker/docker-compose.yml)
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY dashboard ./dashboard
RUN mkdir -p /daten && chown node:node /daten
USER node
ENV DASHBOARD_DATEN=/daten NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/gesund || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dashboard/server.js"]
