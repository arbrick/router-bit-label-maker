# --- build: inline fonts and libraries into one page ---
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- serve: static nginx, unprivileged, port 8080 ---
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --chmod=644 nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=644 --from=build /app/dist/index.html /usr/share/nginx/html/index.html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
