# syntax=docker/dockerfile:1
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS production-dependencies

WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline --no-audit --no-fund

FROM node:22-alpine AS runtime

ENV NODE_ENV=production HOST=0.0.0.0

WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/dist-server ./dist-server

EXPOSE 3000
USER node
CMD ["npm", "start"]
