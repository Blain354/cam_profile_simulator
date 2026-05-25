# .specify/ — Spec-Driven Development Artifacts

> **Purpose:** Rules that agents VERIFY (not just read).
> These files form the backbone of Spec-Driven Development for this project.

## Structure

```
.specify/
├── constitution.md          ← Governing principles — agents validate before "done"
└── templates/               ← Templates copied into specs/ for each feature
    ├── spec-template.md     ← Feature specification
    └── checklist-template.md ← Implementation validation checklist
```

## How It Works

### 1. Constitution — The Law
`constitution.md` defines non-negotiable rules for the project:
- Network rules (apiFetch, Docker DNS, no localhost)
- Quality standards (function size, no `any` types, type hints)
- Build gates (must pass before "done")
- Testing standards (TDD vertical slices, 80%+ coverage)

**The agent reads this at session start and validates against it before every "done".**

### 2. Specs — The Blueprint
For each feature:
```
specs/
└── 001-feature-name/
    ├── spec.md       ← Requirements, user stories, network impact
    └── checklist.md  ← Generated validation items for this feature
```

### 3. Validation Script
```
scripts/
└── validate-deploy-ready.sh  ← Automated network/build checks
```

Run after `docker-compose up --build` to catch deployment issues locally.

## Agent Workflow

```
Session Start
  ├── Read constitution.md (mandatory)
  ├── Read CONTEXT.md if exists
  │
Feature Request
  ├── Grill session (optional, for >1 module changes)
  ├── Write spec: copy template → specs/NNN-name/spec.md
  ├── Generate checklist from template
  │
Implementation
  ├── TDD vertical slices
  ├── Verify against constitution rules
  │
Pre-Done
  ├── ./scripts/validate-deploy-ready.sh
  ├── All build gates pass
  └── "Done" only when constitution rules satisfied
```

> **Inspired by GitHub Spec Kit** — adapted to this project's React 19 + FastAPI + Docker + Traefik stack.
