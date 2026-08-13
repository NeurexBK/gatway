# Build em dois estágios: o runtime não carrega toolchain de TypeScript.
FROM node:20-alpine AS build

WORKDIR /app

# Camada de dependências separada: só invalida quando os manifests mudam.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.check.json ./
COPY scripts ./scripts
COPY src ./src

# Postgres em produção (o Prisma não aceita env() no provider do datasource).
ENV DATABASE_PROVIDER=postgresql
RUN node scripts/set-db-provider.js postgresql \
 && npx prisma generate \
 && npm run build

# Descarta devDependencies para a imagem final.
RUN npm prune --omit=dev


FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# dumb-init como PID 1: repassa SIGTERM ao Node, então o shutdown gracioso
# (fechar o servidor, desconectar o Prisma) realmente acontece.
RUN apk add --no-cache dumb-init

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/schema.prisma ./src/database/schema.prisma
COPY --from=build /app/package.json ./package.json

# Não roda como root.
USER node

EXPOSE 3000

# O healthcheck usa /health (liveness), não /health/ready — este último devolve
# 503 quando o saldo do vault está baixo, e isso não é motivo para reiniciar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
