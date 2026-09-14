# PDA governance demo — Linux container image for Azure Container Apps.
# At-rest protection uses Azure Key Vault (not Windows DPAPI) via PDA_PROTECTOR=keyvault.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PDA_ALLOW_REMOTE=1 \
    PDA_PROTECTOR=keyvault \
    PDA_DEPENDENCIES=/app \
    PDA_STATE_DIR=/state \
    PDA_PUBLIC_SCHEME=https \
    PORT=8110
WORKDIR /app
# ca-certificates: the Copilot SDK's native HTTP client needs a system CA trust store (absent in -slim).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app && useradd --system --gid app --home-dir /app app \
    && mkdir -p /state \
    && chown -R app:app /state
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.mjs ./
COPY app ./app
COPY public ./public
RUN chown -R app:app /app
USER app
EXPOSE 8110
CMD ["node", "server.mjs"]
