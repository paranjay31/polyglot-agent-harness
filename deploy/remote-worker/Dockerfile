FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins
RUN corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 8790
CMD ["node", "dist/apps/remote-worker/src/main.js"]
