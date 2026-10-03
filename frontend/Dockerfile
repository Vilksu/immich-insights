FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# NAS/SMB copies can leave files from public/ owner-readable only.
# Nginx serves them as an unprivileged user.
RUN chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
