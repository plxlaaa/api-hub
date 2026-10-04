# ============================================================
#  API Hub 容器镜像（多阶段构建）
#  适用：不想在宿主机装 Node/bun 的用户，或无 systemd 的容器环境
#  构建：docker build -t api-hub .
#  运行：见 docker-compose.yml
# ============================================================

# ---------- 阶段 1：安装依赖 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# CN_MIRROR=1 走国内镜像（install-api-hub.sh --cn 或 compose 里设置）
ARG CN_MIRROR=0
ENV npm_config_registry=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN if [ "$CN_MIRROR" = "1" ]; then \
      echo 'registry=https://registry.npmmirror.com' > /root/.npmrc; \
      echo 'registry=https://registry.npmmirror.com' > /root/.bunfig.toml; \
    fi

# libssl/libstdc++ 是 Prisma query engine 的运行时依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷锁文件做依赖层缓存：源码变动不会触发重新装依赖
COPY package.json bun.lock* ./
# 有 bun.lock 就用 bun（更快），否则退回 npm
RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then \
      npm install -g bun >/dev/null 2>&1 && bun install --frozen-lockfile; \
    else \
      npm ci || npm install; \
    fi

# ---------- 阶段 2：构建 ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ARG CN_MIRROR=0
ENV npm_config_registry=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN if [ "$CN_MIRROR" = "1" ]; then \
      echo 'registry=https://registry.npmmirror.com' > /root/.npmrc; \
      echo 'registry=https://registry.npmmirror.com' > /root/.bunfig.toml; \
      export PRISMA_ENGINES_MIRROR='https://registry.npmmirror.com/-/binary/prisma'; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma Client 生成（schema 变更时需重新生成）
RUN if [ "$CN_MIRROR" = "1" ]; then export PRISMA_ENGINES_MIRROR='https://registry.npmmirror.com/-/binary/prisma'; fi \
 && npx prisma generate

# standalone 输出已配置在 next.config.ts
RUN npm run build

# ---------- 阶段 3：运行时 ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/app/db/custom.db

# standalone 产物自带精简 node_modules；再补 Prisma engine 与静态资源
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# standalone 里缺 query engine（prisma generate 产物在 node_modules/.prisma）
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/doctor.mjs ./doctor.mjs

# 数据目录：SQLite 与凭据文件都落在这里，必须挂卷持久化
RUN mkdir -p /app/db && chown -R nextjs:nodejs /app/db
VOLUME ["/app/db"]

USER nextjs
EXPOSE 3000

# 健康检查：探针接口无需鉴权
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/auth/status" || exit 1

CMD ["node", "server.js"]