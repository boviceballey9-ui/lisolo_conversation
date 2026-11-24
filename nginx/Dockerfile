# Image Nginx avec le build de production du frontend.
# Contexte de build : la racine du dépôt (voir docker-compose.yml).

# 1. Construction du frontend (tsc + vite build) dans un conteneur Node.
FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2. Image finale : Nginx seul, avec les fichiers statiques. Node n'y est plus.
FROM nginx:1.28-alpine
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
