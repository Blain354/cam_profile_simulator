# UI uniformity — 2026-10-08

The owner requested shared layouts and effective blain-ui use across template-derived applications, including secondary routes and mobile screens, while preserving specialized interactions.

- Kit dependency: `@blain-projects/ui ^1.7.2`.
- Header format: full-width; shared `ThemeToggle` and measured content clearance.
- Changes: Explorer and Profile Builder; common theme owner/header, responsive stacked panels and kit fields/actions.
- Preserved domain UX: Simulation charts, numeric/range controls, solve workflow, guided hints and STL export.

Verified: production frontend build; available frontend tests; synthetic browser fixtures at 375, 768 and 1440px in light/dark themes. Fixtures isolate UI checks from live writes and external services. Screenshots and command logs are stored outside the repository at `/home/blain/ui-uniformity-20261008/evidence/`. These checks do not claim end-to-end coverage of live external integrations.
