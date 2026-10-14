#!/bin/bash
# check-build-secrets.sh
# ------------------------------------------------------------------
# Fails if the GitHub Packages token (NODE_AUTH_TOKEN) can reach a Docker
# build any other way than as a BuildKit secret.
#
# Why: BuildKit records build arguments, and RUN lines with their values
# expanded, in its build history and cache under /var/lib/docker, where anyone
# in the docker group can read them. A secret mount is never recorded.
#
# Allowed:   RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN npm ci
#            compose: build.secrets: [npm_token] + secrets.npm_token.environment
# Forbidden: ARG/ENV NODE_AUTH_TOKEN in a Dockerfile, NODE_AUTH_TOKEN as a
#            compose args/environment entry, --build-arg NODE_AUTH_TOKEN.
#
# Usage: ./scripts/check-build-secrets.sh [repo-root]   (default: this repo)
# Runs before any build: no Docker needed, nothing is printed but file:line.
# ------------------------------------------------------------------

set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VAR=NODE_AUTH_TOKEN
FOUND=0

# Every file of the repo except dependencies, build output and agent worktrees.
list_files() {
  find "$ROOT" \( -name node_modules -o -name .git -o -name dist -o -name .venv \
    -o -path '*/.claude/worktrees' \) -prune -o -type f "$@" -print
}

report() {
  local what="$1" hits="$2"
  if [ -n "$hits" ]; then
    echo "❌ $what:"
    echo "$hits" | sed "s|^$ROOT/|    |"
    FOUND=1
  fi
}

DOCKERFILES=$(list_files \( -name 'Dockerfile*' -o -name '*.Dockerfile' \))
COMPOSE=$(list_files \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' \
  -o -name 'compose*.yml' -o -name 'compose*.yaml' \))
SCRIPTS=$(list_files \( -name '*.sh' -o -name '*.ps1' -o -name 'Makefile' -o -name '*.mk' \
  -o -name '*.yml' -o -name '*.yaml' -o -name 'package.json' \) \
  -not -name 'check-build-secrets.sh' -not -name 'test-check-build-secrets.sh')

grep_files() {
  local pattern="$1" files="$2"
  [ -n "$files" ] || return 0
  echo "$files" | tr '\n' '\0' | xargs -0 grep -HnE -e "$pattern" 2>/dev/null || true
}

report "$VAR declared as ARG/ENV in a Dockerfile (use a secret mount)" \
  "$(grep_files "^[[:space:]]*(ARG|ENV)[[:space:]]+$VAR([[:space:]=]|$)" "$DOCKERFILES")"

# A key or list item named NODE_AUTH_TOKEN is a build arg or a container env
# entry; the allowed form is the value of `environment:` under `secrets:`.
report "$VAR passed as a compose build arg or env entry (use build.secrets)" \
  "$(grep_files "^[[:space:]]*(-[[:space:]]*)?$VAR[[:space:]]*(:|=|$)" "$COMPOSE")"

report "$VAR passed with --build-arg (use --secret id=npm_token,env=$VAR)" \
  "$(grep_files "--build-arg[[:space:]=]+[\"']?$VAR" "$SCRIPTS")"

if [ "$FOUND" -ne 0 ]; then
  echo "The npm token must reach the build only as the BuildKit secret npm_token."
  echo "See frontend/Dockerfile and docker-compose.yml in web_projects_template."
  exit 1
fi
echo "✅ $VAR reaches Docker builds only as a BuildKit secret"
