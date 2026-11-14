# drift-islands 运行镜像（多阶段构建）
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
# 生产依赖：Node/PG/Redis 客户端均为纯 JS，忽略安装脚本可避开原生模块编译
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/main.js"]
