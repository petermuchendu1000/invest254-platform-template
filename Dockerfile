# Invest254 backend image — runs the WS game engine (8080) and/or REST API (8081).
# Source-first: the services run via `tsx`, so there is NO compile/build step.
# The same image is deployed as two Fly apps (see fly.engine.toml / fly.api.toml),
# each overriding the start command via its own [processes] block.
#
# apps/web (Next.js) is deliberately NOT in this image — it ships to Cloudflare Pages.

FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache dumb-init

# 1) Copy only manifests first for better Docker layer caching.
#    The lockfile drives a reproducible `npm ci`.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/engine/package.json   ./apps/engine/
COPY apps/api/package.json      ./apps/api/

# 2) Install all workspace deps INCLUDING dev deps.
#    `tsx` is a root devDependency and is required at runtime to run the TS
#    sources directly, so we must NOT drop dev deps here. apps/web is absent;
#    npm ci handles the missing workspace and skips its dependencies.
RUN npm ci --include=dev

# 3) Copy backend source (apps/web intentionally excluded).
COPY packages/shared ./packages/shared
COPY packages/db     ./packages/db
COPY apps/engine     ./apps/engine
COPY apps/api        ./apps/api

ENV NODE_ENV=production

# The commit this image was built from, so a running container can say what it is.
#
# Until this existed, "what is actually live?" could only be answered through the Fly API —
# /health returned {status,time} and nothing else, so nobody without Fly credentials could tell a
# deployed fix from an undeployed one. That gap cost real time: a fix was merged, the site looked
# unchanged, and distinguishing "not deployed" from "deployed but broken" needed `flyctl releases`.
# ARG not ENV for the default, so a plain `docker build` still works; the deploy passes the real SHA.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

EXPOSE 8080 8081

ENTRYPOINT ["dumb-init", "--"]
# Default: run BOTH services in one container (website / single-app deploy via root
# fly.toml). The engine binds 8080 and the API binds 8081 from their own defaults
# (neither PORT env is set, so they don't collide). The per-app CLI configs
# (fly.engine.toml / fly.api.toml) override this with a single-service [processes].
CMD ["sh", "-c", "npm -w @invest254/engine start & npm -w @invest254/api start & wait"]
