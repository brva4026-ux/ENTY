# Build de producción del frontend + servir con nginx + proxy /api al backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_BACKEND_URL=http://localhost:8000
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
RUN npm run build

# SSR/proxy server propio (más robusto que `vite preview`)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
# Render inyecta $PORT; server.mjs lo lee de env (argv como fallback)
EXPOSE 12000
CMD ["sh", "-c", "node server.mjs ${PORT:-12000}"]