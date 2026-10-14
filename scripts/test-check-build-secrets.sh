#!/bin/bash
# Regression test for check-build-secrets.sh: the npm token may reach a Docker
# build only as a BuildKit secret, never as a build argument.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT_DIR/scripts/check-build-secrets.sh"
TMP_DIR="$(mktemp -d)"
FAILED=0

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Fixture: the allowed shape (secret mount + compose secret).
make_clean_repo() {
  local dir="$1"
  mkdir -p "$dir/frontend"
  cat > "$dir/frontend/Dockerfile" <<'EOF'
# syntax=docker/dockerfile:1.10
FROM node:20-alpine AS builder
COPY package*.json .npmrc ./
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN npm ci
EOF
  cat > "$dir/docker-compose.yml" <<'EOF'
services:
  frontend:
    build:
      context: ./frontend
      secrets:
        - npm_token
secrets:
  npm_token:
    environment: NODE_AUTH_TOKEN
EOF
}

expect() {
  local want="$1" name="$2" dir="$3" output status
  set +e
  output="$(bash "$CHECK" "$dir" 2>&1)"
  status=$?
  set -e
  if [ "$want" = pass ] && [ "$status" -ne 0 ]; then
    echo "FAIL: $name — expected pass, got exit $status"; echo "$output"; FAILED=1
  elif [ "$want" = fail ] && [ "$status" -eq 0 ]; then
    echo "FAIL: $name — expected failure, got exit 0"; echo "$output"; FAILED=1
  else
    echo "ok: $name"
  fi
}

make_clean_repo "$TMP_DIR/clean"
expect pass "secret mount + compose secret" "$TMP_DIR/clean"

make_clean_repo "$TMP_DIR/arg"
printf 'FROM node:20-alpine\nARG NODE_AUTH_TOKEN\nRUN npm ci\n' > "$TMP_DIR/arg/frontend/Dockerfile"
expect fail "ARG NODE_AUTH_TOKEN in a Dockerfile" "$TMP_DIR/arg"

make_clean_repo "$TMP_DIR/env"
printf 'FROM node:20-alpine\nENV NODE_AUTH_TOKEN=x\n' > "$TMP_DIR/env/frontend/Dockerfile.prod"
expect fail "ENV NODE_AUTH_TOKEN in a Dockerfile variant" "$TMP_DIR/env"

make_clean_repo "$TMP_DIR/args"
cat > "$TMP_DIR/args/docker-compose.yml" <<'EOF'
services:
  frontend:
    build:
      context: ./frontend
      args:
        NODE_AUTH_TOKEN: ${NODE_AUTH_TOKEN:-}
EOF
expect fail "NODE_AUTH_TOKEN as a compose build arg" "$TMP_DIR/args"

make_clean_repo "$TMP_DIR/list"
cat > "$TMP_DIR/list/docker-compose.yml" <<'EOF'
services:
  frontend:
    build:
      context: ./frontend
      args:
        - NODE_AUTH_TOKEN
EOF
expect fail "NODE_AUTH_TOKEN as a compose build arg (list form)" "$TMP_DIR/list"

make_clean_repo "$TMP_DIR/cli"
mkdir -p "$TMP_DIR/cli/scripts"
printf '#!/bin/sh\ndocker build --build-arg NODE_AUTH_TOKEN="$T" ./frontend\n' > "$TMP_DIR/cli/scripts/build.sh"
expect fail "--build-arg NODE_AUTH_TOKEN in a script" "$TMP_DIR/cli"

make_clean_repo "$TMP_DIR/vendored"
mkdir -p "$TMP_DIR/vendored/frontend/node_modules/pkg"
printf 'FROM x\nARG NODE_AUTH_TOKEN\n' > "$TMP_DIR/vendored/frontend/node_modules/pkg/Dockerfile"
expect pass "node_modules is not scanned" "$TMP_DIR/vendored"

expect pass "this repository" "$ROOT_DIR"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "check-build-secrets test passed"
