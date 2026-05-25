#!/bin/bash
# validate-deploy-ready.sh
# ------------------------------------------------------------------
# Pre-deployment validation script for web_projects_template projects.
# Run AFTER `docker-compose up --build` succeeds.
#
# Verifies network rules, Docker DNS, and common deployment pitfalls
# before pushing to production.
#
# Usage:
#   PROJECT_NAME=myproject ./scripts/validate-deploy-ready.sh
#   or source .env && ./scripts/validate-deploy-ready.sh
# ------------------------------------------------------------------

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
WARN=0
FAIL=0

pass()  { echo -e "  ${GREEN}✅${NC} $1"; ((PASS++)); }
warn()  { echo -e "  ${YELLOW}⚠️${NC}  $1"; ((WARN++)); }
fail()  { echo -e "  ${RED}❌${NC} $1"; ((FAIL++)); }

echo "=============================================="
echo " Pre-Deployment Validation"
echo " Project: ${PROJECT_NAME:-UNSET}"
echo "=============================================="
echo ""

# ── Check PROJECT_NAME is set ──────────────────────────────────────
if [ -z "${PROJECT_NAME:-}" ]; then
  fail "PROJECT_NAME not set. Source .env or pass it explicitly."
  echo ""
  echo "Usage: PROJECT_NAME=myproject ./scripts/validate-deploy-ready.sh"
  exit 1
fi

BACK_CONTAINER="${PROJECT_NAME}-back"
FRONT_CONTAINER="${PROJECT_NAME}-front"

# ── 1. No localhost in source code ──────────────────────────────────
echo "── Network: localhost references ──"
FOUND=$(grep -rn "localhost" backend/ frontend/src/ \
  --include="*.py" --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "localhost:8000" \
  | grep -v "localhost:5173" \
  | grep -v "localhost:5000" \
  | grep -v "# dev" \
  | grep -v "// dev" \
  | grep -v "# local dev" \
  | grep -v "// local dev" \
  | grep -v "localhost:3000" \
  || true)

if [ -n "$FOUND" ]; then
  warn "localhost references found (may be dev-only — verify):"
  echo "$FOUND" | while read line; do echo "    $line"; done
else
  pass "No localhost references in source"
fi

# ── 2. apiFetch() usage ─────────────────────────────────────────────
echo ""
echo "── Network: frontend API calls ──"
RAW_FETCH=$(grep -rn "\bfetch(" frontend/src/ \
  --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "apiFetch" \
  | grep -v "node_modules" \
  | grep -v "// fetch" \
  | grep -v "\.test\." \
  || true)

if [ -n "$RAW_FETCH" ]; then
  warn "Raw fetch() calls found in frontend:"
  echo "$RAW_FETCH" | while read line; do echo "    $line"; done
  echo "  Use apiFetch() from src/api.ts for all backend calls."
else
  pass "All frontend API calls use apiFetch()"
fi

# ── 3. Containers are running ───────────────────────────────────────
echo ""
echo "── Docker: container health ──"
if docker inspect "$BACK_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  pass "Backend container running: $BACK_CONTAINER"
else
  fail "Backend container not running: $BACK_CONTAINER"
fi

if docker inspect "$FRONT_CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
  pass "Frontend container running: $FRONT_CONTAINER"
else
  fail "Frontend container not running: $FRONT_CONTAINER"
fi

# ── 4. Backend health check (inside container) ──────────────────────
echo ""
echo "── Health: backend endpoint ──"
if docker exec "$BACK_CONTAINER" python -c "
import urllib.request
try:
    r = urllib.request.urlopen('http://localhost:5000/api/health')
    assert r.status == 200
except Exception as e:
    exit(1)
" 2>/dev/null; then
  pass "Backend /api/health returns 200"
else
  fail "Backend /api/health unreachable"
fi

# ── 5. Docker DNS — frontend can reach backend ─────────────────────
echo ""
echo "── Network: Docker DNS ──"
if docker exec "$FRONT_CONTAINER" wget -qO- "http://backend:5000/api/health" 2>/dev/null | grep -q .; then
  pass "Frontend can reach backend via Docker DNS (http://backend:5000)"
else
  warn "Frontend cannot reach backend via Docker DNS"
  echo "    Check: is backend on web_network? docker inspect $BACK_CONTAINER"
fi

# ── 6. Volumes ─────────────────────────────────────────────────────
echo ""
echo "── Data: volume persistence ──"
if docker inspect "$BACK_CONTAINER" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null | grep -q "/app/data"; then
  pass "/app/data volume mounted on backend"
else
  warn "/app/data volume NOT mounted on backend — data won't persist"
fi

# ── 7. Secrets check ────────────────────────────────────────────────
echo ""
echo "── Security: secrets scan ──"
SECRETS=$(grep -rIn "sk-.*\|api_key.*=.*\"[^\"]\{20,\}\|token.*=.*\"[^\"]\{20,\}" \
  backend/ frontend/src/ --include="*.py" --include="*.ts" --include="*.tsx" 2>/dev/null \
  | grep -v "apiFetch" \
  | grep -v "bridge-super-secret" \
  | grep -v ".env" \
  || true)

if [ -n "$SECRETS" ]; then
  fail "Potential secrets found in source code:"
  echo "$SECRETS" | while read line; do echo "    $line"; done
else
  pass "No secrets detected in source"
fi

# ── 8. requirements.txt ─────────────────────────────────────────────
echo ""
echo "── Deps: requirements.txt ──"
if [ -f backend/requirements.txt ]; then
  pass "requirements.txt exists"
else
  warn "No requirements.txt in backend/"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo " Results: ${GREEN}$PASS passed${NC}, ${YELLOW}$WARN warnings${NC}, ${RED}$FAIL failed${NC}"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "❌ Fix failures before deploying."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo ""
  echo "⚠️  Warnings present — review before deploying."
  exit 0
else
  echo ""
  echo "✅ All checks passed. Ready to deploy."
  exit 0
fi
