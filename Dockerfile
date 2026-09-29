# Imagem única para web (Next standalone) e worker. Sem segredos na imagem: tudo vem do ambiente.
FROM node:22.23.3-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/api/package.json packages/api/
COPY packages/authorization/package.json packages/authorization/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# O build não lê banco nem segredos; APP_MODE/AUTH só precisam passar na validação de ambiente.
RUN APP_MODE=test AUTH_PROVIDER=mock pnpm --filter @evolu/web build

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 HOSTNAME=0.0.0.0 PORT=3000
RUN corepack enable && groupadd -r evolu && useradd -r -g evolu -d /repo evolu \
  && mkdir -p /data/storage && chown evolu:evolu /data/storage
WORKDIR /repo
COPY --from=build --chown=evolu:evolu /repo /repo
# Next standalone não copia estáticos: ficam ao lado do server.js.
RUN cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
  && chown -R evolu:evolu apps/web/.next/standalone
USER evolu
EXPOSE 3000
CMD ["node", "apps/web/.next/standalone/apps/web/server.js"]
