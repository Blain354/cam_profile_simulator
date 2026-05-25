# Feature Implementation Checklist

> **Auto-generated for each feature. Agentes verify every item before calling work "done".**

---

## Pre-Implementation (Grill → Plan)

- [ ] Grill session completed (features affecting >1 module)
- [ ] `CONTEXT.md` read or created (project glossary)
- [ ] Spec written: `specs/NNN-feature/spec.md`
- [ ] Constitution rules reviewed for this feature
- [ ] Existing codebase searched for reusable patterns

## Network Validation (CRITICAL)

- [ ] All frontend `fetch()` calls use `apiFetch()` from `src/api.ts`
- [ ] Zero hardcoded `localhost` URLs in frontend API calls
- [ ] Zero `localhost` URLs in backend inter-service calls
- [ ] New Docker services on `web_network`
- [ ] Traefik labels present for exposed services
- [ ] No Traefik labels for internal-only services
- [ ] `google-auth` middleware label: kept (private) or removed (public)
- [ ] CORS preflight router present if backend uses `google-auth`
- [ ] New env vars in BOTH `.env` AND `docker-compose.yml`

## Code Quality

- [ ] Functions < 50 lines
- [ ] Files < 400 lines
- [ ] No deep nesting (> 4 levels)
- [ ] TypeScript: no `any` types
- [ ] Python: type hints on all signatures
- [ ] Early returns over nested conditionals

## Testing

- [ ] Backend tests written: `backend/tests/`
- [ ] Frontend tests written: `frontend/src/__tests__/`
- [ ] Coverage ≥ 80% on new code
- [ ] Tests pass in Docker environment
- [ ] Tests use public interfaces (not internal implementation)

## Build Gates (ALL MUST PASS)

- [ ] `npm run build` succeeds
- [ ] `npm run lint` clean
- [ ] `docker-compose up --build` succeeds
- [ ] Backend health check inside Docker: ✅
- [ ] Docker DNS works: `docker exec <frontend> curl backend:5000/api/health` ✅
- [ ] `./scripts/validate-deploy-ready.sh` all green

## Documentation & Cleanup

- [ ] `CONTEXT.md` updated with new terms
- [ ] `README.md` updated if new endpoints/services added
- [ ] `requirements.txt` updated if new Python deps
- [ ] `package.json` deps clean (`npm install` not `npm install <pkg>` then forget)
- [ ] No secrets, tokens, passwords in code
- [ ] No debug `console.log` or `print()` left in production paths
- [ ] Git: conventional commit message (`feat:`, `fix:`, etc.)
