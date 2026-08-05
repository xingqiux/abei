# abaku-web 生产镜像：多阶段构建，node 只用来产出静态 dist，运行时是纯 nginx。
# 不在构建期注入任何 VITE_FIREFLY_TOKEN —— 运行时令牌方案见 src/api/client.ts + TokenGate。
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
