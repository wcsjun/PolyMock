# PolyMock 容器镜像：默认启用路径模式（POLYMOCK_MODE=path），
# 所有服务经主端口 /{basePath} 前缀分发，仅需暴露一个端口。
# 配置持久化到 /data 卷（POLYMOCK_CONFIG_FILE 指向卷内文件）。
#
# 体积优化要点（382MB -> ~127MB）：
#   1) 构建阶段用官方 node 镜像（含 pnpm/corepack/tsc/vite），产物为纯 JS；
#   2) 单独一层只装生产依赖，不把 vite/typescript/playwright 等开发依赖打进镜像；
#   3) 剔除运行期用不到的 vue 相关包——前端已由 vite 打包进 public/，
#      运行时只需 express 依赖树（vue 目前仍声明在 dependencies 中，
#      待其移到 devDependencies 后可删掉本段 rm）；
#   4) 运行阶段基于裸 alpine + 系统 nodejs（无 npm/corepack/toolchain），
#      产物为纯 JS 且无原生模块，跨 node 版本运行安全。

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# 仅保留运行期真正需要的依赖（express 依赖树）
FROM node:22-alpine AS prods
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod \
    && rm -rf node_modules/vue node_modules/@vue \
       node_modules/.pnpm/vue@* node_modules/.pnpm/@vue+* \
       node_modules/.pnpm/@babel+parser@* node_modules/.pnpm/typescript@*

FROM alpine:3.24
RUN apk add --no-cache nodejs
WORKDIR /app
ENV NODE_ENV=production \
    POLYMOCK_MODE=path \
    POLYMOCK_PORT=33233 \
    POLYMOCK_CONFIG_FILE=/data/polymock.config.json
VOLUME ["/data"]
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=prods /app/node_modules ./node_modules
EXPOSE 33233
CMD ["node", "dist/index.js"]
