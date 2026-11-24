# Migration : Compliant Bars → Minivalve Simulator

**Date de migration :** 2026-11-24

Le mécanisme **Compliant Bars** a été extrait de `cam-profile-sim` pour devenir un projet autonome et le nouveau standard : **Minivalve Simulator**.

Tout le code, les routes API (`/api/compliant/*`), les tests, l'interface (`CompliantBars.tsx`, `frontend/src/compliant/*`), le stockage d'expériences (`compliant_solve_experiments`) et l'export Onshape dédié à Compliant Bars ont été **supprimés** de `cam-profile-sim`. Ce dépôt conserve uniquement les simulateurs historiques **Cam**, **Bar Linkage**, **Lever Linkage** et **Pendulum Linkage**.

## Où trouver Minivalve Simulator

| Ressource | Valeur |
|---|---|
| **Workspace local** | `/home/blain/web_projects/minivalve-simulator` |
| **Dépôt Git** | `git@github.com:blain-projects/minivalve-simulator.git` |
| **Frontend (prod)** | `https://minivalve-simulator.blain-projects.ca` |
| **API (prod)** | `https://api.minivalve-simulator.blain-projects.ca` |
| **Archive pré-retrait** | branche `archive/all-mechanisms-stable` dans `cam-profile-sim` |

## Consigne pour les agents IA

Si tu es arrivé dans `/home/blain/web_projects/cam-profile-sim` en cherchant **Compliant Bars** ou **Minivalve Simulator** (par exemple via une ancienne référence dans un pipeline d'agents, un prompt ou une mémoire) :

1. **Change de workspace immédiatement** et va travailler dans `/home/blain/web_projects/minivalve-simulator`.
2. **Mets à jour ta mémoire et tes connaissances** (ta mémoire locale d'agent, `MEMORY.md`, fiches/notes de référence ou pipelines dont tu as la charge) pour pointer vers **`minivalve-simulator`** (`/home/blain/web_projects/minivalve-simulator`, `git@github.com:blain-projects/minivalve-simulator.git`) comme nouveau standard pour Compliant Bars / Minivalve Simulator, afin d'aller directement au bon endroit dès la prochaine session.
