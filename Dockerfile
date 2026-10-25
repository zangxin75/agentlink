# 可选：better-sqlite3 预编译二进制的镜像源（prebuild-install 默认从 GitHub Releases 下载，
# 网络不可达时可指向镜像，如 https://registry.npmmirror.com/-/binary/better-sqlite3）。
# 留空时行为与上游一致（直接走 github.com）。
ARG BSQ_MIRROR=

FROM node:20-slim AS build
ARG BSQ_MIRROR
ENV npm_config_better_sqlite3_binary_host_mirror=$BSQ_MIRROR
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY mcp/package.json mcp/
RUN npm ci
COPY server server
COPY mcp mcp
RUN npm -w server run build && npm -w mcp run build

FROM node:20-slim
ARG BSQ_MIRROR
ENV npm_config_better_sqlite3_binary_host_mirror=$BSQ_MIRROR
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/agentlink.db
COPY package*.json ./
COPY server/package.json server/
COPY mcp/package.json mcp/
RUN npm ci --omit=dev --workspace=server --workspace=mcp
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/mcp/dist mcp/dist
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
