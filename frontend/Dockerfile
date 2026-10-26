# syntax=docker/dockerfile:1.10
# ──────────────────────────────────────────────────────────────────────────────
# Étape 1 : Construction (Build)
# Le token GitHub Packages (NODE_AUTH_TOKEN, scope read:packages) sert uniquement
# à résoudre le package PRIVÉ @blain-projects/ui. Il arrive comme SECRET BuildKit
# `npm_token` (docker-compose.yml → secrets), exposé en variable d'environnement
# le temps du seul `npm ci` ; frontend/.npmrc le lit via ${NODE_AUTH_TOKEN}.
#
# JAMAIS d'`ARG NODE_AUTH_TOKEN` ni de `--build-arg` : BuildKit enregistre les
# build-args et les lignes RUN expansées dans son historique et son cache
# (/var/lib/docker), lisibles par tout le groupe docker.
# scripts/check-build-secrets.sh fait échouer le déploiement s'ils reviennent.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine as builder
WORKDIR /app

# .npmrc ne contient que le placeholder ${NODE_AUTH_TOKEN}, jamais de valeur.
COPY package*.json .npmrc ./

RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN npm ci

# Build data for the SiteFooter and the show-off mode (docker-compose.yml
# build.args). Public values only — never a token here.
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_COMMIT_DATE=
ARG VITE_BLAIN_SHOWOFF=
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT APP_COMMIT_DATE=$APP_COMMIT_DATE VITE_BLAIN_SHOWOFF=$VITE_BLAIN_SHOWOFF

COPY . .
RUN npm run build

# Étape 2 : Serveur de production (Nginx)
FROM nginx:stable-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Configuration pour supporter le routage SPA (Single Page App)
RUN echo "server { listen 80; location / { root /usr/share/nginx/html; index index.html; try_files \$uri \$uri/ /index.html; } }" > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]