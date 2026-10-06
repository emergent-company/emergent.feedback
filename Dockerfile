# Dockerfile — emergent.feedback
#
# Three-stage build:
#   1. node-builder  — compiles the TypeScript client → emergent-feedback.js
#   2. go-builder    — compiles the Go server (embeds the JS bundle)
#   3. runtime       — minimal alpine image
#
# Usage:
#   docker build \
#     --build-arg VERSION=$(cat VERSION) \
#     --build-arg COMMIT=$(git rev-parse --short HEAD) \
#     -t ghcr.io/emergent-company/emergent-feedback:<version> .
#
# Required runtime env vars:
#   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI, JWT_SECRET
# Optional:
#   PORT (default 8080), DB_PATH (default /data/feedback-overlay.db),
#   ALLOWED_ORIGINS (comma-separated, default *)

# ── Stage 1: build JS client ───────────────────────────────────────────────────
FROM node:22-alpine AS node-builder

WORKDIR /client
COPY client/package*.json ./
# Cache npm packages across builds — only invalidated when package-lock.json changes.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline
COPY client/ ./
RUN npm run build

# Build the Memory brand theme CSS → /build/server/app/static/css/theme.css.
# The Tailwind entry's @source globs are relative to landing/styles/app.css
# (../../server/**), so the server sources must be present in this stage or
# the page utilities used in .templ files get tree-shaken out of the CSS.
WORKDIR /build
COPY landing/ ./landing/
COPY server/ ./server/
WORKDIR /build/landing
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline
RUN npm run build

# ── Stage 2: build Go server ───────────────────────────────────────────────────
FROM golang:1.24.2-alpine AS go-builder

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src

ENV GONOSUMDB=github.com/emergent-company/*
# Allow the 1.24 toolchain to satisfy modules that declare a higher go version.
ENV GOTOOLCHAIN=auto

# Download modules first — cached until go.mod/go.sum change.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod \
    go mod download

# Copy source. The JS bundles in server/app/static/ are placeholders in the repo;
# we overwrite them from the node-builder stage below.
COPY . .
COPY --from=node-builder /client/../server/app/static/emergent-feedback.js ./server/app/static/emergent-feedback.js
COPY --from=node-builder /client/../server/app/static/emergent-feedback-replay.js ./server/app/static/emergent-feedback-replay.js
COPY --from=node-builder /build/server/app/static/css/theme.css ./server/app/static/css/theme.css

# VERSION/COMMIT are injected here. Changing them only busts the final link
# step, not the expensive compilation of all dependencies.
ARG VERSION=dev
ARG COMMIT=unknown

RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
      -ldflags="-s -w \
        -X github.com/emergent-company/emergent.feedback/server/app.Version=${VERSION} \
        -X github.com/emergent-company/emergent.feedback/server/app.Commit=${COMMIT}" \
      -o /out/emergent-feedback \
      ./server

# ── Stage 3: runtime ───────────────────────────────────────────────────────────
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata wget

# Non-root user
RUN addgroup -S feedback && adduser -S feedback -G feedback

COPY --link --from=go-builder /out/emergent-feedback /usr/local/bin/emergent-feedback

# Persistent data volume for SQLite database.
# Create /data as root and give it to the feedback user before switching.
RUN mkdir -p /data && chown feedback:feedback /data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=30s \
  CMD wget -qO- http://localhost:8080/health || exit 1

USER feedback

ENTRYPOINT ["/usr/local/bin/emergent-feedback"]
