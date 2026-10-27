# UI uniformity — 2026-10-08

The owner requested shared layouts and effective blain-ui use across template-derived applications, including secondary routes and mobile screens, while preserving specialized interactions.

- Kit dependency: `@blain-projects/ui ^2.1.1` (Liquid 2).
- Header format: full-width; shared `ThemeToggle`.
- Header clearance: the workspace shell owns spacing under the header. In `frontend/src/App.tsx`, `.bui-workspace-shell` uses `gap-4`; the error banner and the Explorer / Profile Builder grids add **no** top margin of their own (`mt-4` removed). `frontend/shell-contract.test.ts` pins that contract.
- Typography / safe area: `frontend/index.html` loads the Liquid 2 F4 webfonts (Hanken Grotesk, JetBrains Mono from Google Fonts) and sets `viewport-fit=cover` on the viewport meta — also pinned by `frontend/shell-contract.test.ts`.
- Site chrome: `SiteFooter` from the kit sits **under** the workspace shell in `frontend/src/App.tsx` so the tool keeps the whole first screen; the footer follows in the page scroll. Version and deployed commit come from Vite defines (`frontend/build-meta.ts`); Docker builds pass `APP_VERSION` / `APP_COMMIT` / `APP_COMMIT_DATE` as compose build args because the image has no `.git`. Project identity for the footer lives in `frontend/src/project.ts`.
- Labels: sentence case in the tool chrome (Explorer / Profile Builder tabs, section titles, axis controls, export modal) — no `uppercase` / wide-tracking utility classes on those labels.
- Show-off mode: `VITE_BLAIN_SHOWOFF` build arg; when unset, the private app stays sober (`frontend/src/project.ts` → `isShowOff`).
- Changes: Explorer and Profile Builder; common theme owner/header, responsive stacked panels and kit fields/actions.
- Preserved domain UX: Simulation charts, numeric/range controls, solve workflow, guided hints and STL export.

Verified: production frontend build; available frontend tests (`frontend/src/App.test.tsx` covers footer placement and sober private-tool chrome; `frontend/shell-contract.test.ts` covers F4 webfonts, `viewport-fit=cover`, and no top margin under the header); synthetic browser fixtures at 375, 768 and 1440px in light/dark themes. Fixtures isolate UI checks from live writes and external services. Screenshots and command logs are stored outside the repository at `/home/blain/ui-uniformity-20261008/evidence/`. These checks do not claim end-to-end coverage of live external integrations.

The frontend resolves the private kit during Docker builds via the BuildKit secret `npm_token` (shell `NODE_AUTH_TOKEN`, never a build argument) and the placeholder-only `.npmrc`. Ports, networks and routing remain as before. Production builds retain the existing private `.env.production` API origin.
