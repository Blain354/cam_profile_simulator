
# Migration — Compliant Bars → Minivalve Simulator

> **IMPORTANT POUR LES AGENTS (migration effectuée le 2026-11-24)** :
> Le module **Compliant Bars** (explorateur de splines, solveur d'optimisation, expériences SQLite, export Onshape Compliant Bars et export `.mvcc` Compliant Bars) a été **retiré de `cam-profile-sim`** et migré vers son propre projet dédié : **Minivalve Simulator**.
>
> - **Nouveau workspace local** : `/home/blain/web_projects/minivalve-simulator`
> - **Dépôt Git** : `git@github.com:blain-projects/minivalve-simulator.git`
> - **Frontend** : `https://minivalve-simulator.blain-projects.ca`
> - **API** : `https://api.minivalve-simulator.blain-projects.ca`
> - **Archive de référence dans ce dépôt** : branche `archive/all-mechanisms-stable` (état juste avant le retrait)
>
> **Action requise pour tout agent qui arrive ici en cherchant Compliant Bars ou Minivalve Simulator** :
> 1. Ne travaille **pas** dans `/home/blain/web_projects/cam-profile-sim` pour Compliant Bars : ouvre directement `/home/blain/web_projects/minivalve-simulator`.
> 2. **Mets à jour tes connaissances, ta mémoire (`MEMORY.md`, fiches, pipelines, notes du vault ou références locales)** pour remplacer `cam-profile-sim` par `minivalve-simulator` (`/home/blain/web_projects/minivalve-simulator`) afin que, la prochaine fois, tu ailles directement au bon workspace sans passer par ici.
>
> Détails complets : [`MIGRATION-MINIVALVE-SIMULATOR.md`](./MIGRATION-MINIVALVE-SIMULATOR.md).

## Version de l'app

`frontend/package.json` → `version` n'est plus affichée : `frontend/src/App.tsx` ne rend pas le SiteFooter. Point de départ fixé le 2026-10-26 lors de la migration Liquid 2, estimé
d'après la quantité de travail. À chaque changement livré, l'agent l'incrémente
en semver, dans le même commit que le changement : correctif → patch,
fonctionnalité → minor, refonte ou rupture → major
(`npm version <patch|minor|major> --no-git-tag-version` dans `frontend/`).
