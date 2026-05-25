# Feature Specification Template

> **Copy this file to `specs/NNN-feature-name/spec.md` and fill in the sections.**
> The agent uses this as the source of truth for planning and implementation.

---

## Feature: [Short Name]

### User Stories

1. **As a** [user role], **I want** [capability], **so that** [benefit].
2. **As a** [user role], **I want** [capability], **so that** [benefit].

### Acceptance Criteria

- [ ] Criteria 1: Given [context], when [action], then [expected result]
- [ ] Criteria 2: ...

### Frontend Changes

| Component | File | Description |
|-----------|------|-------------|
| New/Modified | `frontend/src/components/...` | What it does |

- [ ] Uses `apiFetch()` for all backend calls
- [ ] Works without hardcoded URLs
- [ ] All new components under `frontend/src/components/`

### Backend Changes

| Endpoint | Method | File | Description |
|----------|--------|------|-------------|
| `/api/...` | GET/POST | `backend/app/routers/...` | What it does |

- [ ] Health check endpoint unchanged
- [ ] No `localhost` in URLs (except dev-mode guards)
- [ ] All new routers in `backend/app/routers/`

### Network Impact

- [ ] **New Docker service?** No / Yes → if yes, add to `docker-compose.yml`
- [ ] **New Traefik subdomain?** No / Yes → if yes, add labels
- [ ] **Inter-service calls?** No / Yes → if yes, use `http://<name>:<port>`
- [ ] **New environment variable?** No / Yes → if yes, add to `.env` and `docker-compose.yml`

### Data Impact

- [ ] **New database table/model?** No / Yes → if yes, add SQLModel class + Alembic migration
- [ ] **File storage?** No / Yes → if yes, use `/app/data/` only

### Test Plan

- [ ] Backend test: `backend/tests/test_*.py`
- [ ] Frontend test: `frontend/src/__tests__/*.test.ts`
- [ ] Docker integration test: `docker-compose up --build` then verify endpoints

---

> **Created:** [DATE] — Source: grill session with [AGENT]
