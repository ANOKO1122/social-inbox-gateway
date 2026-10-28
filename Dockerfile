# syntax=docker/dockerfile:1

# ---- build stage: dev dependencies + TypeScript compile ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
# `npm run build` = rm -rf dist, tsc, then copy src/db/migrations/*.sql into dist/
RUN npm run build

# ---- runtime stage: production dependencies + dist only ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# No secrets are baked into the image: configuration comes from the environment at run time.
USER node
EXPOSE 4010
CMD ["node", "dist/server.js"]
