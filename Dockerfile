FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 MARKET_DB=/app/data/market.sqlite
COPY --chown=node:node package.json ./
COPY --chown=node:node backend ./backend
COPY --chown=node:node frontend ./frontend
COPY --chown=node:node scripts ./scripts
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 4173
CMD ["node", "backend/server.mjs"]
