
## Version de l'app

`frontend/package.json` → `version` n'est plus affichée : `frontend/src/App.tsx` ne rend pas le SiteFooter. Point de départ fixé le 2026-10-26 lors de la migration Liquid 2, estimé
d'après la quantité de travail. À chaque changement livré, l'agent l'incrémente
en semver, dans le même commit que le changement : correctif → patch,
fonctionnalité → minor, refonte ou rupture → major
(`npm version <patch|minor|major> --no-git-tag-version` dans `frontend/`).
