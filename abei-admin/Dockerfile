# abei-admin 生产镜像：多阶段构建，node 只用来产出静态 dist，运行时是纯 nginx。
# 和 abei-web 同一套令牌方案（浏览器会话内的 Firefly PAT），构建期不注入任何密钥。
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
