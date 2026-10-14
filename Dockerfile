# Builder compiles TypeScript; runner ships only production deps + dist.
# Matches package.json engines (>=22.5.0). Runnable entry is dist/main.js
# (dist/index.js is a side-effect-free barrel, not a server).
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
# Writable locations for the sqlite file (SQLITE_STORAGE_PATH) and pm2 logs.
RUN mkdir -p ./data ./logs && chown -R node:node /app
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
