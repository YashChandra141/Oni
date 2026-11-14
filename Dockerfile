# Server_Image (Req 39.1-39.3, design section 7): engine built on rust:1.94-bookworm, server on
# oven/bun:1.4.4-debian, run as the non-root `bun` user. No secrets are baked in; DATABASE_URL,
# DIRECT_URL, SESSION_SECRET and the rest come from the environment at run time.

# ---- engine: native Rust sidecar ---------------------------------------------------------------
FROM rust:1.94-bookworm AS engine
WORKDIR /build
COPY rust/ rust/
# Builds only the engine crate (and the protocol crate it depends on). TLS uses rustls + ring.
RUN cargo build --release --locked --manifest-path rust/Cargo.toml -p engine

# ---- deps: production dependencies of the server workspace only --------------------------------
FROM oven/bun:1.4.4-debian AS deps
WORKDIR /app
# Bun needs every workspace manifest to honour the frozen lockfile.
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY web/package.json web/package.json
# --filter keeps the web workspace's dependencies (Next.js and friends) out of the image. This
# includes the exact-pinned `prisma` CLI, which is a regular dependency of server/.
RUN bun install --frozen-lockfile --production --filter '@haunted/server'

# ---- runtime ------------------------------------------------------------------------------------
FROM oven/bun:1.4.4-debian AS runtime
# OpenSSL 3 for Prisma's schema/migration engine, CA certificates for TLS to Neon and the venues.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json bun.lock ./
COPY shared/ shared/
COPY fixtures/ fixtures/
COPY server/package.json server/tsconfig.json server/prisma.config.ts server/
COPY server/prisma/ server/prisma/
COPY server/src/ server/src/
COPY server/scripts/ server/scripts/
COPY --from=engine /build/rust/target/release/engine /app/bin/engine

# Generate the Prisma Client (needs no database; prisma.config.ts falls back to an empty URL), then
# check that the Prisma CLI and its schema engine run on this image. `prisma version` downloads the
# engine binaries here, as root, so the non-root user never needs to write into node_modules.
RUN bun run db:generate \
 && cd server && bun x prisma version

ENV NODE_ENV=production \
    ENGINE_PATH=/app/bin/engine \
    PORT=10000
EXPOSE 10000

USER bun
# The Start_Script applies migrations with `prisma migrate deploy` (cwd server/), then starts the server.
CMD ["bun", "server/scripts/start.ts"]
