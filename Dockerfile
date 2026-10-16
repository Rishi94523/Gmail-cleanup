FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run check:web && npm run build:web

FROM node:24-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY --from=frontend-build /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# The first cloud release is an honest product preview. It does not run the
# process-local SQLite scheduler in an ephemeral/scaling Cloud Run instance.
CMD ["node", "server/preview.js"]
