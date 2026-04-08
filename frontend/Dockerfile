# Étape 1 : Construction (Build)
FROM node:20-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Étape 2 : Serveur de production (Nginx)
FROM nginx:stable-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Configuration pour supporter le routage SPA (Single Page App)
RUN echo "server { listen 80; location / { root /usr/share/nginx/html; index index.html; try_files \$uri \$uri/ /index.html; } }" > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]