# syntax=docker/dockerfile:1

# 构建阶段使用与仓库 engines 约束一致的 Node.js 版本。
# 所有 TypeScript、管理台静态资源和工作区依赖都在该阶段生成，避免运行镜像携带编译工具。
FROM node:22.19.0-bookworm-slim AS builder

WORKDIR /app

# Java Runtime 会复用 monorepo 内的 Pi 包，因此必须以仓库根目录作为 Docker 构建上下文。
COPY . .

# 项目安全规则要求安装依赖时禁用生命周期脚本。管理台不是 npm workspace，需要单独安装。
RUN npm ci --ignore-scripts \
	&& npm ci --prefix packages/java-agent-runtime/manage-console --ignore-scripts \
	&& npm run build:offline \
	&& npm prune --omit=dev --ignore-scripts

# 运行阶段只保留 Node.js、生产依赖和已经编译好的 Runtime/管理台资源。
FROM node:22.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/agent/package.json ./packages/agent/package.json
COPY --from=builder --chown=node:node /app/packages/agent/dist ./packages/agent/dist
COPY --from=builder --chown=node:node /app/packages/ai/package.json ./packages/ai/package.json
COPY --from=builder --chown=node:node /app/packages/ai/dist ./packages/ai/dist
COPY --from=builder --chown=node:node /app/packages/client/package.json ./packages/client/package.json
COPY --from=builder --chown=node:node /app/packages/client/dist ./packages/client/dist
COPY --from=builder --chown=node:node /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=node:node /app/packages/tui/package.json ./packages/tui/package.json
COPY --from=builder --chown=node:node /app/packages/tui/dist ./packages/tui/dist
COPY --from=builder --chown=node:node /app/packages/coding-agent/package.json ./packages/coding-agent/package.json
COPY --from=builder --chown=node:node /app/packages/coding-agent/dist ./packages/coding-agent/dist
COPY --from=builder --chown=node:node /app/packages/java-agent-runtime/package.json ./packages/java-agent-runtime/package.json
COPY --from=builder --chown=node:node /app/packages/java-agent-runtime/dist ./packages/java-agent-runtime/dist
COPY --from=builder --chown=node:node /app/packages/java-agent-runtime/static ./packages/java-agent-runtime/static

# Star2 的 iot 用户也是 1000:1000。使用官方 node 用户运行后，宿主机创建的数据目录可直接读写。
USER node

EXPOSE 8000

# 健康检查只依赖 Node.js 自身，不为一个 HTTP 请求额外安装 curl/wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PI_RUNTIME_PORT || 8000}/healthz`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "packages/java-agent-runtime/dist/main.js"]

