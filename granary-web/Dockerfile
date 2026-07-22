# granary-web 生产镜像：多阶段构建，node 只用来产出静态 dist，运行时是纯 nginx。
# 不在构建期注入任何 VITE_FIREFLY_TOKEN —— 运行时令牌方案见 src/api/client.ts + TokenGate。
FROM node:22-alpine AS build

# 仅影响设置页「旧版界面」链接（非敏感），迁移完成后可删除。
ARG VITE_LEGACY_URL
ENV VITE_LEGACY_URL=${VITE_LEGACY_URL}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
