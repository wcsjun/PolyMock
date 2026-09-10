# PolyMock 容器镜像：默认启用路径模式（POLYMOCK_MODE=path），
# 所有服务经主端口 /{basePath} 前缀分发，仅需暴露一个端口。
# 配置持久化到 /data 卷（POLYMOCK_CONFIG_FILE 指向卷内文件）。
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    POLYMOCK_MODE=path \
    POLYMOCK_PORT=33233 \
    POLYMOCK_CONFIG_FILE=/data/polymock.config.json
VOLUME ["/data"]
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 33233
CMD ["node", "dist/index.js"]
