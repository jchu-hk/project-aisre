# ============================================================
# AI SRE Service — Docker 镜像（多阶段）
# 关联: Issue #370/#371 apps/ai-sre-service
#   仅生产依赖 + dist + config 入运行态；build 中间产物不留在镜像。
#   零被纳管系统硬编码：地址/端点/通道全经 SRE_CONFIG_PATH 注入。
# ============================================================
FROM node:22-alpine AS build
WORKDIR /opt/ai-sre
# 注: 本服务仅有 js-yaml + 构建工具(typescript/ts-node) 的小型稳定依赖集；
# 用 npm install 以识别 ranges（见 runbook §9 关于 lockfile 的说明）。
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------- 运行态 ----------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /opt/ai-sre

# 生产依赖
COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

# 仅复制已编译产物 + 运行所需清单（不含 src / tsconfig / test）
COPY --from=build /opt/ai-sre/dist ./dist

# 运行账户：最小权限，非 root（对齐 NFR-S / C1 最小权限）
RUN addgroup -S ai-sre && adduser -S -G ai-sre ai-sre \
    && mkdir -p /var/lib/ai-sre && chown -R ai-sre:ai-sre /opt/ai-sre /var/lib/ai-sre
USER ai-sre

EXPOSE 9090
# 配置经只读卷挂载，位置由 compose 的 SRE_CONFIG_PATH 指定；缺省可容错到 default.yaml 兜底
ENV SRE_CONFIG_PATH=/etc/ai-sre/school-admin-system.test.yaml
CMD ["node", "dist/main.js"]
